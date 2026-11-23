// backend/services/bd/metricsLoaders.js

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
// HELPERS ESCALARES — soma `total` de um Array<{ total }>
// Usados pelos wrappers load*Total para consumidores que só precisam do
// agregado do período (ex.: inteComerceRawAnalytics.mergeHubSpot).
// ═════════════════════════════════════════════════════════════════════════════

function sumTotal(rows) {
  if (Array.isArray(rows)) {
    let acc = 0;
    for (const r of rows) {
      const n = Number(r?.total);
      if (Number.isFinite(n)) acc += n;
    }
    return acc;
  }
  if (typeof rows === 'number' && Number.isFinite(rows)) return rows;
  return null;
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
// CACHE KEY 
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
// LOADERS PUROS
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

// Wrapper escalar — devolve `number` (soma `total` do período inteiro)
export async function loadEmitidosTotal(params = {}) {
  const rows = await loadEmitidos({ ...params, granularity: null });
  return sumTotal(rows);
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

// Wrapper escalar
export async function loadAssinadosTotal(params = {}) {
  const rows = await loadAssinados({ ...params, granularity: null });
  return sumTotal(rows);
}

// ─── PROTOCOLADOS ──────────────────────────────────
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

// Wrapper escalar — devolve `number` (soma `total` do período inteiro)
export async function loadProtocoladosTotal(params = {}) {
  const rows = await loadProtocolados({ ...params, granularity: null });
  return sumTotal(rows);
}

// ─── GANHOS ────────────────────────────────────────
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

// Wrapper escalar — devolve `number` (soma `total` do período inteiro)
export async function loadGanhosTotal(params = {}) {
  const rows = await loadGanhos({ ...params, granularity: null });
  return sumTotal(rows);
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

// Wrapper escalar — devolve `number` (soma `total` do período inteiro)
export async function loadPerdidosTotal(params = {}) {
  const rows = await loadPerdidos({ ...params, granularity: null });
  return sumTotal(rows);
}

// ─── DESQUALIFICADOS (banco, com mode safra/produção) ─────────────────────────────────────────────────
// Negócios que ENTRARAM na etapa 6659 dentro do período E continuam nela hoje.
//   • h.etapa_nova_id = 6659  → a movimentação que levou o negócio à etapa
//   • d.etapa_id      = 6659  → o negócio ainda está desqualificado hoje
//   • DISTINCT ON (d.deal_id) + ORDER BY data_movimentacao DESC
//       → a entrada MAIS RECENTE de cada negócio, uma linha por deal
//   • responsável/equipe: COALESCE(d.closer_id, d.responsavel_id), o mesmo
//       critério de leads-recebidos
export const DESQ_ETAPA_ID = 6659;

export async function loadDesqualificados({ start, end, equipe, produto, granularity, mode }) {
  const gran = mapGranularity(granularity);
  // SAFRA    → também exige que o negócio tenha sido CRIADO no período.
  // PRODUÇÃO → só a entrada na etapa 6659 no período (ignora a criação).
  const isSafra = String(mode || '').toLowerCase() === 'safra';
  const safraClause = isSafra
    ? `
      AND d.data_criacao_deal::date >= $1::date
      AND d.data_criacao_deal::date <  $2::date`
    : '';

  let base = `
    SELECT DISTINCT ON (d.deal_id)
      d.deal_id,
      COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável') AS colaborador,
      COALESCE(c.nome_equipe, '') AS equipe,
      h.data_movimentacao::date AS data_entrada_etapa
    FROM core.historico_movimentacoes h
    INNER JOIN core.deals d ON d.deal_id = h.deal_id
    LEFT JOIN core.colaboradores c
      ON c.colaborador_id = COALESCE(d.closer_id, d.responsavel_id)
    LEFT JOIN core.produtos pr ON pr.produto_id = d.produto_id
    WHERE h.etapa_nova_id = ${DESQ_ETAPA_ID}
      AND d.etapa_id = ${DESQ_ETAPA_ID}
      AND h.data_movimentacao::date >= $1::date
      AND h.data_movimentacao::date <  $2::date${safraClause}
  `;

  const params = [start, end];
  let idx = 3;
  if (equipe && equipe !== 'todas') {
    base += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
  base += prod.clause;
  params.push(...prod.params);
  base += ` ORDER BY d.deal_id, h.data_movimentacao DESC`;

  const query = gran
    ? `SELECT colaborador, equipe,
              (DATE_TRUNC('${gran}', data_entrada_etapa))::date AS periodo,
              COUNT(*)::int AS total
        FROM (${base}) q
        GROUP BY colaborador, equipe, (DATE_TRUNC('${gran}', data_entrada_etapa))::date
        ORDER BY periodo, colaborador`
    : `SELECT colaborador, equipe, COUNT(*)::int AS total
        FROM (${base}) q
        GROUP BY colaborador, equipe
        ORDER BY colaborador`;

  const result = await analyticsQuery(query, params);
  const label = `desqualificados:${gran || 'agg'}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, gran ? CAP_SERIES : CAP_AGG, label);
}

// Wrapper escalar — devolve `number` (soma `total` do período inteiro)
export async function loadDesqualificadosTotal(params = {}) {
  const rows = await loadDesqualificados({ ...params, granularity: null });
  return sumTotal(rows);
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

// ─── QUANTIDADE DE CARDS POR ETAPA (Recebidos / Em contato / Coleta / Validação Sup) ───

export const STAGE_COUNT_ETAPAS = Object.freeze({
  em_contato:           Object.freeze([6650, 8594, 14105]),
  coleta:               Object.freeze([8595, 6651, 14106]),
});

function etapaList(ids) {
  return ids.map((n) => {
    const v = Number(n);
    if (!Number.isInteger(v) || v <= 0) throw new Error(`etapa_id inválido: ${n}`);
    return v;
  }).join(', ');
}

/**
 * @param {object}   p
 * @param {string}   p.start          data inicial (inclusiva, YYYY-MM-DD)
 * @param {string}   p.end            data final (exclusiva, YYYY-MM-DD)
 * @param {string}  [p.equipe]        filtra por c.nome_equipe
 * @param {string}  [p.produto]       filtra por core.produtos.nome_produto
 * @param {string}  [p.mode]          'safra' aplica o filtro de criação do deal
 * @param {string[]|null} [p.colaboradorIds] null = conta inteira; [] = escopo vazio
 * @returns {Promise<Array<{colaborador_id:string|null, colaborador:string, equipe:string,
 *   recebidos:number, em_contato:number, coleta:number,}>>}
 */
export async function loadStageCounts({ start, end, equipe, produto, mode, colaboradorIds = null }) {
  if (Array.isArray(colaboradorIds) && colaboradorIds.length === 0) return [];

  const isSafra = String(mode || '').toLowerCase() === 'safra';
  const params = [start, end];
  let idx = 3;
  let filters = '';

  if (isSafra) {
    filters += `
      AND d.data_criacao_deal IS NOT NULL
      AND d.data_criacao_deal::date >= $1::date
      AND d.data_criacao_deal::date <  $2::date`;
  }
  if (equipe && equipe !== 'todas') {
    filters += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  if (Array.isArray(colaboradorIds)) {
    filters += ` AND COALESCE(d.closer_id, d.responsavel_id)::text = ANY($${idx}::text[])`;
    params.push(colaboradorIds.map(String)); idx++;
  }
  const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
  filters += prod.clause;
  params.push(...prod.params);

  const joins = `
      LEFT JOIN core.colaboradores c
        ON c.colaborador_id = COALESCE(d.closer_id, d.responsavel_id)
      LEFT JOIN core.produtos pr
        ON pr.produto_id = d.produto_id`;
  const cols = `
        d.deal_id,
        c.colaborador_id::text                                AS colaborador_id,
        COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável') AS colaborador,
        COALESCE(c.nome_equipe, '')                           AS equipe`;
  const stageCte = (etapa, ids) => `
      SELECT ${cols}, '${etapa}' AS etapa
      FROM core.historico_movimentacoes h
      INNER JOIN core.deals d ON d.deal_id = h.deal_id${joins}
      WHERE h.etapa_nova_id IN (${etapaList(ids)})
        AND h.data_movimentacao::date >= $1::date
        AND h.data_movimentacao::date <  $2::date${filters}`;

   const query = `
    WITH movimentos AS (
      SELECT ${cols}, 'recebidos' AS etapa
      FROM core.deals d${joins}
      WHERE d.data_distribuicao_comercial IS NOT NULL
        AND d.data_distribuicao_comercial::date >= $1::date
        AND d.data_distribuicao_comercial::date <  $2::date${filters}
      UNION ALL${stageCte('em_contato', STAGE_COUNT_ETAPAS.em_contato)}
      UNION ALL${stageCte('coleta', STAGE_COUNT_ETAPAS.coleta)}
    )
    SELECT
      colaborador_id, colaborador, equipe,
      COUNT(DISTINCT deal_id) FILTER (WHERE etapa = 'recebidos')::int            AS recebidos,
      COUNT(DISTINCT deal_id) FILTER (WHERE etapa = 'em_contato')::int           AS em_contato,
      COUNT(DISTINCT deal_id) FILTER (WHERE etapa = 'coleta')::int               AS coleta
    FROM movimentos
    GROUP BY colaborador_id, colaborador, equipe
    ORDER BY recebidos DESC, colaborador
  `;

  const result = await analyticsQuery(query, params);
  const label = 'stage-counts';
  warnIfLarge(result.rows, label);
  return capRows(result.rows, CAP_AGG, label);
}


// ─── ASSINADOS / EMITIDOS DO FUNIL (core.assinaturas, safra x produção) ──────

export async function loadAssinaturasFunil({ start, end, equipe, produto, mode, colaboradorIds = null }) {
  if (Array.isArray(colaboradorIds) && colaboradorIds.length === 0) return [];

  const isSafra = String(mode || '').toLowerCase() === 'safra';
  const params = [start, end];
  let idx = 3;
  let filters = '';
  if (isSafra) {
    filters += `
      AND b.data_criacao_deal IS NOT NULL
      AND b.data_criacao_deal::date >= $1::date
      AND b.data_criacao_deal::date <  $2::date`;
  }
  if (equipe && equipe !== 'todas') {
    filters += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }
  if (Array.isArray(colaboradorIds)) {
    filters += ` AND b.dono_id::text = ANY($${idx}::text[])`;
    params.push(colaboradorIds.map(String)); idx++;
  }
  const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
  filters += prod.clause;
  params.push(...prod.params);

  const query = `
    WITH base AS (
      SELECT
        a.assinatura_id,
        a.produto_id,
        COALESCE(d1.deal_id, d2.deal_id)                     AS deal_id,
        COALESCE(d1.data_criacao_deal, d2.data_criacao_deal) AS data_criacao_deal,
        COALESCE(d1.closer_id, d1.responsavel_id,
                 d2.closer_id, d2.responsavel_id)           AS dono_deal_id,
        a.consultor_responsavel_assinatura_id,
        a.consultor_responsavel_emissao_id,
        a.data_emissao,
        a.data_assinatura,
        a.status_assinatura
      FROM core.assinaturas a
      LEFT JOIN core.deals d1
        ON d1.deal_id = a.deal_id
      LEFT JOIN core.deals d2
        ON a.deal_id IS NULL
       AND d2.hubspot_deal_id = a.hubspot_deal_id
       AND d2.crm_origem = 'HUBSPOT'
       AND d2.is_deleted IS NOT TRUE
      WHERE a.tipo_emissao = 'ORIGINAL'
        AND a.data_cancelamento IS NULL
    ),
    eventos AS (
      SELECT b.*, 'emitidos' AS tipo,
             COALESCE(b.consultor_responsavel_emissao_id,
                      b.consultor_responsavel_assinatura_id,
                      b.dono_deal_id) AS dono_id
      FROM base b
      WHERE b.data_emissao IS NOT NULL
        AND (b.data_emissao AT TIME ZONE 'UTC')::date >= $1::date
        AND (b.data_emissao AT TIME ZONE 'UTC')::date <  $2::date
      UNION ALL
      SELECT b.*, 'assinados' AS tipo,
             COALESCE(b.consultor_responsavel_assinatura_id,
                      b.dono_deal_id) AS dono_id
      FROM base b
      WHERE b.data_assinatura IS NOT NULL
        AND UPPER(TRIM(COALESCE(b.status_assinatura, ''))) = 'ASSINADO'
        AND (b.data_assinatura AT TIME ZONE 'UTC')::date >= $1::date
        AND (b.data_assinatura AT TIME ZONE 'UTC')::date <  $2::date
    )
    SELECT
      c.colaborador_id::text                                AS colaborador_id,
      COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável') AS colaborador,
      COALESCE(c.nome_equipe, '')                           AS equipe,
      COUNT(DISTINCT COALESCE(b.deal_id::text, 'assinatura:' || b.assinatura_id::text))
        FILTER (WHERE b.tipo = 'emitidos')::int  AS emitidos,
      COUNT(DISTINCT COALESCE(b.deal_id::text, 'assinatura:' || b.assinatura_id::text))
        FILTER (WHERE b.tipo = 'assinados')::int AS assinados
    FROM eventos b
    LEFT JOIN core.colaboradores c ON c.colaborador_id = b.dono_id
    LEFT JOIN core.produtos pr     ON pr.produto_id    = b.produto_id
    WHERE 1 = 1${filters}
    GROUP BY c.colaborador_id, COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável'), COALESCE(c.nome_equipe, '')
    ORDER BY assinados DESC, colaborador
  `;

  const result = await analyticsQuery(query, params);
  const label = `assinaturas-funil:${isSafra ? 'safra' : 'producao'}`;
  warnIfLarge(result.rows, label);
  return capRows(result.rows, CAP_AGG, label);
}

// ─── DISCADOR × ASSINATURAS ──────────────────────────────────────────────────
// Chave de nome usada em TODOS os cruzamentos por nome: sem acento, maiúscula,
// espaços colapsados. Antes o cruzamento era só UPPER(TRIM()), então
// "João  Silva" (OLOS) × "Joao Silva" (CRM) não batiam e a linha ficava sem
// equipe/unidade.
const SQL_ACENTOS = 'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ';
const SQL_SEM_ACENTOS = 'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn';
const sqlNameKey = (expr) =>
  `UPPER(REGEXP_REPLACE(TRIM(TRANSLATE(COALESCE(${expr}, ''), '${SQL_ACENTOS}', '${SQL_SEM_ACENTOS}')), '\\s+', ' ', 'g'))`;

// Telefone só com dígitos, sem zeros à esquerda e sem DDI 55.
// Antes era igualdade exata (a.telefone = o.number): "+55 (11) 9..." ×
// "119..." não cruzava e a assinatura sumia do relatório.
const sqlPhoneKey = (expr) =>
  `REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(${expr}::text, ''), '\\D', '', 'g'), '^0+', ''), '^55(?=\\d{10,11}$)', '')`;

export async function loadDiscadorResultado({ start, end }) {
  const query = `
    WITH periodo AS MATERIALIZED (
      SELECT $1::date AS inicio, $2::date AS fim
    ),
    equipes_excluidas (equipe) AS (
      VALUES
        ('Coordenacao Closer'),('Departamento Backoffice'),('Diretoria'),
        ('Departamento Marketing'),('Departamento Comercial'),
        ('Equipe Erika'),('Equipe Leonardo'),('Equipe Leticia'),
        ('Equipe Michael'),('Equipe Erica'),('Equipe Thales'),
        ('Equipe Yuri'),('Equipe Rodolfo'),('Equipe Jennifer'),
        ('Equipe Natalia'),('Equipe Maria Eduarda'),('Equipe Reciclagem'),
        (''),('Equipe'),('Equipe Camila'),('Sales Ops'),
        ('Equipe Elizandra'),('Equipe Bruno Abreu'),('Equipe Lucas Magno'),
        ('Equipe SP1'),('Equipe Marcia'),('Equipe Lucilene'),('backoffice'),
        ('Equipe Debora'),('Equipe Curitiba'),('Equipe Gabriela Toledo'),
        ('Equipe SP01'),('Equipe Adriele'),('Equipe Toledo'),('Equipe Priscila'),
        ('Equipe Maiana'),('Equipe Marcio')
    ),
    equipes_excluidas_norm AS MATERIALIZED (
      SELECT DISTINCT LOWER(TRIM(equipe)) AS equipe_norm
      FROM equipes_excluidas
    ),
    classificacao (qualification_name, categoria) AS MATERIALIZED (
      VALUES
        ('Acidente a mais de 20 anos','cpc_sem_negocio'),
        ('Acidente recente','cpc_sem_negocio'),
        ('Aposentado','cpc_sem_negocio'),
        ('BPC - LOAS Desqualificado','cpc_sem_negocio'),
        ('BPC - LOAS Ganho','cpc_sem_negocio'),
        ('Cliente atritado','cpc_sem_negocio'),
        ('Cliente desconhece o cadastro','cpc_sem_negocio'),
        ('Contribuinte individual - autonomo','cpc_sem_negocio'),
        ('Em processo com a MADM','cpc_sem_negocio'),
        ('Fora do periodo aquisitivo','cpc_sem_negocio'),
        ('Fora do periodo de graca','cpc_sem_negocio'),
        ('Ja recebe o auxilio-acidente','cpc_sem_negocio'),
        ('Ja revisado','cpc_sem_negocio'),
        ('Ja tem acao','cpc_sem_negocio'),
        ('Ja tem advogado','cpc_sem_negocio'),
        ('Ja tem processo de auxilio acidente','cpc_sem_negocio'),
        ('Nao aposentado','cpc_sem_negocio'),
        ('Nao concomitante','cpc_sem_negocio'),
        ('Nao tem direito','cpc_sem_negocio'),
        ('Nunca sofreu acidente','cpc_sem_negocio'),
        ('Nunca trabalhou de carteira assinada','cpc_sem_negocio'),
        ('Pensionista','cpc_sem_negocio'),
        ('Recebendo auxilio-doenca','cpc_sem_negocio'),
        ('Sem interesse','cpc_sem_negocio'),
        ('Sem sequela','cpc_sem_negocio'),
        ('Trabalhando','cpc_sem_negocio'),
        ('Emissao de contrato','cpc_a'),
        ('Pediu contato via WhatsApp','cpc_a'),
        ('Tratativa via WhatsApp','cpc_a'),
        ('Coleta de documentacao','cpc_a'),
        ('Mudo','mudo'),
        ('Queda de ligacao','queda_ligacao')
    ),
    classificacao_norm AS MATERIALIZED (
      SELECT LOWER(TRIM(qualification_name)) AS qualification_name_norm, categoria
      FROM classificacao
    ),

    -- CTE de discagens: filtro de período sargável, uso de classificacao_norm
    base AS (
      SELECT
        COALESCE(NULLIF(TRIM(o.agent_name),''),'(sem agente)')      AS agent_name,
        COALESCE(NULLIF(TRIM(o.campaign_name),''),'(sem campanha)') AS campaign_name,
        o.tma,
        COALESCE(c.categoria,'outros') AS categoria
      FROM madm.view_base_olos_temp o
      CROSS JOIN periodo p
      LEFT JOIN classificacao_norm c
        ON LOWER(TRIM(o.qualification_name)) = c.qualification_name_norm
      WHERE o.call_date >= p.inicio
        AND o.call_date <  p.fim + INTERVAL '1 day'
    ),

    colaboradores_norm AS (
      SELECT
        c.colaborador_id,
        TRIM(c.nome)                       AS nome,
        NULLIF(TRIM(c.nome_equipe), '')    AS nome_equipe,
        c.unidade_id,
        ${sqlNameKey('c.nome')}            AS nome_key,
        (ee.equipe_norm IS NOT NULL)       AS excluida
      FROM core.colaboradores c
      LEFT JOIN equipes_excluidas_norm ee
        ON LOWER(TRIM(COALESCE(c.nome_equipe,''))) = ee.equipe_norm
      WHERE NULLIF(TRIM(c.nome), '') IS NOT NULL
    ),
    colaboradores_unicos AS (
      SELECT
        nome_key,
        (ARRAY_AGG(colaborador_id ORDER BY excluida, colaborador_id))[1] AS colaborador_id,
        (ARRAY_AGG(unidade_id ORDER BY excluida, (unidade_id IS NULL), colaborador_id))[1] AS unidade_id,
        STRING_AGG(DISTINCT nome_equipe, ' / ' ORDER BY nome_equipe)
          FILTER (WHERE NOT excluida AND nome_equipe IS NOT NULL) AS nome_equipe,
        BOOL_AND(excluida) AS somente_equipes_excluidas
      FROM colaboradores_norm
      GROUP BY nome_key
    ),
    colaboradores_por_id AS (
      SELECT colaborador_id, MAX(nome) AS nome
      FROM colaboradores_norm
      GROUP BY colaborador_id
    ),

    assinaturas_unicas AS MATERIALIZED (
      SELECT DISTINCT ON (a.deal_id)
        a.deal_id,
        ${sqlPhoneKey('a.telefone')} AS phone_key,
        a.data_assinatura,
        a.consultor_responsavel_assinatura_id
      FROM core.assinaturas a
      CROSS JOIN periodo p
      WHERE a.deal_id IS NOT NULL
        AND a.data_assinatura >= p.inicio
        AND a.data_assinatura <  p.fim + INTERVAL '1 day'
      ORDER BY a.deal_id, a.data_assinatura DESC NULLS LAST
    ),

    ultima_ligacao AS MATERIALIZED (
      SELECT DISTINCT ON (l.phone_key)
        l.phone_key, l.agent_name, l.campaign_name
      FROM (
        SELECT
          ${sqlPhoneKey('o.number')}        AS phone_key,
          NULLIF(TRIM(o.agent_name), '')    AS agent_name,
          NULLIF(TRIM(o.campaign_name), '') AS campaign_name,
          o.call_date
        FROM madm.view_base_olos_temp o
        WHERE o.number IS NOT NULL
      ) l
      CROSS JOIN periodo p
      WHERE LENGTH(l.phone_key) >= 10
        AND l.phone_key IN (
          SELECT phone_key
          FROM assinaturas_unicas
          WHERE phone_key IS NOT NULL
            AND phone_key <> ''
        )
      ORDER BY
        l.phone_key,
        (l.call_date >= p.inicio
          AND l.call_date <  p.fim + INTERVAL '1 day') DESC,
        l.call_date DESC NULLS LAST
    ),

    -- Crédito da assinatura: agente da última ligação para o telefone.
    -- Se esse agente NÃO existe no cadastro de colaboradores (login do OLOS
    -- diferente do nome, agente vazio etc.), o crédito vai para o consultor
    -- responsável pela assinatura — assim ela ganha equipe/unidade e não some
    -- quando se filtra por unidade/equipe.
    assinaturas_atribuidas AS (
      SELECT
        au.deal_id,
        CASE
          WHEN cu_ag.nome_key IS NOT NULL THEN ul.agent_name
          ELSE COALESCE(NULLIF(TRIM(cp.nome), ''), ul.agent_name, '(sem agente)')
        END AS agent_name,
        COALESCE(ul.campaign_name, '(sem campanha)') AS campaign_name
      FROM assinaturas_unicas au
      INNER JOIN ultima_ligacao ul
        ON ul.phone_key = au.phone_key
      LEFT JOIN colaboradores_unicos cu_ag
        ON ul.agent_name IS NOT NULL
       AND cu_ag.nome_key = ${sqlNameKey('ul.agent_name')}
      LEFT JOIN colaboradores_por_id cp
        ON cp.colaborador_id = au.consultor_responsavel_assinatura_id
    ),
    assinaturas_agregadas AS (
      SELECT
        ${sqlNameKey('agent_name')}    AS agent_key,
        UPPER(TRIM(campaign_name))     AS campaign_key,
        MAX(agent_name)                AS agent_name,
        MAX(campaign_name)             AS campaign_name,
        COUNT(*)                       AS assinados
      FROM assinaturas_atribuidas
      GROUP BY 1, 2
    ),
    discagens_agregadas AS (
      SELECT
        ${sqlNameKey('agent_name')}    AS agent_key,
        UPPER(TRIM(campaign_name))     AS campaign_key,
        MAX(agent_name)                AS agent_name,
        MAX(campaign_name)             AS campaign_name,
        COUNT(*) AS total_discagens,
        COUNT(*) FILTER (WHERE categoria='cpc_sem_negocio') AS cpc_sem_negocio,
        COUNT(*) FILTER (WHERE categoria='cpc_a')           AS cpc_a,
        COUNT(*) FILTER (WHERE categoria='mudo')            AS mudo,
        COUNT(*) FILTER (WHERE categoria='queda_ligacao')   AS queda_ligacao,
        COUNT(*) FILTER (WHERE categoria IN ('cpc_sem_negocio','cpc_a')) AS cpc_total,
        SUM(COALESCE(tma,0)) AS tma_total
      FROM base
      GROUP BY 1, 2
    )
    SELECT
      COALESCE(d.agent_name, s.agent_name)       AS agent_name,
      COALESCE(d.campaign_name, s.campaign_name) AS campaign_name,
      cu.colaborador_id,
      cu.unidade_id,
      cu.nome_equipe,
      COALESCE(d.total_discagens,0) AS total_discagens,
      COALESCE(d.cpc_sem_negocio,0) AS cpc_sem_negocio,
      COALESCE(d.cpc_a,0)           AS cpc_a,
      COALESCE(d.mudo,0)            AS mudo,
      COALESCE(d.queda_ligacao,0)   AS queda_ligacao,
      COALESCE(d.cpc_total,0)       AS cpc_total,
      COALESCE(d.tma_total,0)       AS tma_total,
      COALESCE(s.assinados,0)       AS assinados,
      ROUND(
        100.0 * COALESCE(s.assinados,0)::numeric
        / NULLIF(COALESCE(d.cpc_a,0),0),
        2
      ) AS conversao_ass_cpc_a,
      p.inicio AS periodo_inicio,
      p.fim    AS periodo_fim
    FROM discagens_agregadas d
    FULL OUTER JOIN assinaturas_agregadas s
      ON s.agent_key    = d.agent_key
     AND s.campaign_key = d.campaign_key
    LEFT JOIN colaboradores_unicos cu
      ON cu.nome_key = COALESCE(d.agent_key, s.agent_key)
    CROSS JOIN periodo p
    WHERE COALESCE(cu.somente_equipes_excluidas, FALSE) = FALSE
    ORDER BY 1, 2
  `;

  const result = await analyticsQuery(query, [start, end]);
  const label = 'discador-resultado';
  warnIfLarge(result.rows, label);

  // Postgres devolve bigint como string no driver `pg`.
  const rows = result.rows.map((r) => ({
    agent_name: r.agent_name,
    campaign_name: r.campaign_name,
    colaborador_id: r.colaborador_id ?? null,
    unidade_id: r.unidade_id == null ? null : Number(r.unidade_id),
    nome_equipe: r.nome_equipe,
    total_discagens: Number(r.total_discagens) || 0,
    cpc_sem_negocio: Number(r.cpc_sem_negocio) || 0,
    cpc_a: Number(r.cpc_a) || 0,
    mudo: Number(r.mudo) || 0,
    queda_ligacao: Number(r.queda_ligacao) || 0,
    cpc_total: Number(r.cpc_total) || 0,
    tma_total: Number(r.tma_total) || 0,
    assinados: Number(r.assinados) || 0,
    conversao_ass_cpc_a: Number(r.conversao_ass_cpc_a) || 0,
    periodo_inicio: r.periodo_inicio,
    periodo_fim: r.periodo_fim,
  }));

  // NÃO truncar: o frontend soma estas linhas. Cortar em CAP_AGG (8.000)
  // fazia assinaturas sumirem em períodos longos.
  if (rows.length > CAP_AGG) {
    console.warn(`[loader:${label}] ${rows.length} linhas (acima de ${CAP_AGG}) — retornando todas.`);
  }
  return rows;
}
