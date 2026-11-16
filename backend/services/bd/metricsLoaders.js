// backend/services/bd/metricsLoaders.js
// ─────────────────────────────────────────────────────────────────────────────
// Data-access layer de métricas. Cada `load*` é uma query pura — sem cache.
// Exceções (com cache interno, compartilhado entre rotas):
//   • loadDemanda          → /demanda-atual, /demanda-reprimida, /demanda-resumo
//   • resolveNomesPorEquipe → /ligacoes, /ligacoes/tabulacoes, /ligacoes-produtivas
//
// ⚠️ SAfra vs PRODUÇÃO (aplicado em loadGanhos e loadProtocolados)
// ─────────────────────────────────────────────────────────────────────────────
//   • mode=producao (default) → filtra por data_ganho da view (data do evento)
//   • mode=safra              → INNER JOIN em core.deals e filtra por
//                               d.created_at (data de criação do deal)
//
// O filtro de safra é a coorte por created_at: "dos deals criados no período,
// quantos já foram ganhos/protocolados". Produção é "dos ganhos/protocolados
// no período, independente de quando o deal foi criado".
//
// ⚠️ TIMEZONE — data_ganho vs created_at
//   • data_ganho  é timestamptz → precisa AT TIME ZONE 'UTC'
//   • created_at  é timestamp (já em SP) → ::date direto, sem conversão
//   (mesma regra de data_distribuicao_comercial em leads-recebidos)
// ─────────────────────────────────────────────────────────────────────────────

import db, { analyticsQuery } from './db.js';
import { cacheFirst } from './cacheFirst.js';

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS DE SQL
// ═════════════════════════════════════════════════════════════════════════════

function normalize(str) {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function mapGranularity(granularity) {
  const map = { daily: 'day', weekly: 'week', monthly: 'month' };
  return map[granularity] || null;
}

const PRODUCT_VARIANTS = {
  'Auxilio Acidente': ['Auxilio Acidente', 'Auxílio Acidente'],
  'Quinquenio':       ['Quinquenio', 'Quinquênio'],
  'Concomitante':     ['Concomitante', 'concomitante'],
  'BPC/LOAS':         ['BPC/LOAS', 'BPC / LOAS', 'BPC_LOAS'],
  'Isenção de IR Aposentadoria': ['Isenção de IR Aposentadoria', 'Isencao de IR Aposentadoria'],
};

function buildProdutoClause(produto, columnExpr, startIdx) {
  if (!produto || produto === 'Todos') {
    return { clause: '', params: [], nextIdx: startIdx };
  }
  const variants = PRODUCT_VARIANTS[produto];
  const normalizedColumn = `LOWER(TRIM(${columnExpr}))`;
  if (variants) {
    const list = variants.map(v => v.trim().toLowerCase());
    const placeholders = list.map((_, i) => `$${startIdx + i}`).join(', ');
    return {
      clause: ` AND ${normalizedColumn} IN (${placeholders})`,
      params: list,
      nextIdx: startIdx + list.length,
    };
  }
  return {
    clause: ` AND ${normalizedColumn} = $${startIdx}`,
    params: [String(produto).trim().toLowerCase()],
    nextIdx: startIdx + 1,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// FILTRO SAFRA vs PRODUÇÃO (usado em loadGanhos e loadProtocolados)
// ─────────────────────────────────────────────────────────────────────────────
// Safra:      coorte por core.deals.created_at (quando o deal foi criado)
// Produção:   filtro por data_ganho da view (quando o evento ocorreu)
//
// Retorna as três peças que variam entre os dois modos:
//   • joinClause:  '' ou "INNER JOIN core.deals d ON ..."
//   • whereClause: a expressão de filtro de período ($1 e $2)
//   • dateColumn:  a coluna de data a ser usada em SELECT/GROUP BY (gran)
//   • needsAtTimeZone: true se a coluna for timestamptz (data_ganho)
// ═════════════════════════════════════════════════════════════════════════════

function buildPeriodFilter(mode, aliasedColumns = {}) {
  const isSafra = String(mode || '').toLowerCase() === 'safra';
  const viewAlias = aliasedColumns.view || 'l';
  const dealAlias = aliasedColumns.deal || 'd';

  if (isSafra) {
    return {
      isSafra: true,
      joinClause: `INNER JOIN core.deals ${dealAlias} ON ${dealAlias}.deal_id = ${viewAlias}.deal_id`,
      whereClause: `${dealAlias}.created_at::date >= $1::date
        AND ${dealAlias}.created_at::date <  $2::date
        AND ${dealAlias}.is_deleted IS NOT TRUE`,
      dateColumn: `${dealAlias}.created_at`,
      needsAtTimeZone: false,
    };
  }

  return {
    isSafra: false,
    joinClause: '',
    whereClause: `(${viewAlias}.data_ganho AT TIME ZONE 'UTC')::date >= $1
      AND (${viewAlias}.data_ganho AT TIME ZONE 'UTC')::date < $2`,
    dateColumn: `${viewAlias}.data_ganho`,
    needsAtTimeZone: true,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// PROTEÇÃO CONTRA PAYLOAD GIGANTE
// ─────────────────────────────────────────────────────────────────────────────
// Limites calibrados para não truncar em uso normal:
//   • Série temporal (gran): 253 colaboradores × 31 dias = 7.843 linhas
//     → cap de 10.000 dá 27% de folga
//   • Agregado por colaborador: ~2.000–4.000 linhas; cap de 8.000 é folgado
//   • Detalhe (demanda): uma linha por deal → cap de 20.000
//
// Se o log mostrar "TRUNCANDO", é sinal de query retornando linhas demais.
// ═════════════════════════════════════════════════════════════════════════════

const CAP_SERIES = 10_000;
const CAP_AGG = 8_000;
const CAP_DETAIL = 20_000;
const WARN_BYTES_THRESHOLD = 2 * 1024 * 1024; // 2 MB

function capRows(rows, limit, label) {
  if (!Array.isArray(rows)) return rows;
  if (rows.length <= limit) return rows;
  console.warn(
    `[loader:${label}] TRUNCANDO ${rows.length} → ${limit} linhas. ` +
    `Isso indica filtro sem equipe ou período muito longo. ` +
    `A resposta pode estar incompleta — investigue.`
  );
  return rows.slice(0, limit);
}

function warnIfLarge(rows, label) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  try {
    const approxBytes = JSON.stringify(rows).length;
    if (approxBytes > WARN_BYTES_THRESHOLD) {
      console.warn(
        `[loader:${label}] payload grande: ${rows.length} linhas, ` +
        `~${(approxBytes / 1024 / 1024).toFixed(2)} MB — pode causar timeout no Redis`
      );
    }
  } catch {
    // ignora
  }
  return rows;
}

// ═════════════════════════════════════════════════════════════════════════════
// QUALIFICATIONS (usado por /ligacoes* e /ligacoes/tabulacoes)
// ═════════════════════════════════════════════════════════════════════════════

export const QUALIFICATIONS = {
  productive: [
    'Transferida a Outro Módulo',
    'SMS Enviado',
    'Pediu contato via WhatsApp',
    'Coleta de documentacao',
    'Emissao de contrato',
    'Tratativa via WhatsApp',
  ],
  appointments: [
    'Retornar ligacao', 'Trabalhando',
  ],
  occurrences: [
    'Nao tabulada - tempo excedido', 'Não tabulada - tempo excedido',
    'Mudo', 'Queda de ligacao', 'Queda de ligação', 'Caixa postal',
  ],
  failures: [
    'Ja tem advogado','Ja revisado','Ja em processo de revisao',
    'Sem interesse', 'Nao pertence ao cliente', 'Faleceu', 'Ja tem acao',
    'Nao tem direito', 'Nunca trabalhou de carteira assinada', 'Nunca sofreu acidente',
    'Cliente desconhece o cadastro', 'Nao quer mais contato', 'Nao concomitante',
    'Nao aposentado', 'Fora do periodo aquisitivo', 'Pensionista', 'Aposentadoria RPPS',
    'Aposentado antes de 2015', 'BPC - LOAS Desqualificado', 'BPC - LOAS Ganho',
    'Ja recebe o auxilio-acidente', 'Em processo com a MADM', 'Sem sequela',
    'Aposentado', 'Sem documentacao', 'Contribuinte individual - autonomo',
    'Acidente a mais de 20 anos', 'Ja tem processo de auxilio acidente',
    'Cliente Atritado', 'Ja em processo de revisao', 'Recebendo auxilio-doenca',
    'Acidente recente', 'Fora do periodo de graca', 'Cliente desqualificado',
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// CACHE KEY (idêntica à usada por warmupSetup.js — nunca duplica entrada)
// ═════════════════════════════════════════════════════════════════════════════

export function metricCacheKey(tipo, params) {
  const parts = [tipo];
  const keys = Object.keys(params || {}).sort();
  for (const k of keys) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') parts.push(`${k}=${v}`);
  }
  return parts.join(':');
}

// ═════════════════════════════════════════════════════════════════════════════
// resolveNomesPorEquipe — CACHEADO (1h fresco / 2h stale)
// ═════════════════════════════════════════════════════════════════════════════

const STOPWORDS_EQUIPE = new Set([
  'equipe', 'time', 'grupo', 'setor', 'area', 'área',
  'comercial', 'discadora', 'judit', 'olos', 'crm',
  '-', '–', '—', 'de', 'da', 'do', 'das', 'dos', 'e', '&',
]);

function tokenizeEquipe(str) {
  return normalize(str)
    .split(/\s+/)
    .filter(t => t && !STOPWORDS_EQUIPE.has(t));
}

export async function resolveNomesPorEquipe(equipeNome) {
  if (!equipeNome || equipeNome === 'todas') return [];

  return cacheFirst(
    `equipe-membros:${equipeNome}`,
    async () => {
      const r = await analyticsQuery(
        `SELECT nome, nome_equipe
           FROM core.view_app_colaboradores
          WHERE nome IS NOT NULL`
      );
      const filtroTokens = tokenizeEquipe(equipeNome);
      if (filtroTokens.length === 0) return [];
      return r.rows
        .filter(row => {
          const normRow = normalize(row.nome_equipe || '');
          if (normRow === normalize(equipeNome)) return true;
          const rowTokens = new Set(tokenizeEquipe(row.nome_equipe || ''));
          return filtroTokens.every(t => rowTokens.has(t));
        })
        .map(row => row.nome)
        .filter(Boolean);
    },
    { ttlMs: 3_600_000, staleMs: 7_200_000 } // 1h / 2h
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// LOADERS PUROS (SQL direto — sem cache; o cache é por rota em metrics.js)
// ═════════════════════════════════════════════════════════════════════════════

// ─── EMITIDOS ────────────────────────────────────────────────────────────────
export async function loadEmitidos({ start, end, equipe, produto, granularity }) {
  const gran = mapGranularity(granularity);
  let query = gran
    ? `SELECT
         COALESCE(NULLIF(TRIM(e.consultor_responsavel_emissao), ''), 'Sem responsável') as colaborador,
         COALESCE(e.equipe_responsavel_emissao, '') as equipe,
         (DATE_TRUNC('${gran}', e.data_emissao) AT TIME ZONE 'UTC')::date as periodo,
         COUNT(*)::int as total`
    : `SELECT
         COALESCE(NULLIF(TRIM(e.consultor_responsavel_emissao), ''), 'Sem responsável') as colaborador,
         COALESCE(e.equipe_responsavel_emissao, '') as equipe,
         COUNT(*)::int as total`;
  query += `
    FROM core.view_emitidos e
    WHERE (e.data_emissao AT TIME ZONE 'UTC')::date >= $1
      AND (e.data_emissao AT TIME ZONE 'UTC')::date < $2
  `;
  const params = [start, end];
  let idx = 3;
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(e.equipe_responsavel_emissao)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'e.produto', idx);
  query += prod.clause;
  params.push(...prod.params);
  query += gran
    ? ` GROUP BY colaborador, e.equipe_responsavel_emissao,
         (DATE_TRUNC('${gran}', e.data_emissao) AT TIME ZONE 'UTC')::date
         ORDER BY periodo, colaborador`
    : ` GROUP BY colaborador, e.equipe_responsavel_emissao ORDER BY colaborador`;
  const result = await analyticsQuery(query, params);
  const label = `emitidos:${gran || 'agg'}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, gran ? CAP_SERIES : CAP_AGG, label);
}

// ─── ASSINADOS ───────────────────────────────────────────────────────────────
export async function loadAssinados({ start, end, equipe, produto, granularity }) {
  const gran = mapGranularity(granularity);
  let query = gran
    ? `SELECT
         COALESCE(NULLIF(TRIM(consultor_responsavel_assinatura), ''), 'Sem responsável') as colaborador,
         equipe_responsavel_assinatura as equipe,
         (DATE_TRUNC('${gran}', data_assinatura) AT TIME ZONE 'UTC')::date as periodo,
         COUNT(*)::int as total`
    : `SELECT
         COALESCE(NULLIF(TRIM(consultor_responsavel_assinatura), ''), 'Sem responsável') as colaborador,
         equipe_responsavel_assinatura as equipe,
         COUNT(*)::int as total`;
  query += `
    FROM core.view_assinados
    WHERE (data_assinatura AT TIME ZONE 'UTC')::date >= $1
      AND (data_assinatura AT TIME ZONE 'UTC')::date < $2
  `;
  const params = [start, end];
  let idx = 3;
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(equipe_responsavel_assinatura)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'produto', idx);
  query += prod.clause;
  params.push(...prod.params);
  query += gran
    ? ` GROUP BY colaborador, equipe_responsavel_assinatura,
         (DATE_TRUNC('${gran}', data_assinatura) AT TIME ZONE 'UTC')::date
         ORDER BY periodo, colaborador`
    : ` GROUP BY colaborador, equipe_responsavel_assinatura ORDER BY colaborador`;
  const result = await analyticsQuery(query, params);
  const label = `assinados:${gran || 'agg'}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, gran ? CAP_SERIES : CAP_AGG, label);
}

// ─── PROTOCOLADOS (com mode safra/produção) ──────────────────────────────────
export async function loadProtocolados({ start, end, equipe, produto, granularity, mode }) {
  const gran = mapGranularity(granularity);
  const periodFilter = buildPeriodFilter(mode);

  const dateExpr = gran
    ? (periodFilter.needsAtTimeZone
        ? `(DATE_TRUNC('${gran}', ${periodFilter.dateColumn}) AT TIME ZONE 'UTC')::date`
        : `(DATE_TRUNC('${gran}', ${periodFilter.dateColumn}))::date`)
    : null;

  let query = gran
    ? `SELECT
         COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
         COALESCE(c.nome_equipe, '') as equipe,
         ${dateExpr} as periodo,
         COUNT(*)::int as total`
    : `SELECT
         COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
         COALESCE(c.nome_equipe, '') as equipe,
         COUNT(*)::int as total`;

  query += `
    FROM core.view_app_juridico_auditoria l
    ${periodFilter.joinClause}
    LEFT JOIN core.view_app_colaboradores c ON l.responsavel_lead = c.nome
    WHERE ${periodFilter.whereClause}
      AND l.etapa IN ('Protocolado')
  `;

  const params = [start, end];
  let idx = 3;
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'l.produto', idx);
  query += prod.clause;
  params.push(...prod.params);

  query += gran
    ? ` GROUP BY colaborador, c.nome_equipe, ${dateExpr}
         ORDER BY periodo, colaborador`
    : ` GROUP BY colaborador, c.nome_equipe ORDER BY colaborador`;

  const result = await analyticsQuery(query, params);
  const label = `protocolados:${gran || 'agg'}:${periodFilter.isSafra ? 'safra' : 'prod'}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, gran ? CAP_SERIES : CAP_AGG, label);
}

// ─── GANHOS (com mode safra/produção) ────────────────────────────────────────
export async function loadGanhos({ start, end, equipe, produto, granularity, demanda, mode }) {
  const gran = mapGranularity(granularity);
  const somenteDemandaAtual = String(demanda || '').toLowerCase() === 'atual';
  const periodFilter = buildPeriodFilter(mode);

  const dateExpr = gran
    ? (periodFilter.needsAtTimeZone
        ? `(DATE_TRUNC('${gran}', ${periodFilter.dateColumn}) AT TIME ZONE 'UTC')::date`
        : `(DATE_TRUNC('${gran}', ${periodFilter.dateColumn}))::date`)
    : null;

  let query = gran
    ? `SELECT
         COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
         COALESCE(c.nome_equipe, '') as equipe,
         ${dateExpr} as periodo,
         COUNT(*)::int as total`
    : `SELECT
         COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
         COALESCE(c.nome_equipe, '') as equipe,
         COUNT(*)::int as total`;

  query += `
    FROM core.view_app_juridico_auditoria l
    ${periodFilter.joinClause}
    LEFT JOIN core.view_app_colaboradores c ON l.responsavel_lead = c.nome
    WHERE ${periodFilter.whereClause}
      AND l.etapa <> 'Venda perdida'
  `;

  if (somenteDemandaAtual) {
    query += ` AND EXISTS (
      SELECT 1 FROM core.assinaturas a
      WHERE a.deal_id = l.deal_id
        AND (a.data_assinatura AT TIME ZONE 'UTC')::date >= DATE_TRUNC('month', $1::date)
        AND (a.data_assinatura AT TIME ZONE 'UTC')::date <  DATE_TRUNC('month', $1::date) + INTERVAL '1 month'
    )`;
  }

  const params = [start, end];
  let idx = 3;
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'l.produto', idx);
  query += prod.clause;
  params.push(...prod.params);

  query += gran
    ? ` GROUP BY colaborador, c.nome_equipe, ${dateExpr}
         ORDER BY periodo, colaborador`
    : ` GROUP BY colaborador, c.nome_equipe ORDER BY colaborador`;

  const result = await analyticsQuery(query, params);
  const label = `ganhos:${gran || 'agg'}:${periodFilter.isSafra ? 'safra' : 'prod'}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, gran ? CAP_SERIES : CAP_AGG, label);
}

// ─── PERDIDOS ────────────────────────────────────────────────────────────────
export async function loadPerdidos({ start, end, equipe, produto, granularity }) {
  const gran = mapGranularity(granularity);
  let query = gran
    ? `SELECT
         COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
         COALESCE(c.nome_equipe, '') as equipe,
         (DATE_TRUNC('${gran}', l.data_perda) AT TIME ZONE 'UTC')::date as periodo,
         COUNT(*)::int as total`
    : `SELECT
         COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
         COALESCE(c.nome_equipe, '') as equipe,
         COUNT(*)::int as total`;
  query += `
    FROM core.view_app_juridico_auditoria l
    LEFT JOIN core.view_app_colaboradores c ON l.responsavel_lead = c.nome
    WHERE (l.data_perda AT TIME ZONE 'UTC')::date >= $1
      AND (l.data_perda AT TIME ZONE 'UTC')::date < $2
      AND l.etapa = 'Venda perdida'
  `;
  const params = [start, end];
  let idx = 3;
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'l.produto', idx);
  query += prod.clause;
  params.push(...prod.params);
  query += gran
    ? ` GROUP BY colaborador, c.nome_equipe,
         (DATE_TRUNC('${gran}', l.data_perda) AT TIME ZONE 'UTC')::date
         ORDER BY periodo, colaborador`
    : ` GROUP BY colaborador, c.nome_equipe ORDER BY colaborador`;
  const result = await analyticsQuery(query, params);
  const label = `perdidos:${gran || 'agg'}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, gran ? CAP_SERIES : CAP_AGG, label);
}

// ─── LEADS RECEBIDOS — série temporal ────────────────────────────────────────
export async function loadLeadsRecebidosGran({ start, end, equipe, produto, granularity }) {
  const gran = mapGranularity(granularity);
  let query = `
    SELECT
      COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável') AS colaborador,
      COALESCE(c.nome_equipe, '') AS equipe,
      (DATE_TRUNC('${gran}', d.data_distribuicao_comercial))::date AS periodo,
      COUNT(DISTINCT d.deal_id)::int AS total
    FROM core.deals d
    LEFT JOIN core.colaboradores c
      ON c.colaborador_id = COALESCE(d.closer_id, d.responsavel_id)
    LEFT JOIN core.produtos pr
      ON pr.produto_id = d.produto_id
    WHERE d.data_distribuicao_comercial IS NOT NULL
      AND d.data_distribuicao_comercial::date >= $1::date
      AND d.data_distribuicao_comercial::date <  $2::date
  `;
  const params = [start, end];
  let idx = 3;
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
  query += prod.clause;
  params.push(...prod.params);
  query += `
    GROUP BY
      COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável'),
      COALESCE(c.nome_equipe, ''),
      (DATE_TRUNC('${gran}', d.data_distribuicao_comercial))::date
    ORDER BY
      (DATE_TRUNC('${gran}', d.data_distribuicao_comercial))::date,
      COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável')
  `;
  const result = await analyticsQuery(query, params);
  const label = `leads-recebidos:gran:${gran}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, CAP_SERIES, label);
}

// ─── LEADS RECEBIDOS — agregado por colaborador ──────────────────────────────
export async function loadLeadsRecebidosAgg({ start, end, equipe, produto }) {
  let query = `
    WITH assinatura_por_deal AS (
      SELECT deal_id,
        MIN(data_assinatura) FILTER (
          WHERE data_assinatura IS NOT NULL
            AND UPPER(COALESCE(status_assinatura, '')) = 'ASSINADO'
        ) AS data_assinatura
      FROM core.assinaturas
      WHERE deal_id IS NOT NULL
      GROUP BY deal_id
    ),
    protocolo_por_deal AS (
      SELECT deal_id,
        MIN(data_protocolo) FILTER (
          WHERE data_protocolo IS NOT NULL
            AND (NULLIF(BTRIM(numero_processo), '') IS NOT NULL
              OR NULLIF(BTRIM(numero_protocolo), '') IS NOT NULL)
        ) AS data_protocolo
      FROM core.processos
      WHERE deal_id IS NOT NULL
      GROUP BY deal_id
    ),
    base AS (
      SELECT
        d.deal_id,
        d.data_distribuicao_comercial::date AS data_recebimento,
        COALESCE(d.closer_id, d.responsavel_id) AS colaborador_id,
        c.nome AS colaborador,
        c.nome_equipe,
        c.unidade_id,
        COALESCE(p.nome_pipeline, 'Sem pipeline') AS pipeline,
        COALESCE(e.nome_etapa,    'Sem etapa')    AS etapa,
        COALESCE(pr.nome_produto, 'Sem produto')  AS produto,
        a.data_assinatura,
        d.data_ganho,
        pp.data_protocolo
      FROM core.deals d
      LEFT JOIN core.colaboradores c
        ON c.colaborador_id = COALESCE(d.closer_id, d.responsavel_id)
      LEFT JOIN ops.crm_pipelines p
        ON p.pipeline_id = d.pipeline_id
      LEFT JOIN ops.crm_etapas e
        ON e.etapa_id = d.etapa_id
       AND (p.crm IS NULL OR e.crm = p.crm)
      LEFT JOIN core.produtos pr
        ON pr.produto_id = d.produto_id
      LEFT JOIN assinatura_por_deal a
        ON a.deal_id = d.deal_id
      LEFT JOIN protocolo_por_deal pp
        ON pp.deal_id = d.deal_id
      WHERE d.data_distribuicao_comercial IS NOT NULL
        AND d.data_distribuicao_comercial::date >= $1::date
        AND d.data_distribuicao_comercial::date <  $2::date
  `;
  const params = [start, end];
  let idx = 3;
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
  query += prod.clause;
  params.push(...prod.params);
  query += `
    )
    SELECT
      colaborador_id,
      COALESCE(NULLIF(TRIM(colaborador), ''), 'Sem responsável') AS colaborador,
      COALESCE(nome_equipe, '') AS equipe,
      unidade_id,
      pipeline, etapa, produto,
      COUNT(DISTINCT deal_id)::int AS leads_recebidos,
      COUNT(DISTINCT deal_id)::int AS total,
      COUNT(DISTINCT deal_id) FILTER (WHERE data_assinatura IS NOT NULL)::int AS assinados,
      COUNT(DISTINCT deal_id) FILTER (WHERE data_ganho      IS NOT NULL)::int AS ganhos,
      COUNT(DISTINCT deal_id) FILTER (WHERE data_protocolo  IS NOT NULL)::int AS protocolados,
      ROUND(100.0 * COUNT(DISTINCT deal_id) FILTER (WHERE data_assinatura IS NOT NULL)
            / NULLIF(COUNT(DISTINCT deal_id), 0), 2) AS conversao_assinatura_pct,
      ROUND(100.0 * COUNT(DISTINCT deal_id) FILTER (WHERE data_ganho IS NOT NULL)
            / NULLIF(COUNT(DISTINCT deal_id), 0), 2) AS conversao_ganho_pct,
      ROUND(100.0 * COUNT(DISTINCT deal_id) FILTER (WHERE data_protocolo IS NOT NULL)
            / NULLIF(COUNT(DISTINCT deal_id), 0), 2) AS conversao_protocolo_pct
    FROM base
    GROUP BY colaborador_id, colaborador, nome_equipe, unidade_id, pipeline, etapa, produto
    ORDER BY colaborador, pipeline, etapa
  `;
  const result = await analyticsQuery(query, params);
  const label = 'leads-recebidos:agg';
  warnIfLarge(result.rows, label);
  return capRows(result.rows, CAP_AGG, label);
}

// ─── LIGAÇÕES ────────────────────────────────────────────────────────────────
export async function loadLigacoes({ start, end, granularity }) {
  const gran = mapGranularity(granularity);
  let query = gran
    ? `SELECT
         (DATE_TRUNC('${gran}', call_date) AT TIME ZONE 'UTC')::date AS periodo,
         agent_name AS colaborador,
         equipe,
         campaign_name AS campanha,
         COUNT(*)::int AS total_ligacoes,
         COUNT(DISTINCT lead_id)::int AS leads_distintos,
         COUNT(*) FILTER (WHERE qualification_name = ANY($3::text[]))::int AS produtivas,
         COUNT(*) FILTER (WHERE qualification_name = ANY($4::text[]))::int AS agendamentos,
         COUNT(*) FILTER (WHERE LOWER(BTRIM(qualification_name)) = ANY($5::text[]))::int AS ocorrencias,
         COUNT(*) FILTER (WHERE qualification_name = ANY($6::text[]))::int AS insucessos,
         AVG(tma)::numeric(12, 2) AS tma_medio`
    : `SELECT
         agent_name AS colaborador,
         equipe,
         campaign_name AS campanha,
         COUNT(*)::int AS total_ligacoes,
         COUNT(DISTINCT lead_id)::int AS leads_distintos,
         COUNT(*) FILTER (WHERE qualification_name = ANY($3::text[]))::int AS produtivas,
         COUNT(*) FILTER (WHERE qualification_name = ANY($4::text[]))::int AS agendamentos,
         COUNT(*) FILTER (WHERE LOWER(BTRIM(qualification_name)) = ANY($5::text[]))::int AS ocorrencias,
         COUNT(*) FILTER (WHERE qualification_name = ANY($6::text[]))::int AS insucessos,
         AVG(tma)::numeric(12, 2) AS tma_medio`;
  query += `
    FROM madm.view_base_olos_temp
    WHERE call_date::date >= $1::date
      AND call_date::date < $2::date
  `;
  const params = [
    start, end,
    QUALIFICATIONS.productive,
    QUALIFICATIONS.appointments,
    QUALIFICATIONS.occurrences.map(v => v.trim().toLowerCase()),
    QUALIFICATIONS.failures,
  ];
  query += gran
    ? ` GROUP BY (DATE_TRUNC('${gran}', call_date) AT TIME ZONE 'UTC')::date, agent_name, equipe, campaign_name ORDER BY periodo, colaborador`
    : ` GROUP BY agent_name, equipe, campaign_name ORDER BY colaborador`;
  const result = await analyticsQuery(query, params);
  const label = `ligacoes:${gran || 'agg'}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, gran ? CAP_SERIES : CAP_AGG, label);
}

// ─── LIGAÇÕES — tabulações ───────────────────────────────────────────────────
export async function loadLigacoesTabulacoes({ start, end, categoria }) {
  const categories = {
    productive:   QUALIFICATIONS.productive,
    appointments: QUALIFICATIONS.appointments,
    occurrences:  QUALIFICATIONS.occurrences,
    failures:     QUALIFICATIONS.failures,
  };
  const qualifications = categories[categoria];
  if (!qualifications) {
    const err = new Error('categoria inválida');
    err.status = 400;
    throw err;
  }
  const query = `
    SELECT qualification_name AS tabulacao,
           agent_name AS colaborador,
           equipe AS equipe,
           COUNT(*)::int AS total
    FROM madm.view_base_olos_temp
    WHERE call_date::date >= $1::date
      AND call_date::date < $2::date
      AND LOWER(BTRIM(qualification_name)) = ANY($3::text[])
    GROUP BY qualification_name, agent_name, equipe
    ORDER BY total DESC, tabulacao
  `;
  const params = [start, end, qualifications.map(v => v.trim().toLowerCase())];
  const result = await analyticsQuery(query, params);
  const label = `ligacoes-tab:${categoria}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, CAP_AGG, label);
}

// ─── LIGAÇÕES PRODUTIVAS ─────────────────────────────────────────────────────
export async function loadLigacoesProdutivas({ start, end, equipe, colaborador }) {
  let query = `
    SELECT COUNT(*)::int AS total
    FROM madm.view_base_olos_temp
    WHERE qualification_name = ANY($1::text[])
      AND call_date::date >= $2::date
      AND call_date::date < $3::date
  `;
  const params = [QUALIFICATIONS.productive, start, end];
  let idx = 4;
  if (equipe && equipe !== 'todas') {
    const nomesEquipe = await resolveNomesPorEquipe(equipe);
    if (nomesEquipe.length === 0) return [{ total: 0 }];
    query += ` AND agent_name = ANY($${idx}::text[])`;
    params.push(nomesEquipe); idx++;
  }
  if (colaborador) {
    query += ` AND LOWER(TRIM(agent_name)) = LOWER(TRIM($${idx}))`;
    params.push(colaborador);
  }
  const result = await analyticsQuery(query, params);
  return result.rows;
}

// ─── LEADS POR ETAPA ─────────────────────────────────────────────────────────
export async function loadLeadsStages({ start, end, equipe, produto }) {
  let query = `
    SELECT
      COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável') AS colaborador,
      COALESCE(e.nome_etapa,    'Sem etapa')    AS etapa_lead,
      COALESCE(p.nome_pipeline, 'Sem pipeline') AS pipeline,
      COUNT(DISTINCT d.deal_id)::int            AS total
    FROM core.deals d
    LEFT JOIN core.colaboradores c
      ON c.colaborador_id = COALESCE(d.closer_id, d.responsavel_id)
    LEFT JOIN ops.crm_pipelines p
      ON p.pipeline_id = d.pipeline_id
    LEFT JOIN ops.crm_etapas e
      ON e.etapa_id = d.etapa_id
     AND (p.crm IS NULL OR e.crm = p.crm)
    LEFT JOIN core.produtos pr
      ON pr.produto_id = d.produto_id
    WHERE d.data_distribuicao_comercial IS NOT NULL
      AND d.data_distribuicao_comercial::date >= $1::date
      AND d.data_distribuicao_comercial::date <  $2::date
  `;
  const params = [start, end];
  let idx = 3;
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
  query += prod.clause;
  params.push(...prod.params);
  query += `
    GROUP BY
      COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável'),
      COALESCE(e.nome_etapa,    'Sem etapa'),
      COALESCE(p.nome_pipeline, 'Sem pipeline')
    ORDER BY colaborador, etapa_lead
  `;
  const result = await analyticsQuery(query, params);
  const label = 'leads-stages';
  warnIfLarge(result.rows, label);
  return capRows(result.rows, CAP_AGG, label);
}

// ─── CATÁLOGO DE ETAPAS ──────────────────────────────────────────────────────
export async function loadLeadsStagesCatalog({ start, end }) {
  const query = `
    SELECT DISTINCT
      COALESCE(p.nome_pipeline, 'Sem pipeline')  AS pipeline,
      COALESCE(p.crm,           '(sem crm)')     AS crm,
      COALESCE(e.nome_etapa,    'Sem etapa')     AS etapa,
      COALESCE(pr.nome_produto, '(sem produto)') AS produto
    FROM core.deals d
    LEFT JOIN ops.crm_pipelines p ON p.pipeline_id = d.pipeline_id
    LEFT JOIN ops.crm_etapas   e ON e.etapa_id   = d.etapa_id
                                AND (p.crm IS NULL OR e.crm = p.crm)
    LEFT JOIN core.produtos    pr ON pr.produto_id = d.produto_id
    WHERE d.data_distribuicao_comercial IS NOT NULL
      AND d.data_distribuicao_comercial::date >= $1::date
      AND d.data_distribuicao_comercial::date <  $2::date
    ORDER BY pipeline, etapa, produto
  `;
  const result = await analyticsQuery(query, [start, end]);
  return result.rows;
}

// ─── PERFORMANCE SEMANAL ─────────────────────────────────────────────────────
export async function loadWeekly({ start, end }) {
  const query = `
    SELECT
      (DATE_TRUNC('week', data_assinatura) AT TIME ZONE 'UTC')::date as semana,
      COUNT(*)::int as vendas
    FROM core.view_assinados
    WHERE (data_assinatura AT TIME ZONE 'UTC')::date >= $1
      AND (data_assinatura AT TIME ZONE 'UTC')::date < $2
    GROUP BY (DATE_TRUNC('week', data_assinatura) AT TIME ZONE 'UTC')::date
    ORDER BY semana
  `;
  const result = await analyticsQuery(query, [start, end]);
  return result.rows.map(row => ({
    semana: row.semana,
    vendas: row.vendas,
    meta: 5,
  }));
}

// ─── ASSINADOS DIÁRIO POR EQUIPE ─────────────────────────────────────────────
export async function loadAssinadosDiarioPorEquipe({ inicio, fim, equipe }) {
  let query = `
    SELECT equipe_responsavel_assinatura as equipe,
           (data_assinatura AT TIME ZONE 'UTC')::date as dia,
           COUNT(*)::int as total
    FROM core.view_assinados
    WHERE (data_assinatura AT TIME ZONE 'UTC')::date >= $1
      AND (data_assinatura AT TIME ZONE 'UTC')::date < $2
  `;
  const params = [inicio, fim];
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(equipe_responsavel_assinatura)) = LOWER(TRIM($3))`;
    params.push(equipe);
  }
  query += ` GROUP BY equipe_responsavel_assinatura, dia ORDER BY dia, equipe_responsavel_assinatura`;
  const result = await analyticsQuery(query, params);
  const label = 'assinados-diario-eq';
  warnIfLarge(result.rows, label);
  const capped = capRows(result.rows, CAP_SERIES, label);
  return capped.map(item => ({
    equipe: item.equipe,
    time: item.equipe,
    dia: item.dia instanceof Date ? item.dia.toISOString().slice(0, 10) : item.dia,
    total: Number(item.total) || 0,
  }));
}

// ─── ASSINADOS DIÁRIO POR COLABORADOR ────────────────────────────────────────
export async function loadAssinadosDiarioColaborador({ inicio, fim }) {
  const query = `
    SELECT (data_assinatura AT TIME ZONE 'UTC')::date as dia,
           consultor_responsavel_assinatura as colaborador,
           COUNT(*)::int as total
    FROM core.view_assinados
    WHERE (data_assinatura AT TIME ZONE 'UTC')::date >= $1
      AND (data_assinatura AT TIME ZONE 'UTC')::date < $2
    GROUP BY dia, consultor_responsavel_assinatura
    ORDER BY dia, consultor_responsavel_assinatura
  `;
  const result = await analyticsQuery(query, [inicio, fim]);
  const label = 'assinados-diario-col';
  warnIfLarge(result.rows, label);
  const capped = capRows(result.rows, CAP_SERIES, label);
  return capped.map(item => ({
    dia: item.dia instanceof Date ? item.dia.toISOString().slice(0, 10) : item.dia,
    colaborador: item.colaborador,
    total: Number(item.total) || 0,
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// DEMANDA — CACHEADO INTERNAMENTE (compartilhado entre 3 rotas)
// ─────────────────────────────────────────────────────────────────────────────

async function loadDemandaUncached({ tipo, equipe, produto }) {
  const baseSelect = `
    SELECT
      c.nome AS colaborador,
      COALESCE(cc.nome_equipe, '') AS equipe,
      a.lead_id,
      a.deal_id,
      (a.data_emissao    AT TIME ZONE 'UTC')::date AS data_emissao,
      (a.data_assinatura AT TIME ZONE 'UTC')::date AS data_assinatura,
      (d.data_ganho      AT TIME ZONE 'UTC')::date AS data_ganho,
      p.nome_pipeline AS pipeline,
      e.nome_etapa    AS etapa,
      COALESCE(pr.nome_produto, 'Sem produto') AS produto
    FROM core.assinaturas a
    INNER JOIN core.colaboradores c
      ON c.colaborador_id = a.consultor_responsavel_assinatura_id
    INNER JOIN core.deals d
      ON d.deal_id = a.deal_id
    LEFT JOIN core.view_app_colaboradores cc
      ON cc.nome = c.nome
    LEFT JOIN ops.crm_pipelines p
      ON p.pipeline_id = d.pipeline_id AND p.crm = 'HUBSPOT'
    LEFT JOIN ops.crm_etapas e
      ON e.etapa_id = d.etapa_id AND e.crm = 'HUBSPOT'
    LEFT JOIN core.produtos pr
      ON pr.produto_id = d.produto_id
  `;
  const where = tipo === 'atual'
    ? `WHERE a.data_assinatura >= DATE_TRUNC('month', CURRENT_DATE)`
    : `WHERE a.data_assinatura <  DATE_TRUNC('month', CURRENT_DATE)
         AND d.data_ganho IS NULL`;
  let query = `${baseSelect} ${where}`;
  const params = [];
  let idx = 1;
  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(cc.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
  query += prod.clause;
  params.push(...prod.params);
  query += ` ORDER BY a.data_assinatura DESC`;
  const result = await analyticsQuery(query, params);
  const label = `demanda:${tipo}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, CAP_DETAIL, label);
}

export async function loadDemanda({ tipo, equipe, produto }) {
  const key = `demanda:${tipo}:${equipe || 'todas'}:${produto || 'Todos'}`;
  return cacheFirst(
    key,
    () => loadDemandaUncached({ tipo, equipe, produto }),
    { ttlMs: 300_000, staleMs: 1_800_000 } // 5min / 30min
  );
}