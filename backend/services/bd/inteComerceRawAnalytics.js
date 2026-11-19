// backend/services/bd/inteComerceRawAnalytics.js

import { createHash } from 'node:crypto';
import db from './db.js';
import { cached } from './inteComerceCache.js';
import {
  loadAssinadosTotal,
  loadGanhosTotal,
  loadProtocoladosTotal,
  loadEmitidosTotal,
  loadDesqualificadosTotal,
  loadStageCounts,
  loadAssinaturasFunil,
  metricCacheKey,
} from './metricsLoaders.js';

const STATEMENT_TIMEOUT_MS = 45_000;
const WORK_MEM = process.env.DB_ANALYTICS_WORK_MEM || '64MB';

const HUBSPOT_DATE_FILTER_MODE = (process.env.HUBSPOT_DATE_FILTER_MODE || 'between').toLowerCase();
const HUBSPOT_DISABLE_PRODUCTION_DATE_FILTER = process.env.HUBSPOT_DISABLE_PRODUCTION_DATE_FILTER === 'true';

const EVENT_TYPES = new Set([
  'DEAL_CREATED','RECEBIDO_CORPORATIVO','RECEBIDO_ASSESSOR','TRABALHADO_PROXY',
  'EM_CONTATO','COLETA','CONTRATO','EMITIDO_ORIGINAL','ASSINADO_ORIGINAL',
  'GANHO','PROTOCOLADO','DESQUALIFICADO',
]);
const STAGE_TYPES = new Map([
  ['6650','EM_CONTATO'],['8594','EM_CONTATO'],['14105','EM_CONTATO'],
  ['6651','COLETA'],    ['8595','COLETA'],    ['14106','COLETA'],
  ['6659','DESQUALIFICADO'],
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
const PLACEHOLDER_COLLAB = '(SEM ATRIBUICAO)';
const PLACEHOLDER_TEAM = '(SEM EQUIPE)';

const PRODUCTION_MODES = new Set(['producao', 'producao-3-meses']);

const HUBSPOT_MAX_ATTEMPTS = 3;
const HUBSPOT_ATTEMPT_TIMEOUT_MS = 15_000;

const workMemMatch = /^(\d+)(kB|MB|GB)$/i.exec(WORK_MEM);
const workMemBytes = workMemMatch
  ? Number(workMemMatch[1]) * ({ kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 })[workMemMatch[2].toLowerCase()]
  : NaN;
if (!Number.isSafeInteger(workMemBytes) || workMemBytes < 4 * 1024 ** 2 || workMemBytes > 256 * 1024 ** 2) {
  throw new Error('DB_ANALYTICS_WORK_MEM deve estar entre 4MB e 256MB.');
}

const HS_PROPS_CONFIG = Object.freeze({
  assinaturaDate:        process.env.HUBSPOT_PROP_ASSINATURA_DATE         ?? 'data_da_assinatura',
  assinaturaDateType:    (process.env.HUBSPOT_PROP_ASSINATURA_DATE_TYPE || 'date').toLowerCase() === 'datetime' ? 'datetime' : 'date',
  assinaturaStatus:      process.env.HUBSPOT_PROP_ASSINATURA_STATUS       ?? 'status_do_contrato',
  assinaturaSignedValue: process.env.HUBSPOT_PROP_ASSINATURA_SIGNED_VALUE ?? 'assinado',
  protocoloDate:         process.env.HUBSPOT_PROP_PROTOCOLO_DATE          ?? 'data_do_protocolo',
  protocoloDateType:     (process.env.HUBSPOT_PROP_PROTOCOLO_DATE_TYPE || 'date').toLowerCase() === 'datetime' ? 'datetime' : 'date',
  ganhoDate:             process.env.HUBSPOT_PROP_GANHO_DATE              ?? 'data_do_ganho',
  ganhoDateType:         (process.env.HUBSPOT_PROP_GANHO_DATE_TYPE || 'date').toLowerCase() === 'datetime' ? 'datetime' : 'date',
});

const HUBSPOT_PRODUCT_PROPERTY = process.env.HUBSPOT_PROP_PRODUTO || null;
const HUBSPOT_PRODUCT_MAP = (() => {
  const raw = process.env.HUBSPOT_PRODUCT_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      if (Array.isArray(v) && v.length > 0) out[k] = v.map(String);
    }
    return out;
  } catch { return {}; }
})();

const HUBSPOT_OWNER_PROPERTY = process.env.HUBSPOT_PROP_OWNER || 'hubspot_owner_id';
const HUBSPOT_OWNER_MAP = (() => {
  const raw = process.env.HUBSPOT_OWNER_MAP;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(parsed || {})) {
      if (v != null) out[String(k).trim().toLowerCase()] = String(v);
    }
    return out;
  } catch { return {}; }
})();

const HUBSPOT_DESQ_STAGE_IDS = (() => {
  const raw = process.env.HUBSPOT_DESQ_STAGE_IDS;
  if (!raw) return null;
  const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : null;
})();

const DESQ_STAGE_PRODUCT_MAP = (() => {
  const raw = process.env.HUBSPOT_DESQ_STAGE_PRODUCT_MAP;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const out = {};
      for (const [k, v] of Object.entries(parsed || {})) {
        if (v != null) out[String(k).trim()] = String(v);
      }
      return out;
    } catch (e) {
      console.warn('[hubspot] HUBSPOT_DESQ_STAGE_PRODUCT_MAP inválido:', e?.message);
    }
  }
  return {
    '1419898639': 'Quinquenio',
    '1460263591': 'Isenção de IR Aposentadoria',
  };
})();

function isDesqStageAllowedForProduct(stageId, produto) {
  const requiredProduct = DESQ_STAGE_PRODUCT_MAP[String(stageId)];
  if (!requiredProduct) return true;
  if (!produto) return true;
  return requiredProduct === produto;
}

function selectDesqStages(stages, produto) {
  const all = [...stages.desq];
  const filtered = all.filter((id) => isDesqStageAllowedForProduct(id, produto));
  return { all, filtered };
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
  const t = a.receivedAt - b.receivedAt; if (t) return t;
  const i = Number(a.collaboratorId) - Number(b.collaboratorId); if (i) return i;
  return String(a.team ?? '').localeCompare(String(b.team ?? ''));
}
function localDay(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  const d = Object.fromEntries(parts.map(({ type, value: v }) => [type, v]));
  return `${d.year}-${d.month}-${d.day}`;
}
function utcDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function pickColumn(row, names) {
  for (const n of names) if (row && row[n] != null && row[n] !== '') return row[n];
  return null;
}
function syntheticId(row, prefix) {
  const explicit = pickColumn(row, ['assinatura_id', 'id', 'deal_id', 'hubspot_deal_id']);
  if (explicit != null) return `${prefix}_${explicit}`;
  return `${prefix}_${createHash('sha1').update(JSON.stringify(row)).digest('hex').slice(0, 16)}`;
}
function isSyntheticDealId(dealId) { return dealId == null || String(dealId).startsWith('__view_'); }
function normalizeTeamKey(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeLabel(s) {
  return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const DESQ_STAGE_IDS_FALLBACK = new Set(['6659']);
let DESQ_STAGE_IDS_CACHE = null;
let DESQ_STAGE_IDS_AT = 0;
const DESQ_STAGE_IDS_TTL = 5 * 60_000;
async function getDesqStageIds(client) {
  const now = Date.now();
  if (DESQ_STAGE_IDS_CACHE && now - DESQ_STAGE_IDS_AT < DESQ_STAGE_IDS_TTL) return DESQ_STAGE_IDS_CACHE;
  try {
    const { rows } = await client.query(`SELECT etapa_id::text AS id FROM ops.crm_etapas WHERE crm = 'HUBSPOT' AND (LOWER(TRIM(nome_etapa)) LIKE '%desqualific%' OR etapa_id::text = '6659')`);
    const ids = new Set(rows.map((r) => r.id));
    DESQ_STAGE_IDS_CACHE = ids.size > 0 ? ids : DESQ_STAGE_IDS_FALLBACK;
  } catch { DESQ_STAGE_IDS_CACHE = DESQ_STAGE_IDS_FALLBACK; }
  DESQ_STAGE_IDS_AT = now;
  return DESQ_STAGE_IDS_CACHE;
}

const EM_CONTATO_FALLBACK = new Set(['6650']);
let EM_CONTATO_IDS_CACHE = null;
let EM_CONTATO_IDS_AT = 0;
const EM_CONTATO_IDS_TTL = 5 * 60_000;
async function getEmContatoStageIds(client) {
  const now = Date.now();
  if (EM_CONTATO_IDS_CACHE && now - EM_CONTATO_IDS_AT < EM_CONTATO_IDS_TTL) return EM_CONTATO_IDS_CACHE;
  try {
    const { rows } = await client.query(`SELECT etapa_id::text AS id FROM ops.crm_etapas WHERE crm = 'HUBSPOT' AND LOWER(TRIM(nome_etapa)) LIKE 'em contato%'`);
    const ids = new Set(rows.map((r) => r.id));
    EM_CONTATO_IDS_CACHE = ids.size > 0 ? ids : EM_CONTATO_FALLBACK;
  } catch { EM_CONTATO_IDS_CACHE = EM_CONTATO_FALLBACK; }
  EM_CONTATO_IDS_AT = now;
  return EM_CONTATO_IDS_CACHE;
}

function isCurrentlyDisqualified(dealRow, desqStageIds) {
  if (!dealRow) return false;
  const cur = String(dealRow.current_etapa_id ?? '').trim();
  return cur !== '' && desqStageIds.has(cur);
}
function isCurrentlyEmContato(dealRow, emContatoStageIds) {
  if (!dealRow) return false;
  const cur = String(dealRow.current_etapa_id ?? '').trim();
  return cur !== '' && emContatoStageIds.has(cur);
}

const HUBSPOT_API = 'https://api.hubapi.com';
const HUBSPOT_SEARCH_URL = `${HUBSPOT_API}/crm/v3/objects/deals/search`;
const HUBSPOT_PIPELINES_URL = `${HUBSPOT_API}/crm/v3/pipelines/deals`;
const HUBSPOT_OWNERS_URL = `${HUBSPOT_API}/crm/v3/owners`;

function hubspotEnabled() { return Boolean(process.env.HUBSPOT_ACCESS_TOKEN); }
function hubspotToken() {
  const t = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!t) { const err = new Error('HUBSPOT_ACCESS_TOKEN não configurado'); err.hubspotDisabled = true; throw err; }
  return t;
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let hubspotQueue = Promise.resolve();
function hubspotScheduled(fn) {
  const next = hubspotQueue.then(async () => { try { return await fn(); } finally { await sleepMs(300); } });
  hubspotQueue = next.catch(() => {});
  return next;
}

const HUBSPOT_STAGE_LABELS = Object.freeze({
  emContato:           ['em contato'],
  desq:                ['desqualificado', 'desqualificada', 'desqualificados', 'desqualificadas'],
  vendaPerdida:        ['venda perdida', 'perdido'],
  ganho:               ['ganho', 'venda ganha', 'venda ganho', 'fechado ganho', 'closed won'],
  protocolado:         ['protocolado'],
  protocoloAguardando: ['aguardando protocolo', 'ag protocolo', 'ag. protocolo', 'em protocolo'],
});
function matchStageKey(label) {
  const l = normalizeLabel(label);
  for (const [key, list] of Object.entries(HUBSPOT_STAGE_LABELS)) if (list.includes(l)) return key;
  if (l.startsWith('em contato')) return 'emContato';
  if (l.startsWith('desqualific')) return 'desq';
  return null;
}

let HS_STAGES = null; let HS_STAGES_AT = 0; const HS_STAGES_TTL = 10 * 60_000;
async function getHubSpotStages() {
  if (HS_STAGES && Date.now() - HS_STAGES_AT < HS_STAGES_TTL) return HS_STAGES;
  const token = hubspotToken();
  const resp = await fetch(HUBSPOT_PIPELINES_URL, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`HubSpot pipelines HTTP ${resp.status}`);
  const body = await resp.json();
  const pipelines = Array.isArray(body.results) ? body.results : [];
  const sets = { emContato: new Set(), desq: new Set(), vendaPerdida: new Set(), ganho: new Set(), protocolado: new Set(), protocoloAguardando: new Set() };

  const desqDetails = [];
  for (const p of pipelines) for (const s of p.stages || []) {
    const key = matchStageKey(s.label);
    if (key === 'desq') {
      desqDetails.push({
        pipelineId: String(p.id),
        pipelineLabel: p.label,
        stageId: String(s.id),
        stageLabel: s.label,
      });
    }
    if (key) sets[key].add(String(s.id));
  }

  console.log('[hubspot] desq stages matched:',
    desqDetails.map((d) => `${d.pipelineLabel}/${d.stageLabel}(${d.stageId})`).join(' | ') || '(NENHUM)');

  if (HUBSPOT_DESQ_STAGE_IDS) {
    console.log('[hubspot] desq override ativo (HUBSPOT_DESQ_STAGE_IDS):', HUBSPOT_DESQ_STAGE_IDS);
    sets.desq = new Set(HUBSPOT_DESQ_STAGE_IDS);
  }

  HS_STAGES = sets; HS_STAGES_AT = Date.now();
  return HS_STAGES;
}

let HS_OWNERS = null; let HS_OWNERS_AT = 0; const HS_OWNERS_TTL = 10 * 60_000;
async function getHubSpotOwners() {
  if (HS_OWNERS && Date.now() - HS_OWNERS_AT < HS_OWNERS_TTL) return HS_OWNERS;
  const token = hubspotToken();
  const all = []; let after = null; let safety = 0;
  do {
    if (++safety > 50) throw new Error('Paginação de owners HubSpot excedeu o limite de 50 páginas');
    const url = new URL(HUBSPOT_OWNERS_URL);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`HubSpot owners HTTP ${resp.status}`);
    const body = await resp.json();
    for (const o of body.results || []) all.push({ id: String(o.id), email: String(o.email || '').trim().toLowerCase() });
    after = body.paging?.next?.after ?? null;
  } while (after);
  const byEmail = new Map();
  for (const o of all) if (o.email) byEmail.set(o.email, o.id);
  HS_OWNERS = { all, byEmail }; HS_OWNERS_AT = Date.now();
  return HS_OWNERS;
}

async function fetchEmailsForScope(params) {
  const filters = []; const values = []; let idx = 1;
  if (Array.isArray(params.colaborador_ids_escopo)) {
    if (params.colaborador_ids_escopo.length === 0) return [];
    filters.push(`colaborador_id::text = ANY($${idx++}::text[])`);
    values.push(params.colaborador_ids_escopo.map(String));
  } else {
    if (params.colaborador_id != null) { filters.push(`colaborador_id::text = $${idx++}`); values.push(String(params.colaborador_id)); }
    if (params.equipe && String(params.equipe).trim().toLowerCase() !== 'todas') { filters.push(`LOWER(TRIM(nome_equipe)) = LOWER(TRIM($${idx++}))`); values.push(String(params.equipe)); }
    if (params.unidade_id != null) { filters.push(`unidade_id = $${idx++}`); values.push(Number(params.unidade_id)); }
  }
  if (filters.length === 0) return [];
  const client = await db.pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT DISTINCT LOWER(TRIM(email)) AS email FROM core.view_app_colaboradores WHERE ${filters.join(' AND ')} AND email IS NOT NULL AND TRIM(email) <> ''`,
      values,
    );
    return rows.map((r) => r.email).filter(Boolean);
  } finally { client.release(); }
}

async function resolveHubSpotOwnerIds(params) {
  const hasExplicitScope =
    Array.isArray(params.colaborador_ids_escopo) || params.colaborador_id != null ||
    (params.equipe && String(params.equipe).trim().toLowerCase() !== 'todas') || params.unidade_id != null;
  if (!hasExplicitScope) return null;
  const emails = await fetchEmailsForScope(params);
  if (emails.length === 0) return [];
  const { byEmail } = await getHubSpotOwners();
  const ids = new Set(); let missing = 0;
  for (const email of emails) {
    const key = String(email).trim().toLowerCase();
    if (HUBSPOT_OWNER_MAP[key]) { ids.add(HUBSPOT_OWNER_MAP[key]); continue; }
    const ownerId = byEmail.get(key);
    if (ownerId) ids.add(ownerId); else missing++;
  }
  if (missing > 0) console.log('[hubspot-owners] colaboradores sem owner mapeado:', missing, '/', emails.length);
  return [...ids];
}

async function hubspotSearchTotalGroups(filterGroups) {
  const token = hubspotToken();
  return hubspotScheduled(async () => {
    for (let attempt = 0; attempt < HUBSPOT_MAX_ATTEMPTS; attempt++) {
      const requestBody = { filterGroups, limit: 1, properties: ['createdate'] };
      const resp = await fetch(HUBSPOT_SEARCH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(HUBSPOT_ATTEMPT_TIMEOUT_MS),
      });
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt === HUBSPOT_MAX_ATTEMPTS - 1) throw new Error(`HubSpot ${resp.status} após ${HUBSPOT_MAX_ATTEMPTS} tentativas`);
        const retryHeader = resp.headers.get('retry-after');
        const retrySec = retryHeader == null ? NaN : Number(retryHeader);
        const delay = Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : 1000 * 2 ** attempt;
        await sleepMs(delay); continue;
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.error('[hubspot] HTTP error — payload enviado', {
          status: resp.status,
          filterGroupsCount: filterGroups.length,
          requestBody: JSON.stringify(requestBody),
          responseBody: text.slice(0, 1000),
        });
        throw new Error(`HubSpot HTTP ${resp.status}: ${text.slice(0, 500)}`);
      }
      const data = await resp.json();
      if (!Number.isSafeInteger(data.total) || data.total < 0) throw new Error('HubSpot retornou total inválido');
      if (data.total >= 10_000) throw new Error('Consulta atingiu 10.000 resultados — divida o período em janelas menores.');
      return data.total;
    }
    throw new Error('Consulta HubSpot não concluída');
  });
}
async function hubspotSearchTotal(filters) { return hubspotSearchTotalGroups([{ filters }]); }

function midnightSP(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) { const err = new Error(`Data inválida (YYYY-MM-DD): ${dateStr}`); err.status = 400; throw err; }
  const ms = Date.parse(`${dateStr}T00:00:00-03:00`);
  if (!Number.isFinite(ms)) { const err = new Error(`Data inválida: ${dateStr}`); err.status = 400; throw err; }
  return ms;
}

function buildDateFilter(prop, dateType, startMs, endMs) {
  if (dateType === 'datetime') {
    switch (HUBSPOT_DATE_FILTER_MODE) {
      case 'between':
        return [{ propertyName: prop, operator: 'BETWEEN', value: String(startMs), highValue: String(endMs - 1) }];
      case 'between_num':
        return [{ propertyName: prop, operator: 'BETWEEN', value: Number(startMs), highValue: Number(endMs - 1) }];
      case 'iso':
        return [
          { propertyName: prop, operator: 'GTE', value: new Date(startMs).toISOString() },
          { propertyName: prop, operator: 'LTE', value: new Date(endMs - 1).toISOString() },
        ];
      case 'gte_lt':
      default:
        return [
          { propertyName: prop, operator: 'GTE', value: String(startMs) },
          { propertyName: prop, operator: 'LT',  value: String(endMs) },
        ];
    }
  }
  const startDate = localDay(new Date(startMs));
  const endDate   = localDay(new Date(endMs - 1));
  return [
    { propertyName: prop, operator: 'GTE', value: startDate },
    { propertyName: prop, operator: 'LTE', value: endDate },
  ];
}

async function fetchHubSpotOverview({ inicio, fim_exclusivo, produto, mode, ownerIds }) {
  if (!hubspotEnabled()) return { ok: false, motivo: 'HUBSPOT_ACCESS_TOKEN não configurado' };
  const startMs = midnightSP(inicio);
  const endMs   = midnightSP(fim_exclusivo);
  if (startMs >= endMs) return { ok: false, motivo: 'end deve ser posterior a start' };

  const startedAt = Date.now();
  if (startMs >= Date.now()) return { ok: false, motivo: 'Período inicia depois do momento atual' };

  console.log('[hubspot] query range', {
    inicio, fim_exclusivo, mode, produto,
    startISO: new Date(startMs).toISOString(),
    endISO:   new Date(endMs).toISOString(),
    dateFilterMode: HUBSPOT_DATE_FILTER_MODE,
    disableProductionDateFilter: HUBSPOT_DISABLE_PRODUCTION_DATE_FILTER,
  });

  const stages = await getHubSpotStages();
  const isProducao = PRODUCTION_MODES.has(mode);

  let productFilter = [];
  if (produto) {
    const values = HUBSPOT_PRODUCT_MAP[produto];
    if (!HUBSPOT_PRODUCT_PROPERTY || !values || !values.length) return { ok: false, motivo: `filtro de produto "${produto}" sem mapeamento HubSpot configurado` };
    productFilter = [{ propertyName: HUBSPOT_PRODUCT_PROPERTY, operator: 'IN', values }];
  }
  const ownerFilter = (Array.isArray(ownerIds) && ownerIds.length > 0) ? [{ propertyName: HUBSPOT_OWNER_PROPERTY, operator: 'IN', values: ownerIds }] : [];

  const creationFilter = [
    { propertyName: 'createdate', operator: 'GTE', value: String(startMs) },
    { propertyName: 'createdate', operator: 'LT',  value: String(endMs) },
    ...productFilter, ...ownerFilter,
  ];
  const baseFilter = isProducao ? [...productFilter, ...ownerFilter] : creationFilter;

  const result = {
    ok: true, criados: 0, em_contato: null, desqualificados: null, assinados: null,
    ganhos: null, protocolados: null, protocoloAguardando: null,
    ganhos_metodo: null, protocolados_metodo: null, desqualificados_metodo: null,
    em_contato_metodo: null,
    erros: {}, duracao_ms: 0, consulted_at: new Date(startedAt).toISOString(),
    mode: mode || 'safra', owner_filter: Array.isArray(ownerIds) ? ownerIds.length : null,
    desq_stages_all: null, desq_stages_used: null, desq_stages_excluded: null,
  };

  try { result.criados = await hubspotSearchTotal(creationFilter); }
  catch (e) { return { ok: false, motivo: `HubSpot criados: ${e.message}` }; }

  try {
    if (stages.emContato.size > 0) {
      const stageList = [...stages.emContato];
      const useDateFilter = isProducao && !HUBSPOT_DISABLE_PRODUCTION_DATE_FILTER;

      if (useDateFilter) {
        // PRODUÇÃO: o HubSpot recusa (HTTP 400) a busca por data de entrada na
        result.em_contato = null;
        result.em_contato_metodo = 'banco (produção: entrada na etapa no período)';
      } else {
        // SAFRA: criado no período + etapa atual "Em contato".
        result.em_contato_metodo = `created in period + dealstage IN (${stageList.join(',')})`;
        result.em_contato = await hubspotSearchTotal([
          ...creationFilter,
          { propertyName: 'dealstage', operator: 'IN', values: stageList },
        ]);
      }
    } else {
      result.erros.em_contato = 'Nenhum stage "Em contato" encontrado';
    }
  } catch (e) {
    result.em_contato = null;
    result.erros.em_contato = e.message;
  }

  // ─── DESQUALIFICADOS ───────────────────────────────────────────────────────
  result.desqualificados = null;
  result.desqualificados_metodo = 'banco (canonical_metrics)';
  result.desq_stages_all = [];
  result.desq_stages_used = [];
  result.desq_stages_excluded = [];

  result.ganhos_metodo = 'canonical_metrics';

  try {
    if (HS_PROPS_CONFIG.ganhoDate && stages.protocolado.size > 0) {
      result.protocolados = await hubspotSearchTotal([...baseFilter, ...buildDateFilter(HS_PROPS_CONFIG.ganhoDate, HS_PROPS_CONFIG.ganhoDateType, startMs, endMs), { propertyName: 'dealstage', operator: 'IN', values: [...stages.protocolado] }]);
      result.protocolados_metodo = isProducao ? 'data_do_ganho + etapa_protocolado (produção)' : 'data_do_ganho + etapa_protocolado (safra)';
    } else if (stages.protocolado.size > 0) {
      result.protocolados = await hubspotSearchTotal([...baseFilter, { propertyName: 'dealstage', operator: 'IN', values: [...stages.protocolado] }]);
      result.protocolados_metodo = 'etapa_atual';
      result.erros.protocolados = 'data_do_ganho indisponível — contando etapa atual, não "Protocolado no período".';
    } else { result.erros.protocolados = 'Nenhum stage "Protocolado" encontrado'; }
  } catch (e) { result.erros.protocolados = e.message; }

  try {
    if (stages.protocoloAguardando.size > 0) {
      result.protocoloAguardando = await hubspotSearchTotal([...creationFilter, { propertyName: 'dealstage', operator: 'IN', values: [...stages.protocoloAguardando] }]);
    }
  } catch (e) { result.erros.protocoloAguardando = e.message; }

  result.duracao_ms = Date.now() - startedAt;
  console.log('[hubspot] resp', {
    ok: result.ok, mode: result.mode, criados: result.criados, assinados: result.assinados,
    ganhos: result.ganhos, ganhos_metodo: result.ganhos_metodo,
    protocolados: result.protocolados, protocolados_metodo: result.protocolados_metodo,
    desqualificados: result.desqualificados, desqualificados_metodo: result.desqualificados_metodo,
    em_contato: result.em_contato, em_contato_metodo: result.em_contato_metodo,
    owner_filter: result.owner_filter,
    desq_stages_used: result.desq_stages_used,
    desq_stages_excluded: result.desq_stages_excluded,
    erros: result.erros, duracao_ms: result.duracao_ms,
  });
  return result;
}

async function getHubSpotOverviewCached(params) {
  if (!hubspotEnabled()) return { ok: false, motivo: 'HUBSPOT_ACCESS_TOKEN não configurado' };
  const ownerSig = Array.isArray(params.ownerIds) ? createHash('sha1').update(params.ownerIds.slice().sort().join(',')).digest('hex').slice(0, 12) : 'all';
  const key = `hubspot-overview:${params.inicio}|${params.fim_exclusivo}|${params.produto || ''}|${params.mode || ''}|${ownerSig}`;
  try {
    return await cached(key, () => fetchHubSpotOverview(params), { ttlMs: 5 * 60_000, staleMs: 60_000, forceRefresh: params.refresh === true });
  } catch (e) { return { ok: false, motivo: e?.message || String(e) }; }
}

function canUseHubSpotFor(params, ownerIds) {
  if (ownerIds === null) {
    if (params.pode_ver_conta_inteira !== true) return { ok: false, motivo: 'sem autorização explícita de conta inteira — HubSpot bloqueado' };
  } else if (Array.isArray(ownerIds) && ownerIds.length === 0) {
    return { ok: false, motivo: 'escopo selecionado não mapeia para nenhum hubspot_owner_id' };
  }
  if (params.produto) {
    const values = HUBSPOT_PRODUCT_MAP[params.produto];
    if (!HUBSPOT_PRODUCT_PROPERTY || !values || !values.length) return { ok: false, motivo: `filtro de produto "${params.produto}" sem mapeamento HubSpot` };
  }
  return { ok: true };
}

function filterScope(assessor, params) {
  if (!assessor) return false;
  if (params.colaborador_ids_escopo != null && !params.colaborador_ids_escopo.map(String).includes(String(assessor.collaboratorId))) return false;
  if (params.colaborador_id != null && String(assessor.collaboratorId) !== String(params.colaborador_id)) return false;
  if (params.equipe && normalizeTeamKey(assessor.team) !== normalizeTeamKey(params.equipe)) return false;
  return true;
}
function filterScopeBroad(event, params) {
  if (!event) return false;
  if (params.colaborador_ids_escopo != null) { if (event.collaboratorId == null) return false; if (!params.colaborador_ids_escopo.map(String).includes(String(event.collaboratorId))) return false; }
  if (params.colaborador_id != null) { if (event.collaboratorId == null) return false; if (String(event.collaboratorId) !== String(params.colaborador_id)) return false; }
  if (params.equipe && normalizeTeamKey(event.team) !== normalizeTeamKey(params.equipe)) return false;
  return true;
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
  const groups = []; let current;
  for (const row of history) {
    const time = timestamp(row.data_movimentacao); if (!time) continue;
    const key = time.getTime();
    if (!current || current.key !== key) { current = { key, time, rows: [], etapaSame: null, etapaAny: null, pipelineSame: null, pipelineAny: null, ownerSame: null, ownerAny: null }; groups.push(current); }
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
    group.previousStage = previousStage; group.previousPipeline = previousPipeline; group.previousPipelineChange = previousPipelineChange; group.previousOwner = previousOwner;
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
  const episodes = []; const episodeKeys = new Set();

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
      if (!selected || episode.receivedAt > selected.receivedAt || (episode.receivedAt.getTime() === selected.receivedAt.getTime() && Number(episode.episodioId) > Number(selected.episodioId))) selected = episode;
    }
    return selected;
  }
  return { episodes, groups, groupByTime, attributionsByDeal, attributionAt, stageChanges };
}


async function loadRawEvents({ inicio, fim_exclusivo, produto, mode }) {
  const useViews = PRODUCTION_MODES.has(mode);
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

    const desqStageIds = await getDesqStageIds(client);
    const emContatoStageIds = await getEmContatoStageIds(client);

    const productVariantsUpper = produto ? (PRODUCT_VARIANTS[produto] || [produto]).map((p) => p.trim().toUpperCase()) : null;
    const productFilterClause = productVariantsUpper ? 'AND UPPER(TRIM(produto)) = ANY($3::text[])' : '';
    const productFilterValues = productVariantsUpper ? [productVariantsUpper] : [];

    const productIds = produto
      ? (await client.query(`SELECT produto_id::text FROM core.produtos WHERE LOWER(TRIM(nome_produto)) = ANY($1::text[])`, [(PRODUCT_VARIANTS[produto] || [produto]).map((n) => n.trim().toLowerCase())])).rows.map((r) => r.produto_id)
      : null;
    if (produto && !productIds.length) {
      await client.query('COMMIT');
      return { asOf, events: [], deals: new Map(), episodesByDeal: new Map(), collaboratorNames: new Map(), desqStageIds, emContatoStageIds };
    }

    const candidates = await client.query({
      text: `
        SELECT DISTINCT matches.deal_id::text AS deal_id
        FROM (
          SELECT h.deal_id FROM core.historico_movimentacoes h
          WHERE h.crm_origem = 'HUBSPOT' AND h.data_movimentacao >= $1 AND h.data_movimentacao < $2
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
            AND ($3::bigint[] IS NULL OR d.produto_id = ANY($3::bigint[]))
          UNION
          SELECT COALESCE(s.deal_id, matched.deal_id)
          FROM core.assinaturas s
          LEFT JOIN core.deals matched ON matched.hubspot_deal_id = s.hubspot_deal_id AND matched.crm_origem = 'HUBSPOT' AND matched.is_deleted IS NOT TRUE
          WHERE ($3::bigint[] IS NULL OR s.produto_id = ANY($3::bigint[]))
            AND s.tipo_emissao = 'ORIGINAL' AND s.data_cancelamento IS NULL
            AND ((s.data_emissao >= $1 AND s.data_emissao < $2) OR (s.data_assinatura >= $1 AND s.data_assinatura < $2))
          UNION
          SELECT d.deal_id FROM core.deals d
          WHERE d.crm_origem = 'HUBSPOT' AND d.is_deleted IS NOT TRUE
            AND ($3::bigint[] IS NULL OR d.produto_id = ANY($3::bigint[]))
            AND d.data_distribuicao_comercial >= $1 AND d.data_distribuicao_comercial < $2
          UNION
          SELECT d.deal_id FROM core.deals d
          WHERE d.crm_origem = 'HUBSPOT' AND d.is_deleted IS NOT TRUE
            AND ($3::bigint[] IS NULL OR d.produto_id = ANY($3::bigint[]))
            AND d.created_at >= $1 AND d.created_at < $2
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
      return { asOf, events: [], deals: new Map(), episodesByDeal: new Map(), collaboratorNames: new Map(), desqStageIds, emContatoStageIds };
    }

    const dealResult = await client.query({
      text: `
        SELECT d.deal_id::text, d.hubspot_deal_id, d.data_ganho, d.data_protocolo,
               d.motivo_perda, d.produto_id::text,
               d.etapa_id::text AS current_etapa_id, d.pipeline_id::text AS current_pipeline_id,
               d.data_distribuicao_comercial, d.created_at
        FROM core.deals d
        WHERE d.deal_id = ANY($1::bigint[])
          AND ($2::bigint[] IS NULL OR d.produto_id = ANY($2::bigint[]))
          AND d.crm_origem = 'HUBSPOT' AND d.is_deleted IS NOT TRUE`,
      values: [dealIds, productIds],
      query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
    });
    const historyResult = await client.query({
      text: `
        SELECT movimentacao_id::text, deal_id::text, data_movimentacao, tipo_movimentacao,
               crm_origem, etapa_anterior_id::text, etapa_nova_id::text,
               responsavel_anterior_id::text, responsavel_novo_id::text,
               pipeline_anterior_id::text, pipeline_novo_id::text
        FROM core.historico_movimentacoes
        WHERE deal_id = ANY($1::bigint[]) AND crm_origem = 'HUBSPOT' AND data_movimentacao <= CURRENT_TIMESTAMP
        ORDER BY deal_id, data_movimentacao, movimentacao_id`,
      values: [dealIds],
      query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
    });
    const collaboratorResult = await client.query(`SELECT colaborador_id::text, nome, nome_equipe, cargo, departamento FROM core.colaboradores`);

    const dealRows = dealResult.rows;
    const dealMap = new Map(dealRows.map((deal) => [deal.deal_id, deal]));
    const hubspotIds = [...new Set(dealRows.map((deal) => deal.hubspot_deal_id).filter(Boolean))];
    const aliasDealResult = hubspotIds.length
      ? await client.query({
          text: `SELECT d.deal_id::text, d.hubspot_deal_id FROM core.deals d WHERE d.hubspot_deal_id = ANY($1::text[]) AND ($2::bigint[] IS NULL OR d.produto_id = ANY($2::bigint[])) AND d.crm_origem = 'HUBSPOT' AND d.is_deleted IS NOT TRUE`,
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

    let signatureResult = { rows: [] }; let assinadosViewResult = { rows: [] }; let emitidosViewResult = { rows: [] }; let legalOutcomeResult = { rows: [] };

    if (useViews) {
      assinadosViewResult = await client.query({
        text: `
          SELECT v.*, a.assinatura_id::text AS assinatura_id, a.deal_id::text AS deal_id, a.hubspot_deal_id, a.consultor_responsavel_assinatura_id::text AS consultor_responsavel_assinatura_id
          FROM core.view_assinados v
          LEFT JOIN core.assinaturas a
            ON a.data_assinatura = v.data_assinatura
           AND a.consultor_responsavel_assinatura_id = (SELECT c.colaborador_id FROM core.colaboradores c WHERE LOWER(TRIM(c.nome)) = LOWER(TRIM(v.consultor_responsavel_assinatura)) LIMIT 1)
           AND a.tipo_emissao = 'ORIGINAL' AND a.data_cancelamento IS NULL
          WHERE v.data_assinatura::date >= $1::date AND v.data_assinatura::date <= $2::date
            ${productFilterClause.replace(/\bproduto\b/g, 'v.produto')}`,
        values: [dataInicio, dataFimInclusive, ...productFilterValues],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
      emitidosViewResult = await client.query({
        text: `
          SELECT v.*, a.assinatura_id::text AS assinatura_id, a.deal_id::text AS deal_id, a.hubspot_deal_id, a.consultor_responsavel_emissao_id::text AS consultor_responsavel_emissao_id
          FROM core.view_emitidos v
          LEFT JOIN core.assinaturas a
            ON a.data_emissao = v.data_emissao
           AND a.consultor_responsavel_emissao_id = (SELECT c.colaborador_id FROM core.colaboradores c WHERE LOWER(TRIM(c.nome)) = LOWER(TRIM(v.consultor_responsavel_emissao)) LIMIT 1)
           AND a.tipo_emissao = 'ORIGINAL' AND a.data_cancelamento IS NULL
          WHERE v.data_emissao::date >= $1::date AND v.data_emissao::date <= $2::date
            ${productFilterClause.replace(/\bproduto\b/g, 'v.produto')}`,
        values: [dataInicio, dataFimInclusive, ...productFilterValues],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });

      const legalQueryValues = [dataInicio, dataFimInclusive];
      let productParamIndex = null;
      if (productVariantsUpper) { productParamIndex = legalQueryValues.length + 1; legalQueryValues.push(productVariantsUpper); }
      const dealIdsParamIndex = legalQueryValues.length + 1;
      legalQueryValues.push(dealIds);
      const productFragment = productParamIndex != null ? `AND UPPER(TRIM(produto)) = ANY($${productParamIndex}::text[])` : '';

      legalOutcomeResult = await client.query({
        text: `
          SELECT deal_id::text AS deal_id, data_ganho, etapa, responsavel_lead::text AS responsavel_lead_id
          FROM core.view_app_juridico_auditoria
          WHERE data_ganho IS NOT NULL
            AND ((data_ganho::date >= $1::date AND data_ganho::date <= $2::date ${productFragment}) OR deal_id::text = ANY($${dealIdsParamIndex}::text[]))`,
        values: legalQueryValues,
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
    } else {
      signatureResult = await client.query({
        text: `
          SELECT assinatura_id::text, deal_id::text, hubspot_deal_id, data_emissao, data_assinatura, consultor_responsavel_assinatura_id::text, status_assinatura
          FROM core.assinaturas
          WHERE ($3::bigint[] IS NULL OR produto_id = ANY($3::bigint[]))
            AND tipo_emissao = 'ORIGINAL' AND data_cancelamento IS NULL
            AND UPPER(TRIM(COALESCE(status_assinatura, ''))) = 'ASSINADO'
            AND (deal_id = ANY($1::bigint[]) OR hubspot_deal_id = ANY($2::text[]))`,
        values: [dealIds, [], productIds],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
      if (hubspotIds.length) {
        signatureResult = await client.query({
          text: `
            SELECT assinatura_id::text, deal_id::text, hubspot_deal_id, data_emissao, data_assinatura, consultor_responsavel_assinatura_id::text, status_assinatura
            FROM core.assinaturas
            WHERE ($3::bigint[] IS NULL OR produto_id = ANY($3::bigint[]))
              AND tipo_emissao = 'ORIGINAL' AND data_cancelamento IS NULL
              AND UPPER(TRIM(COALESCE(status_assinatura, ''))) = 'ASSINADO'
              AND (deal_id = ANY($1::bigint[]) OR hubspot_deal_id = ANY($2::text[]))`,
          values: [dealIds, hubspotIds, productIds],
          query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
        });
      }
      legalOutcomeResult = await client.query({
        text: `SELECT deal_id::text, data_ganho, etapa, responsavel_lead::text AS responsavel_lead_id FROM core.view_app_juridico_auditoria WHERE deal_id = ANY($1::bigint[]) AND data_ganho IS NOT NULL`,
        values: [dealIds],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
    }

    const legalDealIdSet = new Set(legalOutcomeResult.rows.map((r) => String(r.deal_id)));

    const viewDealValuesNeedingLookup = new Set();
    for (const row of [...assinadosViewResult.rows, ...emitidosViewResult.rows, ...legalOutcomeResult.rows]) {
      const dealIdVal = pickColumn(row, ['deal_id']);
      if (dealIdVal != null && !dealMap.has(String(dealIdVal))) viewDealValuesNeedingLookup.add(String(dealIdVal));
      const hsIdVal = pickColumn(row, ['hubspot_deal_id']);
      if (hsIdVal != null && !dealMap.has(String(hsIdVal)) && !dealIdByHubspot.has(String(hsIdVal))) viewDealValuesNeedingLookup.add(String(hsIdVal));
    }
    const viewDealIdByHubspot = new Map();
    if (viewDealValuesNeedingLookup.size > 0) {
      const resolved = await client.query({
        text: `SELECT d.deal_id::text AS deal_id, d.hubspot_deal_id FROM core.deals d WHERE d.crm_origem = 'HUBSPOT' AND (d.hubspot_deal_id = ANY($1::text[]) OR d.deal_id::text = ANY($1::text[]))`,
        values: [[...viewDealValuesNeedingLookup]],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
      for (const r of resolved.rows) {
        viewDealIdByHubspot.set(String(r.deal_id), String(r.deal_id));
        if (r.hubspot_deal_id != null) viewDealIdByHubspot.set(String(r.hubspot_deal_id), String(r.deal_id));
      }
    }

    const assinaturaIdsNeedingLookup = new Set();
    for (const row of assinadosViewResult.rows) {
      const dealIdVal = pickColumn(row, ['deal_id']);
      const hsIdVal = pickColumn(row, ['hubspot_deal_id']);
      const canResolveDirect =
        (dealIdVal != null && (dealMap.has(String(dealIdVal)) || viewDealIdByHubspot.has(String(dealIdVal)) || legalDealIdSet.has(String(dealIdVal)))) ||
        (hsIdVal != null && (dealMap.has(String(hsIdVal)) || dealIdByHubspot.has(String(hsIdVal)) || viewDealIdByHubspot.has(String(hsIdVal))));
      if (!canResolveDirect) {
        const assinaturaId = pickColumn(row, ['assinatura_id']);
        if (assinaturaId != null) assinaturaIdsNeedingLookup.add(String(assinaturaId));
      }
    }
    const dealIdByAssinatura = new Map();
    if (assinaturaIdsNeedingLookup.size > 0) {
      const resolved = await client.query({
        text: `SELECT assinatura_id::text, deal_id::text, hubspot_deal_id FROM core.assinaturas WHERE assinatura_id::text = ANY($1::text[])`,
        values: [[...assinaturaIdsNeedingLookup]],
        query_timeout: STATEMENT_TIMEOUT_MS + 3_000,
      });
      for (const r of resolved.rows) if (r.deal_id != null) dealIdByAssinatura.set(r.assinatura_id, String(r.deal_id));
    }

    const collaboratorMap = new Map(collaboratorResult.rows.map((r) => [r.colaborador_id, r]));
    const historyByDeal = new Map();
    for (const row of historyResult.rows) { const list = historyByDeal.get(row.deal_id) || []; list.push(row); historyByDeal.set(row.deal_id, list); }

    const allEpisodes = new Map(); const allEpisodeGroups = new Map();
    const events = []; const deals = new Map();

    for (const deal of dealRows) {
      deals.set(deal.deal_id, deal);
      const history = historyByDeal.get(deal.deal_id) || [];
      const attribution = buildAttributions(history, deal, collaboratorMap, asOf);
      allEpisodes.set(deal.deal_id, attribution);
      allEpisodeGroups.set(deal.deal_id, attribution.episodes);

      let entryAt = null;
      for (const r of history) {
        const t = timestamp(r.data_movimentacao); if (!t || t > asOf) continue;
        const isEntry =
          (r.tipo_movimentacao === 'CRIACAO_DEAL' && String(r.pipeline_novo_id) === PIPELINE_COMERCIAL) ||
          (r.tipo_movimentacao === 'MUDANCA_PIPELINE' && String(r.pipeline_novo_id) === PIPELINE_COMERCIAL && String(r.pipeline_anterior_id) !== PIPELINE_COMERCIAL);
        if (isEntry && (entryAt === null || t < entryAt)) entryAt = t;
      }
      if (entryAt) events.push({ dealId: deal.deal_id, occurredAt: entryAt, dateKey: utcDate(entryAt), collaboratorId: null, team: null, type: 'RECEBIDO_CORPORATIVO' });

      const creationRows = history.filter((r) => r.tipo_movimentacao === 'CRIACAO_DEAL').sort((a, b) => (timestamp(a.data_movimentacao)?.getTime() ?? 0) - (timestamp(b.data_movimentacao)?.getTime() ?? 0));
      const firstCreation = creationRows[0];

      let createdAt = null;
      if (deal.created_at) createdAt = timestamp(deal.created_at);
      if (!createdAt && firstCreation) createdAt = timestamp(firstCreation.data_movimentacao);
      if (!createdAt && deal.data_distribuicao_comercial) createdAt = timestamp(deal.data_distribuicao_comercial);
      if (!createdAt && history.length) { const firstAny = history.map((r) => timestamp(r.data_movimentacao)).filter(Boolean).sort((a, b) => a - b)[0]; if (firstAny) createdAt = firstAny; }

      if (createdAt && createdAt <= asOf) {
        const assigned = attribution.attributionAt(createdAt);
        events.push({ dealId: deal.deal_id, occurredAt: createdAt, dateKey: utcDate(createdAt), collaboratorId: assigned?.collaboratorId ?? null, team: assigned?.team ?? null, type: 'DEAL_CREATED' });
        if (firstCreation && String(firstCreation.etapa_nova_id) === '6650') {
          events.push({ dealId: deal.deal_id, occurredAt: createdAt, dateKey: utcDate(createdAt), collaboratorId: assigned?.collaboratorId ?? null, team: assigned?.team ?? null, type: 'EM_CONTATO' });
        }
      }

      for (const episode of attribution.episodes) {
        if (episode.cargo !== 'Assessor') continue;
        events.push({ dealId: deal.deal_id, occurredAt: episode.receivedAt, dateKey: utcDate(episode.receivedAt), collaboratorId: episode.collaboratorId, team: episode.team, type: 'RECEBIDO_ASSESSOR' });
        if (episode.workedAt) events.push({ dealId: deal.deal_id, occurredAt: episode.workedAt, dateKey: utcDate(episode.workedAt), collaboratorId: episode.collaboratorId, team: episode.team, type: 'TRABALHADO_PROXY' });
      }

      for (const row of attribution.stageChanges) {
  const eventAt = timestamp(row.data_movimentacao);
  const group = eventAt && attribution.groupByTime.get(eventAt.getTime());
  if (!group) continue;
  const pipelineAtEvent = group.pipelineSame ?? group.previousPipelineChange ?? PIPELINE_COMERCIAL;
  const etapaNovaId = String(row.etapa_nova_id ?? '');

  if (desqStageIds.has(etapaNovaId)) {
    const assigned = attribution.attributionAt(eventAt);
    events.push({ dealId: deal.deal_id, occurredAt: eventAt, dateKey: utcDate(eventAt),
                  collaboratorId: assigned?.collaboratorId ?? null, team: assigned?.team ?? null,
                  type: 'DESQUALIFICADO' });
    continue;
  }

  const type = STAGE_TYPES.get(etapaNovaId);
  if (!type) continue;
  if (type === 'EM_CONTATO' && firstCreation && String(firstCreation.etapa_nova_id) === '6650'
      && eventAt.getTime() === timestamp(firstCreation.data_movimentacao)?.getTime()) continue;
  const assigned = attribution.attributionAt(eventAt);
  events.push({ ... type });
}
    }

    if (useViews) {
      const pushFromView = (row, dateField, eventType) => {
        const isoDate = utcDate(row[dateField]); if (!isoDate) return;
        const occurredAt = new Date(`${isoDate}T12:00:00Z`);

        let dealId = null;
        const rawDealId = pickColumn(row, ['deal_id']);
        const rawHubspotId = pickColumn(row, ['hubspot_deal_id']);

        for (const candidate of [rawDealId, rawHubspotId]) {
          if (candidate == null) continue;
          const key = String(candidate);
          if (dealMap.has(key))             { dealId = key; break; }
          if (dealIdByHubspot.has(key))     { dealId = dealIdByHubspot.get(key); break; }
          if (viewDealIdByHubspot.has(key)) { dealId = viewDealIdByHubspot.get(key); break; }
          if (legalDealIdSet.has(key))      { dealId = key; break; }
        }

        if (dealId == null) {
          const assinaturaId = pickColumn(row, ['assinatura_id']);
          if (assinaturaId != null && dealIdByAssinatura.has(String(assinaturaId))) {
            dealId = dealIdByAssinatura.get(String(assinaturaId));
          }
        }

        if (dealId == null && rawDealId != null)      dealId = String(rawDealId);
        if (dealId == null && rawHubspotId != null)   dealId = String(rawHubspotId);
        if (dealId == null) dealId = syntheticId(row, `__view_${eventType}`);

        const rawCollabId = pickColumn(row, ['consultor_responsavel_assinatura_id','consultor_responsavel_emissao_id','consultor_primeira_assinatura_id','consultor_primeira_emissao_id','consultor_responsavel_id','responsavel_assinatura_id','responsavel_id','consultor_id','colaborador_id','assessor_id']);
        const consultant = rawCollabId != null ? collaboratorMap.get(String(rawCollabId)) : null;
        let collaboratorId = consultant?.colaborador_id ?? null;
        let team = consultant?.nome_equipe ?? (row.equipe ?? row.nome_equipe ?? null);
        if (collaboratorId == null && dealId && !isSyntheticDealId(dealId)) {
          const attribution = allEpisodes.get(dealId);
          if (attribution) {
            const assigned = attribution.attributionAt(occurredAt);
            if (assigned) {
              collaboratorId = assigned.collaboratorId ?? null;
              if (team == null) team = assigned.team ?? null;
            }
          }
        }
        events.push({ dealId, occurredAt, dateKey: isoDate, collaboratorId, team, type: eventType });
      };
      for (const row of assinadosViewResult.rows) pushFromView(row, 'data_assinatura', 'ASSINADO_ORIGINAL');
      for (const row of emitidosViewResult.rows) pushFromView(row, 'data_emissao', 'EMITIDO_ORIGINAL');
    } else {
      const signaturesByDeal = new Map();
      for (const signature of signatureResult.rows) {
        let dealId = signature.deal_id && dealMap.has(signature.deal_id) ? signature.deal_id : null;
        if (!dealId && signature.hubspot_deal_id) {
          if (dealIdByHubspot.has(signature.hubspot_deal_id)) dealId = dealIdByHubspot.get(signature.hubspot_deal_id);
          else { const matching = dealRows.find((d) => d.hubspot_deal_id === signature.hubspot_deal_id); if (matching && aliasCounts.get(signature.hubspot_deal_id) === 1) dealId = matching.deal_id; }
        }
        if (!dealId) continue;
        const list = signaturesByDeal.get(dealId) || []; list.push(signature); signaturesByDeal.set(dealId, list);
      }
      for (const [dealId, signatures] of signaturesByDeal) {
        const attribution = allEpisodes.get(dealId); if (!attribution) continue;
        const emissions = signatures.map((s) => ({ signature: s, at: timestamp(s.data_emissao) })).filter((i) => i.at).sort((a, b) => a.at - b.at || Number(a.signature.assinatura_id) - Number(b.signature.assinatura_id));
        const validSignatures = signatures.map((s) => ({ signature: s, emissionAt: timestamp(s.data_emissao), signedAt: timestamp(s.data_assinatura) })).filter(({ signedAt }) => signedAt).sort((a, b) => a.signedAt - b.signedAt || Number(a.signature.assinatura_id) - Number(b.signature.assinatura_id));
        for (const emission of emissions) {
          const assigned = attribution.attributionAt(emission.at);
          const consultant = collaboratorMap.get(String(emission.signature.consultor_responsavel_assinatura_id ?? ''));
          const hasConsultant = !!consultant?.colaborador_id;
          events.push({ dealId, occurredAt: emission.at, dateKey: utcDate(emission.at), collaboratorId: hasConsultant ? consultant.colaborador_id : assigned?.collaboratorId ?? null, team: hasConsultant ? consultant.nome_equipe : assigned?.team ?? null, type: 'EMITIDO_ORIGINAL' });
        }
        for (const signed of validSignatures) {
          const consultant = collaboratorMap.get(String(signed.signature.consultor_responsavel_assinatura_id ?? ''));
          const assigned = attribution.attributionAt(signed.signedAt);
          const hasConsultant = !!consultant?.colaborador_id;
          events.push({ dealId, occurredAt: signed.signedAt, dateKey: utcDate(signed.signedAt), collaboratorId: hasConsultant ? consultant.colaborador_id : assigned?.collaboratorId ?? null, team: hasConsultant ? consultant.nome_equipe : assigned?.team ?? null, type: 'ASSINADO_ORIGINAL' });
        }
      }
    }

    const protocolEmittedForDeal = new Set();
    for (const deal of dealRows) {
      if (!deal.data_protocolo) continue;
      const protocolAt = timestamp(deal.data_protocolo); if (!protocolAt || protocolAt > asOf) continue;
      let collabId = null, team = null;
      const attribution = allEpisodes.get(deal.deal_id);
      if (attribution) { const assigned = attribution.attributionAt(protocolAt); collabId = assigned?.collaboratorId ?? null; team = assigned?.team ?? null; }
      events.push({ dealId: deal.deal_id, occurredAt: protocolAt, dateKey: utcDate(protocolAt), collaboratorId: collabId, team, type: 'PROTOCOLADO' });
      protocolEmittedForDeal.add(deal.deal_id);
    }
    for (const outcome of legalOutcomeResult.rows) {
      if (String(outcome.etapa ?? '').trim() !== 'Protocolado') continue;
      let dealId = String(outcome.deal_id);
      if (viewDealIdByHubspot.has(dealId)) dealId = viewDealIdByHubspot.get(dealId);
      if (protocolEmittedForDeal.has(dealId)) continue;
      const occurredAt = timestamp(outcome.data_ganho); if (!occurredAt) continue;
      let collabId = null, team = null;
      if (outcome.responsavel_lead_id) { const c = collaboratorMap.get(String(outcome.responsavel_lead_id)); if (c) { collabId = c.colaborador_id; team = c.nome_equipe; } }
      events.push({ dealId, occurredAt, dateKey: utcDate(outcome.data_ganho), collaboratorId: collabId, team, type: 'PROTOCOLADO' });
    }
    for (const outcome of legalOutcomeResult.rows) {
      const etapaNorm = String(outcome.etapa ?? '').trim().toLowerCase();
      if (etapaNorm === 'venda perdida' || etapaNorm === 'perdida' || etapaNorm === 'perdido') continue;
      const occurredAt = timestamp(outcome.data_ganho); if (!occurredAt) continue;
      const dateKey = utcDate(outcome.data_ganho); if (!dateKey) continue;
      let dealId = String(outcome.deal_id);
      if (viewDealIdByHubspot.has(dealId)) dealId = viewDealIdByHubspot.get(dealId);
      let collabId = null, team = null;
      if (outcome.responsavel_lead_id) { const c = collaboratorMap.get(String(outcome.responsavel_lead_id)); if (c) { collabId = c.colaborador_id; team = c.nome_equipe; } }
      if (!collabId) { const attribution = allEpisodes.get(dealId); if (attribution) { const assigned = attribution.attributionAt(occurredAt); collabId = assigned?.collaboratorId ?? null; team = assigned?.team ?? null; } }
      events.push({ dealId, occurredAt, dateKey, collaboratorId: collabId, team, type: 'GANHO' });
    }

    await client.query('COMMIT');
    const collaboratorNames = new Map(collaboratorResult.rows.map((r) => [r.colaborador_id, r.nome]));
    return { asOf, events, deals, episodesByDeal: allEpisodeGroups, collaboratorNames, desqStageIds, emContatoStageIds };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) { releaseError = e; }
    throw error;
  } finally { client.release(releaseError); }
}

function rawCacheKey(params) {
  return createHash('sha256').update(`${params.inicio}|${params.fim_exclusivo}|${params.produto || ''}|${params.mode || ''}|${(params.colaborador_ids_escopo || []).slice().sort().join(',')}`).digest('hex');
}
async function getRawEvents(params) {
  return cached(`inte-comerce-raw:${rawCacheKey(params)}`, () => loadRawEvents(params), { forceRefresh: params.refresh === true });
}

function emptyResult() { 
  return {
    overview: { recebidos:0, trabalhados_proxy:0, em_contato_crm:0, assinados:0, ganhos:0, protocolados:0, desqualificados:0 },
    strategic: { recebidos:0, em_contato:0, assinados:0, assinados_que_ganharam:0, pct_recebidos_ate_assinados:null, pct_recebidos_ate_em_contato:null, pct_assinados_ate_ganhos:null, variacao_safra_sem_maturidade_equivalente:null },
    funnel: { recebidos:0, trabalhados:0, em_contato:0, coleta:0, emitidos:0, assinados:0, ganhos:0, protocolados:0, desqualificados_saida:0, coleta_sem_contato_observado:0 },
    daily: [], reasons: [], collaborators: [], teams: [],
    hubspot: null, hubspotCards: null,
    productionComparison: null,
    safraComparison: null,
  };
}

function buildProductionComparisonResults(raw, params) {
  const monthBounds = periodBounds(params.production_month_inicio, params.production_month_fim);
  const selectedDayBounds = params.selected_day && params.selected_day_end ? periodBounds(params.selected_day, params.selected_day_end) : null;
  const activeIds = new Set((params.colaborador_ids_ativos || []).map(String));
  const noFilter = !params.equipe && params.colaborador_id == null;
  const scopedRestriction = params.colaborador_ids_escopo != null;

  const metrics = { recebidos: null, trabalhados_proxy: 'TRABALHADO_PROXY', em_contato_crm: 'EM_CONTATO', coleta: 'COLETA', emitidos: 'EMITIDO_ORIGINAL', assinados: 'ASSINADO_ORIGINAL', ganhos: 'GANHO', protocolados: 'PROTOCOLADO', desqualificados: 'DESQUALIFICADO' };
  const broadMetrics = new Set(['emitidos','assinados','ganhos','protocolados']);
  const metricKeys = Object.keys(metrics);
  const metricByType = new Map(Object.entries(metrics).filter(([, t]) => t != null).map(([k, t]) => [t, k]));

  const monthDeals = new Map(metricKeys.map((k) => [k, new Set()]));
  const dayDeals = new Map(metricKeys.map((k) => [k, new Set()]));
  const dailyByDay = new Map();
  const byCollaborator = new Map();
  const byTeam = new Map();
  const reasonCounts = new Map();
  const reasonSeenDeals = new Map();

  const getOrCreateCollab = (collaboratorId, team) => {
    const key = `${collaboratorId}|${team}`;
    let collab = byCollaborator.get(key);
    if (!collab) {
      collab = { colaborador_id: collaboratorId, colaborador: raw.collaboratorNames?.get(collaboratorId) || PLACEHOLDER_COLLAB, equipe_atual: team, metricDeals: new Map(metricKeys.map((k) => [k, new Set()])), pct_olos_pendente: null, pct_hubspot_pendente: null };
      byCollaborator.set(key, collab);
    }
    return collab;
  };
  const getOrCreateTeam = (team) => {
    let teamRow = byTeam.get(team);
    if (!teamRow) { teamRow = { equipe: team, metricDeals: new Map(metricKeys.map((k) => [k, new Set()])) }; byTeam.set(team, teamRow); }
    return teamRow;
  };
  const getOrCreateDay = (day) => {
    let dayRow = dailyByDay.get(day);
    if (!dayRow) { dayRow = { dealIds: new Map(metricKeys.map((k) => [k, new Set()])) }; dailyByDay.set(day, dayRow); }
    return dayRow;
  };

  const signedDateByDeal = new Map();
  for (const event of raw.events) {
    if (event.type !== 'ASSINADO_ORIGINAL') continue;
    if (event.occurredAt > raw.asOf) continue;
    const signDate = event.dateKey || utcDate(event.occurredAt);
    if (!signDate) continue;
    const prev = signedDateByDeal.get(event.dealId);
    if (!prev || signDate < prev) signedDateByDeal.set(event.dealId, signDate);
  }

  const ganhoDateByDeal = new Map();
  for (const event of raw.events) {
    if (event.type !== 'GANHO') continue;
    if (event.occurredAt > raw.asOf) continue;
    if (event.occurredAt < monthBounds.start || event.occurredAt >= monthBounds.end) continue;
    const gainDate = event.dateKey || utcDate(event.occurredAt);
    if (!gainDate) continue;
    const prev = ganhoDateByDeal.get(event.dealId);
    if (!prev || gainDate < prev) ganhoDateByDeal.set(event.dealId, gainDate);
  }

  let signedAndGained = 0;
  for (const [dealId, gainDate] of ganhoDateByDeal) {
    const signDate = signedDateByDeal.get(dealId);
    if (signDate && signDate <= gainDate) signedAndGained++;
  }

  for (const event of raw.events) {
    if (event.occurredAt < monthBounds.start || event.occurredAt >= monthBounds.end || event.occurredAt > raw.asOf || !EVENT_TYPES.has(event.type)) continue;
    const day = localDay(event.occurredAt);

    if (event.type === 'RECEBIDO_CORPORATIVO' || event.type === 'RECEBIDO_ASSESSOR') {
      if (event.type === 'RECEBIDO_CORPORATIVO') {
        if (!noFilter || scopedRestriction) continue;
        monthDeals.get('recebidos').add(event.dealId);
        const dayRow = getOrCreateDay(day);
        dayRow.dealIds.get('recebidos').add(event.dealId);
        if (selectedDayBounds && event.occurredAt >= selectedDayBounds.start && event.occurredAt < selectedDayBounds.end) dayDeals.get('recebidos').add(event.dealId);
      } else {
        const countInTotal = !noFilter || scopedRestriction;
        if (countInTotal) {
          if (!filterScopeBroad(event, params)) continue;
          monthDeals.get('recebidos').add(`${event.dealId}|${day}`);
          const dayRow = getOrCreateDay(day);
          dayRow.dealIds.get('recebidos').add(event.dealId);
          if (selectedDayBounds && event.occurredAt >= selectedDayBounds.start && event.occurredAt < selectedDayBounds.end) dayDeals.get('recebidos').add(event.dealId);
        }
        if (event.collaboratorId != null && filterScope(event, params)) {
          const collaboratorId = String(event.collaboratorId);
          const team = event.team || PLACEHOLDER_TEAM;
          const dealDayKey = `${event.dealId}|${day}`;
          getOrCreateCollab(collaboratorId, team).metricDeals.get('recebidos').add(dealDayKey);
          getOrCreateTeam(team).metricDeals.get('recebidos').add(dealDayKey);
        }
      }
      continue;
    }

    const metric = metricByType.get(event.type);
    if (!metric) continue;

    const isBroad = broadMetrics.has(metric);
    const collaboratorId = event.collaboratorId == null ? null : String(event.collaboratorId);

    if (collaboratorId == null) {
      if (params.equipe != null || params.colaborador_id != null) continue;
      if (scopedRestriction) continue;
      if (!isBroad && !params.include_unassigned) continue;
    } else if (isBroad) {
      if (!filterScopeBroad(event, params)) continue;
    } else {
      if (!filterScope(event, params)) continue;
      if (!activeIds.has(collaboratorId)) continue;
    }

    const team = event.team || PLACEHOLDER_TEAM;
    const collaboratorKey = collaboratorId || PLACEHOLDER_COLLAB;
    const collab = getOrCreateCollab(collaboratorKey, team);
    const teamRow = getOrCreateTeam(team);
    const dayRow = getOrCreateDay(day);

    monthDeals.get(metric).add(event.dealId);
    dayRow.dealIds.get(metric).add(event.dealId);
    collab.metricDeals.get(metric).add(event.dealId);
    teamRow.metricDeals.get(metric).add(event.dealId);
    if (selectedDayBounds && event.occurredAt >= selectedDayBounds.start && event.occurredAt < selectedDayBounds.end) dayDeals.get(metric).add(event.dealId);

    if (metric === 'desqualificados') {
      const reason = String(raw.deals.get(event.dealId)?.motivo_perda || '').trim() || '(SEM MOTIVO)';
      let seen = reasonSeenDeals.get(reason);
      if (!seen) { seen = new Set(); reasonSeenDeals.set(reason, seen); }
      if (!seen.has(event.dealId)) { seen.add(event.dealId); reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1); }
    }
  }

  const monthTotals = Object.fromEntries(metricKeys.map((k) => [k, monthDeals.get(k).size]));
  const dayTotals = Object.fromEntries(metricKeys.map((k) => [k, dayDeals.get(k).size]));

  const result = emptyResult();
  result.overview = { recebidos: monthTotals.recebidos, trabalhados_proxy: monthTotals.trabalhados_proxy, em_contato_crm: monthTotals.em_contato_crm, assinados: monthTotals.assinados, ganhos: monthTotals.ganhos, protocolados: monthTotals.protocolados, desqualificados: monthTotals.desqualificados };
  result.funnel = { recebidos: monthTotals.recebidos, trabalhados: monthTotals.trabalhados_proxy, em_contato: monthTotals.em_contato_crm, coleta: monthTotals.coleta, emitidos: monthTotals.emitidos, assinados: monthTotals.assinados, ganhos: monthTotals.ganhos, protocolados: monthTotals.protocolados, desqualificados_saida: monthTotals.desqualificados, coleta_sem_contato_observado: 0 };
  result.strategic = {
    recebidos: monthTotals.recebidos, em_contato: monthTotals.em_contato_crm,
    assinados: monthTotals.assinados, assinados_que_ganharam: signedAndGained,
    pct_recebidos_ate_assinados: monthTotals.recebidos ? Number((100 * monthTotals.assinados / monthTotals.recebidos).toFixed(2)) : null,
    pct_recebidos_ate_em_contato: monthTotals.recebidos ? Number((100 * monthTotals.em_contato_crm / monthTotals.recebidos).toFixed(2)) : null,
    pct_assinados_ate_ganhos: monthTotals.ganhos ? Number((100 * signedAndGained / monthTotals.ganhos).toFixed(2)) : null,
    variacao_safra_sem_maturidade_equivalente: null,
  };

  result.daily = [];
  for (let day = new Date(monthBounds.start); day < monthBounds.end; day.setUTCDate(day.getUTCDate() + 1)) {
    const iso = day.toISOString().slice(0, 10);
    const row = dailyByDay.get(iso);
    const received = row?.dealIds.get('recebidos').size || 0;
    const signed = row?.dealIds.get('assinados').size || 0;
    result.daily.push({ dia: iso, recebidos: received, assinados_ate_corte: signed, taxa_safra_pct: received ? Number((100 * signed / received).toFixed(2)) : null });
  }

  result.reasons = [...reasonCounts].map(([motivo, n]) => ({ motivo, deals_desqualificados: n })).sort((a, b) => b.deals_desqualificados - a.deals_desqualificados || a.motivo.localeCompare(b.motivo));

  const toCollabRow = (row) => ({
    colaborador_id: row.colaborador_id, colaborador: row.colaborador, equipe_atual: row.equipe_atual,
    recebimentos_deal_dia: row.metricDeals.get('recebidos').size, trabalhados: row.metricDeals.get('trabalhados_proxy').size,
    em_contato: row.metricDeals.get('em_contato_crm').size, coleta: row.metricDeals.get('coleta').size,
    assinados: row.metricDeals.get('assinados').size, ganhos: row.metricDeals.get('ganhos').size,
    protocolados: row.metricDeals.get('protocolados').size,
    pct_olos_pendente: row.pct_olos_pendente, pct_hubspot_pendente: row.pct_hubspot_pendente,
  });

  result.collaborators = [...byCollaborator.values()].map(toCollabRow).filter((row) => row.colaborador !== PLACEHOLDER_COLLAB && row.colaborador_id !== PLACEHOLDER_COLLAB).sort((a, b) => b.assinados - a.assinados || b.recebimentos_deal_dia - a.recebimentos_deal_dia);

  result.teams = [...byTeam.values()].filter((row) => row.equipe !== PLACEHOLDER_TEAM).map((row) => {
    const uniqueDealIds = new Set();
    for (const set of row.metricDeals.values()) for (const v of set) uniqueDealIds.add(typeof v === 'string' && v.includes('|') ? v.split('|')[0] : v);
    return {
      equipe: row.equipe, recebimentos_assessor_deal_dia: row.metricDeals.get('recebidos').size,
      deals_unicos_da_equipe: uniqueDealIds.size, trabalhados: row.metricDeals.get('trabalhados_proxy').size,
      em_contato: row.metricDeals.get('em_contato_crm').size, coleta: row.metricDeals.get('coleta').size,
      assinados: row.metricDeals.get('assinados').size, ganhos: row.metricDeals.get('ganhos').size,
      protocolados: row.metricDeals.get('protocolados').size,
    };
  }).sort((a, b) => b.assinados - a.assinados);

  result.productionComparison = {
    day: selectedDayBounds ? { recebidos: dayTotals.recebidos, assinados: dayTotals.assinados, ganhos: dayTotals.ganhos, protocolados: dayTotals.protocolados } : null,
    month: { recebidos: monthTotals.recebidos, assinados: monthTotals.assinados, ganhos: monthTotals.ganhos, protocolados: monthTotals.protocolados },
  };
  result.asOf = raw.asOf;
  return result;
}

function filteredEvents(raw, params) {
  const { start, end } = periodBounds(params.inicio, params.fim_exclusivo);
  const activeIds = new Set((params.colaborador_ids_ativos || []).map(String));
  const events = raw.events.filter((event) =>
    event.occurredAt >= start && event.occurredAt <= raw.asOf &&
    (event.collaboratorId == null || activeIds.has(String(event.collaboratorId))) &&
    EVENT_TYPES.has(event.type));
  for (const [dealId, episodes] of raw.episodesByDeal || []) {
    const firstReceipt = episodes.filter((e) => e.receivedAt >= start && e.receivedAt < end).sort((a, b) => a.receivedAt - b.receivedAt || Number(a.episodioId) - Number(b.episodioId))[0];
    if (!firstReceipt) continue;
    const firstAssessor = episodes.filter((e) => e.cargo === 'Assessor' && e.receivedAt >= firstReceipt.receivedAt && e.collaboratorId !== null && activeIds.has(String(e.collaboratorId))).sort(compareAssessorEvents)[0];
    if (firstAssessor) events.push({ dealId, occurredAt: firstReceipt.receivedAt, collaboratorId: firstAssessor.collaboratorId, team: firstAssessor.team, type: 'RECEBIDO_CORPORATIVO' });
  }
  return events;
}

function buildOperationalResults(raw, params) {
  const events = filteredEvents(raw, params);
  const eventsByDeal = new Map();
  for (const e of events) { const list = eventsByDeal.get(e.dealId) || []; list.push(e); eventsByDeal.set(e.dealId, list); }
  const corporateReceipts = new Map();
  for (const e of events) { if (e.type !== 'RECEBIDO_CORPORATIVO') continue; const c = corporateReceipts.get(e.dealId); if (!c || e.occurredAt < c.occurredAt) corporateReceipts.set(e.dealId, e); }
  const firstAssessorByDeal = new Map();
  for (const e of events) {
    if (e.type !== 'RECEBIDO_ASSESSOR') continue;
    const c = firstAssessorByDeal.get(e.dealId);
    if (!c || compareAssessorEvents({ receivedAt: e.occurredAt, collaboratorId: e.collaboratorId, team: e.team }, { receivedAt: c.occurredAt, collaboratorId: c.collaboratorId, team: c.team }) < 0) firstAssessorByDeal.set(e.dealId, e);
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
      dealId, receiptAt: receipt.occurredAt, events: dealEvents, firstWorkAt: firstOf('TRABALHADO_PROXY'),
      contacted: contacts.length > 0, contactAtOrBeforeReceipt: contacts.some((e) => e.occurredAt <= receipt.occurredAt),
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
    daily.push({ dia: iso, recebidos: row?.recebidos || 0, assinados_ate_corte: row?.assinados_ate_corte || 0, taxa_safra_pct: row?.recebidos ? Number((100 * row.assinados_ate_corte / row.recebidos).toFixed(2)) : null });
  }
  const reasonCounts = new Map();
  for (const i of cohort) {
    if (!inRange(i.firstDisqualifiedAt, i.receiptAt)) continue;
    const reason = String(raw.deals.get(i.dealId)?.motivo_perda || '').trim() || '(SEM MOTIVO)';
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  const reasons = [...reasonCounts].map(([motivo, n]) => ({ motivo, deals_desqualificados: n })).sort((a, b) => b.deals_desqualificados - a.deals_desqualificados || a.motivo.localeCompare(b.motivo));
  const receivedAssessors = new Map();
  for (const e of events) {
    if (e.type !== 'RECEBIDO_ASSESSOR' || e.occurredAt >= bounds.end) continue;
    if (params.equipe && normalizeTeamKey(e.team) !== normalizeTeamKey(params.equipe)) continue;
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
    const teamRow = byTeam.get(team) || { equipe: team, recebimentos_assessor_deal_dia: 0, deals_unicos_da_equipe: new Set(), trabalhados: new Set(), em_contato: new Set(), coleta: new Set(), assinados: new Set(), ganhos: new Set(), protocolados: new Set() };
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
    deals_unicos_da_equipe: row.deals_unicos_da_equipe.size, trabalhados: row.trabalhados.size,
    em_contato: row.em_contato.size, coleta: row.coleta.size, assinados: row.assinados.size,
    ganhos: row.ganhos.size, protocolados: row.protocolados.size,
  })).sort((a, b) => b.assinados - a.assinados);

  const result = emptyResult();
  result.overview = counts;
  result.strategic = {
    recebidos: cohort.length, em_contato: contactCount, assinados: counts.assinados, assinados_que_ganharam: signedAndGained,
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

function buildComparisonResults(raw, params) {
  const cohortBounds = periodBounds(params.cohort_inicio, params.cohort_fim);
  const resultBounds = periodBounds(params.result_inicio, params.result_fim);
  const activeIds = new Set((params.colaborador_ids_ativos || []).map(String));

  const creationsByDeal = new Map();
  for (const event of raw.events) {
    if (event.type !== 'DEAL_CREATED' || event.occurredAt < cohortBounds.start || event.occurredAt >= cohortBounds.end || event.occurredAt > raw.asOf) continue;
    const current = creationsByDeal.get(event.dealId);
    if (!current || event.occurredAt < current.createdAt) creationsByDeal.set(event.dealId, { createdAt: event.occurredAt });
  }
  const cohort = [];
  for (const [dealId, creation] of creationsByDeal) {
    const assessor = (raw.episodesByDeal.get(dealId) || []).filter((e) => e.cargo === 'Assessor' && e.receivedAt >= creation.createdAt && activeIds.has(String(e.collaboratorId))).sort(compareAssessorEvents)[0];
    if (assessor && !filterScope(assessor, params)) continue;
    if (!assessor && (!params.include_unassigned || params.equipe || params.colaborador_id != null)) continue;
    cohort.push({
      dealId, createdAt: creation.createdAt,
      collaboratorId: assessor ? String(assessor.collaboratorId) : PLACEHOLDER_COLLAB,
      collaborator: assessor ? raw.collaboratorNames?.get(String(assessor.collaboratorId)) || PLACEHOLDER_COLLAB : PLACEHOLDER_COLLAB,
      team: assessor?.team || PLACEHOLDER_TEAM,
    });
  }

  const eventsByDealAllTime = new Map();
  for (const e of raw.events) { if (e.occurredAt > raw.asOf) continue; const list = eventsByDealAllTime.get(e.dealId) || []; list.push(e); eventsByDealAllTime.set(e.dealId, list); }

  const DAILY_METRIC_BY_EVENT = { ASSINADO_ORIGINAL: 'assinados', GANHO: 'ganhos', PROTOCOLADO: 'protocolados', EMITIDO_ORIGINAL: 'emitidos', DESQUALIFICADO: 'perdidos' };
  const milestoneByDeal = new Map();
  for (const i of cohort) {
    const evs = (eventsByDealAllTime.get(i.dealId) || []).filter((e) => e.occurredAt >= i.createdAt);
    const reached = new Set();
    for (const e of evs) { const metric = DAILY_METRIC_BY_EVENT[e.type]; if (metric) reached.add(metric); }
    milestoneByDeal.set(i.dealId, reached);
  }

  const cohortByDeal = new Map(cohort.map((i) => [i.dealId, i]));
  const eventsByDeal = new Map();
  for (const e of raw.events) {
    const item = cohortByDeal.get(e.dealId);
    if (!item || e.occurredAt < item.createdAt || e.occurredAt > raw.asOf) continue;
    const list = eventsByDeal.get(e.dealId) || [];
    list.push(e); eventsByDeal.set(e.dealId, list);
  }
  const metricTypes = { trabalhados_proxy: 'TRABALHADO_PROXY', em_contato_crm: 'EM_CONTATO', coleta: 'COLETA', emitidos: 'EMITIDO_ORIGINAL', assinados: 'ASSINADO_ORIGINAL', ganhos: 'GANHO', protocolados: 'PROTOCOLADO', desqualificados: 'DESQUALIFICADO' };

  const dealsByMetric = new Map(Object.keys(metricTypes).map((k) => [k, new Set()]));
  const firstMetricAtByDeal = new Map();
  for (const [dealId, events] of eventsByDeal) {
    const firstAt = new Map();
    for (const e of events) {
      const metric = Object.entries(metricTypes).find(([, t]) => t === e.type)?.[0];
      if (!metric) continue;
      dealsByMetric.get(metric).add(dealId);
      if (!firstAt.has(metric) || e.occurredAt < firstAt.get(metric)) firstAt.set(metric, e.occurredAt);
    }
    firstMetricAtByDeal.set(dealId, firstAt);
  }
  {
    const desqAtual = new Set();
    for (const item of cohort) {
      if (isCurrentlyDisqualified(raw.deals.get(item.dealId), raw.desqStageIds)) desqAtual.add(item.dealId);
    }
    dealsByMetric.set('desqualificados', desqAtual);
  }

  const emContatoHistoricoSet = dealsByMetric.get('em_contato_crm');
  const emContatoAtualSet = new Set();
  for (const dealId of emContatoHistoricoSet) if (isCurrentlyEmContato(raw.deals.get(dealId), raw.emContatoStageIds)) emContatoAtualSet.add(dealId);

  const metricCount = (k) => dealsByMetric.get(k).size;

  let safraComparison = null;
  if (params.mode === 'safra') {
    let dayComparison = null;
    if (params.selected_day && params.selected_day_end) {
      const dayBounds = periodBounds(params.selected_day, params.selected_day_end);
      const dayCohort = cohort.filter((i) => i.createdAt >= dayBounds.start && i.createdAt < dayBounds.end);
      let dayAssinados = 0, dayGanhos = 0, dayProtocolados = 0;
      for (const i of dayCohort) {
        const reached = milestoneByDeal.get(i.dealId);
        if (reached?.has('assinados')) dayAssinados++;
        if (reached?.has('ganhos')) dayGanhos++;
        if (reached?.has('protocolados')) dayProtocolados++;
      }
      dayComparison = { recebidos: dayCohort.length, assinados: dayAssinados, ganhos: dayGanhos, protocolados: dayProtocolados };
    }
    let monthAssinados = 0, monthGanhos = 0, monthProtocolados = 0;
    for (const i of cohort) {
      const reached = milestoneByDeal.get(i.dealId);
      if (reached?.has('assinados')) monthAssinados++;
      if (reached?.has('ganhos')) monthGanhos++;
      if (reached?.has('protocolados')) monthProtocolados++;
    }
    safraComparison = { day: dayComparison, month: { recebidos: cohort.length, assinados: monthAssinados, ganhos: monthGanhos, protocolados: monthProtocolados } };
  }
  const signedAndGained = cohort.filter((i) => {
    const firstAt = firstMetricAtByDeal.get(i.dealId);
    return firstAt?.has('assinados') && firstAt.has('ganhos') && firstAt.get('ganhos') >= firstAt.get('assinados');
  }).length;

  const counts = { recebidos: cohort.length, trabalhados_proxy: metricCount('trabalhados_proxy'), em_contato_crm: emContatoAtualSet.size, assinados: metricCount('assinados'), ganhos: metricCount('ganhos'), protocolados: metricCount('protocolados'), desqualificados: metricCount('desqualificados') };
  const funnel = {
    recebidos: cohort.length, trabalhados: counts.trabalhados_proxy, em_contato: emContatoHistoricoSet.size,
    coleta: metricCount('coleta'), emitidos: metricCount('emitidos'),
    assinados: counts.assinados, ganhos: counts.ganhos, protocolados: counts.protocolados,
    desqualificados_saida: counts.desqualificados,
    coleta_sem_contato_observado: cohort.filter((i) => dealsByMetric.get('coleta').has(i.dealId) && !dealsByMetric.get('em_contato_crm').has(i.dealId)).length,
  };

  const dailyByCreationDay = new Map();
  for (const i of cohort) {
    const day = localDay(i.createdAt);
    const entry = dailyByCreationDay.get(day) || { recebidos: 0, assinados: 0, ganhos: 0, protocolados: 0, emitidos: 0, perdidos: 0 };
    entry.recebidos++;
    const reached = milestoneByDeal.get(i.dealId);
    if (reached?.has('assinados')) entry.assinados++;
    if (reached?.has('ganhos')) entry.ganhos++;
    if (reached?.has('protocolados')) entry.protocolados++;
    if (reached?.has('emitidos')) entry.emitidos++;
    if (reached?.has('perdidos') && isCurrentlyDisqualified(raw.deals.get(i.dealId), raw.desqStageIds)) entry.perdidos++;
    dailyByCreationDay.set(day, entry);
  }

  const chartStart = cohortBounds.start < resultBounds.start ? cohortBounds.start : resultBounds.start;
  const chartEnd = cohortBounds.end > resultBounds.end ? cohortBounds.end : resultBounds.end;
  const daily = [];
  for (let d = new Date(chartStart); d < chartEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const entry = dailyByCreationDay.get(iso);
    const recebidos = entry?.recebidos || 0;
    const assinadosDia = entry?.assinados || 0;
    daily.push({
      dia: iso, recebidos, assinados_ate_corte: assinadosDia,
      taxa_safra_pct: recebidos ? Number((100 * assinadosDia / recebidos).toFixed(2)) : null,
      assinados: assinadosDia, ganhos: entry?.ganhos || 0, protocolados: entry?.protocolados || 0,
      emitidos: entry?.emitidos || 0, perdidos: entry?.perdidos || 0,
    });
  }

  const reasonCounts = new Map();
  for (const dealId of dealsByMetric.get('desqualificados')) {
    const reason = String(raw.deals.get(dealId)?.motivo_perda || '').trim() || '(SEM MOTIVO)';
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  const reasons = [...reasonCounts].map(([motivo, n]) => ({ motivo, deals_desqualificados: n })).sort((a, b) => b.deals_desqualificados - a.deals_desqualificados || a.motivo.localeCompare(b.motivo));

  const byCollaborator = new Map();
  const byTeam = new Map();
  for (const i of cohort) {
    const events = eventsByDeal.get(i.dealId) || [];
    const has = (t) => events.some((e) => e.type === t);
    const key = `${i.collaboratorId}|${i.team}`;
    const row = byCollaborator.get(key) || {
      colaborador_id: i.collaboratorId, colaborador: i.collaborator, equipe_atual: i.team,
      recebimentos_deal_dia: 0, trabalhados: 0, em_contato: 0, coleta: 0, assinados: 0, ganhos: 0, protocolados: 0,
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

    const tr = byTeam.get(i.team) || { equipe: i.team, recebimentos_assessor_deal_dia: 0, deals_unicos_da_equipe: 0, trabalhados: 0, em_contato: 0, coleta: 0, assinados: 0, ganhos: 0, protocolados: 0 };
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
    recebidos: cohort.length, em_contato: emContatoHistoricoSet.size, assinados: counts.assinados, assinados_que_ganharam: signedAndGained,
    pct_recebidos_ate_assinados: cohort.length ? Number((100 * counts.assinados / cohort.length).toFixed(2)) : null,
    pct_recebidos_ate_em_contato: cohort.length ? Number((100 * emContatoHistoricoSet.size / cohort.length).toFixed(2)) : null,
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


function buildHubspotCards(hs) {
  return {
    criados: hs.criados ?? null, em_contato: hs.em_contato ?? null,
    desqualificados: hs.desqualificados ?? null, assinados: hs.assinados ?? null,
    ganhos: hs.ganhos ?? null, protocolados: hs.protocolados ?? null,
    protocolo_aguardando: hs.protocoloAguardando ?? null,
  };
}

function hubspotDiagnostics(hs) {
  const age_ms = hs.consulted_at ? Math.max(0, Date.now() - Date.parse(hs.consulted_at)) : null;
  return {
    consulted_at: hs.consulted_at ?? null, age_ms,
    mode: hs.mode ?? null, owner_filter: hs.owner_filter ?? null,
    metodo: {
      ganhos: hs.ganhos_metodo ?? null,
      protocolados: hs.protocolados_metodo ?? null,
      desqualificados: hs.desqualificados_metodo ?? null,
      em_contato: hs.em_contato_metodo ?? null,
    },
    desq_stages: {
      all: hs.desq_stages_all ?? null,
      used: hs.desq_stages_used ?? null,
      excluded: hs.desq_stages_excluded ?? null,
    },
    erros: Object.keys(hs.erros || {}).length ? hs.erros : undefined,
  };
}

// ─── CANONICAL (banco) ───────────────────────────────────────────────────────

async function canonicalTotal(label, loaderFn, params, extra = {}) {
  let val = null;
  try {
    val = await cached(
      metricCacheKey(label, { ...params, ...extra }),
      () => loaderFn({
        start: params.inicio,
        end: params.fim_exclusivo,
        equipe: params.equipe,
        produto: params.produto,
        ...extra,
      }),
      { forceRefresh: params.refresh === true }
    );
  } catch (e) {
    console.error(`[inte-comerce] ${label}: loader falhou (${e?.message || e})`);
  }
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  console.error(
    `[BACKEND ERROR] [inte-comerce] ${label}: load retornou ${typeof val}, ` +
    `mantendo valor do builder`
  );
  return null;
}

// assinados: visão geral + funil + estratégico + produção
async function applyCanonicalAssinados(result, params) {
  const val = await canonicalTotal('assinados', loadAssinadosTotal, params);
  if (val == null) return 'banco';
  result.overview.assinados = val;
  if (result.funnel) result.funnel.assinados = val;
  if (result.strategic) result.strategic.assinados = val;
  const pc = result.productionComparison;
  if (pc?.month) pc.month.assinados = val;
  if (pc?.day) pc.day.assinados = val;
  if (result.strategic && result.overview.recebidos > 0) {
    result.strategic.pct_recebidos_ate_assinados =
      Number((100 * val / result.overview.recebidos).toFixed(2));
  }
  return 'canonical_metrics';
}

// desqualificados: visão geral + saída do funil
async function applyCanonicalDesqualificados(result, params) {
  const val = await canonicalTotal('desqualificados', loadDesqualificadosTotal, params, { mode: params.mode });
  if (val == null) return 'banco';
  result.overview.desqualificados = val;
  if (result.funnel) result.funnel.desqualificados_saida = val;
  return 'canonical_metrics';
}

async function mergeHubSpot(result, hs, params) {
  if (!hs.ok) {
    const fonte = {};
    fonte.assinados       = await applyCanonicalAssinados(result, params);
    fonte.desqualificados = await applyCanonicalDesqualificados(result, params);
    result.hubspot = {
      ativo: false,
      fonte,
      produto_aplicado: params.produto ?? null,
      motivo: hs.motivo || 'HubSpot indisponível',
    };
    return;
  }

  const fonte = {};
  const setFromHs = (key, val) => {
    if (typeof val === 'number' && Number.isFinite(val)) {
      result.overview[key] = val;
      fonte[key] = 'hubspot';
    } else {
      fonte[key] = 'banco';
    }
  };
  setFromHs('recebidos',       hs.criados);
  setFromHs('em_contato_crm',  hs.em_contato);
  fonte.assinados          = 'canonical_metrics';
  fonte.ganhos             = 'canonical_metrics';
  fonte.protocolados       = 'canonical_metrics';
  fonte.trabalhados_proxy  = 'banco';

  result.strategic.recebidos  = result.overview.recebidos;
  result.strategic.em_contato = result.overview.em_contato_crm;
  result.strategic.assinados  = result.overview.assinados;

  const sameSourcePct = (numKey, denKey) => {
    if (fonte[numKey] !== 'hubspot' || fonte[denKey] !== 'hubspot') return null;
    const n = result.overview[numKey], d = result.overview[denKey];
    if (typeof n !== 'number' || typeof d !== 'number' || d <= 0) return null;
    return Number((100 * n / d).toFixed(2));
  };
  const pctR2A = sameSourcePct('assinados', 'recebidos');
  if (pctR2A != null) result.strategic.pct_recebidos_ate_assinados = pctR2A;
  const pctR2EC = sameSourcePct('em_contato_crm', 'recebidos');
  if (pctR2EC != null) result.strategic.pct_recebidos_ate_em_contato = pctR2EC;

  const loaderBase = {
    start: params.inicio,
    end: params.fim_exclusivo,
    equipe: params.equipe,
    produto: params.produto,
  };

  const applyCanonical = async (label, loaderFn, targetObj, targetKey, extra = {}) => {
    let val = null;
    try {
      val = await cached(
        metricCacheKey(label, { ...params, ...extra }),
        () => loaderFn({ ...loaderBase, ...extra }),
        { forceRefresh: params.refresh === true }
      );
    } catch (e) {
      console.error(`[inte-comerce] ${label}: loader falhou (${e?.message || e})`);
    }
    if (typeof val === 'number' && Number.isFinite(val)) {
      targetObj[targetKey] = val;
      return 'canonical_metrics';
    }
    console.error(
      `[BACKEND ERROR] [inte-comerce] ${label}: load retornou ${typeof val}, ` +
      `mantendo builder=${targetObj[targetKey]}`
    );
    return 'banco';
  };

  fonte.assinados    = await applyCanonicalAssinados(result, params);
  fonte.ganhos       = await applyCanonical('ganhos',       loadGanhosTotal,       result.overview, 'ganhos',       { mode: params.mode });
  fonte.protocolados = await applyCanonical('protocolados', loadProtocoladosTotal, result.overview, 'protocolados', { mode: params.mode });
  fonte.emitidos     = await applyCanonical('emitidos',     loadEmitidosTotal,     result.funnel,   'emitidos');
  fonte.desqualificados = await applyCanonicalDesqualificados(result, params);

  result.strategic.recebidos  = result.overview.recebidos;
  result.strategic.em_contato = result.overview.em_contato_crm;
  result.strategic.assinados  = result.overview.assinados;

  if (result.overview.recebidos > 0) {
    result.strategic.pct_recebidos_ate_assinados  =
      Number((100 * result.overview.assinados      / result.overview.recebidos).toFixed(2));
    result.strategic.pct_recebidos_ate_em_contato =
      Number((100 * result.overview.em_contato_crm / result.overview.recebidos).toFixed(2));
  }

  const erroKeys = Object.keys(hs.erros || {});
  const motivo = erroKeys.length === 0
    ? null
    : `parcial: ${erroKeys.join(', ')} caíram para banco`;

  result.hubspotCards = buildHubspotCards(hs);
  result.hubspot = {
    ativo: true,
    fonte,
    produto_aplicado: params.produto ?? null,
    motivo,
    ...hubspotDiagnostics(hs),
  };
}

// ─── QUANTIDADES POR ETAPA (banco, consulta de referência) ───────────────────
// Recebidos, Em contato, Coleta e Validação Sup passam a vir de
// metricsLoaders.loadStageCounts em TODOS os blocos (visão geral, funil,
// estratégico, colaboradores, equipes e produção). Roda DEPOIS do merge com o
// HubSpot para o banco ter a última palavra nessas quatro quantidades.
function stageScopeIds(params) {
  if (params.colaborador_id != null) return [String(params.colaborador_id)];
  if (params.colaborador_ids_escopo != null) return params.colaborador_ids_escopo.map(String);
  return null;
}

async function loadScopedCached(label, loaderFn, params) {
  const colaboradorIds = stageScopeIds(params);
  const scopeKey = colaboradorIds == null
    ? 'all'
    : createHash('sha256').update(colaboradorIds.slice().sort().join(',')).digest('hex');
  try {
    const rows = await cached(
      metricCacheKey(label, {
        start: params.inicio, end: params.fim_exclusivo,
        equipe: params.equipe, produto: params.produto,
        mode: params.mode, scope: scopeKey,
      }),
      () => loaderFn({
        start: params.inicio,
        end: params.fim_exclusivo,
        equipe: params.equipe,
        produto: params.produto,
        mode: params.mode,
        colaboradorIds,
      }),
      { forceRefresh: params.refresh === true }
    );
    if (Array.isArray(rows)) return rows;
    console.error(`[BACKEND ERROR] [inte-comerce] ${label}: load retornou ${typeof rows}, mantendo valores do builder`);
  } catch (e) {
    console.error(`[inte-comerce] ${label}: loader falhou (${e?.message || e})`);
  }
  return null;
}

async function loadStageCountsCached(params) {
  const colaboradorIds = stageScopeIds(params);
  const scopeKey = colaboradorIds == null
    ? 'all'
    : createHash('sha256').update(colaboradorIds.slice().sort().join(',')).digest('hex');
  try {
    const rows = await cached(
      metricCacheKey('stage-counts', {
        start: params.inicio, end: params.fim_exclusivo,
        equipe: params.equipe, produto: params.produto,
        mode: params.mode, scope: scopeKey,
      }),
      () => loadStageCounts({
        start: params.inicio,
        end: params.fim_exclusivo,
        equipe: params.equipe,
        produto: params.produto,
        mode: params.mode,
        colaboradorIds,
      }),
      { forceRefresh: params.refresh === true }
    );
    if (Array.isArray(rows)) return rows;
    console.error(`[BACKEND ERROR] [inte-comerce] stage-counts: load retornou ${typeof rows}, mantendo valores do builder`);
  } catch (e) {
    console.error(`[inte-comerce] stage-counts: loader falhou (${e?.message || e})`);
  }
  return null;
}

const STAGE_KEYS = ['recebidos', 'em_contato', 'coleta'];
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Assinados e Emitidos do funil (core.assinaturas) — respeitam safra x produção
// e o escopo (unidade / equipe / colaborador). Última palavra nesses números.
async function applyCanonicalAssinaturasFunil(result, params) {
  const rows = await loadScopedCached('assinaturas-funil', loadAssinaturasFunil, params);
  if (!rows) return 'banco';

  let emitidos = 0, assinados = 0;
  for (const r of rows) { emitidos += num(r.emitidos); assinados += num(r.assinados); }

  result.overview.assinados = assinados;
  if (result.funnel) { result.funnel.assinados = assinados; result.funnel.emitidos = emitidos; }
  if (result.strategic) {
    result.strategic.assinados = assinados;
    const rec = num(result.overview.recebidos);
    result.strategic.pct_recebidos_ate_assinados = rec ? Number((100 * assinados / rec).toFixed(2)) : null;
  }
  if (result.productionComparison?.month) result.productionComparison.month.assinados = assinados;
  if (result.safraComparison?.month) result.safraComparison.month.assinados = assinados;

  if (Array.isArray(result.collaborators)) {
    const byId = new Map();
    for (const r of rows) if (r.colaborador_id != null) byId.set(String(r.colaborador_id), r);
    const used = new Set();
    for (const c of result.collaborators) {
      const id = c.colaborador_id != null ? String(c.colaborador_id) : null;
      const src = id && !used.has(id) ? byId.get(id) : null;
      if (src) used.add(id);
      c.assinados = num(src?.assinados);
      c.emitidos = num(src?.emitidos);
    }
    for (const [id, src] of byId) {
      if (used.has(id) || (!num(src.assinados) && !num(src.emitidos))) continue;
      result.collaborators.push({
        colaborador_id: id, colaborador: src.colaborador, equipe_atual: src.equipe || PLACEHOLDER_TEAM,
        recebimentos_deal_dia: 0, trabalhados: 0, em_contato: 0, coleta: 0, 
        emitidos: num(src.emitidos), assinados: num(src.assinados), ganhos: 0, protocolados: 0,
        pct_olos_pendente: null, pct_hubspot_pendente: null,
      });
    }
    result.collaborators.sort((a, b) => b.assinados - a.assinados || b.recebimentos_deal_dia - a.recebimentos_deal_dia);
  }

  if (Array.isArray(result.teams)) {
    const byTeam = new Map();
    for (const r of rows) {
      const key = normalizeTeamKey(r.equipe);
      if (!key) continue;
      const acc = byTeam.get(key) || { equipe: r.equipe, assinados: 0, emitidos: 0 };
      acc.assinados += num(r.assinados); acc.emitidos += num(r.emitidos);
      byTeam.set(key, acc);
    }
    const seen = new Set();
    for (const t of result.teams) {
      const key = normalizeTeamKey(t.equipe);
      seen.add(key);
      const src = byTeam.get(key);
      t.assinados = num(src?.assinados);
      t.emitidos = num(src?.emitidos);
    }
    for (const [key, src] of byTeam) {
      if (seen.has(key) || (!src.assinados && !src.emitidos)) continue;
      result.teams.push({
        equipe: src.equipe, recebimentos_assessor_deal_dia: 0, deals_unicos_da_equipe: 0,
        trabalhados: 0, em_contato: 0, coleta: 0,
        emitidos: src.emitidos, assinados: src.assinados, ganhos: 0, protocolados: 0,
      });
    }
    result.teams.sort((a, b) => b.assinados - a.assinados);
  }

  return 'banco_assinaturas';
}

async function applyCanonicalStageCounts(result, params) {
  const rows = await loadStageCountsCached(params);
  if (!rows) return 'banco';

  // Totais (cada deal pertence a um único responsável → soma = distintos)
  const totals = { recebidos: 0, em_contato: 0, coleta: 0 };
  for (const r of rows) for (const k of STAGE_KEYS) totals[k] += num(r[k]);

  result.overview.recebidos = totals.recebidos;
  result.overview.em_contato_crm = totals.em_contato;
  if (result.funnel) {
    result.funnel.recebidos = totals.recebidos;
    result.funnel.em_contato = totals.em_contato;
    result.funnel.coleta = totals.coleta;
  }
  if (result.strategic) {
    result.strategic.recebidos = totals.recebidos;
    result.strategic.em_contato = totals.em_contato;
    result.strategic.pct_recebidos_ate_em_contato = totals.recebidos
      ? Number((100 * totals.em_contato / totals.recebidos).toFixed(2)) : null;
    result.strategic.pct_recebidos_ate_assinados = totals.recebidos
      ? Number((100 * num(result.overview.assinados) / totals.recebidos).toFixed(2)) : null;
  }
  if (result.productionComparison?.month) result.productionComparison.month.recebidos = totals.recebidos;
  if (result.safraComparison?.month) result.safraComparison.month.recebidos = totals.recebidos;

  // Colaboradores — uma linha da consulta por colaborador_id
  if (Array.isArray(result.collaborators)) {
    const byId = new Map();
    for (const r of rows) if (r.colaborador_id != null) byId.set(String(r.colaborador_id), r);

    const rowsById = new Map();
    for (const c of result.collaborators) {
      const id = c.colaborador_id != null ? String(c.colaborador_id) : null;
      if (!id) continue;
      if (!rowsById.has(id)) rowsById.set(id, []);
      rowsById.get(id).push(c);
    }
    for (const [id, list] of rowsById) {
      const src = byId.get(id);
      const target = (src && list.find((c) => normalizeTeamKey(c.equipe_atual) === normalizeTeamKey(src.equipe))) || list[0];
      for (const c of list) {
        const s = c === target ? src : null;
        c.recebimentos_deal_dia = num(s?.recebidos);
        c.em_contato = num(s?.em_contato);
        c.coleta = num(s?.coleta);
      }
    }
    for (const [id, src] of byId) {
      if (rowsById.has(id)) continue;
      result.collaborators.push({
        colaborador_id: id, colaborador: src.colaborador, equipe_atual: src.equipe || PLACEHOLDER_TEAM,
        recebimentos_deal_dia: num(src.recebidos), trabalhados: 0,
        em_contato: num(src.em_contato), coleta: num(src.coleta),
        assinados: 0, ganhos: 0, protocolados: 0,
        pct_olos_pendente: null, pct_hubspot_pendente: null,
      });
    }
    result.collaborators.sort((a, b) => b.assinados - a.assinados || b.recebimentos_deal_dia - a.recebimentos_deal_dia);
  }

  // Equipes — soma da consulta por nome_equipe
  if (Array.isArray(result.teams)) {
    const byTeam = new Map();
    for (const r of rows) {
      const key = normalizeTeamKey(r.equipe);
      if (!key) continue;
      const acc = byTeam.get(key) || { equipe: r.equipe, recebidos: 0, em_contato: 0, coleta: 0 };
      for (const k of STAGE_KEYS) acc[k] += num(r[k]);
      byTeam.set(key, acc);
    }
    const seen = new Set();
    for (const t of result.teams) {
      const key = normalizeTeamKey(t.equipe);
      const src = byTeam.get(key);
      seen.add(key);
      t.recebimentos_assessor_deal_dia = num(src?.recebidos);
      t.em_contato = num(src?.em_contato);
      t.coleta = num(src?.coleta);
    }
    for (const [key, src] of byTeam) {
      if (seen.has(key)) continue;
      result.teams.push({
        equipe: src.equipe, recebimentos_assessor_deal_dia: src.recebidos,
        deals_unicos_da_equipe: src.recebidos, trabalhados: 0,
        em_contato: src.em_contato, coleta: src.coleta,
        assinados: 0, ganhos: 0, protocolados: 0,
      });
    }
    result.teams.sort((a, b) => b.assinados - a.assinados);
  }

  return 'banco_etapas';
}

export async function getInteComerceRawAnalytics(params) {
  const raw = await getRawEvents(params);

  let result;
  if (PRODUCTION_MODES.has(params.mode)) {
    result = buildProductionComparisonResults(raw, params);
  } else if (params.mode === 'safra') {
    result = buildComparisonResults(raw, params);
  } else {
    result = buildOperationalResults(raw, params);
  }

  if (hubspotEnabled()) {
    const ownerIds = await resolveHubSpotOwnerIds(params);
    const gate = canUseHubSpotFor(params, ownerIds);
    if (gate.ok) {
      const hs = await getHubSpotOverviewCached({
        inicio: params.inicio,
        fim_exclusivo: params.fim_exclusivo,
        produto: params.produto,
        mode: params.mode,
        ownerIds,
        refresh: params.refresh,
      });
      await mergeHubSpot(result, hs, params);
    } else {
      const fonte = {};
      fonte.assinados       = await applyCanonicalAssinados(result, params);
      fonte.desqualificados = await applyCanonicalDesqualificados(result, params);
      result.hubspot = {
        ativo: false,
        fonte,
        produto_aplicado: params.produto ?? null,
        motivo: gate.motivo,
      };
    }
  } else {
    const fonte = {};
    fonte.assinados       = await applyCanonicalAssinados(result, params);
    fonte.desqualificados = await applyCanonicalDesqualificados(result, params);
    result.hubspot = {
      ativo: false,
      fonte,
      produto_aplicado: params.produto ?? null,
      motivo: 'HUBSPOT_ACCESS_TOKEN não configurado',
    };
  }

  // Quantidades por etapa (Recebidos / Em contato / Coleta / Validação Sup)
  // sempre vêm da consulta de referência no banco — última palavra.
  const fonteEtapas = await applyCanonicalStageCounts(result, params);
  // Assinados / Emitidos — depois das etapas (usa recebidos final no %)
  const fonteAssinaturas = await applyCanonicalAssinaturasFunil(result, params);
  if (result.hubspot) {
    result.hubspot.fonte = {
      ...(result.hubspot.fonte || {}),
      recebidos: fonteEtapas, em_contato_crm: fonteEtapas,
      coleta: fonteEtapas,
      assinados: fonteAssinaturas, emitidos: fonteAssinaturas,
    };
  }

  return result;
}

export async function getInteComercePeriodSummary(params) {
  const raw = await getRawEvents(params);

  let full;
  if (PRODUCTION_MODES.has(params.mode)) {
    full = buildProductionComparisonResults(raw, params);
  } else if (params.mode === 'safra') {
    full = buildComparisonResults(raw, params);
  } else {
    full = buildOperationalResults(raw, params);
  }

  // ✅ FIX 21: o resumo usa o mesmo total de assinados do resto do relatório
  await applyCanonicalAssinados(full, params);
  await applyCanonicalStageCounts(full, params);
  await applyCanonicalAssinaturasFunil(full, params);

  const month = full.productionComparison?.month
    ? {
        recebidos:    full.productionComparison.month.recebidos    ?? 0,
        assinados:    full.productionComparison.month.assinados    ?? 0,
        ganhos:       full.productionComparison.month.ganhos       ?? 0,
        protocolados: full.productionComparison.month.protocolados ?? 0,
      }
    : {
        recebidos:    full.overview.recebidos    ?? 0,
        assinados:    full.overview.assinados    ?? 0,
        ganhos:       full.overview.ganhos       ?? 0,
        protocolados: full.overview.protocolados ?? 0,
      };

  const day = full.productionComparison?.day
    ? {
        recebidos:    full.productionComparison.day.recebidos    ?? 0,
        assinados:    full.productionComparison.day.assinados    ?? 0,
        ganhos:       full.productionComparison.day.ganhos       ?? 0,
        protocolados: full.productionComparison.day.protocolados ?? 0,
      }
    : null;

  return { asOf: full.asOf, month, day };
}