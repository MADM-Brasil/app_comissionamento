// Serviço completo — ES modules, Node.js 18+.
// Correção: defaults de Coleta/Entrada confirmados no Closer desta conta.
// Variáveis de ambiente não vazias E numéricas continuam tendo precedência.
// Qualquer valor inválido (vazio, não numérico, com lixo) é ignorado e o
// default é usado — evitando o erro "HUBSPOT_STAGE_*_ID inválido" em runtime.
// Autorização de usuário/equipe continua sendo responsabilidade dos workers.
// Locks locais não substituem reserva exclusiva e locks distribuídos.

const API_ORIGIN = 'https://api.hubapi.com';

// ---------------------------------------------------------------------------
// Leitura de configuração
// ---------------------------------------------------------------------------
// `setting` continua aceitando qualquer string (usado para token e texto).
const setting = (name, fallback = '') => String(process.env[name] || fallback).trim();

// `settingNumeric` é usado para IDs. Diferente de `setting`:
//   - descarta espaços em branco nas pontas;
//   - se o valor não for uma sequência puramente numérica (ex.: "", "abc",
//     "123 ", "12\n", "null"), cai automaticamente no default.
// Isso evita que um valor inválido no .env (ou uma linha em branco
// acidental) quebre `temporalCheck` no momento da movimentação.
const settingNumeric = (name, fallback = '') => {
  const raw = String(process.env[name] ?? '').trim();
  if (/^\d+$/.test(raw)) return raw;
  return String(fallback ?? '').trim();
};

// IDs de pipeline (numéricos, com defaults confirmados no Closer desta conta)
const PIPELINE_BASE_LEADS_ID             = settingNumeric('HUBSPOT_PIPELINE_BASE_LEADS_ID', '905901447');
const PIPELINE_CLOSER_ID                 = settingNumeric('HUBSPOT_PIPELINE_CLOSER_ID', '904458124');
const PIPELINE_JURIDICO_AUDITORIA_ID     = settingNumeric('HUBSPOT_PIPELINE_JURIDICO_AUDITORIA_ID', '905179189');

// Portal ID — não tem default (precisa existir no ambiente), mas é lido como
// string pura porque `verifyHubSpotPortalConfiguration` já faz a validação.
const HUBSPOT_PORTAL_ID = setting('HUBSPOT_PORTAL_ID');

// IDs de etapa no Closer (numéricos, com defaults confirmados)
const STAGE_EM_CONTATO_ID             = settingNumeric('HUBSPOT_STAGE_EM_CONTATO_ID', '1368997801');
const STAGE_DESQUALIFICADO_ID         = settingNumeric('HUBSPOT_STAGE_DESQUALIFICADO_ID', '1368997806');
const STAGE_COLETA_DOCUMENTACAO_ID    = settingNumeric('HUBSPOT_STAGE_COLETA_DOCUMENTACAO_ID', '1368997802');
const STAGE_ENTRADA_ID                = settingNumeric('HUBSPOT_STAGE_ENTRADA_ID', '1368997800');

export const HUBSPOT_PIPELINE_BASE_LEADS_ID = PIPELINE_BASE_LEADS_ID;
export const HUBSPOT_PIPELINE_CLOSER_ID = PIPELINE_CLOSER_ID;
export const HUBSPOT_PIPELINE_JURIDICO_AUDITORIA_ID = PIPELINE_JURIDICO_AUDITORIA_ID;
export const HUBSPOT_PORTAL_ID_CONFIGURED = HUBSPOT_PORTAL_ID;
export const HUBSPOT_STAGE_EM_CONTATO_ID = STAGE_EM_CONTATO_ID;
export const HUBSPOT_STAGE_DESQUALIFICADO_ID = STAGE_DESQUALIFICADO_ID;
export const HUBSPOT_STAGE_COLETA_DOCUMENTACAO_ID = STAGE_COLETA_DOCUMENTACAO_ID;
export const HUBSPOT_STAGE_ENTRADA_ID = STAGE_ENTRADA_ID;

const CONTACT_PROPERTIES = ['email','firstname','lastname','phone','hs_whatsapp_phone_number','contact_cpf','contact_fonte','contact_produto','hubspot_owner_id'];
const DEAL_PROPERTIES = ['dealname','pipeline','dealstage','hubspot_owner_id','notes_last_updated','motivo_da_perda','hs_lastmodifieddate','produto'];

const PIPELINE_NAMES = {
  [PIPELINE_BASE_LEADS_ID]: 'Base de Leads', [PIPELINE_CLOSER_ID]: 'Closer',
  [PIPELINE_JURIDICO_AUDITORIA_ID]: 'Jurídico Auditoria de Ganho',
  '905179471': 'PRO', '926561825': 'Fator K', '925690734': 'Quinquenio/concomitante',
};

const STAGE_NAMES = {
  [STAGE_EM_CONTATO_ID]: 'Em Contato', [STAGE_DESQUALIFICADO_ID]: 'Desqualificado',
  [STAGE_COLETA_DOCUMENTACAO_ID]: 'Coleta de documentação', [STAGE_ENTRADA_ID]: 'Entrada',
};

const RULE_MESSAGES = Object.freeze({
  created_and_moved: 'Card criado na Base de Leads e movido para o Closer (Em Contato).',
  base_to_closer: 'Card movido da Base de Leads para o Closer (Em Contato).',
  desqualificado_to_em_contato: 'Card desqualificado reativado no Closer (Em Contato).',
  closer_without_owner: 'Card estava no Closer sem responsável; atribuído agora.',
  reassigned_by_last_modified_date: 'Card reatribuído com base na última modificação.',
  already_assigned: 'Card já está com o responsável informado; contato alinhado.',
  ambiguous_deals: 'Contato associado a vários cards. Use o link do card correto.',
  fallback_block: 'Card fora dos pipelines permitidos.',
  owned_by_another_recent_activity: 'Card pertence a outro responsável e a última modificação está dentro do prazo mínimo.',
  owner_missing: 'Responsável destino não informado.',
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function hubError(message, details = {}) {
  return Object.assign(new Error(message), { code: 'HUBSPOT_ERROR', retryable: false, blocked: false, ...details });
}

function id(value, label = 'Identificador') {
  const result = String(value ?? '').trim();
  if (!/^\d+$/.test(result)) throw hubError(`${label} inválido.`, { blocked: true, code: 'INVALID_ID' });
  return result;
}

function optionalText(value) { return value == null ? '' : String(value).trim(); }

function cleanEmail(value) {
  const result = optionalText(value).toLowerCase();
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw hubError('E-mail inválido.', { blocked: true });
  return result;
}

function token() {
  const result = setting('CHV_Hubspot');
  if (!result) throw hubError('CHV_Hubspot não está configurado.', { code: 'CONFIGURATION_ERROR' });
  return result;
}

function timeoutMs() {
  const value = Number(process.env.HUBSPOT_HTTP_TIMEOUT_MS || 20000);
  return Number.isFinite(value) && value >= 1000 && value <= 120000 ? value : 20000;
}

function retryDelay(response, attempt) {
  const raw = response?.headers.get('retry-after');
  const numeric = raw ? Number(raw) : NaN;
  const dated = raw ? Date.parse(raw) - Date.now() : NaN;
  const delay = Number.isFinite(numeric) ? numeric * 1000 : Number.isFinite(dated) ? dated : 500 * (2 ** attempt);
  return Math.min(30000, Math.max(250, delay)) + Math.floor(Math.random() * 200);
}

async function request(endpoint, { method = 'GET', body, readOnly = false, attempts = 3 } = {}) {
  const safe = method === 'GET' || readOnly;
  const totalAttempts = safe ? attempts : 1;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const response = await fetch(new URL(endpoint, API_ORIGIN), {
        method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; }
      catch { throw hubError('Resposta não JSON recebida do HubSpot.', { httpStatus: response.status, retryable: safe, outcomeUnknown: !safe }); }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = hubError(`HubSpot retornou HTTP ${response.status}.`, {
          httpStatus: response.status, retryable, blocked: response.status === 404,
          correlationId: data.correlationId || null, category: data.category || null,
          retryAfter: response.headers.get('retry-after'), outcomeUnknown: !safe && response.status >= 500,
        });
        if (safe && retryable && attempt + 1 < totalAttempts) {
          clearTimeout(timer); await sleep(retryDelay(response, attempt)); continue;
        }
        throw error;
      }
      return data;
    } catch (error) {
      if (error.code) throw error;
      const wrapped = hubError('Falha de rede ou timeout ao acessar o HubSpot.', {
        retryable: true, outcomeUnknown: !safe, code: 'NETWORK_ERROR',
      });
      if (safe && attempt + 1 < totalAttempts) {
        clearTimeout(timer); await sleep(500 * (2 ** attempt)); continue;
      }
      throw wrapped;
    } finally { clearTimeout(timer); }
  }
  throw hubError('Consulta ao HubSpot não concluída.');
}

let verifiedAccount = null;
let portalVerification = null;

export async function verifyHubSpotPortalConfiguration() {
  id(HUBSPOT_PORTAL_ID, 'HUBSPOT_PORTAL_ID');
  const currentToken = token();
  if (verifiedAccount?.token === currentToken && verifiedAccount.expiresAt > Date.now()) return verifiedAccount.portalId;
  if (!portalVerification || portalVerification.token !== currentToken) {
    const promise = (async () => {
      const account = await request('/integrations/v1/me');
      const portalId = String(account.portalId ?? '');
      if (portalId !== HUBSPOT_PORTAL_ID) throw hubError('A conta do token não corresponde ao HUBSPOT_PORTAL_ID.', { blocked: true, code: 'ACCOUNT_MISMATCH' });
      verifiedAccount = { token: currentToken, portalId, expiresAt: Date.now() + 300000 };
      return portalId;
    })();
    portalVerification = { token: currentToken, promise };
    promise.finally(() => { if (portalVerification?.promise === promise) portalVerification = null; }).catch(() => {});
  }
  return portalVerification.promise;
}

async function accountReady() { await verifyHubSpotPortalConfiguration(); }

const mutexes = new Map();
async function withLocks(keys, action) {
  const releases = [];
  try {
    for (const key of [...new Set(keys)].sort()) {
      const previous = mutexes.get(key) || Promise.resolve();
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const tail = previous.then(() => gate);
      mutexes.set(key, tail);
      await previous;
      releases.push(() => { release(); if (mutexes.get(key) === tail) mutexes.delete(key); });
    }
    return await action();
  } finally { releases.reverse().forEach(release => release()); }
}

function mapDeal(deal) {
  const p = deal.properties || {};
  return { id: String(deal.id), dealName: p.dealname || null, pipeline: p.pipeline || null,
    stage: p.dealstage || null, ownerId: p.hubspot_owner_id || null,
    notesLastUpdated: p.notes_last_updated || null, motivoDaPerda: p.motivo_da_perda || null,
    lastModifiedDate: p.hs_lastmodifieddate || null, produto: p.produto || null };
}

async function getContact(contactId, properties = CONTACT_PROPERTIES) {
  return request(`/crm/v3/objects/contacts/${id(contactId)}?properties=${encodeURIComponent(properties.join(','))}`);
}

async function getDeal(dealId) {
  return request(`/crm/v3/objects/deals/${id(dealId)}?properties=${encodeURIComponent(DEAL_PROPERTIES.join(','))}`);
}

async function associationIds(fromType, fromId, toType) {
  const ids = new Set(), cursors = new Set();
  let after;
  do {
    const query = new URLSearchParams({ limit: '500' });
    if (after !== undefined) query.set('after', String(after));
    const data = await request(`/crm/v4/objects/${fromType}/${id(fromId)}/associations/${toType}?${query}`);
    for (const a of data.results || []) ids.add(id(a.toObjectId, 'Registro associado'));
    const next = data.paging?.next?.after;
    after = next == null ? undefined : String(next);
    if (after !== undefined) {
      if (cursors.has(after)) throw hubError('Cursor de associações repetido; leitura interrompida.');
      cursors.add(after);
    }
  } while (after !== undefined);
  return [...ids];
}

async function getDealsByIds(dealIds = []) {
  const results = [];
  for (const dealId of [...new Set(dealIds.map(value => id(value)))]) results.push(mapDeal(await getDeal(dealId)));
  return results;
}

export async function getContactDeals(contactId) {
  await accountReady();
  return getDealsByIds(await associationIds('contacts', contactId, 'deals'));
}

function normalizePhone(value) { return optionalText(value).replace(/\D/g, ''); }

function nationalPhone(value) {
  const digits = normalizePhone(value);
  return digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
}

function phonesMatch(a, b) {
  const left = nationalPhone(a), right = nationalPhone(b);
  return left.length >= 10 && left === right;
}

function buildPhoneVariants(phone) {
  const raw = optionalText(phone), digits = normalizePhone(raw), national = nationalPhone(raw);
  return [...new Set([raw, digits, national, national ? `55${national}` : '', national ? `+55${national}` : ''].filter(Boolean))];
}

async function searchContacts(payload) {
  const results = [], cursors = new Set();
  let after;
  do {
    const data = await request('/crm/v3/objects/contacts/search', { method: 'POST', readOnly: true,
      body: { ...payload, properties: CONTACT_PROPERTIES, limit: 100, ...(after === undefined ? {} : { after }) } });
    results.push(...(data.results || []));
    const next = data.paging?.next?.after;
    after = next == null ? undefined : String(next);
    if (after !== undefined) {
      if (cursors.has(after)) throw hubError('Cursor de pesquisa repetido.');
      cursors.add(after);
    }
  } while (after !== undefined);
  return results;
}

async function searchContactByField(propertyName, value) {
  return searchContacts({ filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }] });
}

function chooseUnique(results) {
  const unique = [...new Map(results.map(c => [String(c.id), c])).values()];
  if (unique.length > 1) throw hubError('Mais de um contato corresponde à busca. Selecione o registro antes de movimentar.', {
    blocked: true, code: 'AMBIGUOUS_CONTACT', candidateIds: unique.map(c => String(c.id)),
  });
  return unique[0] || null;
}

async function searchContactByPhone(phone) {
  const results = [];
  const matching = c => [c.properties?.phone, c.properties?.hs_whatsapp_phone_number].some(value => phonesMatch(value, phone));
  for (const variant of buildPhoneVariants(phone)) {
    for (const property of ['phone', 'hs_whatsapp_phone_number']) results.push(...(await searchContactByField(property, variant)).filter(matching));
  }
  if (!results.length) results.push(...(await searchContacts({ query: normalizePhone(phone) })).filter(matching));
  return chooseUnique(results);
}

function validateContact(contact, input) {
  const props = contact.properties || {}, divergences = [];
  if (input.email && props.email && cleanEmail(props.email) !== input.email) divergences.push('e-mail');
  const phones = [props.phone, props.hs_whatsapp_phone_number].filter(Boolean);
  if (input.phone && phones.length && !phones.some(phone => phonesMatch(phone, input.phone))) divergences.push('telefone');
  if (input.cpf && props.contact_cpf && normalizePhone(props.contact_cpf) !== input.cpf) divergences.push('CPF');
  return { found: true, divergente: divergences.length > 0, contact,
    ...(divergences.length ? { motivo: `Dados divergentes do cadastro: ${divergences.join(', ')}` } : {}) };
}

export async function findContactAndValidate({ email, phone, cpf } = {}) {
  await accountReady();
  const input = { email: cleanEmail(email), phone: normalizePhone(phone), cpf: normalizePhone(cpf) };
  if (optionalText(cpf) && input.cpf.length !== 11) throw hubError('CPF deve conter 11 dígitos.', { blocked: true });
  let contact = null;
  if (nationalPhone(phone).length >= 10) contact = await searchContactByPhone(phone);
  if (!contact && input.email) contact = chooseUnique(await searchContactByField('email', input.email));
  if (!contact && input.cpf) contact = chooseUnique(await searchContactByField('contact_cpf', input.cpf));
  return contact ? validateContact(contact, input) : { found: false, divergente: false, contact: null };
}

export async function searchContact(input = {}) {
  const result = await findContactAndValidate(input);
  if (result.divergente) throw hubError(result.motivo, { blocked: true, code: 'CONTACT_DATA_MISMATCH' });
  return result.contact;
}

export async function findOwnerIdByEmailStrict(email) {
  const normalized = cleanEmail(email);
  if (!normalized) return null;
  await accountReady();
  const data = await request(`/crm/v3/owners?email=${encodeURIComponent(normalized)}&archived=false`);
  const matches = (data.results || []).filter(o => !o.archived && cleanEmail(o.email) === normalized);
  if (data.paging?.next || matches.length > 1) throw hubError('Consulta de proprietário inconclusiva ou ambígua.', { blocked: true });
  return matches.length ? id(matches[0].id, 'Proprietário') : null;
}

export async function findOwnerIdByEmail(email) { return findOwnerIdByEmailStrict(email); }

async function activeOwner(ownerId) {
  const owner = await request(`/crm/v3/owners/${id(ownerId, 'Proprietário')}`);
  if (owner.archived || !owner.email || String(owner.id) !== String(ownerId)) throw hubError('Proprietário destino inválido ou arquivado.', { blocked: true });
  return owner;
}

export async function getHubSpotOwnerEmail(ownerId) {
  if (!ownerId) return null;
  await accountReady();
  return cleanEmail((await request(`/crm/v3/owners/${id(ownerId, 'Proprietário')}`)).email) || null;
}

export async function createContact({ firstName, lastName, email, phone, cpf, origem, ownerId, produto } = {}) {
  await accountReady();
  const properties = { firstname: optionalText(firstName), lastname: optionalText(lastName) };
  const normalizedEmail = cleanEmail(email);
  if (normalizedEmail) properties.email = normalizedEmail;
  if (optionalText(phone)) { properties.phone = optionalText(phone); properties.hs_whatsapp_phone_number = optionalText(phone); }
  if (optionalText(cpf)) {
    const cleaned = normalizePhone(cpf);
    if (cleaned.length !== 11) throw hubError('CPF deve conter 11 dígitos.', { blocked: true });
    properties.contact_cpf = cleaned;
  }
  if (origem) properties.contact_fonte = optionalText(origem);
  if (produto) properties.contact_produto = optionalText(produto);
  if (ownerId) { await activeOwner(ownerId); properties.hubspot_owner_id = id(ownerId); }
  try { return await request('/crm/v3/objects/contacts', { method: 'POST', body: { properties, associations: [] } }); }
  catch (error) {
    if (error.httpStatus === 409 && normalizedEmail) {
      const existing = chooseUnique(await searchContactByField('email', normalizedEmail));
      if (existing) {
        const validated = validateContact(existing, { email: normalizedEmail, phone: normalizePhone(phone), cpf: normalizePhone(cpf) });
        if (validated.divergente) throw hubError(validated.motivo, { blocked: true });
        if (produto && String(existing.properties?.contact_produto || '') !== String(produto)) {
          try {
            await request(`/crm/v3/objects/contacts/${id(existing.id)}`, { method: 'PATCH', body: { properties: { contact_produto: optionalText(produto) } } });
            existing.properties = { ...(existing.properties || {}), contact_produto: optionalText(produto) };
          } catch (patchError) { console.error('[hubspot] Falha ao sincronizar contact_produto:', patchError.message); }
        }
        return existing;
      }
    }
    throw error;
  }
}

export async function updateContactOwner(contactId, ownerId, produto = null) {
  await accountReady(); id(contactId, 'Contato'); await activeOwner(ownerId);
  return request(`/crm/v3/objects/contacts/${id(contactId)}`, { method: 'PATCH', body: {
    properties: { hubspot_owner_id: id(ownerId), ...(produto ? { contact_produto: optionalText(produto) } : {}) },
  } });
}

export async function getFirstStageId(pipelineId) {
  await accountReady();
  const data = await request(`/crm/v3/pipelines/deals/${id(pipelineId)}/stages`);
  const stages = (data.results || []).filter(s => !s.archived).sort((a,b) => Number(a.displayOrder) - Number(b.displayOrder));
  return stages[0]?.id ? String(stages[0].id) : null;
}

async function validateStage(pipelineId, stageId) {
  const data = await request(`/crm/v3/pipelines/deals/${id(pipelineId)}/stages`);
  if (!(data.results || []).some(s => String(s.id) === String(stageId) && !s.archived)) throw hubError('Etapa não pertence ao pipeline configurado.', { blocked: true, code: 'INVALID_STAGE' });
}

async function dealContactAssociationType() {
  const data = await request('/crm/v4/associations/deals/contacts/labels');
  const types = (data.results || []).filter(t => t.category === 'HUBSPOT_DEFINED' && t.label === null);
  if (types.length !== 1) throw hubError('Não foi possível resolver a associação padrão de negócio para contato.');
  return Number(id(types[0].typeId, 'Tipo de associação'));
}

export async function createDealForContact(contactId, dealName, pipelineId, stageId = null, ownerId = null, produto = null) {
  await accountReady(); id(contactId, 'Contato'); id(pipelineId, 'Pipeline');
  const finalStage = stageId || await getFirstStageId(pipelineId);
  id(finalStage, 'Etapa'); await validateStage(pipelineId, finalStage);
  if (ownerId) await activeOwner(ownerId);
  const associationTypeId = await dealContactAssociationType();
  return request('/crm/v3/objects/deals', { method: 'POST', body: {
    properties: { dealname: optionalText(dealName), pipeline: String(pipelineId), dealstage: String(finalStage), motivo_da_perda: '',
      ...(produto ? { produto: optionalText(produto) } : {}), ...(ownerId ? { hubspot_owner_id: id(ownerId) } : {}) },
    associations: [{ to: { id: String(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId }] }],
  } });
}

export async function moveDealToCloserEmContato(dealId, ownerId = null, produto = null) {
  await accountReady(); await validateStage(PIPELINE_CLOSER_ID, STAGE_EM_CONTATO_ID);
  if (ownerId) await activeOwner(ownerId);
  const deal = await request(`/crm/v3/objects/deals/${id(dealId)}`, { method: 'PATCH', body: {
    properties: { pipeline: PIPELINE_CLOSER_ID, dealstage: STAGE_EM_CONTATO_ID, motivo_da_perda: '',
      ...(produto ? { produto: optionalText(produto) } : {}), ...(ownerId ? { hubspot_owner_id: id(ownerId) } : {}) },
  } });
  return { deal, lastUpdatedAt: deal.properties?.hs_lastmodifieddate || null };
}

export async function syncMovementProduct(dealId, contactId, produto) {
  if (!produto) return;
  await accountReady(); const value = optionalText(produto);
  await request(`/crm/v3/objects/deals/${id(dealId)}`, { method: 'PATCH', body: { properties: { produto: value } } });
  await request(`/crm/v3/objects/contacts/${id(contactId)}`, { method: 'PATCH', body: { properties: { contact_produto: value } } });
  const deal = await getDeal(dealId), contact = await getContact(contactId, ['contact_produto']);
  if (String(deal.properties?.produto || '') !== value || String(contact.properties?.contact_produto || '') !== value) throw hubError('Produto final do card ou contato não confirmado.', { code: 'PRODUCT_CONFIRMATION_FAILED' });
}

function hoursSince(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return !Number.isFinite(timestamp) || timestamp > Date.now() ? null : (Date.now() - timestamp) / 3600000;
}

// ---------------------------------------------------------------------------
// temporalCheck — regra de prazo por etapa.
//
// CORREÇÃO:
//   Antes, a função validava `STAGE_COLETA_DOCUMENTACAO_ID` e
//   `STAGE_ENTRADA_ID` **incondicionalmente** no topo, mesmo quando o card
//   estava em outra etapa (ex.: "Em Contato"). Isso fazia qualquer
//   movimentação falhar com "HUBSPOT_STAGE_*_ID inválido" se a variável
//   correspondente não estivesse bem configurada — mesmo que aquela etapa
//   não fosse usada para o card em questão.
//
//   Agora a validação do ID só ocorre para a etapa **efetivamente
//   aplicável** ao card. Como os defaults já foram garantidos pelo
//   `settingNumeric`, este `id(...)` funciona como dupla proteção:
//   se algo extremamente raro quebrar o default, o erro aponta a etapa
//   específica em vez de bloquear qualquer movimentação.
// ---------------------------------------------------------------------------
function temporalCheck(deal) {
  const required = {
    [STAGE_COLETA_DOCUMENTACAO_ID]: 72,
    [STAGE_ENTRADA_ID]: 24,
    [STAGE_EM_CONTATO_ID]: 24,
  };

  const currentStage = String(deal.stage ?? '');
  const requiredHours = required[currentStage];

  // Só valida o ID da etapa aplicável ao card corrente.
  if (currentStage === STAGE_COLETA_DOCUMENTACAO_ID) {
    id(STAGE_COLETA_DOCUMENTACAO_ID, 'HUBSPOT_STAGE_COLETA_DOCUMENTACAO_ID');
  } else if (currentStage === STAGE_ENTRADA_ID) {
    id(STAGE_ENTRADA_ID, 'HUBSPOT_STAGE_ENTRADA_ID');
  } else if (currentStage === STAGE_EM_CONTATO_ID) {
    id(STAGE_EM_CONTATO_ID, 'HUBSPOT_STAGE_EM_CONTATO_ID');
  }

  const hours = hoursSince(deal.lastModifiedDate);
  const allowed = hours !== null && requiredHours !== undefined && hours > requiredHours;
  const reason = hours === null ? 'Data da última modificação ausente, inválida ou futura'
    : requiredHours === undefined ? 'Etapa não elegível para movimentação por tempo'
    : allowed ? `Última modificação há mais de ${requiredHours}h`
    : `Prazo de mais de ${requiredHours}h desde a última modificação ainda não atingido`;
  return { allowed, reason, requiredHours: requiredHours ?? null, hoursSinceNote: hours, lastUpdated: deal.lastModifiedDate || null };
}

function assignmentResult(deal, extras = {}) {
  return { blocked: false, dealId: deal?.id || null, pipeline: deal?.pipeline || null, stage: deal?.stage || null,
    pipelineNome: PIPELINE_NAMES[deal?.pipeline] || deal?.pipeline || null,
    stageNome: STAGE_NAMES[deal?.stage] || deal?.stage || null, lastUpdatedAt: deal?.lastModifiedDate || null, ...extras };
}

export async function garantirLeadNoCloser(contactId, dealName, ownerId = null, collaboratorName = '', produto = null) {
  if (!ownerId) return assignmentResult(null, { blocked: true, ruleApplied: 'owner_missing', message: RULE_MESSAGES.owner_missing });
  await accountReady(); await activeOwner(ownerId);
  return withLocks([`contact:${id(contactId)}`], async () => {
    const deals = await getContactDeals(contactId);
    if (deals.length > 1) return assignmentResult(null, { blocked: true, ruleApplied: 'ambiguous_deals', message: RULE_MESSAGES.ambiguous_deals });
    let deal = deals[0], rule;
    if (!deal) rule = 'created_and_moved';
    else if (String(deal.pipeline) === PIPELINE_BASE_LEADS_ID) rule = 'base_to_closer';
    else if (String(deal.pipeline) !== PIPELINE_CLOSER_ID) return assignmentResult(deal, { blocked: true, ruleApplied: 'fallback_block', message: RULE_MESSAGES.fallback_block });
    else if (String(deal.stage) === STAGE_DESQUALIFICADO_ID) rule = 'desqualificado_to_em_contato';
    else if (!deal.ownerId) rule = 'closer_without_owner';
    else if (String(deal.ownerId) === String(ownerId)) {
      try {
        await updateContactOwner(contactId, ownerId, produto);
        await syncMovementProduct(deal.id, contactId, produto);
        return assignmentResult(mapDeal(await getDeal(deal.id)), { alreadyAssigned: true, ruleApplied: 'already_assigned', message: RULE_MESSAGES.already_assigned });
      } catch (error) {
        error.partialResult = { dealId: deal.id, contactId: String(contactId), produto };
        error.requiresReconciliation = true; error.retryable = false; throw error;
      }
    } else {
      const check = temporalCheck(deal);
      if (!check.allowed) return assignmentResult(deal, { blocked: true, ruleApplied: 'owned_by_another_recent_activity',
        message: `${RULE_MESSAGES.owned_by_another_recent_activity} ${check.reason}.`, requiredHours: check.requiredHours,
        hoursSinceNote: check.hoursSinceNote, notesLastUpdated: check.lastUpdated });
      rule = 'reassigned_by_last_modified_date';
    }
    const previousContact = await getContact(contactId, ['hubspot_owner_id']);
    let writeAttempted = false, createdDealId = null;
    try {
      if (deal) {
        const fresh = mapDeal(await getDeal(deal.id));
        if (['pipeline','stage','ownerId','lastModifiedDate'].some(k => String(fresh[k] || '') !== String(deal[k] || ''))) throw hubError('Card mudou durante a validação.', { blocked: true, code: 'CONTEXT_CHANGED' });
      } else {
        writeAttempted = true;
        const created = await createDealForContact(contactId, dealName, PIPELINE_BASE_LEADS_ID, null, ownerId, produto);
        createdDealId = String(created.id); deal = mapDeal(created);
      }
      writeAttempted = true;
      await moveDealToCloserEmContato(deal.id, ownerId, produto);
      await updateContactOwner(contactId, ownerId, produto);
      await syncMovementProduct(deal.id, contactId, produto);
      const confirmedDeal = mapDeal(await getDeal(deal.id)), confirmedContact = await getContact(contactId, ['hubspot_owner_id']);
      if (String(confirmedDeal.ownerId) !== String(ownerId) || confirmedDeal.pipeline !== PIPELINE_CLOSER_ID || confirmedDeal.stage !== STAGE_EM_CONTATO_ID || String(confirmedContact.properties?.hubspot_owner_id) !== String(ownerId)) throw hubError('Atribuição final não confirmada.', { code: 'CONFIRMATION_FAILED' });
      return assignmentResult(confirmedDeal, { ruleApplied: rule, message: RULE_MESSAGES[rule] || 'Movimentação concluída com sucesso.' });
    } catch (error) {
      if (writeAttempted) {
        error.partialResult = { dealId: deal?.id || null, createdDealId, contactId: String(contactId), previousContactOwnerId: previousContact.properties?.hubspot_owner_id || '', writeAttempted: true, produto };
        error.requiresReconciliation = true; error.retryable = false;
      }
      throw error;
    }
  });
}

export async function verificarPipelineBaseELevio(contactId) {
  const deal = await findDealInBaseLeads(contactId);
  return { noPipelineBase: Boolean(deal), noFaseEnvio: false, pipeline: deal?.pipeline || null, stage: deal?.stage || null };
}

export async function isContactInPipeline(contactId, pipelineId) {
  return (await getContactDeals(contactId)).some(d => String(d.pipeline) === String(pipelineId));
}

export async function findDealInBaseLeads(contactId) {
  const matches = (await getContactDeals(contactId)).filter(d => String(d.pipeline) === PIPELINE_BASE_LEADS_ID);
  if (matches.length > 1) throw hubError('Mais de um card na Base de Leads.', { blocked: true });
  return matches[0] || null;
}

export async function validateFinalAssignment(contactId, expectedOwnerId, expectedDealId = null, options = {}) {
  await accountReady(); id(expectedOwnerId, 'Proprietário esperado');
  const deals = await getContactDeals(contactId);
  const target = expectedDealId ? deals.find(d => d.id === String(expectedDealId)) : deals.length === 1 ? deals[0] : null;
  if (!target) return { ok: false, error: expectedDealId ? 'Card esperado não associado ao contato.' : 'Card ausente ou ambíguo.', resolvedBy: null };
  const contact = await getContact(contactId, ['hubspot_owner_id']);
  const contactOwnerId = contact.properties?.hubspot_owner_id || '';
  const expectedPipeline = String(options.expectedPipeline || PIPELINE_CLOSER_ID);
  const expectedStage = options.expectedStage === null ? null : String(options.expectedStage || STAGE_EM_CONTATO_ID);
  const ok = String(target.ownerId) === String(expectedOwnerId) && String(contactOwnerId) === String(expectedOwnerId) && String(target.pipeline) === expectedPipeline && (expectedStage === null || String(target.stage) === expectedStage);
  return { ok, resolvedBy: expectedDealId ? 'expected_deal_id' : 'unique_associated_deal', contactOwnerId, deal: target, lastUpdatedAt: target.lastModifiedDate,
    details: { dealPipeline: target.pipeline, dealStage: target.stage, dealOwnerId: target.ownerId, contactOwnerId, associatedDeals: deals } };
}

export async function getDealMovementContext(dealId, portalId) {
  id(dealId, 'Card');
  if (String(portalId) !== id(HUBSPOT_PORTAL_ID, 'HUBSPOT_PORTAL_ID')) throw hubError('Link pertence a outra conta.', { blocked: true });
  await accountReady(); const deal = mapDeal(await getDeal(dealId));
  if (![PIPELINE_BASE_LEADS_ID, PIPELINE_CLOSER_ID].includes(String(deal.pipeline))) throw hubError('Link Hub permitido somente na Base de Leads e no Closer.', { blocked: true, code: 'PIPELINE_NOT_ALLOWED' });
  return { dealId: deal.id, dealName: deal.dealName || '', pipeline: String(deal.pipeline), stage: String(deal.stage || ''), ownerId: String(deal.ownerId || ''), lastModifiedDate: deal.lastModifiedDate };
}

function assertContext(expected, actual) {
  if (!expected || ['ownerId','pipeline','stage'].some(k => !Object.prototype.hasOwnProperty.call(expected, k))) throw hubError('Contexto validado de origem é obrigatório.', { blocked: true, code: 'EXPECTED_CONTEXT_REQUIRED' });
  if ((expected.dealId !== undefined && String(expected.dealId) !== actual.dealId) || ['ownerId','pipeline','stage'].some(k => String(expected[k] || '') !== String(actual[k] || '')) || (expected.lastModifiedDate !== undefined && String(expected.lastModifiedDate || '') !== String(actual.lastModifiedDate || ''))) throw hubError('Card mudou após a validação. Revalide a autorização antes de executar.', { blocked: true, code: 'CONTEXT_CHANGED' });
}

// Implementação comum mantém as regras específicas de cada fluxo.
async function reassignWithContext(dealId, ownerId, portalId, expectedCurrentContext, { linkHub = false, produto = null } = {}) {
  id(dealId, 'Card'); id(ownerId, 'Proprietário destino');
  return withLocks([`deal:${dealId}`], async () => {
    const initial = await getDealMovementContext(dealId, portalId);
    assertContext(expectedCurrentContext, initial); await activeOwner(ownerId);
    const contactIds = await associationIds('deals', dealId, 'contacts');
    if (contactIds.length !== 1) throw hubError(contactIds.length ? 'Card associado a múltiplos contatos; defina o contato principal antes de reatribuir.' : 'Card sem contato associado.', { blocked: true, code: 'CONTACT_ASSOCIATION_NOT_UNIQUE' });
    const contactId = contactIds[0];
    return withLocks([`contact:${contactId}`], async () => {
      const linkedDeals = await associationIds('contacts', contactId, 'deals');
      if (linkedDeals.length !== 1 || linkedDeals[0] !== String(dealId)) throw hubError('Contato compartilhado com outros cards. Movimentação requer revisão.', { blocked: true, code: 'SHARED_CONTACT' });
      const previousContact = await getContact(contactId, ['hubspot_owner_id']);
      const previousContactOwners = [{ contactId, ownerId: String(previousContact.properties?.hubspot_owner_id || '') }];
      const context = await getDealMovementContext(dealId, portalId);
      assertContext(expectedCurrentContext, context); assertContext(initial, context);
      const moveFromBase = linkHub && context.pipeline === PIPELINE_BASE_LEADS_ID;
      if (moveFromBase) await validateStage(PIPELINE_CLOSER_ID, STAGE_EM_CONTATO_ID);
      if (!linkHub) {
        const latest = await associationIds('deals', dealId, 'contacts');
        if (latest.length !== 1 || latest[0] !== contactId) throw hubError('Associação mudou durante a validação.', { blocked: true });
      }
      const attemptedContactIds = [], completedContactIds = [];
      let dealWriteAttempted = false, dealUpdated = false;
      try {
        dealWriteAttempted = true;
        await request(`/crm/v3/objects/deals/${dealId}`, { method: 'PATCH', body: { properties: {
          hubspot_owner_id: String(ownerId),
          ...(moveFromBase ? { pipeline: PIPELINE_CLOSER_ID, dealstage: STAGE_EM_CONTATO_ID, motivo_da_perda: '' } : {}),
          ...(linkHub && produto ? { produto: optionalText(produto) } : {}),
        } } });
        dealUpdated = true; attemptedContactIds.push(contactId);
        await updateContactOwner(contactId, ownerId, linkHub ? produto : null);
        if (linkHub) await syncMovementProduct(dealId, contactId, produto);
        const contact = await getContact(contactId, ['hubspot_owner_id']);
        if (String(contact.properties?.hubspot_owner_id || '') !== String(ownerId)) throw hubError('Proprietário do contato não confirmado.');
        completedContactIds.push(contactId);
        const finalContext = await getDealMovementContext(dealId, portalId);
        if (finalContext.ownerId !== String(ownerId)) throw hubError('Proprietário final divergente.', { code: 'CONFIRMATION_FAILED' });
        const expectedPipeline = moveFromBase ? PIPELINE_CLOSER_ID : context.pipeline;
        const expectedStage = moveFromBase ? STAGE_EM_CONTATO_ID : context.stage;
        if (finalContext.pipeline !== expectedPipeline || finalContext.stage !== expectedStage) throw hubError(moveFromBase ? 'Pipeline/etapa final divergente após movimentação.' : 'Pipeline/etapa alterados indevidamente.', { code: 'CONFIRMATION_FAILED' });
        const finalContacts = await associationIds('deals', dealId, 'contacts');
        if (finalContacts.length !== 1 || finalContacts[0] !== contactId) throw hubError('Associação final divergente.');
        return { dealId: String(dealId), dealName: finalContext.dealName, pipeline: finalContext.pipeline, stage: finalContext.stage,
          previousDealOwnerId: context.ownerId, previousPipeline: context.pipeline, previousStage: context.stage,
          previousContactOwners, contactIds, lastUpdatedAt: finalContext.lastModifiedDate,
          ...(linkHub ? { movedFromBaseLeads: moveFromBase, produto: produto || null } : {}) };
      } catch (error) {
        error.partialResult = { dealId: String(dealId), dealWriteAttempted, dealUpdated, dealOutcomeUnknown: Boolean(error.outcomeUnknown && !dealUpdated),
          attemptedContactIds, completedContactIds, unconfirmedContactIds: contactIds.filter(v => !completedContactIds.includes(v)),
          notAttemptedContactIds: contactIds.filter(v => !attemptedContactIds.includes(v)), previousDealOwnerId: context.ownerId,
          previousContactOwners, expectedDestinationOwnerId: String(ownerId), previousPipeline: context.pipeline, previousStage: context.stage,
          ...(linkHub ? { produto: produto || null } : {}) };
        error.requiresReconciliation = dealWriteAttempted; error.retryable = false; throw error;
      }
    });
  });
}

export async function reassignDealForLinkHubMovement(dealId, ownerId, portalId, expectedCurrentContext, produto = null) {
  return reassignWithContext(dealId, ownerId, portalId, expectedCurrentContext, { linkHub: true, produto });
}

export async function reassignDealAndContactsOwner(dealId, ownerId, portalId, expectedCurrentContext) {
  return reassignWithContext(dealId, ownerId, portalId, expectedCurrentContext);
}