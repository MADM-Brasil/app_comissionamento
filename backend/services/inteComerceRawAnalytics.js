// backend/services/inteComerceRawAnalytics.js
import { createHash } from 'node:crypto';
import db from './db.js';
import { cached } from './inteComerceCache.js';

const STATEMENT_TIMEOUT_MS = 55_000;
const WORK_MEM = process.env.DB_ANALYTICS_WORK_MEM || '64MB';
const EVENT_TYPES = new Set([
  'DEAL_CREATED','RECEBIDO_CORPORATIVO','RECEBIDO_ASSESSOR','TRABALHADO_PROXY',
  'EM_CONTATO','COLETA','CONTRATO','EMITIDO_ORIGINAL','ASSINADO_ORIGINAL',
  'GANHO','PROTOCOLADO','DESQUALIFICADO',
]);
const STAGE_TYPES = new Map([
  ['6650','EM_CONTATO'],['6651','COLETA'],['6652','CONTRATO'],['6659','DESQUALIFICADO'],
]);
const PIPELINE_COMERCIAL = '572';
const PRODUCT_VARIANTS = {
  'Auxilio Acidente': ['Auxilio Acidente','Auxílio Acidente'],
  'Quinquenio': ['Quinquenio','Quinquênio'],
  'Concomitante': ['Concomitante'],
  'Fator K': ['Fator K'],
  'BPC/LOAS': ['BPC/LOAS','BPC / LOAS','BPC_LOAS'],
  'Isenção de IR Aposentadoria': ['Isenção de IR Aposentadoria','Isencao de IR Aposentadoria'],
};
// Placeholders usados nas tabelas e nos motivos. Constantes para evitar
// duplicação entre backend e (futura) exportação CSV.
const PLACEHOLDER_COLLAB = '(SEM ATRIBUICAO)';
const PLACEHOLDER_TEAM = '(SEM EQUIPE)';

const workMemMatch = /^(\d+)(kB|MB|GB)$/i.exec(WORK_MEM);
const workMemBytes = workMemMatch
  ? Number(workMemMatch[1]) * ({ kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 })[workMemMatch[2].toLowerCase()]
  : NaN;
if (!Number.isSafeInteger(workMemBytes) || workMemBytes < 4 * 1024 ** 2 || workMemBytes > 256 * 1024 ** 2) {
  throw new Error('DB_ANALYTICS_WORK_MEM deve estar entre 4MB e 256MB.');
}

function periodBounds(start, end) {
  return { start: new Date(`${start}T03:00:00.000Z`), end: new Date(`${end}T03:00:00.000Z`) };
}
function timestamp(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
function compareAssessorEvents(a, b) {
  const t = a.receivedAt - b.receivedAt;
  if (t) return t;
  const i = Number(a.collaboratorId) - Number(b.collaboratorId);
  if (i) return i;
  return String(a.team ?? '').localeCompare(String(b.team ?? ''));
}
function localDay(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const d = Object.fromEntries(parts.map(({ type, value: v }) => [type, v]));
  return `${d.year}-${d.month}-${d.day}`;
}
function utcDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function pickColumn(row, names) {
  for (const n of names) {
    if (row && row[n] != null && row[n] !== '') return row[n];
  }
  return null;
}
function syntheticId(row, prefix) {
  const explicit = pickColumn(row, ['assinatura_id', 'id', 'deal_id', 'hubspot_deal_id']);
  if (explicit != null) return `${prefix}_${explicit}`;
  return `${prefix}_${createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16)}`;
}

function selectLatest(rows, predicate, valueKey) {
  let selected = null;
  for (const row of rows) {
    if (row[valueKey] == null || !predicate(row)) continue;
    if (!selected || Number(row.movimentacao_id) > Number(selected.movimentacao_id)) selected = row;
  }
  return selected?.[valueKey] ?? null;
}

function buildInstantGroups(history) {
  const groups = [];
  let current;
  for (const row of history) {
    const time = timestamp(row.data_movimentacao);
    if (!time) continue;
    const key = time.getTime();
    if (!current || current.key !== key) {
      current = { key, time, rows: [], etapaSame: null, etapaAny: null, pipelineSame: null, pipelineAny: null, ownerSame: null, ownerAny: null };
      groups.push(current);
    }
    current.rows.push(row);
  }
  let previousStage = null, previousPipeline = null, previousPipelineChange = null, previousOwner = null;
  for (const group of groups) {
    group.etapaSame = selectLatest(group.rows, (r) => ['CRIACAO_DEAL','MUDANCA_ETAPA'].includes(r.tipo_movimentacao), 'etapa_nova_id');
    group.etapaAny = selectLatest(group.rows, () => true, 'etapa_nova_id');
    group.pipelineSame = selectLatest(group.rows, (r) => r.tipo_movimentacao === 'MUDANCA_PIPELINE', 'pipeline_novo_id');
    group.pipelineAny = selectLatest(group.rows, () => true, 'pipeline_novo_id');
    group.ownerSame = selectLatest(group.rows, (r) => r.tipo_movimentacao === 'MUDANCA_RESPONSAVEL', 'responsavel_novo_id');
    group.ownerAny = selectLatest(group.rows, (r) => ['CRIACAO_DEAL','MUDANCA_RESPONSAVEL'].includes(r.tipo_movimentacao), 'responsavel_novo_id');
    group.previousStage = previousStage;
    group.previousPipeline = previousPipeline;
    group.previousPipelineChange = previousPipelineChange;
    group.previousOwner = previousOwner;
    if (group.etapaAny != null) previousStage = group.etapaAny;
    if (group.pipelineAny != null) previousPipeline = group.pipelineAny;
    if (group.pipelineSame != null) previousPipelineChange = group.pipelineSame;
    if (group.ownerAny != null) previousOwner = group.ownerAny;
  }
  return groups;
}

function buildAttributions(history, deal, collaborators, now) {
  const groups = buildInstantGroups(history);
  const groupByTime = new Map(groups.map((g) => [g.key, g]));
  const episodes = [];
  const episodeKeys = new Set();

  for (const row of history) {
    if (!['CRIACAO_DEAL','MUDANCA_RESPONSAVEL','MUDANCA_PIPELINE'].includes(row.tipo_movimentacao)) continue;
    if (row.tipo_movimentacao === 'MUDANCA_RESPONSAVEL' && String(row.responsavel_anterior_id ?? '') === String(row.responsavel_novo_id ?? '')) continue;
    if (row.tipo_movimentacao === 'MUDANCA_PIPELINE' && (String(row.pipeline_novo_id ?? '') !== PIPELINE_COMERCIAL || String(row.pipeline_anterior_id ?? '') === PIPELINE_COMERCIAL)) continue;
    const time = timestamp(row.data_movimentacao);
    const group = time && groupByTime.get(time.getTime());
    if (!group) continue;
    const collaboratorId = row.tipo_movimentacao === 'MUDANCA_PIPELINE' ? group.ownerSame ?? group.previousOwner : row.responsavel_novo_id;
    const collaborator = collaborators.get(String(collaboratorId ?? ''));
    const stageAtReceive = group.etapaSame ?? row.etapa_nova_id ?? group.previousStage;
    const pipelineAtReceive = group.pipelineSame ?? row.pipeline_novo_id ?? group.previousPipeline;
    if (!deal || String(pipelineAtReceive ?? '') !== PIPELINE_COMERCIAL || !['6649','6650'].includes(String(stageAtReceive ?? '')) || !collaborator || collaborator.departamento !== 'Comercial' || !['Assessor','Supervisor'].includes(collaborator.cargo)) continue;
    const key = `${deal.deal_id}|${time.toISOString()}|${collaboratorId}`;
    if (episodeKeys.has(key)) continue;
    episodeKeys.add(key);
    episodes.push({ episodioId: row.movimentacao_id, dealId: String(deal.deal_id), receivedAt: time, collaboratorId: String(collaboratorId), collaborator, team: collaborator.nome_equipe, cargo: collaborator.cargo, endAt: now, workedAt: null });
  }
  episodes.sort((a, b) => a.receivedAt - b.receivedAt || Number(a.episodioId) - Number(b.episodioId));

  const ownerChanges = history.filter((r) => r.tipo_movimentacao === 'MUDANCA_RESPONSAVEL');
  const pipelineExits = history.filter((r) => r.tipo_movimentacao === 'MUDANCA_PIPELINE' && String(r.pipeline_anterior_id ?? '') === PIPELINE_COMERCIAL && String(r.pipeline_novo_id ?? '') !== PIPELINE_COMERCIAL);
  const stageChanges = history.filter((r) => r.tipo_movimentacao === 'MUDANCA_ETAPA' && r.etapa_nova_id != null && String(r.etapa_nova_id) !== String(r.etapa_anterior_id ?? ''));

  for (const episode of episodes) {
    const nextOwnerChange = ownerChanges.find((r) =>
      String(r.responsavel_anterior_id ?? '') === episode.collaboratorId &&
      String(r.responsavel_novo_id ?? '') !== episode.collaboratorId &&
      (timestamp(r.data_movimentacao) > episode.receivedAt ||
       (timestamp(r.data_movimentacao)?.getTime() === episode.receivedAt.getTime() && Number(r.movimentacao_id) > Number(episode.episodioId))));
    const pipelineExit = pipelineExits.find((r) => timestamp(r.data_movimentacao) > episode.receivedAt);
    const endTimes = [now];
    if (nextOwnerChange) endTimes.push(timestamp(nextOwnerChange.data_movimentacao));
    if (pipelineExit) endTimes.push(timestamp(pipelineExit.data_movimentacao));
    episode.endAt = new Date(Math.min(...endTimes.map((v) => v.getTime())));
    const firstWork = stageChanges.find((r) => {
      const at = timestamp(r.data_movimentacao);
      return at > episode.receivedAt && at < episode.endAt && ['6650','6651','6652','6656'].includes(String(r.etapa_nova_id));
    });
    episode.workedAt = firstWork ? timestamp(firstWork.data_movimentacao) : null;
  }

  const attributionsByDeal = new Map();
  for (const episode of episodes) {
    const list = attributionsByDeal.get(episode.dealId) || [];
    list.push(episode);
    attributionsByDeal.set(episode.dealId, list);
  }
  function attributionAt(eventAt) {
    let selected = null;
    for (const episode of episodes) {
      if (episode.cargo !== 'Assessor' || eventAt < episode.receivedAt || eventAt >= episode.endAt) continue;
      if (!selected || episode.receivedAt > selected.receivedAt ||
          (episode.receivedAt.getTime() === selected.receivedAt.getTime() && Number(episode.episodioId) > Number(selected.episodioId))) {
        selected = episode;
      }
    }
    return selected;
  }
  return { episodes, groups, groupByTime, attributionsByDeal, attributionAt, stageChanges };
}

// ============================================================
// Carregamento — branch por mode
//   - producao: assinados/emitidos/ganhos/protocolados vêm das VIEWS
//   - outros modes: comportamento original (core.assinaturas + view por deal_id)
// ============================================================
async function loadRawEvents({ inicio, fim_exclusivo, produto, mode }) {
  const useViews = mode === 'producao';
  const bounds = periodBounds(inicio, fim_exclusivo);
  const dataInicio = inicio;
  const dataFimInclusive = new Date(Date.parse(`${fim_exclusivo}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  const client = await db.pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query("SELECT set_config('work_mem', $1, true)", [WORK_MEM]);
    const asOf = timestamp((await client.query('SELECT CURRENT_TIMESTAMP AS as_of')).rows[0].as_of);

    // Filtro de produto do usuário (usado nas views)
    const productVariantsUpper = produto
      ? (PRODUCT_VARIANTS[produto] || [produto]).map((p) => p.trim().toUpperCase())
      : null;
    const productFilterClause = productVariantsUpper ? 'AND UPPER(TRIM(produto)) = ANY($3::text[])' : '';
    const productFilterValues = productVariantsUpper ? [productVariantsUpper] : [];

    // IDs de produto (usado nas consultas a core.deals)
    const productIds = produto
      ? (await client.query(
          `SELECT produto_id::text FROM core.produtos
           WHERE LOWER(TRIM(nome_produto)) = ANY($1::text[])`,
          [(PRODUCT_VARIANTS[produto] || [produto]).map((name) => name.trim().toLowerCase())],
        )).rows.map((row) => row.produto_id)
      : null;
    if (produto && !productIds.length) {
      await client.query('COMMIT');
      return { asOf, events: [], deals: new Map(), episodesByDeal: new Map(), collaboratorNames: new Map() };
    }

    // ── Candidatos / deal / histórico (funnel) — sempre ─────
    const candidates = await client.query({
      text: `
        SELECT DISTINCT matches.deal_id::text AS deal_id
        FROM (
          SELECT h.deal_id FROM core.historico_movimentacoes h
          WHERE h.crm_origem = 'HUBSPOT'
            AND h.data_movimentacao >= $1 AND h.data_movimentacao < $2
            AND h.tipo_movimentacao IN ('CRIACAO_DEAL','MUDANCA_RESPONSAVEL','MUDANCA_PIPELINE','MUDANCA_ETAPA')
          UNION
          SELECT d.deal_id FROM core.deals d
          WHERE d.crm_origem = 'HUBSPOT' AND d.is_deleted IS NOT TRUE
            AND ($3::bigint[] IS NULL OR d.produto_id = ANY($3::bigint[]))
            AND ((d.data_ganho >= $1 AND d.data_ganho < $2) OR (d.data_protocolo >= $1 AND d.data_protocolo < $2))
          UNION
          SELECT legal.deal_id FROM core.view_app_juridico_auditoria legal
          JOIN core.deals d ON d.deal_id = legal.deal_id
          WHERE legal.data_ganho >= $1 AND legal.data_ganho < $2
            AND legal.etapa <> 'Venda perdida'
            AND ($3::bigint[] IS NULL OR d.produto_id = ANY($3::bigint[]))
          UNION
          SELECT COALESCE(s.deal_id, matched.deal_id)
          FROM core.assinaturas s
          LEFT JOIN core.deals matched
            ON matched.hubspot_deal_id = s.hubspot_deal_id
           AND matched.crm_origem = 'HUBSPOT' AND matched.is_deleted IS NOT TRUE
          WHERE ($3::bigint[] IS NULL OR s.produto_id = ANY($3::bigint[]))
            AND s.tipo_emissao = 'ORIGINAL' AND s.data_cancelamento IS NULL
            AND ((s.data_emissao >= $1 AND s.data_emissao < $2) OR (s.data_assinatura >= $1 AND s.data_assinatura < $2))
        ) matches
        JOIN core.deals d ON d.deal_id = matches.deal_id
        WHERE d.crm_origem = 'HUBSPOT'
          AND ($3::bigint[] IS NULL OR d.produto_id = ANY($3::bigint[]))
          AND d.is_deleted IS NOT TRUE`,
      values: [bounds.start, bounds.end, productIds],
      query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
    });
    const dealIds = candidates.rows.map((row) => row.deal_id);
    if (!dealIds.length) {
      await client.query('COMMIT');
      return { asOf, events: [], deals: new Map(), episodesByDeal: new Map(), collaboratorNames: new Map() };
    }

    const dealResult = await client.query({
      text: `
        SELECT d.deal_id::text, d.hubspot_deal_id, d.data_ganho, d.data_protocolo,
               d.motivo_perda, d.produto_id::text
        FROM core.deals d
        WHERE d.deal_id = ANY($1::bigint[])
          AND ($2::bigint[] IS NULL OR d.produto_id = ANY($2::bigint[]))
          AND d.crm_origem = 'HUBSPOT' AND d.is_deleted IS NOT TRUE`,
      values: [dealIds, productIds],
      query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
    });
    const historyResult = await client.query({
      text: `
        SELECT movimentacao_id::text, deal_id::text, data_movimentacao,
               tipo_movimentacao, crm_origem, etapa_anterior_id::text,
               etapa_nova_id::text, responsavel_anterior_id::text,
               responsavel_novo_id::text, pipeline_anterior_id::text,
               pipeline_novo_id::text
        FROM core.historico_movimentacoes
        WHERE deal_id = ANY($1::bigint[]) AND crm_origem = 'HUBSPOT'
          AND data_movimentacao <= CURRENT_TIMESTAMP
        ORDER BY deal_id, data_movimentacao, movimentacao_id`,
      values: [dealIds],
      query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
    });
    const collaboratorResult = await client.query(
      `SELECT colaborador_id::text, nome, nome_equipe, cargo, departamento FROM core.colaboradores`,
    );

    // ── Branch por mode ────────────────────────────────────
    let signatureResult = { rows: [] };
    let assinadosViewResult = { rows: [] };
    let emitidosViewResult = { rows: [] };
    let legalOutcomeResult = { rows: [] };

    if (useViews) {
      assinadosViewResult = await client.query({
        text: `
          SELECT * FROM core.view_assinados
          WHERE data_assinatura::date >= $1::date
            AND data_assinatura::date <= $2::date
            ${productFilterClause}
        `,
        values: [dataInicio, dataFimInclusive, ...productFilterValues],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
      emitidosViewResult = await client.query({
        text: `
          SELECT * FROM core.view_emitidos
          WHERE data_emissao::date >= $1::date
            AND data_emissao::date <= $2::date
            ${productFilterClause}
        `,
        values: [dataInicio, dataFimInclusive, ...productFilterValues],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
      legalOutcomeResult = await client.query({
        text: `
          SELECT deal_id::text AS deal_id, data_ganho, etapa,
                 responsavel_lead::text AS responsavel_lead_id
          FROM core.view_app_juridico_auditoria
          WHERE data_ganho::date >= $1::date
            AND data_ganho::date <= $2::date
            AND etapa <> 'Venda perdida'
            ${productFilterClause}
        `,
        values: [dataInicio, dataFimInclusive, ...productFilterValues],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
    } else {
      signatureResult = await client.query({
        text: `
          SELECT assinatura_id::text, deal_id::text, hubspot_deal_id,
                 data_emissao, data_assinatura, consultor_responsavel_assinatura_id::text,
                 status_assinatura
          FROM core.assinaturas
          WHERE ($3::bigint[] IS NULL OR produto_id = ANY($3::bigint[]))
            AND tipo_emissao = 'ORIGINAL' AND data_cancelamento IS NULL
            AND UPPER(TRIM(COALESCE(status_assinatura, ''))) = 'ASSINADO'
            AND (deal_id = ANY($1::bigint[]) OR hubspot_deal_id = ANY($2::text[]))`,
        values: [dealIds, [], productIds], // hubspotIds computado abaixo
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
      // (hubspotIds precisam ser preenchidos — segunda passada abaixo)
      const dealRowsForHubspot = dealResult.rows;
      const hsIds = [...new Set(dealRowsForHubspot.map((d) => d.hubspot_deal_id).filter(Boolean))];
      if (hsIds.length) {
        signatureResult = await client.query({
          text: `
            SELECT assinatura_id::text, deal_id::text, hubspot_deal_id,
                   data_emissao, data_assinatura, consultor_responsavel_assinatura_id::text,
                   status_assinatura
            FROM core.assinaturas
            WHERE ($3::bigint[] IS NULL OR produto_id = ANY($3::bigint[]))
              AND tipo_emissao = 'ORIGINAL' AND data_cancelamento IS NULL
              AND UPPER(TRIM(COALESCE(status_assinatura, ''))) = 'ASSINADO'
              AND (deal_id = ANY($1::bigint[]) OR hubspot_deal_id = ANY($2::text[]))`,
          values: [dealIds, hsIds, productIds],
          query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
        });
      }
      legalOutcomeResult = await client.query({
        text: `
          SELECT deal_id::text, data_ganho, etapa, responsavel_lead::text AS responsavel_lead_id
          FROM core.view_app_juridico_auditoria
          WHERE deal_id = ANY($1::bigint[])
            AND data_ganho IS NOT NULL AND etapa <> 'Venda perdida'`,
        values: [dealIds],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
    }

    const dealRows = dealResult.rows;
    const dealMap = new Map(dealRows.map((deal) => [deal.deal_id, deal]));
    const hubspotIds = [...new Set(dealRows.map((deal) => deal.hubspot_deal_id).filter(Boolean))];
    const aliasDealResult = hubspotIds.length
      ? await client.query({
          text: `
            SELECT d.deal_id::text, d.hubspot_deal_id FROM core.deals d
            WHERE d.hubspot_deal_id = ANY($1::text[])
              AND ($2::bigint[] IS NULL OR d.produto_id = ANY($2::bigint[]))
              AND d.crm_origem = 'HUBSPOT' AND d.is_deleted IS NOT TRUE`,
          values: [hubspotIds, productIds],
          query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
        })
      : { rows: [] };
    const aliasCounts = new Map();
    const dealIdByHubspot = new Map();
    for (const deal of aliasDealResult.rows) {
      aliasCounts.set(deal.hubspot_deal_id, (aliasCounts.get(deal.hubspot_deal_id) || 0) + 1);
      dealIdByHubspot.set(deal.hubspot_deal_id, deal.deal_id);
    }

    const collaboratorMap = new Map(collaboratorResult.rows.map((r) => [r.colaborador_id, r]));
    const historyByDeal = new Map();
    for (const row of historyResult.rows) {
      const list = historyByDeal.get(row.deal_id) || [];
      list.push(row);
      historyByDeal.set(row.deal_id, list);
    }

    const allEpisodes = new Map();
    const allEpisodeGroups = new Map();
    const events = [];
    const deals = new Map();

    // ── Eventos de funil (histórico) ───────────────────────
    for (const deal of dealRows) {
      deals.set(deal.deal_id, deal);
      const history = historyByDeal.get(deal.deal_id) || [];
      const attribution = buildAttributions(history, deal, collaboratorMap, asOf);
      allEpisodes.set(deal.deal_id, attribution);
      allEpisodeGroups.set(deal.deal_id, attribution.episodes);

      const creation = history
        .filter((r) => r.tipo_movimentacao === 'CRIACAO_DEAL')
        .map((r) => timestamp(r.data_movimentacao))
        .filter(Boolean)
        .sort((a, b) => a - b)[0];
      if (creation) {
        const assigned = attribution.attributionAt(creation);
        events.push({ dealId: deal.deal_id, occurredAt: creation, collaboratorId: assigned?.collaboratorId ?? null, team: assigned?.team ?? null, type: 'DEAL_CREATED' });
      }

      for (const episode of attribution.episodes) {
        if (episode.cargo !== 'Assessor') continue;
        events.push({ dealId: deal.deal_id, occurredAt: episode.receivedAt, collaboratorId: episode.collaboratorId, team: episode.team, type: 'RECEBIDO_ASSESSOR' });
        if (episode.workedAt) {
          events.push({ dealId: deal.deal_id, occurredAt: episode.workedAt, collaboratorId: episode.collaboratorId, team: episode.team, type: 'TRABALHADO_PROXY' });
        }
      }

      for (const row of attribution.stageChanges) {
        const eventAt = timestamp(row.data_movimentacao);
        const group = eventAt && attribution.groupByTime.get(eventAt.getTime());
        if (!group) continue;
        const pipelineAtEvent = group.pipelineSame ?? group.previousPipelineChange ?? PIPELINE_COMERCIAL;
        const type = STAGE_TYPES.get(String(row.etapa_nova_id));
        if (String(pipelineAtEvent) !== PIPELINE_COMERCIAL || !type) continue;
        const assigned = attribution.attributionAt(eventAt);
        events.push({ dealId: deal.deal_id, occurredAt: eventAt, collaboratorId: assigned?.collaboratorId ?? null, team: assigned?.team ?? null, type });
      }
    }

    // ── Eventos de assinatura/emissão ─────────────────────
    if (useViews) {
      // Fonte: views canônicas. Uma linha = um evento. Timestamp = data::T12Z
      // para que localDay (BRT) coincida com o ::date (UTC) aplicado na view.
      //
      // ⚠️ Consultores que não resolvem em core.colaboradores NÃO viram
      //    um bucket por ID órfão: o evento entra como não atribuído
      //    (collaboratorId = null). Sem isso, cada ID cru geraria uma
      //    linha "(SEM ATRIBUICAO) | (SEM EQUIPE)" na tabela.
      const pushFromView = (row, dateField, eventType) => {
        const isoDate = utcDate(row[dateField]);
        if (!isoDate) return;
        const occurredAt = new Date(`${isoDate}T12:00:00Z`);
        let dealId = pickColumn(row, ['deal_id']);
        if (dealId == null) {
          const hubspot = pickColumn(row, ['hubspot_deal_id']);
          if (hubspot != null && aliasCounts.get(String(hubspot)) === 1 && dealIdByHubspot.has(String(hubspot))) {
            dealId = dealIdByHubspot.get(String(hubspot));
          }
        }
        if (dealId != null) dealId = String(dealId);
        if (!dealId) dealId = syntheticId(row, `__view_${eventType}`);

        const rawCollabId = pickColumn(row, [
          'consultor_responsavel_assinatura_id', 'consultor_responsavel_id',
          'responsavel_assinatura_id', 'responsavel_id',
          'colaborador_id', 'assessor_id',
        ]);
        const consultant = rawCollabId != null ? collaboratorMap.get(String(rawCollabId)) : null;

        events.push({
          dealId,
          occurredAt,
          // Só usa o ID do colaborador se ele resolver em core.colaboradores.
          // Caso contrário, trata como não atribuído.
          collaboratorId: consultant?.colaborador_id ?? null,
          team: consultant?.nome_equipe ?? (row.equipe ?? row.nome_equipe ?? null),
          type: eventType,
        });
      };
      for (const row of assinadosViewResult.rows) pushFromView(row, 'data_assinatura', 'ASSINADO_ORIGINAL');
      for (const row of emitidosViewResult.rows) pushFromView(row, 'data_emissao', 'EMITIDO_ORIGINAL');
    } else {
      // Comportamento original: core.assinaturas com atribuição via histórico
      const signaturesByDeal = new Map();
      for (const signature of signatureResult.rows) {
        let dealId = signature.deal_id && dealMap.has(signature.deal_id) ? signature.deal_id : null;
        if (!dealId && signature.deal_id == null && signature.hubspot_deal_id) {
          const matching = dealRows.find((d) => d.hubspot_deal_id === signature.hubspot_deal_id);
          if (matching && aliasCounts.get(signature.hubspot_deal_id) === 1) dealId = matching.deal_id;
        }
        if (!dealId) continue;
        const list = signaturesByDeal.get(dealId) || [];
        list.push(signature);
        signaturesByDeal.set(dealId, list);
      }
      for (const [dealId, signatures] of signaturesByDeal) {
        const attribution = allEpisodes.get(dealId);
        if (!attribution) continue;
        const emissions = signatures
          .map((s) => ({ signature: s, at: timestamp(s.data_emissao) }))
          .filter((i) => i.at)
          .sort((a, b) => a.at - b.at || Number(a.signature.assinatura_id) - Number(b.signature.assinatura_id));
        const validSignatures = signatures
          .map((s) => ({ signature: s, emissionAt: timestamp(s.data_emissao), signedAt: timestamp(s.data_assinatura) }))
          .filter(({ emissionAt, signedAt }) => signedAt && (!emissionAt || emissionAt <= signedAt))
          .sort((a, b) => a.signedAt - b.signedAt || Number(a.signature.assinatura_id) - Number(b.signature.assinatura_id));

        for (const emission of emissions) {
          const assigned = attribution.attributionAt(emission.at);
          const consultant = collaboratorMap.get(String(emission.signature.consultor_responsavel_assinatura_id ?? ''));
          const hasConsultant = !!consultant?.colaborador_id;
          events.push({ dealId, occurredAt: emission.at, collaboratorId: hasConsultant ? consultant.colaborador_id : assigned?.collaboratorId ?? null, team: hasConsultant ? consultant.nome_equipe : assigned?.team ?? null, type: 'EMITIDO_ORIGINAL' });
        }
        for (const signed of validSignatures) {
          const consultant = collaboratorMap.get(String(signed.signature.consultor_responsavel_assinatura_id ?? ''));
          const assigned = attribution.attributionAt(signed.signedAt);
          const hasConsultant = !!consultant?.colaborador_id;
          events.push({ dealId, occurredAt: signed.signedAt, collaboratorId: hasConsultant ? consultant.colaborador_id : assigned?.collaboratorId ?? null, team: hasConsultant ? consultant.nome_equipe : assigned?.team ?? null, type: 'ASSINADO_ORIGINAL' });
        }
      }
    }

    // ── Ganho / Protocolado ───────────────────────────────
    //
    // ⚠️ Não usamos o `responsavel_lead_id` cru quando ele não resolve
    //    em core.colaboradores — o evento fica sem atribuição e cai no
    //    bucket único, em vez de gerar uma linha por ID órfão.
    for (const outcome of legalOutcomeResult.rows) {
      const occurredAt = timestamp(outcome.data_ganho);
      if (!occurredAt) continue;
      const dealId = String(outcome.deal_id);

      // Attribution: view's responsavel_lead → history attributionAt
      let collabId = null;
      let team = null;
      if (outcome.responsavel_lead_id) {
        const c = collaboratorMap.get(String(outcome.responsavel_lead_id));
        if (c) { collabId = c.colaborador_id; team = c.nome_equipe; }
      }
      if (!collabId) {
        const attribution = allEpisodes.get(dealId);
        if (attribution) {
          const assigned = attribution.attributionAt(occurredAt);
          collabId = assigned?.collaboratorId ?? null;
          team = assigned?.team ?? null;
        }
      }

      events.push({ dealId, occurredAt, collaboratorId: collabId, team, type: 'GANHO' });

      if (String(outcome.etapa ?? '').trim() === 'Protocolado') {
        events.push({ dealId, occurredAt, collaboratorId: collabId, team, type: 'PROTOCOLADO' });
      }
    }

    await client.query('COMMIT');
    const collaboratorNames = new Map(collaboratorResult.rows.map((r) => [r.colaborador_id, r.nome]));
    return { asOf, events, deals, episodesByDeal: allEpisodeGroups, collaboratorNames };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) { releaseError = e; }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

function rawCacheKey(params) {
  // mode entra na chave: safra e produção têm caches separados → os eventos
  // da produção (views) nunca contaminam a safra (core.assinaturas).
  return createHash('sha256')
    .update(`${params.inicio}|${params.fim_exclusivo}|${params.produto || ''}|${params.mode || ''}`)
    .digest('hex');
}

async function getRawEvents(params) {
  return cached(
    `inte-comerce-raw:${rawCacheKey(params)}`,
    () => loadRawEvents(params),
    { forceRefresh: params.refresh === true },
  );
}

// Escopo estrito — usado pelas métricas de FUNIL (recebidos, trabalhados,
// em contato, coleta, contrato, desqualificados).
function filterScope(assessor, params) {
  if (!assessor) return false;
  if (params.colaborador_ids_escopo != null && !params.colaborador_ids_escopo.map(String).includes(String(assessor.collaboratorId))) return false;
  if (params.colaborador_id != null && String(assessor.collaboratorId) !== String(params.colaborador_id)) return false;
  if (params.equipe && assessor.team !== params.equipe) return false;
  return true;
}

// Escopo broad — assinados / emitidos / ganhos / protocolados.
// Aplica APENAS os filtros explícitos do usuário (equipe, colaborador).
// Não aplica `scoped_all_ids` / `activeIds` / `include_unassigned`:
// as views /metrics/* não fazem esses filtros.
function filterScopeBroad(event, params) {
  if (!event) return false;
  if (params.colaborador_id != null) {
    if (event.collaboratorId == null) return false;
    if (String(event.collaboratorId) !== String(params.colaborador_id)) return false;
  }
  if (params.equipe) {
    if (event.team !== params.equipe) return false;
  }
  return true;
}

function emptyResult() {
  return {
    overview: { recebidos:0, trabalhados_proxy:0, em_contato_crm:0, assinados:0, ganhos:0, protocolados:0, desqualificados:0 },
    strategic: { recebidos:0, em_contato:0, assinados:0, assinados_que_ganharam:0, pct_recebidos_ate_assinados:null, pct_recebidos_ate_em_contato:null, pct_assinados_ate_ganhos:null, variacao_safra_sem_maturidade_equivalente:null },
    funnel: { recebidos:0, trabalhados:0, em_contato:0, coleta:0, contrato:0, emitidos:0, assinados:0, ganhos:0, protocolados:0, desqualificados_saida:0, coleta_sem_contato_observado:0 },
    daily: [], reasons: [], collaborators: [], teams: [],
  };
}

// ============================================================
// Modo PRODUÇÃO — usa filterScopeBroad em signatureMetrics + ganhos/protocolados
// ============================================================
function buildProductionComparisonResults(raw, params) {
  const monthBounds = periodBounds(params.production_month_inicio, params.production_month_fim);
  const selectedDayBounds = params.selected_day && params.selected_day_end
    ? periodBounds(params.selected_day, params.selected_day_end) : null;
  const activeIds = new Set((params.colaborador_ids_ativos || []).map(String));
  const metrics = {
    recebidos: 'RECEBIDO_ASSESSOR', trabalhados_proxy: 'TRABALHADO_PROXY', em_contato_crm: 'EM_CONTATO',
    coleta: 'COLETA', contrato: 'CONTRATO', emitidos: 'EMITIDO_ORIGINAL', assinados: 'ASSINADO_ORIGINAL',
    ganhos: 'GANHO', protocolados: 'PROTOCOLADO', desqualificados: 'DESQUALIFICADO',
  };
  const signatureMetrics = new Set(['emitidos','assinados']);
  const broadMetrics = new Set(['emitidos','assinados','ganhos','protocolados']);
  const metricKeys = Object.keys(metrics);
  const metricByType = new Map(Object.entries(metrics).map(([k, t]) => [t, k]));

  const monthDeals = new Map(metricKeys.map((k) => [k, new Set()]));
  const dayDeals = new Map(metricKeys.map((k) => [k, new Set()]));
  const monthSigCounts = new Map(metricKeys.map((k) => [k, 0]));
  const daySigCounts = new Map(metricKeys.map((k) => [k, 0]));

  const dailyByDay = new Map();
  const byCollaborator = new Map();
  const byTeam = new Map();
  const reasonCounts = new Map();
  const firstMetricAtByDeal = new Map();

  const bump = (map, key, delta = 1) => map.set(key, (map.get(key) || 0) + delta);

  for (const event of raw.events) {
    if (event.occurredAt < monthBounds.start || event.occurredAt >= monthBounds.end ||
        event.occurredAt > raw.asOf || !EVENT_TYPES.has(event.type)) continue;

    const metric = metricByType.get(event.type);
    if (!metric) continue;
    const isSignature = signatureMetrics.has(metric);
    const isBroad = broadMetrics.has(metric);
    const collaboratorId = event.collaboratorId == null ? null : String(event.collaboratorId);

    if (collaboratorId == null) {
      // Sem atribuição:
      //   - filtro explícito (equipe/colaborador) descarta
      //   - broad conta sempre; funil exige include_unassigned
      if (params.equipe != null || params.colaborador_id != null) continue;
      if (!isBroad && !params.include_unassigned) continue;
    } else if (isBroad) {
      if (!filterScopeBroad(event, params)) continue;
    } else {
      if (!filterScope(event, params)) continue;
      if (!activeIds.has(collaboratorId)) continue;
    }

    const day = localDay(event.occurredAt);
    const team = event.team || PLACEHOLDER_TEAM;
    const collaboratorKey = collaboratorId || PLACEHOLDER_COLLAB;
    const collabKey = `${collaboratorKey}|${team}`;

    let collab = byCollaborator.get(collabKey);
    if (!collab) {
      collab = {
        colaborador_id: collaboratorKey,
        colaborador: raw.collaboratorNames?.get(collaboratorKey) || PLACEHOLDER_COLLAB,
        equipe_atual: team,
        metricDeals: new Map(metricKeys.map((k) => [k, new Set()])),
        metricCounts: new Map(metricKeys.map((k) => [k, 0])),
        pct_olos_pendente: null, pct_hubspot_pendente: null,
      };
      byCollaborator.set(collabKey, collab);
    }
    let teamRow = byTeam.get(team);
    if (!teamRow) {
      teamRow = {
        equipe: team,
        metricDeals: new Map(metricKeys.map((k) => [k, new Set()])),
        metricCounts: new Map(metricKeys.map((k) => [k, 0])),
      };
      byTeam.set(team, teamRow);
    }
    let dayRow = dailyByDay.get(day);
    if (!dayRow) {
      dayRow = {
        dealIds: new Map(metricKeys.map((k) => [k, new Set()])),
        sigCounts: new Map(metricKeys.map((k) => [k, 0])),
      };
      dailyByDay.set(day, dayRow);
    }

    if (isSignature) {
      bump(monthSigCounts, metric);
      bump(dayRow.sigCounts, metric);
      bump(collab.metricCounts, metric);
      bump(teamRow.metricCounts, metric);
      if (selectedDayBounds && event.occurredAt >= selectedDayBounds.start && event.occurredAt < selectedDayBounds.end) {
        bump(daySigCounts, metric);
      }
    } else {
      monthDeals.get(metric).add(event.dealId);
      dayRow.dealIds.get(metric).add(event.dealId);
      collab.metricDeals.get(metric).add(event.dealId);
      teamRow.metricDeals.get(metric).add(event.dealId);
      if (selectedDayBounds && event.occurredAt >= selectedDayBounds.start && event.occurredAt < selectedDayBounds.end) {
        dayDeals.get(metric).add(event.dealId);
      }
    }

    const firstAt = firstMetricAtByDeal.get(event.dealId) || new Map();
    if (!firstAt.has(metric) || event.occurredAt < firstAt.get(metric)) firstAt.set(metric, event.occurredAt);
    firstMetricAtByDeal.set(event.dealId, firstAt);

    if (metric === 'desqualificados') {
      const reason = String(raw.deals.get(event.dealId)?.motivo_perda || '').trim() || '(SEM MOTIVO)';
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
  }

  const monthTotals = Object.fromEntries(metricKeys.map((k) => [
    k, signatureMetrics.has(k) ? monthSigCounts.get(k) : monthDeals.get(k).size,
  ]));
  const dayTotals = Object.fromEntries(metricKeys.map((k) => [
    k, signatureMetrics.has(k) ? daySigCounts.get(k) : dayDeals.get(k).size,
  ]));

  let signedAndGained = 0;
  for (const dates of firstMetricAtByDeal.values()) {
    if (dates.has('assinados') && dates.has('ganhos') && dates.get('ganhos') >= dates.get('assinados')) signedAndGained++;
  }

  const result = emptyResult();
  result.overview = {
    recebidos: monthTotals.recebidos, trabalhados_proxy: monthTotals.trabalhados_proxy,
    em_contato_crm: monthTotals.em_contato_crm, assinados: monthTotals.assinados,
    ganhos: monthTotals.ganhos, protocolados: monthTotals.protocolados, desqualificados: monthTotals.desqualificados,
  };
  result.funnel = {
    recebidos: monthTotals.recebidos, trabalhados: monthTotals.trabalhados_proxy,
    em_contato: monthTotals.em_contato_crm, coleta: monthTotals.coleta, contrato: monthTotals.contrato,
    emitidos: monthTotals.emitidos, assinados: monthTotals.assinados,
    ganhos: monthTotals.ganhos, protocolados: monthTotals.protocolados,
    desqualificados_saida: monthTotals.desqualificados, coleta_sem_contato_observado: 0,
  };
  result.strategic = {
    recebidos: monthTotals.recebidos, em_contato: monthTotals.em_contato_crm,
    assinados: monthTotals.assinados, assinados_que_ganharam: signedAndGained,
    pct_recebidos_ate_assinados: monthTotals.recebidos
      ? Number((100 * monthTotals.assinados / monthTotals.recebidos).toFixed(2))
      : null,
    pct_recebidos_ate_em_contato: monthTotals.recebidos
      ? Number((100 * monthTotals.em_contato_crm / monthTotals.recebidos).toFixed(2))
      : null,
    pct_assinados_ate_ganhos: monthTotals.assinados
      ? Number((100 * signedAndGained / monthTotals.assinados).toFixed(2)) : null,
    variacao_safra_sem_maturidade_equivalente: null,
  };

  result.daily = [];
  for (let day = new Date(monthBounds.start); day < monthBounds.end; day.setUTCDate(day.getUTCDate() + 1)) {
    const iso = day.toISOString().slice(0, 10);
    const row = dailyByDay.get(iso);
    const received = row?.dealIds.get('recebidos').size || 0;
    const signed = row?.sigCounts.get('assinados') || 0;
    result.daily.push({
      dia: iso, recebidos: received, assinados_ate_corte: signed,
      taxa_safra_pct: received ? Number((100 * signed / received).toFixed(2)) : null,
    });
  }

  result.reasons = [...reasonCounts].map(([motivo, n]) => ({ motivo, deals_desqualificados: n }))
    .sort((a, b) => b.deals_desqualificados - a.deals_desqualificados || a.motivo.localeCompare(b.motivo));

  const toCollabRow = (row) => ({
    colaborador_id: row.colaborador_id, colaborador: row.colaborador, equipe_atual: row.equipe_atual,
    recebimentos_deal_dia: row.metricDeals.get('recebidos').size,
    trabalhados: row.metricDeals.get('trabalhados_proxy').size,
    em_contato: row.metricDeals.get('em_contato_crm').size,
    coleta: row.metricDeals.get('coleta').size,
    assinados: row.metricCounts.get('assinados'),
    ganhos: row.metricDeals.get('ganhos').size,
    protocolados: row.metricDeals.get('protocolados').size,
    pct_olos_pendente: row.pct_olos_pendente, pct_hubspot_pendente: row.pct_hubspot_pendente,
  });

  // ⚠️ A tabela detalhada mostra APENAS entidades reais.
  //    Eventos sem atribuição continuam contando em overview/funnel/daily/strategic,
  //    mas não geram mais linhas "(SEM ATRIBUICAO) | (SEM EQUIPE)".
  result.collaborators = [...byCollaborator.values()]
    .map(toCollabRow)
    .filter((row) => row.colaborador !== PLACEHOLDER_COLLAB && row.colaborador_id !== PLACEHOLDER_COLLAB)
    .sort((a, b) => b.assinados - a.assinados || b.recebimentos_deal_dia - a.recebimentos_deal_dia);

  result.teams = [...byTeam.values()]
    .filter((row) => row.equipe !== PLACEHOLDER_TEAM)
    .map((row) => ({
      equipe: row.equipe,
      recebimentos_assessor_deal_dia: row.metricDeals.get('recebidos').size,
      deals_unicos_da_equipe: new Set(metricKeys.flatMap((k) => [...row.metricDeals.get(k)])).size,
      trabalhados: row.metricDeals.get('trabalhados_proxy').size,
      em_contato: row.metricDeals.get('em_contato_crm').size,
      coleta: row.metricDeals.get('coleta').size,
      assinados: row.metricCounts.get('assinados'),
      ganhos: row.metricDeals.get('ganhos').size,
      protocolados: row.metricDeals.get('protocolados').size,
    }))
    .sort((a, b) => b.assinados - a.assinados);

  result.productionComparison = {
    day: selectedDayBounds ? {
      recebidos: dayTotals.recebidos, assinados: dayTotals.assinados,
      ganhos: dayTotals.ganhos, protocolados: dayTotals.protocolados,
    } : null,
    month: {
      recebidos: monthTotals.recebidos, assinados: monthTotals.assinados,
      ganhos: monthTotals.ganhos, protocolados: monthTotals.protocolados,
    },
  };
  result.asOf = raw.asOf;
  return result;
}

// ============================================================
// Modo OPERACIONAL (inalterado)
// ============================================================
function filteredEvents(raw, params) {
  const { start, end } = periodBounds(params.inicio, params.fim_exclusivo);
  const activeIds = new Set((params.colaborador_ids_ativos || []).map(String));
  const events = raw.events.filter((event) =>
    event.occurredAt >= start && event.occurredAt <= raw.asOf &&
    (event.collaboratorId == null || activeIds.has(String(event.collaboratorId))) &&
    EVENT_TYPES.has(event.type));
  for (const [dealId, episodes] of raw.episodesByDeal || []) {
    const firstReceipt = episodes
      .filter((e) => e.receivedAt >= start && e.receivedAt < end)
      .sort((a, b) => a.receivedAt - b.receivedAt || Number(a.episodioId) - Number(b.episodioId))[0];
    if (!firstReceipt) continue;
    const firstAssessor = episodes
      .filter((e) => e.cargo === 'Assessor' && e.receivedAt >= firstReceipt.receivedAt &&
                     e.collaboratorId !== null && activeIds.has(String(e.collaboratorId)))
      .sort(compareAssessorEvents)[0];
    if (firstAssessor) {
      events.push({ dealId, occurredAt: firstReceipt.receivedAt, collaboratorId: firstAssessor.collaboratorId, team: firstAssessor.team, type: 'RECEBIDO_CORPORATIVO' });
    }
  }
  return events;
}

function buildOperationalResults(raw, params) {
  const events = filteredEvents(raw, params);
  const eventsByDeal = new Map();
  for (const e of events) {
    const list = eventsByDeal.get(e.dealId) || [];
    list.push(e);
    eventsByDeal.set(e.dealId, list);
  }
  const corporateReceipts = new Map();
  for (const e of events) {
    if (e.type !== 'RECEBIDO_CORPORATIVO') continue;
    const c = corporateReceipts.get(e.dealId);
    if (!c || e.occurredAt < c.occurredAt) corporateReceipts.set(e.dealId, e);
  }
  const firstAssessorByDeal = new Map();
  for (const e of events) {
    if (e.type !== 'RECEBIDO_ASSESSOR') continue;
    const c = firstAssessorByDeal.get(e.dealId);
    if (!c || compareAssessorEvents(
      { receivedAt: e.occurredAt, collaboratorId: e.collaboratorId, team: e.team },
      { receivedAt: c.occurredAt, collaboratorId: c.collaboratorId, team: c.team }) < 0) {
      firstAssessorByDeal.set(e.dealId, e);
    }
  }
  const cohort = [];
  for (const [dealId, receipt] of corporateReceipts) {
    if (receipt.occurredAt >= periodBounds(params.inicio, params.fim_exclusivo).end) continue;
    const assessor = firstAssessorByDeal.get(dealId);
    if (!filterScope(assessor, params)) continue;
    const dealEvents = eventsByDeal.get(dealId) || [];
    const firstOf = (t) => dealEvents.filter((e) => e.type === t).sort((a, b) => a.occurredAt - b.occurredAt)[0]?.occurredAt || null;
    const contacts = dealEvents.filter((e) => e.type === 'EM_CONTATO');
    const firstContact = contacts.map((e) => e.occurredAt).sort((a, b) => a - b)[0] || null;
    cohort.push({
      dealId, receiptAt: receipt.occurredAt, events: dealEvents,
      firstWorkAt: firstOf('TRABALHADO_PROXY'), contacted: contacts.length > 0,
      contactAtOrBeforeReceipt: contacts.some((e) => e.occurredAt <= receipt.occurredAt),
      firstContactAt: firstContact, firstDisqualifiedAt: firstOf('DESQUALIFICADO'),
      firstCollectionAt: firstOf('COLETA'), firstContractAt: firstOf('CONTRATO'),
      firstEmissionAt: firstOf('EMITIDO_ORIGINAL'), firstSignatureAt: firstOf('ASSINADO_ORIGINAL'),
      gainedAt: firstOf('GANHO'), protocolAt: firstOf('PROTOCOLADO'),
    });
  }
  const inRange = (v, r) => v != null && v >= r && v <= raw.asOf;
  const counts = {
    recebidos: cohort.length,
    trabalhados_proxy: cohort.filter((i) => inRange(i.firstWorkAt, i.receiptAt)).length,
    em_contato_crm: cohort.filter((i) => i.contacted && (i.contactAtOrBeforeReceipt || i.firstContactAt <= raw.asOf)).length,
    assinados: cohort.filter((i) => inRange(i.firstSignatureAt, i.receiptAt)).length,
    ganhos: cohort.filter((i) => inRange(i.gainedAt, i.receiptAt)).length,
    protocolados: cohort.filter((i) => inRange(i.protocolAt, i.receiptAt)).length,
    desqualificados: cohort.filter((i) => inRange(i.firstDisqualifiedAt, i.receiptAt)).length,
  };
  const contactCount = counts.em_contato_crm;
  const signedAndGained = cohort.filter((i) => inRange(i.firstSignatureAt, i.receiptAt) && i.gainedAt && i.gainedAt >= i.firstSignatureAt && i.gainedAt <= raw.asOf).length;
  const funnel = {
    recebidos: cohort.length, trabalhados: counts.trabalhados_proxy, em_contato: contactCount,
    coleta: cohort.filter((i) => inRange(i.firstCollectionAt, i.receiptAt)).length,
    contrato: cohort.filter((i) => inRange(i.firstContractAt, i.receiptAt)).length,
    emitidos: cohort.filter((i) => inRange(i.firstEmissionAt, i.receiptAt)).length,
    assinados: counts.assinados, ganhos: counts.ganhos, protocolados: counts.protocolados,
    desqualificados_saida: counts.desqualificados,
    coleta_sem_contato_observado: cohort.filter((i) => i.firstCollectionAt != null && !i.contacted).length,
  };
  const dailyMap = new Map();
  for (const i of cohort) {
    const day = localDay(i.receiptAt);
    const row = dailyMap.get(day) || { dia: day, recebidos: 0, assinados_ate_corte: 0 };
    row.recebidos++;
    if (inRange(i.firstSignatureAt, i.receiptAt)) row.assinados_ate_corte++;
    dailyMap.set(day, row);
  }
  const bounds = periodBounds(params.inicio, params.fim_exclusivo);
  const daily = [];
  for (let d = new Date(bounds.start); d < bounds.end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const row = dailyMap.get(iso);
    daily.push({ dia: iso, recebidos: row?.recebidos || 0, assinados_ate_corte: row?.assinados_ate_corte || 0,
      taxa_safra_pct: row?.recebidos ? Number((100 * row.assinados_ate_corte / row.recebidos).toFixed(2)) : null });
  }
  const reasonCounts = new Map();
  for (const i of cohort) {
    if (!inRange(i.firstDisqualifiedAt, i.receiptAt)) continue;
    const reason = String(raw.deals.get(i.dealId)?.motivo_perda || '').trim() || '(SEM MOTIVO)';
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  const reasons = [...reasonCounts].map(([motivo, n]) => ({ motivo, deals_desqualificados: n }))
    .sort((a, b) => b.deals_desqualificados - a.deals_desqualificados || a.motivo.localeCompare(b.motivo));
  const receivedAssessors = new Map();
  for (const e of events) {
    if (e.type !== 'RECEBIDO_ASSESSOR' || e.occurredAt >= bounds.end) continue;
    if (params.equipe && e.team !== params.equipe) continue;
    if (params.colaborador_id != null && String(e.collaboratorId) !== String(params.colaborador_id)) continue;
    if (params.colaborador_ids_escopo != null && !params.colaborador_ids_escopo.map(String).includes(String(e.collaboratorId))) continue;
    const day = localDay(e.occurredAt);
    const key = `${e.dealId}|${e.collaboratorId}|${day}`;
    const c = receivedAssessors.get(key);
    if (!c || e.occurredAt < c.receivedAt) receivedAssessors.set(key, { ...e, receivedAt: e.occurredAt });
  }
  const byCollaborator = new Map();
  const byTeam = new Map();
  for (const receipt of receivedAssessors.values()) {
    const marks = (eventsByDeal.get(receipt.dealId) || []).filter((e) => e.occurredAt >= receipt.receivedAt);
    const has = (t) => marks.some((e) => e.type === t);
    const team = receipt.team || PLACEHOLDER_TEAM;
    const collabKey = `${receipt.collaboratorId}|${team}`;
    const row = byCollaborator.get(collabKey) || {
      colaborador_id: receipt.collaboratorId, colaborador: PLACEHOLDER_COLLAB, equipe_atual: team,
      recebimentos_deal_dia: 0, trabalhados: 0, em_contato: 0, coletaDeals: new Set(),
      assinados: 0, ganhos: 0, protocoladoDeals: new Set(),
      pct_olos_pendente: null, pct_hubspot_pendente: null,
    };
    row.recebimentos_deal_dia++;
    if (has('TRABALHADO_PROXY')) row.trabalhados++;
    if (has('EM_CONTATO')) row.em_contato++;
    if (has('COLETA')) row.coletaDeals.add(receipt.dealId);
    if (has('ASSINADO_ORIGINAL')) row.assinados++;
    if (has('GANHO')) row.ganhos++;
    if (has('PROTOCOLADO')) row.protocoladoDeals.add(receipt.dealId);
    byCollaborator.set(collabKey, row);

    const teamRow = byTeam.get(team) || {
      equipe: team, recebimentos_assessor_deal_dia: 0, deals_unicos_da_equipe: new Set(),
      trabalhados: new Set(), em_contato: new Set(), coleta: new Set(),
      assinados: new Set(), ganhos: new Set(), protocolados: new Set(),
    };
    teamRow.recebimentos_assessor_deal_dia++;
    teamRow.deals_unicos_da_equipe.add(receipt.dealId);
    if (has('TRABALHADO_PROXY')) teamRow.trabalhados.add(receipt.dealId);
    if (has('EM_CONTATO')) teamRow.em_contato.add(receipt.dealId);
    if (has('COLETA')) teamRow.coleta.add(receipt.dealId);
    if (has('ASSINADO_ORIGINAL')) teamRow.assinados.add(receipt.dealId);
    if (has('GANHO')) teamRow.ganhos.add(receipt.dealId);
    if (has('PROTOCOLADO')) teamRow.protocolados.add(receipt.dealId);
    byTeam.set(team, teamRow);
  }
  for (const row of byCollaborator.values()) {
    row.colaborador_id = String(row.colaborador_id);
    row.colaborador = raw.collaboratorNames?.get(row.colaborador_id) || PLACEHOLDER_COLLAB;
    if (row.equipe_atual == null) row.equipe_atual = PLACEHOLDER_TEAM;
    row.coleta = row.coletaDeals.size;
    row.protocolados = row.protocoladoDeals.size;
    delete row.coletaDeals; delete row.protocoladoDeals;
  }
  const teams = [...byTeam.values()].map((row) => ({
    equipe: row.equipe, recebimentos_assessor_deal_dia: row.recebimentos_assessor_deal_dia,
    deals_unicos_da_equipe: row.deals_unicos_da_equipe.size,
    trabalhados: row.trabalhados.size, em_contato: row.em_contato.size,
    coleta: row.coleta.size, assinados: row.assinados.size,
    ganhos: row.ganhos.size, protocolados: row.protocolados.size,
  })).sort((a, b) => b.assinados - a.assinados);

  const result = emptyResult();
  result.overview = counts;
  result.strategic = {
    recebidos: cohort.length, em_contato: contactCount,
    assinados: counts.assinados, assinados_que_ganharam: signedAndGained,
    pct_recebidos_ate_assinados: cohort.length ? Number((100 * counts.assinados / cohort.length).toFixed(2)) : null,
    pct_recebidos_ate_em_contato: cohort.length ? Number((100 * contactCount / cohort.length).toFixed(2)) : null,
    pct_assinados_ate_ganhos: counts.assinados ? Number((100 * signedAndGained / counts.assinados).toFixed(2)) : null,
    variacao_safra_sem_maturidade_equivalente: null,
  };
  result.funnel = funnel; result.daily = daily; result.reasons = reasons;
  result.collaborators = [...byCollaborator.values()].sort((a, b) => b.assinados - a.assinados || b.recebimentos_deal_dia - a.recebimentos_deal_dia);
  result.teams = teams; result.asOf = raw.asOf;
  return result;
}

// ============================================================
// Modo SAFRA (inalterado em relação ao arquivo que você enviou)
// ============================================================
function buildComparisonResults(raw, params) {
  const cohortBounds = periodBounds(params.cohort_inicio, params.cohort_fim);
  const resultBounds = periodBounds(params.result_inicio, params.result_fim);
  const activeIds = new Set((params.colaborador_ids_ativos || []).map(String));
  const creationsByDeal = new Map();
  for (const event of raw.events) {
    if (event.type !== 'DEAL_CREATED' || event.occurredAt < cohortBounds.start ||
        event.occurredAt >= cohortBounds.end || event.occurredAt > raw.asOf) continue;
    const current = creationsByDeal.get(event.dealId);
    if (!current || event.occurredAt < current.createdAt) creationsByDeal.set(event.dealId, { createdAt: event.occurredAt });
  }
  const cohort = [];
  for (const [dealId, creation] of creationsByDeal) {
    const assessor = (raw.episodesByDeal.get(dealId) || [])
      .filter((e) => e.cargo === 'Assessor' && e.receivedAt >= creation.createdAt && activeIds.has(String(e.collaboratorId)))
      .sort(compareAssessorEvents)[0];
    if (assessor && !filterScope(assessor, params)) continue;
    if (!assessor && (!params.include_unassigned || params.equipe || params.colaborador_id != null)) continue;
    cohort.push({
      dealId, createdAt: creation.createdAt,
      collaboratorId: assessor ? String(assessor.collaboratorId) : PLACEHOLDER_COLLAB,
      collaborator: assessor ? raw.collaboratorNames?.get(String(assessor.collaboratorId)) || PLACEHOLDER_COLLAB : PLACEHOLDER_COLLAB,
      team: assessor?.team || PLACEHOLDER_TEAM,
    });
  }
  const cohortByDeal = new Map(cohort.map((i) => [i.dealId, i]));
  const eventsByDeal = new Map();
  for (const e of raw.events) {
    const item = cohortByDeal.get(e.dealId);
    if (!item || e.occurredAt < resultBounds.start || e.occurredAt >= resultBounds.end ||
        e.occurredAt < item.createdAt || e.occurredAt > raw.asOf) continue;
    const list = eventsByDeal.get(e.dealId) || [];
    list.push(e);
    eventsByDeal.set(e.dealId, list);
  }
  const metricTypes = {
    trabalhados_proxy: 'TRABALHADO_PROXY', em_contato_crm: 'EM_CONTATO',
    coleta: 'COLETA', contrato: 'CONTRATO', emitidos: 'EMITIDO_ORIGINAL',
    assinados: 'ASSINADO_ORIGINAL', ganhos: 'GANHO', protocolados: 'PROTOCOLADO',
    desqualificados: 'DESQUALIFICADO',
  };
  const dealsByMetric = new Map(Object.keys(metricTypes).map((k) => [k, new Set()]));
  const firstMetricAtByDeal = new Map();
  const signedByDay = new Map();
  for (const [dealId, events] of eventsByDeal) {
    const firstAt = new Map();
    for (const e of events) {
      const metric = Object.entries(metricTypes).find(([, t]) => t === e.type)?.[0];
      if (!metric) continue;
      dealsByMetric.get(metric).add(dealId);
      if (!firstAt.has(metric) || e.occurredAt < firstAt.get(metric)) firstAt.set(metric, e.occurredAt);
      if (e.type === 'ASSINADO_ORIGINAL') {
        const day = localDay(e.occurredAt);
        signedByDay.set(day, (signedByDay.get(day) || new Set()).add(dealId));
      }
    }
    firstMetricAtByDeal.set(dealId, firstAt);
  }
  const metricCount = (k) => dealsByMetric.get(k).size;

  let safraComparison = null;
  if (params.mode === 'safra') {
    const monthDealsByMetric = new Map(Object.keys(metricTypes).map((k) => [k, new Set()]));
    for (const e of raw.events) {
      const item = cohortByDeal.get(e.dealId);
      if (!item || e.occurredAt < cohortBounds.start || e.occurredAt >= cohortBounds.end ||
          e.occurredAt < item.createdAt || e.occurredAt > raw.asOf) continue;
      const metric = Object.entries(metricTypes).find(([, t]) => t === e.type)?.[0];
      if (metric) monthDealsByMetric.get(metric).add(e.dealId);
    }
    let dayComparison = null;
    if (params.selected_day && params.selected_day_end) {
      const dayBounds = periodBounds(params.selected_day, params.selected_day_end);
      const dayDealsByMetric = new Map(Object.keys(metricTypes).map((k) => [k, new Set()]));
      for (const e of raw.events) {
        const item = cohortByDeal.get(e.dealId);
        if (!item || e.occurredAt < dayBounds.start || e.occurredAt >= dayBounds.end ||
            e.occurredAt < item.createdAt || e.occurredAt > raw.asOf) continue;
        const metric = Object.entries(metricTypes).find(([, t]) => t === e.type)?.[0];
        if (metric) dayDealsByMetric.get(metric).add(e.dealId);
      }
      const dayCreated = cohort.filter((i) => i.createdAt >= dayBounds.start && i.createdAt < dayBounds.end).length;
      dayComparison = {
        recebidos: dayCreated,
        assinados: dayDealsByMetric.get('assinados').size,
        ganhos: dayDealsByMetric.get('ganhos').size,
        protocolados: dayDealsByMetric.get('protocolados').size,
      };
    }
    safraComparison = {
      day: dayComparison,
      month: {
        recebidos: cohort.length,
        assinados: monthDealsByMetric.get('assinados').size,
        ganhos: monthDealsByMetric.get('ganhos').size,
        protocolados: monthDealsByMetric.get('protocolados').size,
      },
    };
  }
  const signedAndGained = cohort.filter((i) => {
    const firstAt = firstMetricAtByDeal.get(i.dealId);
    return firstAt?.has('assinados') && firstAt.has('ganhos') && firstAt.get('ganhos') >= firstAt.get('assinados');
  }).length;
  const counts = {
    recebidos: cohort.length, trabalhados_proxy: metricCount('trabalhados_proxy'),
    em_contato_crm: metricCount('em_contato_crm'), assinados: metricCount('assinados'),
    ganhos: metricCount('ganhos'), protocolados: metricCount('protocolados'),
    desqualificados: metricCount('desqualificados'),
  };
  const funnel = {
    recebidos: cohort.length, trabalhados: counts.trabalhados_proxy, em_contato: counts.em_contato_crm,
    coleta: metricCount('coleta'), contrato: metricCount('contrato'), emitidos: metricCount('emitidos'),
    assinados: counts.assinados, ganhos: counts.ganhos, protocolados: counts.protocolados,
    desqualificados_saida: counts.desqualificados,
    coleta_sem_contato_observado: cohort.filter((i) => dealsByMetric.get('coleta').has(i.dealId) && !dealsByMetric.get('em_contato_crm').has(i.dealId)).length,
  };
  const dailyMap = new Map();
  for (const i of cohort) {
    const day = localDay(i.createdAt);
    const row = dailyMap.get(day) || { dia: day, recebidos: 0, assinados_ate_corte: 0 };
    row.recebidos++;
    dailyMap.set(day, row);
  }
  for (const [day, deals] of signedByDay) {
    const row = dailyMap.get(day) || { dia: day, recebidos: 0, assinados_ate_corte: 0 };
    row.assinados_ate_corte = deals.size;
    dailyMap.set(day, row);
  }
  const chartStart = cohortBounds.start < resultBounds.start ? cohortBounds.start : resultBounds.start;
  const chartEnd = cohortBounds.end > resultBounds.end ? cohortBounds.end : resultBounds.end;
  const daily = [];
  for (let d = new Date(chartStart); d < chartEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const row = dailyMap.get(iso);
    daily.push({ dia: iso, recebidos: row?.recebidos || 0, assinados_ate_corte: row?.assinados_ate_corte || 0,
      taxa_safra_pct: row?.recebidos ? Number((100 * row.assinados_ate_corte / row.recebidos).toFixed(2)) : null });
  }
  const reasonCounts = new Map();
  for (const dealId of dealsByMetric.get('desqualificados')) {
    const reason = String(raw.deals.get(dealId)?.motivo_perda || '').trim() || '(SEM MOTIVO)';
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  const reasons = [...reasonCounts].map(([motivo, n]) => ({ motivo, deals_desqualificados: n }))
    .sort((a, b) => b.deals_desqualificados - a.deals_desqualificados || a.motivo.localeCompare(b.motivo));

  const byCollaborator = new Map();
  const byTeam = new Map();
  for (const i of cohort) {
    const events = eventsByDeal.get(i.dealId) || [];
    const has = (t) => events.some((e) => e.type === t);
    const key = `${i.collaboratorId}|${i.team}`;
    const row = byCollaborator.get(key) || {
      colaborador_id: i.collaboratorId, colaborador: i.collaborator, equipe_atual: i.team,
      recebimentos_deal_dia: 0, trabalhados: 0, em_contato: 0, coleta: 0,
      assinados: 0, ganhos: 0, protocolados: 0,
      pct_olos_pendente: null, pct_hubspot_pendente: null,
    };
    row.recebimentos_deal_dia++;
    if (has('TRABALHADO_PROXY')) row.trabalhados++;
    if (has('EM_CONTATO')) row.em_contato++;
    if (has('COLETA')) row.coleta++;
    if (has('ASSINADO_ORIGINAL')) row.assinados++;
    if (has('GANHO')) row.ganhos++;
    if (has('PROTOCOLADO')) row.protocolados++;
    byCollaborator.set(key, row);

    const tr = byTeam.get(i.team) || {
      equipe: i.team, recebimentos_assessor_deal_dia: 0, deals_unicos_da_equipe: 0,
      trabalhados: 0, em_contato: 0, coleta: 0, assinados: 0, ganhos: 0, protocolados: 0,
    };
    tr.recebimentos_assessor_deal_dia++;
    tr.deals_unicos_da_equipe++;
    if (has('TRABALHADO_PROXY')) tr.trabalhados++;
    if (has('EM_CONTATO')) tr.em_contato++;
    if (has('COLETA')) tr.coleta++;
    if (has('ASSINADO_ORIGINAL')) tr.assinados++;
    if (has('GANHO')) tr.ganhos++;
    if (has('PROTOCOLADO')) tr.protocolados++;
    byTeam.set(i.team, tr);
  }

  const result = emptyResult();
  result.overview = counts;
  result.strategic = {
    recebidos: cohort.length, em_contato: counts.em_contato_crm,
    assinados: counts.assinados, assinados_que_ganharam: signedAndGained,
    pct_recebidos_ate_assinados: cohort.length ? Number((100 * counts.assinados / cohort.length).toFixed(2)) : null,
    pct_recebidos_ate_em_contato: cohort.length ? Number((100 * counts.em_contato_crm / cohort.length).toFixed(2)) : null,
    pct_assinados_ate_ganhos: counts.assinados ? Number((100 * signedAndGained / counts.assinados).toFixed(2)) : null,
    variacao_safra_sem_maturidade_equivalente: null,
  };
  result.funnel = funnel; result.daily = daily; result.reasons = reasons;
  result.collaborators = [...byCollaborator.values()].sort((a, b) => b.assinados - a.assinados || b.recebimentos_deal_dia - a.recebimentos_deal_dia);
  result.teams = [...byTeam.values()].sort((a, b) => b.assinados - a.assinados);
  result.asOf = raw.asOf;
  if (safraComparison) result.safraComparison = safraComparison;
  return result;
}

function buildResults(raw, params) {
  if (params.mode === 'producao') return buildProductionComparisonResults(raw, params);
  if (params.mode === 'operacional') return buildOperationalResults(raw, params);
  return buildComparisonResults(raw, params);
}

export async function getInteComerceRawAnalytics(params) {
  const raw = await getRawEvents(params);
  return buildResults(raw, params);
}

// ============================================================
// Summary — mantido
// ============================================================
const PRODUCTION_METRICS = [
  { key: 'criados', eventType: 'DEAL_CREATED' },
  { key: 'trabalhados', eventType: 'TRABALHADO_PROXY' },
  { key: 'em_contato', eventType: 'EM_CONTATO' },
  { key: 'coleta', eventType: 'COLETA' },
  { key: 'contrato', eventType: 'CONTRATO' },
  { key: 'emitidos', eventType: 'EMITIDO_ORIGINAL' },
  { key: 'assinados', eventType: 'ASSINADO_ORIGINAL' },
  { key: 'ganhos', eventType: 'GANHO' },
  { key: 'protocolados', eventType: 'PROTOCOLADO' },
  { key: 'desqualificados', eventType: 'DESQUALIFICADO' },
];
function inRange(v, s, e) { return v >= s && v < e; }
function matchesProductionScope(e, params, activeIds) {
  if (e.collaboratorId == null || (activeIds && !activeIds.has(String(e.collaboratorId)))) return false;
  return filterScope(e, params);
}
function countEvents(events, start, end, params, creationByDeal = null) {
  const dealsByMetric = new Map(PRODUCTION_METRICS.map(({ key }) => [key, new Set()]));
  const activeIds = params.colaborador_ids_ativos == null ? null : new Set(params.colaborador_ids_ativos.map(String));
  const metricByEventType = new Map(PRODUCTION_METRICS.map((m) => [m.eventType, m]));
  for (const e of events) {
    if (!inRange(e.occurredAt, start, end)) continue;
    if (!matchesProductionScope(e, params, activeIds)) continue;
    if (creationByDeal) {
      const createdAt = creationByDeal.get(e.dealId);
      if (!createdAt || createdAt < start || createdAt >= end || e.occurredAt < createdAt) continue;
    }
    const metric = metricByEventType.get(e.type);
    if (metric) dealsByMetric.get(metric.key).add(e.dealId);
  }
  return Object.fromEntries([...dealsByMetric].map(([k, d]) => [k, d.size]));
}
export async function getInteComercePeriodSummary(params) {
  const raw = await getRawEvents(params);
  const { start, end } = periodBounds(params.inicio, params.fim_exclusivo);
  const events = raw.events.filter((e) => e.occurredAt <= raw.asOf && EVENT_TYPES.has(e.type));
  if (params.mode === 'safra') {
    const dayTotals = params.selected_day && params.selected_day_end
      ? countEvents(events, periodBounds(params.selected_day, params.selected_day_end).start, periodBounds(params.selected_day, params.selected_day_end).end, params)
      : null;
    return { monthTotals: countEvents(events, start, end, params), dayTotals, selectedDay: params.selected_day || null, asOf: raw.asOf };
  }
  const creationByDeal = new Map();
  for (const e of events) {
    if (e.type !== 'DEAL_CREATED') continue;
    if (!creationByDeal.has(e.dealId) || e.occurredAt < creationByDeal.get(e.dealId)) creationByDeal.set(e.dealId, e.occurredAt);
  }
  if (params.mode === 'producao-3-meses') {
    const months = [];
    for (let ms = new Date(start); ms < end; ms.setUTCMonth(ms.getUTCMonth() + 1)) {
      const me = new Date(Date.UTC(ms.getUTCFullYear(), ms.getUTCMonth() + 1, 1, 3));
      months.push({
        month: localDay(new Date(ms.getTime() + 3 * 60 * 60 * 1000)).slice(0, 7),
        totals: countEvents(events, ms, me, params, creationByDeal),
      });
    }
    return { months, asOf: raw.asOf };
  }
  return { monthTotals: countEvents(events, start, end, params, creationByDeal), asOf: raw.asOf };
}