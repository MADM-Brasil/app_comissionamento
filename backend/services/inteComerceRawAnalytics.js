// backend/services/inteComerceRawAnalytics.js
import { createHash } from 'node:crypto';
import db from './db.js';
import { cached } from './inteComerceCache.js';

const STATEMENT_TIMEOUT_MS = 55_000;
const WORK_MEM = process.env.DB_ANALYTICS_WORK_MEM || '64MB';
const EVENT_TYPES = new Set([
  'DEAL_CREATED',
  'RECEBIDO_CORPORATIVO',
  'RECEBIDO_ASSESSOR',
  'TRABALHADO_PROXY',
  'EM_CONTATO',
  'COLETA',
  'CONTRATO',
  'EMITIDO_ORIGINAL',
  'ASSINADO_ORIGINAL',
  'GANHO',
  'PROTOCOLADO',
  'DESQUALIFICADO',
]);
const STAGE_TYPES = new Map([
  ['6650', 'EM_CONTATO'],
  ['6651', 'COLETA'],
  ['6652', 'CONTRATO'],
  ['6659', 'DESQUALIFICADO'],
]);
const PIPELINE_COMERCIAL = '572';
const PRODUCT_VARIANTS = {
  'Auxilio Acidente': ['Auxilio Acidente', 'Auxílio Acidente'],
  Quinquenio: ['Quinquenio', 'Quinquênio'],
  Concomitante: ['Concomitante'],
  'Fator K': ['Fator K'],
  'BPC/LOAS': ['BPC/LOAS', 'BPC / LOAS', 'BPC_LOAS'],
  'Isenção de IR Aposentadoria': [
    'Isenção de IR Aposentadoria',
    'Isencao de IR Aposentadoria',
  ],
};
const workMemMatch = /^(\d+)(kB|MB|GB)$/i.exec(WORK_MEM);
const workMemBytes = workMemMatch
  ? Number(workMemMatch[1]) * ({ kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 })[workMemMatch[2].toLowerCase()]
  : NaN;
if (!Number.isSafeInteger(workMemBytes) || workMemBytes < 4 * 1024 ** 2 || workMemBytes > 256 * 1024 ** 2) {
  throw new Error('DB_ANALYTICS_WORK_MEM deve estar entre 4MB e 256MB.');
}

function periodBounds(start, end) {
  return {
    start: new Date(`${start}T03:00:00.000Z`),
    end: new Date(`${end}T03:00:00.000Z`),
  };
}

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function compareAssessorEvents(a, b) {
  const timeDifference = a.receivedAt - b.receivedAt;
  if (timeDifference) return timeDifference;
  const idDifference = Number(a.collaboratorId) - Number(b.collaboratorId);
  if (idDifference) return idDifference;
  return String(a.team ?? '').localeCompare(String(b.team ?? ''));
}

function localDay(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const date = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${date.year}-${date.month}-${date.day}`;
}

function selectLatest(rows, predicate, valueKey) {
  let selected = null;
  for (const row of rows) {
    if (row[valueKey] == null || !predicate(row)) continue;
    if (!selected || Number(row.movimentacao_id) > Number(selected.movimentacao_id)) {
      selected = row;
    }
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
      current = {
        key,
        time,
        rows: [],
        etapaSame: null,
        etapaAny: null,
        pipelineSame: null,
        pipelineAny: null,
        ownerSame: null,
        ownerAny: null,
      };
      groups.push(current);
    }
    current.rows.push(row);
  }

  let previousStage = null;
  let previousPipeline = null;
  let previousPipelineChange = null;
  let previousOwner = null;
  for (const group of groups) {
    group.etapaSame = selectLatest(
      group.rows,
      (row) => ['CRIACAO_DEAL', 'MUDANCA_ETAPA'].includes(row.tipo_movimentacao),
      'etapa_nova_id',
    );
    group.etapaAny = selectLatest(group.rows, () => true, 'etapa_nova_id');
    group.pipelineSame = selectLatest(
      group.rows,
      (row) => row.tipo_movimentacao === 'MUDANCA_PIPELINE',
      'pipeline_novo_id',
    );
    group.pipelineAny = selectLatest(group.rows, () => true, 'pipeline_novo_id');
    group.ownerSame = selectLatest(
      group.rows,
      (row) => row.tipo_movimentacao === 'MUDANCA_RESPONSAVEL',
      'responsavel_novo_id',
    );
    group.ownerAny = selectLatest(
      group.rows,
      (row) => ['CRIACAO_DEAL', 'MUDANCA_RESPONSAVEL'].includes(row.tipo_movimentacao),
      'responsavel_novo_id',
    );
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
  const groupByTime = new Map(groups.map((group) => [group.key, group]));
  const episodes = [];
  const episodeKeys = new Set();

  for (const row of history) {
    if (!['CRIACAO_DEAL', 'MUDANCA_RESPONSAVEL', 'MUDANCA_PIPELINE'].includes(row.tipo_movimentacao)) continue;
    if (
      row.tipo_movimentacao === 'MUDANCA_RESPONSAVEL' &&
      String(row.responsavel_anterior_id ?? '') === String(row.responsavel_novo_id ?? '')
    ) continue;
    if (
      row.tipo_movimentacao === 'MUDANCA_PIPELINE' &&
      (String(row.pipeline_novo_id ?? '') !== PIPELINE_COMERCIAL ||
        String(row.pipeline_anterior_id ?? '') === PIPELINE_COMERCIAL)
    ) continue;

    const time = timestamp(row.data_movimentacao);
    const group = time && groupByTime.get(time.getTime());
    if (!group) continue;

    const collaboratorId = row.tipo_movimentacao === 'MUDANCA_PIPELINE'
      ? group.ownerSame ?? group.previousOwner
      : row.responsavel_novo_id;
    const collaborator = collaborators.get(String(collaboratorId ?? ''));
    const stageAtReceive = group.etapaSame ?? row.etapa_nova_id ?? group.previousStage;
    const pipelineAtReceive = group.pipelineSame ?? row.pipeline_novo_id ?? group.previousPipeline;
    if (
      !deal ||
      String(pipelineAtReceive ?? '') !== PIPELINE_COMERCIAL ||
      !['6649', '6650'].includes(String(stageAtReceive ?? '')) ||
      !collaborator ||
      collaborator.departamento !== 'Comercial' ||
      !['Assessor', 'Supervisor'].includes(collaborator.cargo)
    ) continue;

    const key = `${deal.deal_id}|${time.toISOString()}|${collaboratorId}`;
    if (episodeKeys.has(key)) continue;
    episodeKeys.add(key);
    episodes.push({
      episodioId: row.movimentacao_id,
      dealId: String(deal.deal_id),
      receivedAt: time,
      collaboratorId: String(collaboratorId),
      collaborator,
      team: collaborator.nome_equipe,
      cargo: collaborator.cargo,
      endAt: now,
      workedAt: null,
    });
  }

  episodes.sort((a, b) =>
    a.receivedAt - b.receivedAt ||
    Number(a.episodioId) - Number(b.episodioId),
  );

  const ownerChanges = history.filter((row) =>
    row.tipo_movimentacao === 'MUDANCA_RESPONSAVEL',
  );
  const pipelineExits = history.filter((row) =>
    row.tipo_movimentacao === 'MUDANCA_PIPELINE' &&
    String(row.pipeline_anterior_id ?? '') === PIPELINE_COMERCIAL &&
    String(row.pipeline_novo_id ?? '') !== PIPELINE_COMERCIAL,
  );
  const stageChanges = history.filter((row) =>
    row.tipo_movimentacao === 'MUDANCA_ETAPA' &&
    row.etapa_nova_id != null &&
    String(row.etapa_nova_id) !== String(row.etapa_anterior_id ?? ''),
  );

  for (const episode of episodes) {
    const nextOwnerChange = ownerChanges.find((row) =>
      String(row.responsavel_anterior_id ?? '') === episode.collaboratorId &&
      String(row.responsavel_novo_id ?? '') !== episode.collaboratorId &&
      (
        timestamp(row.data_movimentacao) > episode.receivedAt ||
        (
          timestamp(row.data_movimentacao)?.getTime() === episode.receivedAt.getTime() &&
          Number(row.movimentacao_id) > Number(episode.episodioId)
        )
      ),
    );
    const pipelineExit = pipelineExits.find((row) =>
      timestamp(row.data_movimentacao) > episode.receivedAt,
    );
    const endTimes = [now];
    if (nextOwnerChange) endTimes.push(timestamp(nextOwnerChange.data_movimentacao));
    if (pipelineExit) endTimes.push(timestamp(pipelineExit.data_movimentacao));
    episode.endAt = new Date(Math.min(...endTimes.map((value) => value.getTime())));

    const firstWork = stageChanges.find((row) => {
      const eventAt = timestamp(row.data_movimentacao);
      return (
        eventAt > episode.receivedAt &&
        eventAt < episode.endAt &&
        ['6650', '6651', '6652', '6656'].includes(String(row.etapa_nova_id))
      );
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
      if (
        episode.cargo !== 'Assessor' ||
        eventAt < episode.receivedAt ||
        eventAt >= episode.endAt
      ) continue;
      if (
        !selected ||
        episode.receivedAt > selected.receivedAt ||
        (
          episode.receivedAt.getTime() === selected.receivedAt.getTime() &&
          Number(episode.episodioId) > Number(selected.episodioId)
        )
      ) {
        selected = episode;
      }
    }
    return selected;
  }

  return { episodes, groups, groupByTime, attributionsByDeal, attributionAt, stageChanges };
}

async function loadRawEvents({ inicio, fim_exclusivo, produto }) {
  const bounds = periodBounds(inicio, fim_exclusivo);
  const client = await db.pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    await client.query("SELECT set_config('work_mem', $1, true)", [WORK_MEM]);
    const asOfResult = await client.query('SELECT CURRENT_TIMESTAMP AS as_of');
    const asOf = timestamp(asOfResult.rows[0].as_of);
    const productIds = produto
      ? (await client.query(
          `SELECT produto_id::text
           FROM core.produtos
           WHERE LOWER(TRIM(nome_produto)) = ANY($1::text[])`,
          [(PRODUCT_VARIANTS[produto] || [produto]).map((name) => name.trim().toLowerCase())],
        )).rows.map((row) => row.produto_id)
      : null;
    if (produto && !productIds.length) {
      await client.query('COMMIT');
      return {
        asOf,
        events: [],
        deals: new Map(),
        episodesByDeal: new Map(),
        collaboratorNames: new Map(),
      };
    }

    const candidates = await client.query({
      text:
      `SELECT DISTINCT matches.deal_id::text AS deal_id
       FROM (
         SELECT h.deal_id
         FROM core.historico_movimentacoes h
         WHERE h.crm_origem = 'HUBSPOT'
           AND h.data_movimentacao >= $1
           AND h.data_movimentacao < $2
           AND h.tipo_movimentacao IN (
             'CRIACAO_DEAL', 'MUDANCA_RESPONSAVEL', 'MUDANCA_PIPELINE', 'MUDANCA_ETAPA'
           )
         UNION
         SELECT d.deal_id
         FROM core.deals d
         WHERE d.crm_origem = 'HUBSPOT'
           AND d.is_deleted IS NOT TRUE
           AND (
             $3::bigint[] IS NULL
             OR d.produto_id = ANY($3::bigint[])
           )
           AND (
             (d.data_ganho >= $1 AND d.data_ganho < $2)
             OR (d.data_protocolo >= $1 AND d.data_protocolo < $2)
           )
         UNION
           SELECT legal.deal_id
           FROM core.view_app_juridico_auditoria legal
           JOIN core.deals d ON d.deal_id = legal.deal_id
           WHERE legal.data_ganho >= $1
             AND legal.data_ganho < $2
             AND legal.etapa <> 'Venda perdida'
             AND ($3::bigint[] IS NULL OR d.produto_id = ANY($3::bigint[]))
           UNION
         SELECT COALESCE(s.deal_id, matched.deal_id)
         FROM core.assinaturas s
         LEFT JOIN core.deals matched
           ON matched.hubspot_deal_id = s.hubspot_deal_id
          AND matched.crm_origem = 'HUBSPOT'
          AND matched.is_deleted IS NOT TRUE
         WHERE ($3::bigint[] IS NULL OR s.produto_id = ANY($3::bigint[]))
           AND s.tipo_emissao = 'ORIGINAL'
           AND s.data_cancelamento IS NULL
           AND (
             (s.data_emissao >= $1 AND s.data_emissao < $2)
             OR (s.data_assinatura >= $1 AND s.data_assinatura < $2)
           )
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
      return {
        asOf,
        events: [],
        deals: new Map(),
        episodesByDeal: new Map(),
        collaboratorNames: new Map(),
      };
    }

    // ⬇️ Removido o JOIN core.produtos: deals cujo produto foi
    // removido de core.produtos não devem sumir do cálculo.
    const dealResult = await client.query({
      text:
        `SELECT d.deal_id::text, d.hubspot_deal_id, d.data_ganho, d.data_protocolo,
                d.motivo_perda, d.produto_id::text
         FROM core.deals d
         WHERE d.deal_id = ANY($1::bigint[])
           AND (
             $2::bigint[] IS NULL
             OR d.produto_id = ANY($2::bigint[])
           )
           AND d.crm_origem = 'HUBSPOT'
           AND d.is_deleted IS NOT TRUE`,
      values: [dealIds, productIds],
      query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
    });
    const historyResult = await client.query({
      text:
        `SELECT movimentacao_id::text, deal_id::text, data_movimentacao,
                tipo_movimentacao, crm_origem, etapa_anterior_id::text,
                etapa_nova_id::text, responsavel_anterior_id::text,
                responsavel_novo_id::text, pipeline_anterior_id::text,
                pipeline_novo_id::text
         FROM core.historico_movimentacoes
           WHERE deal_id = ANY($1::bigint[])
             AND crm_origem = 'HUBSPOT'
           AND data_movimentacao <= CURRENT_TIMESTAMP
           ORDER BY deal_id, data_movimentacao, movimentacao_id`,
      values: [dealIds],
      query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
    });

    // ⬇️ GANHO e PROTOCOLADO: audit (fonte primária) + fallback em
    // core.deals para deals que não têm linha em
    // view_app_juridico_auditoria ou cuja auditoria está incompleta.
    const legalOutcomeResult = await client.query({
      text:
        `SELECT j.deal_id::text, j.data_ganho, j.etapa, d.data_protocolo
         FROM core.view_app_juridico_auditoria j
         JOIN core.deals d ON d.deal_id = j.deal_id
         WHERE j.deal_id = ANY($1::bigint[])
           AND j.data_ganho IS NOT NULL
           AND j.etapa <> 'Venda perdida'
         UNION ALL
         SELECT d.deal_id::text, d.data_ganho, NULL AS etapa, d.data_protocolo
         FROM core.deals d
         WHERE d.deal_id = ANY($1::bigint[])
           AND d.data_ganho IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM core.view_app_juridico_auditoria j
             WHERE j.deal_id = d.deal_id
               AND j.data_ganho IS NOT NULL
               AND j.etapa <> 'Venda perdida'
           )`,
      values: [dealIds],
      query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
    });
    const collaboratorResult = await client.query(
      `SELECT colaborador_id::text, nome, nome_equipe, cargo, departamento
       FROM core.colaboradores`,
    );

    const dealRows = dealResult.rows;
    const dealMap = new Map(dealRows.map((deal) => [deal.deal_id, deal]));
    const hubspotIds = [...new Set(dealRows.map((deal) => deal.hubspot_deal_id).filter(Boolean))];
    const aliasDealResult = hubspotIds.length
      ? await client.query({
          text:
          `SELECT d.deal_id::text, d.hubspot_deal_id
           FROM core.deals d
           WHERE d.hubspot_deal_id = ANY($1::text[])
             AND (
               $2::bigint[] IS NULL
               OR d.produto_id = ANY($2::bigint[])
             )
             AND d.crm_origem = 'HUBSPOT'
             AND d.is_deleted IS NOT TRUE`,
          values: [hubspotIds, productIds],
          query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
        })
      : { rows: [] };
    const aliasCounts = new Map();
    for (const deal of aliasDealResult.rows) {
      aliasCounts.set(deal.hubspot_deal_id, (aliasCounts.get(deal.hubspot_deal_id) || 0) + 1);
    }

    // ⬇️ FIX PRINCIPAL: $3 agora é o filtro de produto do usuário
    // (productIds, pode ser null), NÃO os produtos dos deals. Sem
    // filtro, aceitamos qualquer assinatura vinculada ao deal em
    // escopo, mesmo que assinatura.produto_id ≠ deal.produto_id.
    const signatureResult = await client.query({
      text:
      `SELECT assinatura_id::text, deal_id::text, hubspot_deal_id,
              data_emissao, data_assinatura, consultor_responsavel_assinatura_id::text,
              status_assinatura
       FROM core.assinaturas
       WHERE tipo_emissao = 'ORIGINAL'
         AND data_cancelamento IS NULL
         AND UPPER(TRIM(COALESCE(status_assinatura, ''))) = 'ASSINADO'
         AND (
           $3::bigint[] IS NULL OR produto_id = ANY($3::bigint[])
         )
         AND (
           deal_id = ANY($1::bigint[])
           OR hubspot_deal_id = ANY($2::text[])
         )`,
      values: [dealIds, hubspotIds, productIds],
      query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
    });

    const collaboratorMap = new Map(
      collaboratorResult.rows.map((row) => [row.colaborador_id, row]),
    );
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

    for (const deal of dealRows) {
      deals.set(deal.deal_id, deal);
      const history = historyByDeal.get(deal.deal_id) || [];
      const attribution = buildAttributions(history, deal, collaboratorMap, asOf);
      allEpisodes.set(deal.deal_id, attribution);
      allEpisodeGroups.set(deal.deal_id, attribution.episodes);

      const creation = history
        .filter((row) => row.tipo_movimentacao === 'CRIACAO_DEAL')
        .map((row) => timestamp(row.data_movimentacao))
        .filter(Boolean)
        .sort((a, b) => a - b)[0];
      if (creation) {
        const assigned = attribution.attributionAt(creation);
        events.push({
          dealId: deal.deal_id,
          occurredAt: creation,
          collaboratorId: assigned?.collaboratorId ?? null,
          team: assigned?.team ?? null,
          type: 'DEAL_CREATED',
        });
      }

      for (const episode of attribution.episodes) {
        if (episode.cargo === 'Assessor') {
          events.push({
            dealId: deal.deal_id,
            occurredAt: episode.receivedAt,
            collaboratorId: episode.collaboratorId,
            team: episode.team,
            type: 'RECEBIDO_ASSESSOR',
          });
          if (episode.workedAt) {
            events.push({
              dealId: deal.deal_id,
              occurredAt: episode.workedAt,
              collaboratorId: episode.collaboratorId,
              team: episode.team,
              type: 'TRABALHADO_PROXY',
            });
          }
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
        events.push({
          dealId: deal.deal_id,
          occurredAt: eventAt,
          collaboratorId: assigned?.collaboratorId ?? null,
          team: assigned?.team ?? null,
          type,
        });
      }
    }

    // GANHO sempre; PROTOCOLADO quando etapa (case-insensitive) for
    // "Protocolado" OU quando deals.data_protocolo existir.
    for (const outcome of legalOutcomeResult.rows) {
      const occurredAt = timestamp(outcome.data_ganho);
      const attribution = allEpisodes.get(outcome.deal_id);
      if (!occurredAt || !attribution) continue;
      const assigned = attribution.attributionAt(occurredAt);
      events.push({
        dealId: outcome.deal_id,
        occurredAt,
        collaboratorId: assigned?.collaboratorId ?? null,
        team: assigned?.team ?? null,
        type: 'GANHO',
      });

      const protocoladoPorEtapa =
        outcome.etapa != null &&
        String(outcome.etapa).trim().toLowerCase() === 'protocolado';
      const protocoladoPorData = outcome.data_protocolo != null;
      if (protocoladoPorEtapa || protocoladoPorData) {
        const protocolAt = protocoladoPorData
          ? timestamp(outcome.data_protocolo)
          : occurredAt;
        if (protocolAt) {
          events.push({
            dealId: outcome.deal_id,
            occurredAt: protocolAt,
            collaboratorId: assigned?.collaboratorId ?? null,
            team: assigned?.team ?? null,
            type: 'PROTOCOLADO',
          });
        }
      }
    }

    const signaturesByDeal = new Map();
    for (const signature of signatureResult.rows) {
      let dealId = signature.deal_id && dealMap.has(signature.deal_id)
        ? signature.deal_id
        : null;
      if (!dealId && signature.deal_id == null && signature.hubspot_deal_id) {
        const matchingDeal = dealRows.find(
          (deal) => deal.hubspot_deal_id === signature.hubspot_deal_id,
        );
        if (
          matchingDeal &&
          aliasCounts.get(signature.hubspot_deal_id) === 1
        ) {
          dealId = matchingDeal.deal_id;
        }
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
        .map((signature) => ({ signature, at: timestamp(signature.data_emissao) }))
        .filter((item) => item.at)
        .sort((a, b) => a.at - b.at || Number(a.signature.assinatura_id) - Number(b.signature.assinatura_id));

      // ⬇️ Removido o filtro `emissionAt <= signedAt`: assinaturas com
      // data de emissão digitada errada ainda devem contar como
      // assinadas (é o que o /metrics/assinados faz).
      const validSignatures = signatures
        .map((signature) => ({
          signature,
          emissionAt: timestamp(signature.data_emissao),
          signedAt: timestamp(signature.data_assinatura),
        }))
        .filter(({ signedAt }) => !!signedAt)
        .sort((a, b) =>
          a.signedAt - b.signedAt ||
          Number(a.signature.assinatura_id) - Number(b.signature.assinatura_id),
        );

      for (const emission of emissions) {
        const assigned = attribution.attributionAt(emission.at);
        const consultant = collaboratorMap.get(
          String(emission.signature.consultor_responsavel_assinatura_id ?? ''),
        );
        const hasConsultant = !!consultant?.colaborador_id;
        events.push({
          dealId,
          occurredAt: emission.at,
          collaboratorId: hasConsultant
            ? consultant.colaborador_id
            : assigned?.collaboratorId ?? null,
          team: hasConsultant
            ? consultant.nome_equipe
            : assigned?.team ?? null,
          type: 'EMITIDO_ORIGINAL',
        });
      }
      for (const signed of validSignatures) {
        const consultant = collaboratorMap.get(
          String(signed.signature.consultor_responsavel_assinatura_id ?? ''),
        );
        const assigned = attribution.attributionAt(signed.signedAt);
        const hasConsultant = !!consultant?.colaborador_id;
        events.push({
          dealId,
          occurredAt: signed.signedAt,
          collaboratorId: hasConsultant
            ? consultant.colaborador_id
            : assigned?.collaboratorId ?? null,
          team: hasConsultant
            ? consultant.nome_equipe
            : assigned?.team ?? null,
          type: 'ASSINADO_ORIGINAL',
        });
      }
    }

    await client.query('COMMIT');
    const collaboratorNames = new Map(
      collaboratorResult.rows.map((row) => [row.colaborador_id, row.nome]),
    );
    return { asOf, events, deals, episodesByDeal: allEpisodeGroups, collaboratorNames };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError;
      console.error('[inte-comerce-raw] Falha ao reverter extração:', rollbackError.message);
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

function rawCacheKey(params) {
  return createHash('sha256')
    .update(`${params.inicio}|${params.fim_exclusivo}|${params.produto || ''}`)
    .digest('hex');
}

async function getRawEvents(params) {
  return cached(
    `inte-comerce-raw:${rawCacheKey(params)}`,
    () => loadRawEvents(params),
    { forceRefresh: params.refresh === true },
  );
}

function filteredEvents(raw, params) {
  const { start, end } = periodBounds(params.inicio, params.fim_exclusivo);
  const activeIds = new Set((params.colaborador_ids_ativos || []).map(String));
  const events = raw.events.filter((event) =>
    event.occurredAt >= start &&
    event.occurredAt <= raw.asOf &&
    (event.collaboratorId == null || activeIds.has(String(event.collaboratorId))) &&
    EVENT_TYPES.has(event.type),
  );
  for (const [dealId, episodes] of raw.episodesByDeal || []) {
    const firstReceipt = episodes
      .filter((episode) => episode.receivedAt >= start && episode.receivedAt < end)
      .sort((a, b) =>
        a.receivedAt - b.receivedAt ||
        Number(a.episodioId) - Number(b.episodioId),
      )[0];
    if (!firstReceipt) continue;
    const firstAssessor = episodes
      .filter((episode) =>
        episode.cargo === 'Assessor' &&
        episode.receivedAt >= firstReceipt.receivedAt &&
        episode.collaboratorId !== null &&
        activeIds.has(String(episode.collaboratorId)),
      )
      .sort(compareAssessorEvents)[0];
    if (firstAssessor) {
      events.push({
        dealId,
        occurredAt: firstReceipt.receivedAt,
        collaboratorId: firstAssessor.collaboratorId,
        team: firstAssessor.team,
        type: 'RECEBIDO_CORPORATIVO',
      });
    }
  }
  return events;
}

function filterScope(assessor, params) {
  if (!assessor) return false;
  if (
    params.colaborador_ids_escopo != null &&
    !params.colaborador_ids_escopo.map(String).includes(String(assessor.collaboratorId))
  ) return false;
  if (
    params.colaborador_id != null &&
    String(assessor.collaboratorId) !== String(params.colaborador_id)
  ) return false;
  if (params.equipe && assessor.team !== params.equipe) return false;
  return true;
}

function emptyResult() {
  return {
    overview: {
      recebidos: 0,
      trabalhados_proxy: 0,
      em_contato_crm: 0,
      assinados: 0,
      ganhos: 0,
      protocolados: 0,
      desqualificados: 0,
    },
    strategic: {
      recebidos: 0,
      em_contato: 0,
      assinados: 0,
      assinados_que_ganharam: 0,
      pct_recebidos_ate_assinados: null,
      pct_recebidos_ate_em_contato: null,
      pct_assinados_ate_ganhos: null,
      variacao_safra_sem_maturidade_equivalente: null,
    },
    funnel: {
      recebidos: 0,
      trabalhados: 0,
      em_contato: 0,
      coleta: 0,
      contrato: 0,
      emitidos: 0,
      assinados: 0,
      ganhos: 0,
      protocolados: 0,
      desqualificados_saida: 0,
      coleta_sem_contato_observado: 0,
    },
    daily: [],
    reasons: [],
    collaborators: [],
    teams: [],
  };
}

function buildProductionComparisonResults(raw, params) {
  const monthBounds = periodBounds(
    params.production_month_inicio,
    params.production_month_fim,
  );
  const selectedDayBounds = params.selected_day && params.selected_day_end
    ? periodBounds(params.selected_day, params.selected_day_end)
    : null;
  const activeIds = new Set((params.colaborador_ids_ativos || []).map(String));
  const metrics = {
    recebidos: 'RECEBIDO_ASSESSOR',
    trabalhados_proxy: 'TRABALHADO_PROXY',
    em_contato_crm: 'EM_CONTATO',
    coleta: 'COLETA',
    contrato: 'CONTRATO',
    emitidos: 'EMITIDO_ORIGINAL',
    assinados: 'ASSINADO_ORIGINAL',
    ganhos: 'GANHO',
    protocolados: 'PROTOCOLADO',
    desqualificados: 'DESQUALIFICADO',
  };
  // Métricas que representam LINHAS (assinaturas/emissões) e não
  // deals únicos — alinhamento com /metrics/assinados e /metrics/emitidos.
  const signatureMetrics = new Set(['emitidos', 'assinados']);
  const metricKeys = Object.keys(metrics);
  const metricByType = new Map(Object.entries(metrics).map(([key, type]) => [type, key]));

  const monthDeals = new Map(metricKeys.map((key) => [key, new Set()]));
  const dayDeals = new Map(metricKeys.map((key) => [key, new Set()]));
  const monthSigCounts = new Map(metricKeys.map((key) => [key, 0]));
  const daySigCounts = new Map(metricKeys.map((key) => [key, 0]));

  const dailyByDay = new Map();
  const byCollaborator = new Map();
  const byTeam = new Map();
  const reasonCounts = new Map();
  const firstMetricAtByDeal = new Map();

  const bump = (map, key, delta = 1) => map.set(key, (map.get(key) || 0) + delta);

  for (const event of raw.events) {
    if (
      event.occurredAt < monthBounds.start ||
      event.occurredAt >= monthBounds.end ||
      event.occurredAt > raw.asOf ||
      !EVENT_TYPES.has(event.type)
    ) continue;

    const metric = metricByType.get(event.type);
    if (!metric) continue;
    const isSignature = signatureMetrics.has(metric);

    const collaboratorId = event.collaboratorId == null ? null : String(event.collaboratorId);
    if (collaboratorId == null) {
      if (!params.include_unassigned || params.equipe || params.colaborador_id != null) continue;
    } else {
      const inScope = filterScope(event, params);
      if (!inScope) continue;
      // ⬇️ Assinados/Emitidos: não exigem que o consultor esteja
      // ativo. O /metrics correspondente não faz esse filtro, e
      // assinaturas de consultores hoje inativos ainda existem.
      if (!isSignature && !activeIds.has(collaboratorId)) continue;
    }

    const day = localDay(event.occurredAt);
    const team = event.team || '(SEM EQUIPE)';
    const collaboratorKey = collaboratorId || '(SEM ATRIBUICAO)';
    const collabKey = `${collaboratorKey}|${team}`;
    let collab = byCollaborator.get(collabKey);
    if (!collab) {
      collab = {
        colaborador_id: collaboratorKey,
        colaborador: raw.collaboratorNames?.get(collaboratorKey) || '(SEM ATRIBUICAO)',
        equipe_atual: team,
        metricDeals: new Map(metricKeys.map((key) => [key, new Set()])),
        metricCounts: new Map(metricKeys.map((key) => [key, 0])),
        pct_olos_pendente: null,
        pct_hubspot_pendente: null,
      };
      byCollaborator.set(collabKey, collab);
    }
    let teamRow = byTeam.get(team);
    if (!teamRow) {
      teamRow = {
        equipe: team,
        metricDeals: new Map(metricKeys.map((key) => [key, new Set()])),
        metricCounts: new Map(metricKeys.map((key) => [key, 0])),
      };
      byTeam.set(team, teamRow);
    }
    let dayRow = dailyByDay.get(day);
    if (!dayRow) {
      dayRow = {
        dealIds: new Map(metricKeys.map((key) => [key, new Set()])),
        sigCounts: new Map(metricKeys.map((key) => [key, 0])),
      };
      dailyByDay.set(day, dayRow);
    }

    if (isSignature) {
      bump(monthSigCounts, metric);
      bump(dayRow.sigCounts, metric);
      bump(collab.metricCounts, metric);
      bump(teamRow.metricCounts, metric);
      if (
        selectedDayBounds &&
        event.occurredAt >= selectedDayBounds.start &&
        event.occurredAt < selectedDayBounds.end
      ) {
        bump(daySigCounts, metric);
      }
    } else {
      monthDeals.get(metric).add(event.dealId);
      dayRow.dealIds.get(metric).add(event.dealId);
      collab.metricDeals.get(metric).add(event.dealId);
      teamRow.metricDeals.get(metric).add(event.dealId);
      if (
        selectedDayBounds &&
        event.occurredAt >= selectedDayBounds.start &&
        event.occurredAt < selectedDayBounds.end
      ) {
        dayDeals.get(metric).add(event.dealId);
      }
    }

    const firstAt = firstMetricAtByDeal.get(event.dealId) || new Map();
    if (!firstAt.has(metric) || event.occurredAt < firstAt.get(metric)) {
      firstAt.set(metric, event.occurredAt);
    }
    firstMetricAtByDeal.set(event.dealId, firstAt);

    if (metric === 'desqualificados') {
      const reason = String(raw.deals.get(event.dealId)?.motivo_perda || '').trim() || '(SEM MOTIVO)';
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }
  }

  const monthTotals = Object.fromEntries(metricKeys.map((key) => [
    key,
    signatureMetrics.has(key) ? monthSigCounts.get(key) : monthDeals.get(key).size,
  ]));
  const dayTotals = Object.fromEntries(metricKeys.map((key) => [
    key,
    signatureMetrics.has(key) ? daySigCounts.get(key) : dayDeals.get(key).size,
  ]));

  let signedAndGained = 0;
  for (const dates of firstMetricAtByDeal.values()) {
    if (
      dates.has('assinados') &&
      dates.has('ganhos') &&
      dates.get('ganhos') >= dates.get('assinados')
    ) {
      signedAndGained++;
    }
  }

  const result = emptyResult();
  result.overview = {
    recebidos: monthTotals.recebidos,
    trabalhados_proxy: monthTotals.trabalhados_proxy,
    em_contato_crm: monthTotals.em_contato_crm,
    assinados: monthTotals.assinados,
    ganhos: monthTotals.ganhos,
    protocolados: monthTotals.protocolados,
    desqualificados: monthTotals.desqualificados,
  };
  result.funnel = {
    recebidos: monthTotals.recebidos,
    trabalhados: monthTotals.trabalhados_proxy,
    em_contato: monthTotals.em_contato_crm,
    coleta: monthTotals.coleta,
    contrato: monthTotals.contrato,
    emitidos: monthTotals.emitidos,
    assinados: monthTotals.assinados,
    ganhos: monthTotals.ganhos,
    protocolados: monthTotals.protocolados,
    desqualificados_saida: monthTotals.desqualificados,
    coleta_sem_contato_observado: 0,
  };
  result.strategic = {
    recebidos: monthTotals.recebidos,
    em_contato: monthTotals.em_contato_crm,
    assinados: monthTotals.assinados,
    assinados_que_ganharam: signedAndGained,
    pct_recebidos_ate_assinados: null,
    pct_recebidos_ate_em_contato: null,
    pct_assinados_ate_ganhos: monthTotals.assinados
      ? Number((100 * signedAndGained / monthTotals.assinados).toFixed(2))
      : null,
    variacao_safra_sem_maturidade_equivalente: null,
  };

  result.daily = [];
  for (let day = new Date(monthBounds.start); day < monthBounds.end; day.setUTCDate(day.getUTCDate() + 1)) {
    const isoDay = day.toISOString().slice(0, 10);
    const row = dailyByDay.get(isoDay);
    const received = row?.dealIds.get('recebidos').size || 0;
    const signed = row?.sigCounts.get('assinados') || 0;
    result.daily.push({
      dia: isoDay,
      recebidos: received,
      assinados_ate_corte: signed,
      taxa_safra_pct: received ? Number((100 * signed / received).toFixed(2)) : null,
    });
  }

  result.reasons = [...reasonCounts].map(([motivo, deals_desqualificados]) => ({
    motivo,
    deals_desqualificados,
  })).sort((a, b) =>
    b.deals_desqualificados - a.deals_desqualificados ||
    a.motivo.localeCompare(b.motivo),
  );

  const toCollaboratorRow = (row) => ({
    colaborador_id: row.colaborador_id,
    colaborador: row.colaborador,
    equipe_atual: row.equipe_atual,
    recebimentos_deal_dia: row.metricDeals.get('recebidos').size,
    trabalhados: row.metricDeals.get('trabalhados_proxy').size,
    em_contato: row.metricDeals.get('em_contato_crm').size,
    coleta: row.metricDeals.get('coleta').size,
    assinados: row.metricCounts.get('assinados'),
    ganhos: row.metricDeals.get('ganhos').size,
    protocolados: row.metricDeals.get('protocolados').size,
    pct_olos_pendente: row.pct_olos_pendente,
    pct_hubspot_pendente: row.pct_hubspot_pendente,
  });

  result.collaborators = [...byCollaborator.values()]
    .map(toCollaboratorRow)
    .sort((a, b) => b.assinados - a.assinados || b.recebimentos_deal_dia - a.recebimentos_deal_dia);

  result.teams = [...byTeam.values()].map((row) => ({
    equipe: row.equipe,
    recebimentos_assessor_deal_dia: row.metricDeals.get('recebidos').size,
    deals_unicos_da_equipe: new Set(
      metricKeys.flatMap((key) => [...row.metricDeals.get(key)]),
    ).size,
    trabalhados: row.metricDeals.get('trabalhados_proxy').size,
    em_contato: row.metricDeals.get('em_contato_crm').size,
    coleta: row.metricDeals.get('coleta').size,
    assinados: row.metricCounts.get('assinados'),
    ganhos: row.metricDeals.get('ganhos').size,
    protocolados: row.metricDeals.get('protocolados').size,
  })).sort((a, b) => b.assinados - a.assinados);

  result.productionComparison = {
    day: selectedDayBounds
      ? {
          recebidos: dayTotals.recebidos,
          assinados: dayTotals.assinados,
          ganhos: dayTotals.ganhos,
          protocolados: dayTotals.protocolados,
        }
      : null,
    month: {
      recebidos: monthTotals.recebidos,
      assinados: monthTotals.assinados,
      ganhos: monthTotals.ganhos,
      protocolados: monthTotals.protocolados,
    },
  };
  result.asOf = raw.asOf;
  return result;
}

function buildResults(raw, params) {
  if (params.mode === 'producao') {
    return buildProductionComparisonResults(raw, params);
  }
  if (params.mode !== 'operacional') {
    return buildComparisonResults(raw, params);
  }

  const events = filteredEvents(raw, params);
  const eventsByDeal = new Map();
  for (const event of events) {
    const list = eventsByDeal.get(event.dealId) || [];
    list.push(event);
    eventsByDeal.set(event.dealId, list);
  }

  const corporateReceipts = new Map();
  for (const event of events) {
    if (event.type !== 'RECEBIDO_CORPORATIVO') continue;
    const current = corporateReceipts.get(event.dealId);
    if (!current || event.occurredAt < current.occurredAt) {
      corporateReceipts.set(event.dealId, event);
    }
  }

  const firstAssessorByDeal = new Map();
  for (const event of events) {
    if (event.type !== 'RECEBIDO_ASSESSOR') continue;
    const current = firstAssessorByDeal.get(event.dealId);
    if (
      !current ||
      compareAssessorEvents(
        { receivedAt: event.occurredAt, collaboratorId: event.collaboratorId, team: event.team },
        { receivedAt: current.occurredAt, collaboratorId: current.collaboratorId, team: current.team },
      ) < 0
    ) {
      firstAssessorByDeal.set(event.dealId, event);
    }
  }

  const cohort = [];
  for (const [dealId, receipt] of corporateReceipts) {
    if (receipt.occurredAt >= periodBounds(params.inicio, params.fim_exclusivo).end) continue;
    const assessor = firstAssessorByDeal.get(dealId);
    if (!filterScope(assessor, params)) continue;
    const dealEvents = eventsByDeal.get(dealId) || [];
    const firstOf = (type) => dealEvents
      .filter((event) => event.type === type)
      .sort((a, b) => a.occurredAt - b.occurredAt)[0]?.occurredAt || null;
    const contacts = dealEvents.filter((event) => event.type === 'EM_CONTATO');
    const firstContact = contacts
      .map((event) => event.occurredAt)
      .sort((a, b) => a - b)[0] || null;
    cohort.push({
      dealId,
      receiptAt: receipt.occurredAt,
      events: dealEvents,
      firstWorkAt: firstOf('TRABALHADO_PROXY'),
      contacted: contacts.length > 0,
      contactAtOrBeforeReceipt: contacts.some((event) => event.occurredAt <= receipt.occurredAt),
      firstContactAt: firstContact,
      firstDisqualifiedAt: firstOf('DESQUALIFICADO'),
      firstCollectionAt: firstOf('COLETA'),
      firstContractAt: firstOf('CONTRATO'),
      firstEmissionAt: firstOf('EMITIDO_ORIGINAL'),
      firstSignatureAt: firstOf('ASSINADO_ORIGINAL'),
      gainedAt: firstOf('GANHO'),
      protocolAt: firstOf('PROTOCOLADO'),
    });
  }

  const inRange = (value, receivedAt) =>
    value != null && value >= receivedAt && value <= raw.asOf;
  const counts = {
    recebidos: cohort.length,
    trabalhados_proxy: cohort.filter((item) => inRange(item.firstWorkAt, item.receiptAt)).length,
    em_contato_crm: cohort.filter((item) =>
      item.contacted &&
      (item.contactAtOrBeforeReceipt || item.firstContactAt <= raw.asOf),
    ).length,
    assinados: cohort.filter((item) => inRange(item.firstSignatureAt, item.receiptAt)).length,
    ganhos: cohort.filter((item) => inRange(item.gainedAt, item.receiptAt)).length,
    protocolados: cohort.filter((item) => inRange(item.protocolAt, item.receiptAt)).length,
    desqualificados: cohort.filter((item) => inRange(item.firstDisqualifiedAt, item.receiptAt)).length,
  };

  const contactCount = cohort.filter((item) =>
    item.contacted &&
    (item.contactAtOrBeforeReceipt || item.firstContactAt <= raw.asOf),
  ).length;
  const signedCount = counts.assinados;
  const signedAndGained = cohort.filter((item) =>
    inRange(item.firstSignatureAt, item.receiptAt) &&
    item.gainedAt &&
    item.gainedAt >= item.firstSignatureAt &&
    item.gainedAt <= raw.asOf,
  ).length;
  const funnel = {
    recebidos: cohort.length,
    trabalhados: counts.trabalhados_proxy,
    em_contato: contactCount,
    coleta: cohort.filter((item) => inRange(item.firstCollectionAt, item.receiptAt)).length,
    contrato: cohort.filter((item) => inRange(item.firstContractAt, item.receiptAt)).length,
    emitidos: cohort.filter((item) => inRange(item.firstEmissionAt, item.receiptAt)).length,
    assinados: signedCount,
    ganhos: counts.ganhos,
    protocolados: counts.protocolados,
    desqualificados_saida: counts.desqualificados,
    coleta_sem_contato_observado: cohort.filter((item) =>
      item.firstCollectionAt != null && !item.contacted,
    ).length,
  };
  const dailyMap = new Map();
  for (const item of cohort) {
    const day = localDay(item.receiptAt);
    const row = dailyMap.get(day) || { dia: day, recebidos: 0, assinados_ate_corte: 0 };
    row.recebidos++;
    if (inRange(item.firstSignatureAt, item.receiptAt)) row.assinados_ate_corte++;
    dailyMap.set(day, row);
  }
  const bounds = periodBounds(params.inicio, params.fim_exclusivo);
  const daily = [];
  for (let day = new Date(bounds.start); day < bounds.end; day.setUTCDate(day.getUTCDate() + 1)) {
    const isoDay = day.toISOString().slice(0, 10);
    const row = dailyMap.get(isoDay);
    daily.push({
      dia: isoDay,
      recebidos: row?.recebidos || 0,
      assinados_ate_corte: row?.assinados_ate_corte || 0,
      taxa_safra_pct: row?.recebidos
        ? Number((100 * row.assinados_ate_corte / row.recebidos).toFixed(2))
        : null,
    });
  }

  const reasonCounts = new Map();
  for (const item of cohort) {
    if (!inRange(item.firstDisqualifiedAt, item.receiptAt)) continue;
    const reason = String(raw.deals.get(item.dealId)?.motivo_perda || '').trim() || '(SEM MOTIVO)';
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  const reasons = [...reasonCounts].map(([motivo, deals_desqualificados]) => ({
    motivo,
    deals_desqualificados,
  })).sort((a, b) =>
    b.deals_desqualificados - a.deals_desqualificados ||
    a.motivo.localeCompare(b.motivo),
  );

  const receivedAssessors = new Map();
  for (const event of events) {
    if (
      event.type !== 'RECEBIDO_ASSESSOR' ||
      event.occurredAt >= bounds.end ||
      (params.equipe && event.team !== params.equipe) ||
      (params.colaborador_id != null && String(event.collaboratorId) !== String(params.colaborador_id)) ||
      (
        params.colaborador_ids_escopo != null &&
        !params.colaborador_ids_escopo.map(String).includes(String(event.collaboratorId))
      )
    ) continue;
    const day = localDay(event.occurredAt);
    const key = `${event.dealId}|${event.collaboratorId}|${day}`;
    const current = receivedAssessors.get(key);
    if (!current || event.occurredAt < current.receivedAt) {
      receivedAssessors.set(key, { ...event, receivedAt: event.occurredAt });
    }
  }

  const byCollaborator = new Map();
  const byTeam = new Map();
  for (const receipt of receivedAssessors.values()) {
    const marks = (eventsByDeal.get(receipt.dealId) || []).filter(
      (event) => event.occurredAt >= receipt.receivedAt,
    );
    const has = (type) => marks.some((event) => event.type === type);
    const collaborator = receipt.collaboratorId;
    const team = receipt.team || '(SEM EQUIPE)';
    const collabKey = `${collaborator}|${team}`;
    const collabRow = byCollaborator.get(collabKey) || {
      colaborador_id: collaborator,
      colaborador: '(SEM ATRIBUICAO)',
      equipe_atual: team,
      recebimentos_deal_dia: 0,
      trabalhados: 0,
      em_contato: 0,
      coletaDeals: new Set(),
      assinados: 0,
      ganhos: 0,
      protocoladoDeals: new Set(),
      pct_olos_pendente: null,
      pct_hubspot_pendente: null,
    };
    collabRow.recebimentos_deal_dia++;
    if (has('TRABALHADO_PROXY')) collabRow.trabalhados++;
    if (has('EM_CONTATO')) collabRow.em_contato++;
    if (has('COLETA')) collabRow.coletaDeals.add(receipt.dealId);
    if (has('ASSINADO_ORIGINAL')) collabRow.assinados++;
    if (has('GANHO')) collabRow.ganhos++;
    if (has('PROTOCOLADO')) collabRow.protocoladoDeals.add(receipt.dealId);
    byCollaborator.set(collabKey, collabRow);

    const teamRow = byTeam.get(team) || {
      equipe: team,
      recebimentos_assessor_deal_dia: 0,
      deals_unicos_da_equipe: new Set(),
      trabalhados: new Set(),
      em_contato: new Set(),
      coleta: new Set(),
      assinados: new Set(),
      ganhos: new Set(),
      protocolados: new Set(),
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
    row.colaborador = raw.collaboratorNames?.get(row.colaborador_id) || '(SEM ATRIBUICAO)';
    if (row.equipe_atual == null) row.equipe_atual = '(SEM EQUIPE)';
    row.coleta = row.coletaDeals.size;
    row.protocolados = row.protocoladoDeals.size;
    delete row.coletaDeals;
    delete row.protocoladoDeals;
  }

  const teams = [...byTeam.values()].map((row) => ({
    equipe: row.equipe,
    recebimentos_assessor_deal_dia: row.recebimentos_assessor_deal_dia,
    deals_unicos_da_equipe: row.deals_unicos_da_equipe.size,
    trabalhados: row.trabalhados.size,
    em_contato: row.em_contato.size,
    coleta: row.coleta.size,
    assinados: row.assinados.size,
    ganhos: row.ganhos.size,
    protocolados: row.protocolados.size,
  })).sort((a, b) => b.assinados - a.assinados);

  const result = emptyResult();
  result.overview = counts;
  result.strategic = {
    recebidos: cohort.length,
    em_contato: contactCount,
    assinados: signedCount,
    assinados_que_ganharam: signedAndGained,
    pct_recebidos_ate_assinados: cohort.length
      ? Number((100 * signedCount / cohort.length).toFixed(2))
      : null,
    pct_recebidos_ate_em_contato: cohort.length
      ? Number((100 * contactCount / cohort.length).toFixed(2))
      : null,
    pct_assinados_ate_ganhos: signedCount
      ? Number((100 * signedAndGained / signedCount).toFixed(2))
      : null,
    variacao_safra_sem_maturidade_equivalente: null,
  };
  result.funnel = funnel;
  result.daily = daily;
  result.reasons = reasons;
  result.collaborators = [...byCollaborator.values()].sort((a, b) =>
    b.assinados - a.assinados ||
    b.recebimentos_deal_dia - a.recebimentos_deal_dia,
  );
  result.teams = teams;
  result.asOf = raw.asOf;
  return result;
}

function buildComparisonResults(raw, params) {
  const cohortBounds = periodBounds(params.cohort_inicio, params.cohort_fim);
  const resultBounds = periodBounds(params.result_inicio, params.result_fim);
  const activeIds = new Set((params.colaborador_ids_ativos || []).map(String));
  const creationsByDeal = new Map();
  for (const event of raw.events) {
    if (
      event.type !== 'DEAL_CREATED' ||
      event.occurredAt < cohortBounds.start ||
      event.occurredAt >= cohortBounds.end ||
      event.occurredAt > raw.asOf
    ) continue;
    const current = creationsByDeal.get(event.dealId);
    if (!current || event.occurredAt < current.createdAt) {
      creationsByDeal.set(event.dealId, { createdAt: event.occurredAt });
    }
  }

  const cohort = [];
  for (const [dealId, creation] of creationsByDeal) {
    const assessor = (raw.episodesByDeal.get(dealId) || [])
      .filter((episode) =>
        episode.cargo === 'Assessor' &&
        episode.receivedAt >= creation.createdAt &&
        activeIds.has(String(episode.collaboratorId)),
      )
      .sort(compareAssessorEvents)[0];
    if (assessor && !filterScope(assessor, params)) continue;
    if (
      !assessor &&
      (
        !params.include_unassigned ||
        params.equipe ||
        params.colaborador_id != null
      )
    ) continue;
    cohort.push({
      dealId,
      createdAt: creation.createdAt,
      collaboratorId: assessor ? String(assessor.collaboratorId) : '(SEM ATRIBUICAO)',
      collaborator: assessor
        ? raw.collaboratorNames?.get(String(assessor.collaboratorId)) || '(SEM ATRIBUICAO)'
        : '(SEM ATRIBUICAO)',
      team: assessor?.team || '(SEM EQUIPE)',
    });
  }

  const cohortByDeal = new Map(cohort.map((item) => [item.dealId, item]));
  const eventsByDeal = new Map();
  for (const event of raw.events) {
    const item = cohortByDeal.get(event.dealId);
    if (
      !item ||
      event.occurredAt < resultBounds.start ||
      event.occurredAt >= resultBounds.end ||
      event.occurredAt < item.createdAt ||
      event.occurredAt > raw.asOf
    ) continue;
    const list = eventsByDeal.get(event.dealId) || [];
    list.push(event);
    eventsByDeal.set(event.dealId, list);
  }

  const metricTypes = {
    trabalhados_proxy: 'TRABALHADO_PROXY',
    em_contato_crm: 'EM_CONTATO',
    coleta: 'COLETA',
    contrato: 'CONTRATO',
    emitidos: 'EMITIDO_ORIGINAL',
    assinados: 'ASSINADO_ORIGINAL',
    ganhos: 'GANHO',
    protocolados: 'PROTOCOLADO',
    desqualificados: 'DESQUALIFICADO',
  };
  const dealsByMetric = new Map(
    Object.entries(metricTypes).map(([key]) => [key, new Set()]),
  );
  const firstMetricAtByDeal = new Map();
  const signedByDay = new Map();
  for (const [dealId, events] of eventsByDeal) {
    const firstAt = new Map();
    for (const event of events) {
      const metric = Object.entries(metricTypes).find(([, type]) => type === event.type)?.[0];
      if (!metric) continue;
      dealsByMetric.get(metric).add(dealId);
      if (!firstAt.has(metric) || event.occurredAt < firstAt.get(metric)) {
        firstAt.set(metric, event.occurredAt);
      }
      if (event.type === 'ASSINADO_ORIGINAL') {
        const day = localDay(event.occurredAt);
        signedByDay.set(day, (signedByDay.get(day) || new Set()).add(dealId));
      }
    }
    firstMetricAtByDeal.set(dealId, firstAt);
  }

  const metricCount = (key) => dealsByMetric.get(key).size;
  let safraComparison = null;
  if (params.mode === 'safra') {
    const monthStart = cohortBounds.start;
    const monthEnd = cohortBounds.end;
    const monthDealsByMetric = new Map(
      Object.keys(metricTypes).map((key) => [key, new Set()]),
    );
    for (const event of raw.events) {
      const item = cohortByDeal.get(event.dealId);
      if (
        !item ||
        event.occurredAt < monthStart ||
        event.occurredAt >= monthEnd ||
        event.occurredAt < item.createdAt ||
        event.occurredAt > raw.asOf
      ) continue;
      const metric = Object.entries(metricTypes).find(([, type]) => type === event.type)?.[0];
      if (metric) monthDealsByMetric.get(metric).add(event.dealId);
    }

    let dayComparison = null;
    if (params.selected_day && params.selected_day_end) {
      const dayBounds = periodBounds(params.selected_day, params.selected_day_end);
      const dayDealsByMetric = new Map(
        Object.keys(metricTypes).map((key) => [key, new Set()]),
      );
      for (const event of raw.events) {
        const item = cohortByDeal.get(event.dealId);
        if (
          !item ||
          event.occurredAt < dayBounds.start ||
          event.occurredAt >= dayBounds.end ||
          event.occurredAt < item.createdAt ||
          event.occurredAt > raw.asOf
        ) continue;
        const metric = Object.entries(metricTypes).find(([, type]) => type === event.type)?.[0];
        if (metric) dayDealsByMetric.get(metric).add(event.dealId);
      }
      const dayCreated = cohort.filter(
        (item) => item.createdAt >= dayBounds.start && item.createdAt < dayBounds.end,
      ).length;
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
  const signedAndGained = cohort.filter((item) => {
    const firstAt = firstMetricAtByDeal.get(item.dealId);
    return firstAt?.has('assinados') &&
      firstAt.has('ganhos') &&
      firstAt.get('ganhos') >= firstAt.get('assinados');
  }).length;
  const counts = {
    recebidos: cohort.length,
    trabalhados_proxy: metricCount('trabalhados_proxy'),
    em_contato_crm: metricCount('em_contato_crm'),
    assinados: metricCount('assinados'),
    ganhos: metricCount('ganhos'),
    protocolados: metricCount('protocolados'),
    desqualificados: metricCount('desqualificados'),
  };
  const funnel = {
    recebidos: cohort.length,
    trabalhados: counts.trabalhados_proxy,
    em_contato: counts.em_contato_crm,
    coleta: metricCount('coleta'),
    contrato: metricCount('contrato'),
    emitidos: metricCount('emitidos'),
    assinados: counts.assinados,
    ganhos: counts.ganhos,
    protocolados: counts.protocolados,
    desqualificados_saida: counts.desqualificados,
    coleta_sem_contato_observado: cohort.filter((item) =>
      dealsByMetric.get('coleta').has(item.dealId) &&
      !dealsByMetric.get('em_contato_crm').has(item.dealId),
    ).length,
  };

  const dailyMap = new Map();
  for (const item of cohort) {
    const day = localDay(item.createdAt);
    const row = dailyMap.get(day) || { dia: day, recebidos: 0, assinados_ate_corte: 0 };
    row.recebidos++;
    dailyMap.set(day, row);
  }
  for (const [day, signedDeals] of signedByDay) {
    const row = dailyMap.get(day) || { dia: day, recebidos: 0, assinados_ate_corte: 0 };
    row.assinados_ate_corte = signedDeals.size;
    dailyMap.set(day, row);
  }
  const chartStart = cohortBounds.start < resultBounds.start ? cohortBounds.start : resultBounds.start;
  const chartEnd = cohortBounds.end > resultBounds.end ? cohortBounds.end : resultBounds.end;
  const daily = [];
  for (let day = new Date(chartStart); day < chartEnd; day.setUTCDate(day.getUTCDate() + 1)) {
    const isoDay = day.toISOString().slice(0, 10);
    const row = dailyMap.get(isoDay);
    daily.push({
      dia: isoDay,
      recebidos: row?.recebidos || 0,
      assinados_ate_corte: row?.assinados_ate_corte || 0,
      taxa_safra_pct: row?.recebidos
        ? Number((100 * row.assinados_ate_corte / row.recebidos).toFixed(2))
        : null,
    });
  }

  const reasonCounts = new Map();
  for (const dealId of dealsByMetric.get('desqualificados')) {
    const reason = String(raw.deals.get(dealId)?.motivo_perda || '').trim() || '(SEM MOTIVO)';
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  const reasons = [...reasonCounts].map(([motivo, deals_desqualificados]) => ({
    motivo,
    deals_desqualificados,
  })).sort((a, b) =>
    b.deals_desqualificados - a.deals_desqualificados ||
    a.motivo.localeCompare(b.motivo),
  );

  const byCollaborator = new Map();
  const byTeam = new Map();
  for (const item of cohort) {
    const events = eventsByDeal.get(item.dealId) || [];
    const has = (type) => events.some((event) => event.type === type);
    const collaboratorKey = `${item.collaboratorId}|${item.team}`;
    const collaboratorRow = byCollaborator.get(collaboratorKey) || {
      colaborador_id: item.collaboratorId,
      colaborador: item.collaborator,
      equipe_atual: item.team,
      recebimentos_deal_dia: 0,
      trabalhados: 0,
      em_contato: 0,
      coleta: 0,
      assinados: 0,
      ganhos: 0,
      protocolados: 0,
      pct_olos_pendente: null,
      pct_hubspot_pendente: null,
    };
    collaboratorRow.recebimentos_deal_dia++;
    if (has('TRABALHADO_PROXY')) collaboratorRow.trabalhados++;
    if (has('EM_CONTATO')) collaboratorRow.em_contato++;
    if (has('COLETA')) collaboratorRow.coleta++;
    if (has('ASSINADO_ORIGINAL')) collaboratorRow.assinados++;
    if (has('GANHO')) collaboratorRow.ganhos++;
    if (has('PROTOCOLADO')) collaboratorRow.protocolados++;
    byCollaborator.set(collaboratorKey, collaboratorRow);

    const teamRow = byTeam.get(item.team) || {
      equipe: item.team,
      recebimentos_assessor_deal_dia: 0,
      deals_unicos_da_equipe: 0,
      trabalhados: 0,
      em_contato: 0,
      coleta: 0,
      assinados: 0,
      ganhos: 0,
      protocolados: 0,
    };
    teamRow.recebimentos_assessor_deal_dia++;
    teamRow.deals_unicos_da_equipe++;
    if (has('TRABALHADO_PROXY')) teamRow.trabalhados++;
    if (has('EM_CONTATO')) teamRow.em_contato++;
    if (has('COLETA')) teamRow.coleta++;
    if (has('ASSINADO_ORIGINAL')) teamRow.assinados++;
    if (has('GANHO')) teamRow.ganhos++;
    if (has('PROTOCOLADO')) teamRow.protocolados++;
    byTeam.set(item.team, teamRow);
  }

  const contactCount = counts.em_contato_crm;
  const result = emptyResult();
  result.overview = counts;
  result.strategic = {
    recebidos: cohort.length,
    em_contato: contactCount,
    assinados: counts.assinados,
    assinados_que_ganharam: signedAndGained,
    pct_recebidos_ate_assinados: cohort.length
      ? Number((100 * counts.assinados / cohort.length).toFixed(2))
      : null,
    pct_recebidos_ate_em_contato: cohort.length
      ? Number((100 * contactCount / cohort.length).toFixed(2))
      : null,
    pct_assinados_ate_ganhos: counts.assinados
      ? Number((100 * signedAndGained / counts.assinados).toFixed(2))
      : null,
    variacao_safra_sem_maturidade_equivalente: null,
  };
  result.funnel = funnel;
  result.daily = daily;
  result.reasons = reasons;
  result.collaborators = [...byCollaborator.values()].sort((a, b) =>
    b.assinados - a.assinados ||
    b.recebimentos_deal_dia - a.recebimentos_deal_dia,
  );
  result.teams = [...byTeam.values()].sort((a, b) => b.assinados - a.assinados);
  result.asOf = raw.asOf;
  if (safraComparison) result.safraComparison = safraComparison;
  return result;
}

export async function getInteComerceRawAnalytics(params) {
  const raw = await getRawEvents(params);
  return buildResults(raw, params);
}

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

function inRange(value, start, end) {
  return value >= start && value < end;
}

function matchesProductionScope(event, params, activeIds) {
  if (
    event.collaboratorId == null ||
    (activeIds && !activeIds.has(String(event.collaboratorId)))
  ) return false;
  return filterScope(event, params);
}

function countEvents(events, start, end, params, creationByDeal = null) {
  const dealsByMetric = new Map(
    PRODUCTION_METRICS.map(({ key }) => [key, new Set()]),
  );
  const activeIds = params.colaborador_ids_ativos == null
    ? null
    : new Set(params.colaborador_ids_ativos.map(String));
  const metricByEventType = new Map(
    PRODUCTION_METRICS.map((metric) => [metric.eventType, metric]),
  );
  for (const event of events) {
    if (!inRange(event.occurredAt, start, end)) continue;
    if (!matchesProductionScope(event, params, activeIds)) continue;
    if (creationByDeal) {
      const createdAt = creationByDeal.get(event.dealId);
      if (!createdAt || createdAt < start || createdAt >= end || event.occurredAt < createdAt) {
        continue;
      }
    }
    const metric = metricByEventType.get(event.type);
    if (metric) dealsByMetric.get(metric.key).add(event.dealId);
  }
  return Object.fromEntries(
    [...dealsByMetric].map(([key, deals]) => [key, deals.size]),
  );
}

export async function getInteComercePeriodSummary(params) {
  const raw = await getRawEvents(params);
  const { start, end } = periodBounds(params.inicio, params.fim_exclusivo);
  const events = raw.events.filter((event) =>
    event.occurredAt <= raw.asOf && EVENT_TYPES.has(event.type),
  );

  if (params.mode === 'safra') {
    const dayTotals = params.selected_day && params.selected_day_end
      ? countEvents(
          events,
          periodBounds(params.selected_day, params.selected_day_end).start,
          periodBounds(params.selected_day, params.selected_day_end).end,
          params,
        )
      : null;
    return {
      monthTotals: countEvents(events, start, end, params),
      dayTotals,
      selectedDay: params.selected_day || null,
      asOf: raw.asOf,
    };
  }

  const creationByDeal = new Map();
  for (const event of events) {
    if (
      event.type === 'DEAL_CREATED' &&
      (
        !creationByDeal.has(event.dealId) ||
        event.occurredAt < creationByDeal.get(event.dealId)
      )
    ) {
      creationByDeal.set(event.dealId, event.occurredAt);
    }
  }

  if (params.mode === 'producao-3-meses') {
    const months = [];
    for (let monthStart = new Date(start); monthStart < end; monthStart.setUTCMonth(monthStart.getUTCMonth() + 1)) {
      const monthEnd = new Date(Date.UTC(
        monthStart.getUTCFullYear(),
        monthStart.getUTCMonth() + 1,
        1,
        3,
      ));
      months.push({
        month: localDay(new Date(monthStart.getTime() + 3 * 60 * 60 * 1000)).slice(0, 7),
        totals: countEvents(events, monthStart, monthEnd, params, creationByDeal),
      });
    }
    return { months, asOf: raw.asOf };
  }

  return {
    monthTotals: countEvents(events, start, end, params, creationByDeal),
    asOf: raw.asOf,
  };
}