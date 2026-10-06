// services/hubspot.js — serviço completo revisado (ES modules, Node.js 18+).
// Todas as exportações originais foram mantidas. Erros técnicos são lançados,
// nunca convertidos em "não encontrado"; buscas ambíguas são bloqueadas.
//
// Contratos relevantes:
// - reassignDealAndContactsOwner exige expectedCurrentContext (fluxo normal);
// - reassignDealForLinkHubMovement: regra do Link Hub:
//     * Base de Leads → move para Closer (Em Contato), limpa motivo_da_perda;
//     * Closer → apenas troca o proprietário, preserva pipeline/etapa;
// - garantirLeadNoCloser devolve "message" descritiva em todas as decisões
//   (inclusive sucesso), para que o worker CRM propague no histórico;
// - bloqueios temporais incluem requiredHours, hoursSinceNote, notesLastUpdated;
// - validação final sem ID explícito só aceita um único card candidato;
// - falhas parciais exigem reconciliação no worker, não repetição automática;
// - nenhum POST/PATCH é repetido automaticamente;
// - mutexes abaixo protegem somente ESTE processo. O worker precisa de locks
//   distribuídos por conta/card/contato (por exemplo no PostgreSQL) e reserva exclusiva;
// - autorização de usuário/equipe continua a cargo de access-control.js e do worker.
// Configurar CHV_Hubspot, HUBSPOT_PORTAL_ID e IDs reais de pipeline/etapa.

const API_ORIGIN = 'https://api.hubapi.com';
const setting = (name, fallback = '') => String(process.env[name] || fallback).trim();

const PIPELINE_BASE_LEADS_ID = setting('HUBSPOT_PIPELINE_BASE_LEADS_ID', '905901447');
const PIPELINE_CLOSER_ID = setting('HUBSPOT_PIPELINE_CLOSER_ID', '904458124');
const PIPELINE_JURIDICO_AUDITORIA_ID = setting('HUBSPOT_PIPELINE_JURIDICO_AUDITORIA_ID', '905179189');
const HUBSPOT_PORTAL_ID = setting('HUBSPOT_PORTAL_ID');
const STAGE_EM_CONTATO_ID = setting('HUBSPOT_STAGE_EM_CONTATO_ID', '1368997801');
const STAGE_DESQUALIFICADO_ID = setting('HUBSPOT_STAGE_DESQUALIFICADO_ID', '1368997806');
const STAGE_COLETA_DOCUMENTACAO_ID = setting('HUBSPOT_STAGE_COLETA_DOCUMENTACAO_ID');
const STAGE_ENTRADA_ID = setting('HUBSPOT_STAGE_ENTRADA_ID');

export const HUBSPOT_PIPELINE_BASE_LEADS_ID = PIPELINE_BASE_LEADS_ID;
export const HUBSPOT_PIPELINE_CLOSER_ID = PIPELINE_CLOSER_ID;
export const HUBSPOT_PIPELINE_JURIDICO_AUDITORIA_ID = PIPELINE_JURIDICO_AUDITORIA_ID;
export const HUBSPOT_PORTAL_ID_CONFIGURED = HUBSPOT_PORTAL_ID;
export const HUBSPOT_STAGE_EM_CONTATO_ID = STAGE_EM_CONTATO_ID;
export const HUBSPOT_STAGE_DESQUALIFICADO_ID = STAGE_DESQUALIFICADO_ID;
export const HUBSPOT_STAGE_COLETA_DOCUMENTACAO_ID = STAGE_COLETA_DOCUMENTACAO_ID;
export const HUBSPOT_STAGE_ENTRADA_ID = STAGE_ENTRADA_ID;

const CONTACT_PROPERTIES = [
  'email', 'firstname', 'lastname', 'phone', 'hs_whatsapp_phone_number',
  'contact_cpf', 'contact_fonte', 'hubspot_owner_id',
];
const DEAL_PROPERTIES = [
  'dealname', 'pipeline', 'dealstage', 'hubspot_owner_id',
  'notes_last_updated', 'motivo_da_perda', 'hs_lastmodifieddate',
];

const PIPELINE_NAMES = {
  [PIPELINE_BASE_LEADS_ID]: 'Base de Leads',
  [PIPELINE_CLOSER_ID]: 'Closer',
  [PIPELINE_JURIDICO_AUDITORIA_ID]: 'Jurídico Auditoria de Ganho',
  '905179471': 'PRO',
  '926561825': 'Fator K',
  '925690734': 'Quinquenio/concomitante',
};
const STAGE_NAMES = {
  [STAGE_EM_CONTATO_ID]: 'Em Contato',
  [STAGE_DESQUALIFICADO_ID]: 'Desqualificado',
  ...(STAGE_COLETA_DOCUMENTACAO_ID ? { [STAGE_COLETA_DOCUMENTACAO_ID]: 'Coleta de documentação' } : {}),
  ...(STAGE_ENTRADA_ID ? { [STAGE_ENTRADA_ID]: 'Entrada' } : {}),
};

// Mensagens amigáveis devolvidas em `message` para cada regra aplicada.
// O worker CRM propaga esses textos no histórico e nas notificações Teams.
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

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function hubError(message, details = {}) {
  return Object.assign(new Error(message), {
    code: 'HUBSPOT_ERROR',
    retryable: false,
    blocked: false,
    ...details,
  });
}

function id(value, label = 'Identificador') {
  const result = String(value ?? '').trim();
  if (!/^\d+$/.test(result)) {
    throw hubError(`${label} inválido.`, { blocked: true, code: 'INVALID_ID' });
  }
  return result;
}

function optionalText(value) {
  return value == null ? '' : String(value).trim();
}

function cleanEmail(value) {
  const result = optionalText(value).toLowerCase();
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) {
    throw hubError('E-mail inválido.', { blocked: true });
  }
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
  const delay = Number.isFinite(numeric)
    ? numeric * 1000
    : Number.isFinite(dated)
      ? dated
      : 500 * (2 ** attempt);
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
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const raw = await response.text();
      let data;
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw hubError('Resposta não JSON recebida do HubSpot.', {
          httpStatus: response.status,
          retryable: safe,
          outcomeUnknown: !safe,
        });
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = hubError(`HubSpot retornou HTTP ${response.status}.`, {
          httpStatus: response.status,
          retryable,
          blocked: response.status === 404,
          correlationId: data.correlationId || null,
          category: data.category || null,
          retryAfter: response.headers.get('retry-after'),
          outcomeUnknown: !safe && response.status >= 500,
        });
        if (safe && retryable && attempt + 1 < totalAttempts) {
          clearTimeout(timer);
          await sleep(retryDelay(response, attempt));
          continue;
        }
        throw error;
      }
      return data;
    } catch (error) {
      if (error.code) throw error;
      const wrapped = hubError('Falha de rede ou timeout ao acessar o HubSpot.', {
        retryable: true,
        outcomeUnknown: !safe,
        code: 'NETWORK_ERROR',
      });
      if (safe && attempt + 1 < totalAttempts) {
        clearTimeout(timer);
        await sleep(500 * (2 ** attempt));
        continue;
      }
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }
  throw hubError('Consulta ao HubSpot não concluída.');
}

let verifiedAccount = null;
let portalVerification = null;

export async function verifyHubSpotPortalConfiguration() {
  id(HUBSPOT_PORTAL_ID, 'HUBSPOT_PORTAL_ID');
  const currentToken = token();
  if (verifiedAccount?.token === currentToken && verifiedAccount.expiresAt > Date.now()) {
    return verifiedAccount.portalId;
  }
  if (!portalVerification || portalVerification.token !== currentToken) {
    const promise = (async () => {
      const account = await request('/integrations/v1/me');
      const portalId = String(account.portalId ?? '');
      if (portalId !== HUBSPOT_PORTAL_ID) {
        throw hubError('A conta do token não corresponde ao HUBSPOT_PORTAL_ID.', {
          blocked: true,
          code: 'ACCOUNT_MISMATCH',
        });
      }
      verifiedAccount = {
        token: currentToken,
        portalId,
        expiresAt: Date.now() + 300000,
      };
      return portalId;
    })();
    portalVerification = { token: currentToken, promise };
    promise
      .finally(() => {
        if (portalVerification?.promise === promise) portalVerification = null;
      })
      .catch(() => {});
  }
  return portalVerification.promise;
}

async function accountReady() {
  await verifyHubSpotPortalConfiguration();
}

// Mutex local — protege apenas este processo. Não é transação distribuída.
const mutexes = new Map();

async function withLocks(keys, action) {
  const unique = [...new Set(keys)].sort();
  const releases = [];
  try {
    for (const key of unique) {
      const previous = mutexes.get(key) || Promise.resolve();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      mutexes.set(key, tail);
      await previous;
      releases.push(() => {
        release();
        if (mutexes.get(key) === tail) mutexes.delete(key);
      });
    }
    return await action();
  } finally {
    releases.reverse().forEach((release) => release());
  }
}

function mapDeal(deal) {
  const properties = deal.properties || {};
  return {
    id: String(deal.id),
    dealName: properties.dealname || null,
    pipeline: properties.pipeline || null,
    stage: properties.dealstage || null,
    ownerId: properties.hubspot_owner_id || null,
    notesLastUpdated: properties.notes_last_updated || null,
    motivoDaPerda: properties.motivo_da_perda || null,
    lastModifiedDate: properties.hs_lastmodifieddate || null,
  };
}

async function getContact(contactId, properties = CONTACT_PROPERTIES) {
  return request(
    `/crm/v3/objects/contacts/${id(contactId)}?properties=${encodeURIComponent(properties.join(','))}`
  );
}

async function getDeal(dealId) {
  return request(
    `/crm/v3/objects/deals/${id(dealId)}?properties=${encodeURIComponent(DEAL_PROPERTIES.join(','))}`
  );
}

async function associationIds(fromType, fromId, toType) {
  const ids = new Set();
  const cursors = new Set();
  let after;
  do {
    const query = new URLSearchParams({ limit: '500' });
    if (after !== undefined) query.set('after', String(after));
    const data = await request(
      `/crm/v4/objects/${fromType}/${id(fromId)}/associations/${toType}?${query}`
    );
    for (const association of data.results || []) {
      ids.add(id(association.toObjectId, 'Registro associado'));
    }
    const next = data.paging?.next?.after;
    after = next === undefined || next === null ? undefined : String(next);
    if (after !== undefined) {
      if (cursors.has(after)) throw hubError('Cursor de associações repetido; leitura interrompida.');
      cursors.add(after);
    }
  } while (after !== undefined);
  return [...ids];
}

async function getDealsByIds(dealIds = []) {
  const results = [];
  for (const dealId of [...new Set(dealIds.map((value) => id(value)))]) {
    results.push(mapDeal(await getDeal(dealId)));
  }
  return results;
}

export async function getContactDeals(contactId) {
  await accountReady();
  return getDealsByIds(await associationIds('contacts', contactId, 'deals'));
}

function normalizePhone(value) {
  return optionalText(value).replace(/\D/g, '');
}

function nationalPhone(value) {
  const digits = normalizePhone(value);
  return digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
}

function phonesMatch(a, b) {
  const left = nationalPhone(a);
  const right = nationalPhone(b);
  return left.length >= 10 && left === right;
}

function buildPhoneVariants(phone) {
  const raw = optionalText(phone);
  const digits = normalizePhone(raw);
  const national = nationalPhone(raw);
  return [
    ...new Set(
      [
        raw,
        digits,
        national,
        national ? `55${national}` : '',
        national ? `+55${national}` : '',
      ].filter(Boolean)
    ),
  ];
}

async function searchContacts(payload) {
  const results = [];
  const cursors = new Set();
  let after;
  do {
    const data = await request('/crm/v3/objects/contacts/search', {
      method: 'POST',
      readOnly: true,
      body: {
        ...payload,
        properties: CONTACT_PROPERTIES,
        limit: 100,
        ...(after === undefined ? {} : { after }),
      },
    });
    results.push(...(data.results || []));
    const next = data.paging?.next?.after;
    after = next === undefined || next === null ? undefined : String(next);
    if (after !== undefined) {
      if (cursors.has(after)) throw hubError('Cursor de pesquisa repetido.');
      cursors.add(after);
    }
  } while (after !== undefined);
  return results;
}

async function searchContactByField(propertyName, value) {
  return searchContacts({
    filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
  });
}

function chooseUnique(results) {
  const unique = [...new Map(results.map((contact) => [String(contact.id), contact])).values()];
  if (unique.length > 1) {
    throw hubError(
      'Mais de um contato corresponde à busca. Selecione o registro antes de movimentar.',
      {
        blocked: true,
        code: 'AMBIGUOUS_CONTACT',
        candidateIds: unique.map((contact) => String(contact.id)),
      }
    );
  }
  return unique[0] || null;
}

async function searchContactByPhone(phone) {
  const results = [];
  for (const variant of buildPhoneVariants(phone)) {
    for (const property of ['phone', 'hs_whatsapp_phone_number']) {
      const contacts = await searchContactByField(property, variant);
      results.push(
        ...contacts.filter((contact) =>
          [contact.properties?.phone, contact.properties?.hs_whatsapp_phone_number].some((value) =>
            phonesMatch(value, phone)
          )
        )
      );
    }
  }
  if (!results.length) {
    const contacts = await searchContacts({ query: normalizePhone(phone) });
    results.push(
      ...contacts.filter((contact) =>
        [contact.properties?.phone, contact.properties?.hs_whatsapp_phone_number].some((value) =>
          phonesMatch(value, phone)
        )
      )
    );
  }
  return chooseUnique(results);
}

function validateContact(contact, input) {
  const props = contact.properties || {};
  const divergences = [];
  if (input.email && props.email && cleanEmail(props.email) !== input.email) {
    divergences.push('e-mail');
  }
  const phones = [props.phone, props.hs_whatsapp_phone_number].filter(Boolean);
  if (input.phone && phones.length && !phones.some((phone) => phonesMatch(phone, input.phone))) {
    divergences.push('telefone');
  }
  if (input.cpf && props.contact_cpf && normalizePhone(props.contact_cpf) !== input.cpf) {
    divergences.push('CPF');
  }
  return {
    found: true,
    divergente: divergences.length > 0,
    contact,
    ...(divergences.length
      ? { motivo: `Dados divergentes do cadastro: ${divergences.join(', ')}` }
      : {}),
  };
}

export async function findContactAndValidate({ email, phone, cpf } = {}) {
  await accountReady();
  const input = {
    email: cleanEmail(email),
    phone: normalizePhone(phone),
    cpf: normalizePhone(cpf),
  };
  if (optionalText(cpf) && input.cpf.length !== 11) {
    throw hubError('CPF deve conter 11 dígitos.', { blocked: true });
  }
  let contact = null;
  if (nationalPhone(phone).length >= 10) contact = await searchContactByPhone(phone);
  if (!contact && input.email) {
    contact = chooseUnique(await searchContactByField('email', input.email));
  }
  if (!contact && input.cpf) {
    contact = chooseUnique(await searchContactByField('contact_cpf', input.cpf));
  }
  return contact
    ? validateContact(contact, input)
    : { found: false, divergente: false, contact: null };
}

export async function searchContact(input = {}) {
  const result = await findContactAndValidate(input);
  if (result.divergente) {
    throw hubError(result.motivo, { blocked: true, code: 'CONTACT_DATA_MISMATCH' });
  }
  return result.contact;
}

export async function findOwnerIdByEmailStrict(email) {
  const normalized = cleanEmail(email);
  if (!normalized) return null;
  await accountReady();
  const data = await request(
    `/crm/v3/owners?email=${encodeURIComponent(normalized)}&archived=false`
  );
  const matches = (data.results || []).filter(
    (owner) => !owner.archived && cleanEmail(owner.email) === normalized
  );
  if (data.paging?.next || matches.length > 1) {
    throw hubError('Consulta de proprietário inconclusiva ou ambígua.', { blocked: true });
  }
  return matches.length ? id(matches[0].id, 'Proprietário') : null;
}

// Compatibilidade de assinatura, mas sem ocultar falhas técnicas.
export async function findOwnerIdByEmail(email) {
  return findOwnerIdByEmailStrict(email);
}

async function activeOwner(ownerId) {
  const owner = await request(`/crm/v3/owners/${id(ownerId, 'Proprietário')}`);
  if (owner.archived || !owner.email || String(owner.id) !== String(ownerId)) {
    throw hubError('Proprietário destino inválido ou arquivado.', { blocked: true });
  }
  return owner;
}

export async function getHubSpotOwnerEmail(ownerId) {
  if (!ownerId) return null;
  await accountReady();
  const owner = await request(`/crm/v3/owners/${id(ownerId, 'Proprietário')}`);
  return cleanEmail(owner.email) || null;
}

export async function createContact({ firstName, lastName, email, phone, cpf, origem, ownerId } = {}) {
  await accountReady();
  const properties = {
    firstname: optionalText(firstName),
    lastname: optionalText(lastName),
  };
  const normalizedEmail = cleanEmail(email);
  if (normalizedEmail) properties.email = normalizedEmail;
  if (optionalText(phone)) {
    properties.phone = optionalText(phone);
    properties.hs_whatsapp_phone_number = optionalText(phone);
  }
  if (optionalText(cpf)) {
    const cleaned = normalizePhone(cpf);
    if (cleaned.length !== 11) {
      throw hubError('CPF deve conter 11 dígitos.', { blocked: true });
    }
    properties.contact_cpf = cleaned;
  }
  if (origem) properties.contact_fonte = optionalText(origem);
  if (ownerId) {
    await activeOwner(ownerId);
    properties.hubspot_owner_id = id(ownerId);
  }
  try {
    return await request('/crm/v3/objects/contacts', {
      method: 'POST',
      body: { properties, associations: [] },
    });
  } catch (error) {
    if (error.httpStatus === 409 && normalizedEmail) {
      const existing = chooseUnique(await searchContactByField('email', normalizedEmail));
      if (existing) {
        const validated = validateContact(existing, {
          email: normalizedEmail,
          phone: normalizePhone(phone),
          cpf: normalizePhone(cpf),
        });
        if (validated.divergente) {
          throw hubError(validated.motivo, { blocked: true });
        }
        return existing;
      }
    }
    throw error;
  }
}

export async function updateContactOwner(contactId, ownerId) {
  await accountReady();
  id(contactId, 'Contato');
  await activeOwner(ownerId);
  return request(`/crm/v3/objects/contacts/${id(contactId)}`, {
    method: 'PATCH',
    body: { properties: { hubspot_owner_id: id(ownerId) } },
  });
}

export async function getFirstStageId(pipelineId) {
  await accountReady();
  const data = await request(`/crm/v3/pipelines/deals/${id(pipelineId)}/stages`);
  const stages = (data.results || [])
    .filter((stage) => !stage.archived)
    .sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder));
  return stages[0]?.id ? String(stages[0].id) : null;
}

async function validateStage(pipelineId, stageId) {
  const data = await request(`/crm/v3/pipelines/deals/${id(pipelineId)}/stages`);
  if (!(data.results || []).some(
    (stage) => String(stage.id) === String(stageId) && !stage.archived
  )) {
    throw hubError('Etapa não pertence ao pipeline configurado.', {
      blocked: true,
      code: 'INVALID_STAGE',
    });
  }
}

async function dealContactAssociationType() {
  const data = await request('/crm/v4/associations/deals/contacts/labels');
  const types = (data.results || []).filter(
    (type) => type.category === 'HUBSPOT_DEFINED' && type.label === null
  );
  if (types.length !== 1) {
    throw hubError('Não foi possível resolver a associação padrão de negócio para contato.');
  }
  return Number(id(types[0].typeId, 'Tipo de associação'));
}

export async function createDealForContact(contactId, dealName, pipelineId, stageId = null, ownerId = null) {
  await accountReady();
  id(contactId, 'Contato');
  id(pipelineId, 'Pipeline');
  const finalStage = stageId || (await getFirstStageId(pipelineId));
  id(finalStage, 'Etapa');
  await validateStage(pipelineId, finalStage);
  if (ownerId) await activeOwner(ownerId);
  const associationTypeId = await dealContactAssociationType();
  return request('/crm/v3/objects/deals', {
    method: 'POST',
    body: {
      properties: {
        dealname: optionalText(dealName),
        pipeline: String(pipelineId),
        dealstage: String(finalStage),
        motivo_da_perda: '',
        ...(ownerId ? { hubspot_owner_id: id(ownerId) } : {}),
      },
      associations: [
        {
          to: { id: String(contactId) },
          types: [
            { associationCategory: 'HUBSPOT_DEFINED', associationTypeId },
          ],
        },
      ],
    },
  });
}

export async function moveDealToCloserEmContato(dealId, ownerId = null) {
  await accountReady();
  await validateStage(PIPELINE_CLOSER_ID, STAGE_EM_CONTATO_ID);
  if (ownerId) await activeOwner(ownerId);
  const deal = await request(`/crm/v3/objects/deals/${id(dealId)}`, {
    method: 'PATCH',
    body: {
      properties: {
        pipeline: PIPELINE_CLOSER_ID,
        dealstage: STAGE_EM_CONTATO_ID,
        motivo_da_perda: '',
        ...(ownerId ? { hubspot_owner_id: id(ownerId) } : {}),
      },
    },
  });
  return { deal, lastUpdatedAt: deal.properties?.hs_lastmodifieddate || null };
}

function hoursSince(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || timestamp > Date.now()) return null;
  return (Date.now() - timestamp) / 3600000;
}

function temporalCheck(deal) {
  id(STAGE_COLETA_DOCUMENTACAO_ID, 'HUBSPOT_STAGE_COLETA_DOCUMENTACAO_ID');
  id(STAGE_ENTRADA_ID, 'HUBSPOT_STAGE_ENTRADA_ID');
  const required = {
    [STAGE_COLETA_DOCUMENTACAO_ID]: 72,
    [STAGE_ENTRADA_ID]: 24,
    [STAGE_EM_CONTATO_ID]: 24,
  };
  const hours = hoursSince(deal.lastModifiedDate);
  const requiredHours = required[String(deal.stage)];
  const allowed = hours !== null && requiredHours !== undefined && hours > requiredHours;
  const reason =
    hours === null
      ? 'Data da última modificação ausente, inválida ou futura'
      : requiredHours === undefined
        ? 'Etapa não elegível para movimentação por tempo'
        : allowed
          ? `Última modificação há mais de ${requiredHours}h`
          : `Prazo de mais de ${requiredHours}h desde a última modificação ainda não atingido`;
  return {
    allowed,
    reason,
    requiredHours: requiredHours ?? null,
    hoursSinceNote: hours,
    lastUpdated: deal.lastModifiedDate || null,
  };
}

function assignmentResult(deal, extras = {}) {
  return {
    blocked: false,
    dealId: deal?.id || null,
    pipeline: deal?.pipeline || null,
    stage: deal?.stage || null,
    pipelineNome: PIPELINE_NAMES[deal?.pipeline] || deal?.pipeline || null,
    stageNome: STAGE_NAMES[deal?.stage] || deal?.stage || null,
    lastUpdatedAt: deal?.lastModifiedDate || null,
    ...extras,
  };
}

export async function garantirLeadNoCloser(contactId, dealName, ownerId = null, collaboratorName = '') {
  if (!ownerId) {
    return assignmentResult(null, {
      blocked: true,
      ruleApplied: 'owner_missing',
      message: RULE_MESSAGES.owner_missing,
    });
  }
  await accountReady();
  await activeOwner(ownerId);
  return withLocks([`contact:${id(contactId)}`], async () => {
    const deals = await getContactDeals(contactId);
    if (deals.length > 1) {
      return assignmentResult(null, {
        blocked: true,
        ruleApplied: 'ambiguous_deals',
        message: RULE_MESSAGES.ambiguous_deals,
      });
    }
    let deal = deals[0];
    let rule;
    if (!deal) rule = 'created_and_moved';
    else if (String(deal.pipeline) === PIPELINE_BASE_LEADS_ID) rule = 'base_to_closer';
    else if (String(deal.pipeline) !== PIPELINE_CLOSER_ID) {
      return assignmentResult(deal, {
        blocked: true,
        ruleApplied: 'fallback_block',
        message: RULE_MESSAGES.fallback_block,
      });
    } else if (String(deal.stage) === STAGE_DESQUALIFICADO_ID) {
      rule = 'desqualificado_to_em_contato';
    } else if (!deal.ownerId) {
      rule = 'closer_without_owner';
    } else if (String(deal.ownerId) === String(ownerId)) {
      await updateContactOwner(contactId, ownerId);
      return assignmentResult(deal, {
        alreadyAssigned: true,
        ruleApplied: 'already_assigned',
        message: RULE_MESSAGES.already_assigned,
      });
    } else {
      const check = temporalCheck(deal);
      if (!check.allowed) {
        return assignmentResult(deal, {
          blocked: true,
          ruleApplied: 'owned_by_another_recent_activity',
          message: `${RULE_MESSAGES.owned_by_another_recent_activity} ${check.reason}.`,
          requiredHours: check.requiredHours,
          hoursSinceNote: check.hoursSinceNote,
          notesLastUpdated: check.lastUpdated,
        });
      }
      rule = 'reassigned_by_last_modified_date';
    }
    const previousContact = await getContact(contactId, ['hubspot_owner_id']);
    let writeAttempted = false;
    let createdDealId = null;
    try {
      if (deal) {
        const fresh = mapDeal(await getDeal(deal.id));
        if (
          ['pipeline', 'stage', 'ownerId', 'lastModifiedDate'].some(
            (key) => String(fresh[key] || '') !== String(deal[key] || '')
          )
        ) {
          throw hubError('Card mudou durante a validação.', {
            blocked: true,
            code: 'CONTEXT_CHANGED',
          });
        }
      } else {
        writeAttempted = true;
        const created = await createDealForContact(
          contactId,
          dealName,
          PIPELINE_BASE_LEADS_ID,
          null,
          ownerId
        );
        createdDealId = String(created.id);
        deal = mapDeal(created);
      }
      writeAttempted = true;
      await moveDealToCloserEmContato(deal.id, ownerId);
      await updateContactOwner(contactId, ownerId);
      const confirmedDeal = mapDeal(await getDeal(deal.id));
      const confirmedContact = await getContact(contactId, ['hubspot_owner_id']);
      if (
        String(confirmedDeal.ownerId) !== String(ownerId) ||
        confirmedDeal.pipeline !== PIPELINE_CLOSER_ID ||
        confirmedDeal.stage !== STAGE_EM_CONTATO_ID ||
        String(confirmedContact.properties?.hubspot_owner_id) !== String(ownerId)
      ) {
        throw hubError('Atribuição final não confirmada.', { code: 'CONFIRMATION_FAILED' });
      }
      return assignmentResult(confirmedDeal, {
        ruleApplied: rule,
        message: RULE_MESSAGES[rule] || 'Movimentação concluída com sucesso.',
      });
    } catch (error) {
      if (writeAttempted) {
        error.partialResult = {
          dealId: deal?.id || null,
          createdDealId,
          contactId: String(contactId),
          previousContactOwnerId: previousContact.properties?.hubspot_owner_id || '',
          writeAttempted: true,
        };
        error.requiresReconciliation = true;
        error.retryable = false;
      }
      throw error;
    }
  });
}

export async function verificarPipelineBaseELevio(contactId) {
  const deal = await findDealInBaseLeads(contactId);
  return {
    noPipelineBase: Boolean(deal),
    noFaseEnvio: false,
    pipeline: deal?.pipeline || null,
    stage: deal?.stage || null,
  };
}

export async function isContactInPipeline(contactId, pipelineId) {
  return (await getContactDeals(contactId)).some(
    (deal) => String(deal.pipeline) === String(pipelineId)
  );
}

export async function findDealInBaseLeads(contactId) {
  const matches = (await getContactDeals(contactId)).filter(
    (deal) => String(deal.pipeline) === PIPELINE_BASE_LEADS_ID
  );
  if (matches.length > 1) {
    throw hubError('Mais de um card na Base de Leads.', { blocked: true });
  }
  return matches[0] || null;
}

export async function validateFinalAssignment(contactId, expectedOwnerId, expectedDealId = null, options = {}) {
  await accountReady();
  id(expectedOwnerId, 'Proprietário esperado');
  const deals = await getContactDeals(contactId);
  let target;
  if (expectedDealId) {
    target = deals.find((deal) => deal.id === String(expectedDealId));
  } else if (deals.length === 1) {
    target = deals[0];
  }
  if (!target) {
    return {
      ok: false,
      error: expectedDealId
        ? 'Card esperado não associado ao contato.'
        : 'Card ausente ou ambíguo.',
      resolvedBy: null,
    };
  }
  const contact = await getContact(contactId, ['hubspot_owner_id']);
  const contactOwnerId = contact.properties?.hubspot_owner_id || '';
  const expectedPipeline = String(options.expectedPipeline || PIPELINE_CLOSER_ID);
  const expectedStage =
    options.expectedStage === null
      ? null
      : String(options.expectedStage || STAGE_EM_CONTATO_ID);
  const ok =
    String(target.ownerId) === String(expectedOwnerId) &&
    String(contactOwnerId) === String(expectedOwnerId) &&
    String(target.pipeline) === expectedPipeline &&
    (expectedStage === null || String(target.stage) === expectedStage);
  return {
    ok,
    resolvedBy: expectedDealId ? 'expected_deal_id' : 'unique_associated_deal',
    contactOwnerId,
    deal: target,
    lastUpdatedAt: target.lastModifiedDate,
    details: {
      dealPipeline: target.pipeline,
      dealStage: target.stage,
      dealOwnerId: target.ownerId,
      contactOwnerId,
      associatedDeals: deals,
    },
  };
}

export async function getDealMovementContext(dealId, portalId) {
  id(dealId, 'Card');
  if (String(portalId) !== id(HUBSPOT_PORTAL_ID, 'HUBSPOT_PORTAL_ID')) {
    throw hubError('Link pertence a outra conta.', { blocked: true });
  }
  await accountReady();
  const deal = mapDeal(await getDeal(dealId));
  if (![PIPELINE_BASE_LEADS_ID, PIPELINE_CLOSER_ID].includes(String(deal.pipeline))) {
    throw hubError('Link Hub permitido somente na Base de Leads e no Closer.', {
      blocked: true,
      code: 'PIPELINE_NOT_ALLOWED',
    });
  }
  return {
    dealId: deal.id,
    dealName: deal.dealName || '',
    pipeline: String(deal.pipeline),
    stage: String(deal.stage || ''),
    ownerId: String(deal.ownerId || ''),
    lastModifiedDate: deal.lastModifiedDate,
  };
}

function assertContext(expected, actual) {
  if (
    !expected ||
    ['ownerId', 'pipeline', 'stage'].some(
      (key) => !Object.prototype.hasOwnProperty.call(expected, key)
    )
  ) {
    throw hubError('Contexto validado de origem é obrigatório.', {
      blocked: true,
      code: 'EXPECTED_CONTEXT_REQUIRED',
    });
  }
  if (
    (expected.dealId !== undefined && String(expected.dealId) !== actual.dealId) ||
    ['ownerId', 'pipeline', 'stage'].some(
      (key) => String(expected[key] || '') !== String(actual[key] || '')
    ) ||
    (expected.lastModifiedDate !== undefined &&
      String(expected.lastModifiedDate || '') !== String(actual.lastModifiedDate || ''))
  ) {
    throw hubError('Card mudou após a validação. Revalide a autorização antes de executar.', {
      blocked: true,
      code: 'CONTEXT_CHANGED',
    });
  }
}

// =====================================================================
// FLUXO LINK HUB
// Regra:
//   - Card na Base de Leads → mover para o pipeline Closer, etapa Em Contato,
//     limpar motivo_da_perda, trocar proprietário do card e do contato.
//   - Card já no Closer → apenas trocar o proprietário; preservar pipeline/etapa.
// =====================================================================
export async function reassignDealForLinkHubMovement(dealId, ownerId, portalId, expectedCurrentContext) {
  id(dealId, 'Card');
  id(ownerId, 'Proprietário destino');
  return withLocks([`deal:${dealId}`], async () => {
    const initial = await getDealMovementContext(dealId, portalId);
    assertContext(expectedCurrentContext, initial);
    await activeOwner(ownerId);

    const contactIds = await associationIds('deals', dealId, 'contacts');
    if (contactIds.length !== 1) {
      throw hubError(
        contactIds.length
          ? 'Card associado a múltiplos contatos; defina o contato principal antes de reatribuir.'
          : 'Card sem contato associado.',
        { blocked: true, code: 'CONTACT_ASSOCIATION_NOT_UNIQUE' }
      );
    }
    const contactId = contactIds[0];

    return withLocks([`contact:${contactId}`], async () => {
      const linkedDeals = await associationIds('contacts', contactId, 'deals');
      if (linkedDeals.length !== 1 || linkedDeals[0] !== String(dealId)) {
        throw hubError('Contato compartilhado com outros cards. Movimentação requer revisão.', {
          blocked: true,
          code: 'SHARED_CONTACT',
        });
      }

      const previousContact = await getContact(contactId, ['hubspot_owner_id']);
      const previousContactOwners = [
        {
          contactId,
          ownerId: String(previousContact.properties?.hubspot_owner_id || ''),
        },
      ];

      const context = await getDealMovementContext(dealId, portalId);
      assertContext(expectedCurrentContext, context);
      assertContext(initial, context);

      const isBaseLeads = context.pipeline === PIPELINE_BASE_LEADS_ID;
      const isCloser = context.pipeline === PIPELINE_CLOSER_ID;
      if (!isBaseLeads && !isCloser) {
        throw hubError('Link Hub permitido somente na Base de Leads e no Closer.', {
          blocked: true,
          code: 'PIPELINE_NOT_ALLOWED',
        });
      }

      if (isBaseLeads) {
        await validateStage(PIPELINE_CLOSER_ID, STAGE_EM_CONTATO_ID);
      }

      const attemptedContactIds = [];
      const completedContactIds = [];
      let dealWriteAttempted = false;
      let dealUpdated = false;

      try {
        dealWriteAttempted = true;

        if (isBaseLeads) {
          await request(`/crm/v3/objects/deals/${dealId}`, {
            method: 'PATCH',
            body: {
              properties: {
                pipeline: PIPELINE_CLOSER_ID,
                dealstage: STAGE_EM_CONTATO_ID,
                motivo_da_perda: '',
                hubspot_owner_id: String(ownerId),
              },
            },
          });
        } else {
          await request(`/crm/v3/objects/deals/${dealId}`, {
            method: 'PATCH',
            body: {
              properties: {
                hubspot_owner_id: String(ownerId),
              },
            },
          });
        }
        dealUpdated = true;

        attemptedContactIds.push(contactId);
        await updateContactOwner(contactId, ownerId);
        const contact = await getContact(contactId, ['hubspot_owner_id']);
        if (String(contact.properties?.hubspot_owner_id || '') !== String(ownerId)) {
          throw hubError('Proprietário do contato não confirmado.');
        }
        completedContactIds.push(contactId);

        const finalContext = await getDealMovementContext(dealId, portalId);
        if (finalContext.ownerId !== String(ownerId)) {
          throw hubError('Proprietário final divergente.', { code: 'CONFIRMATION_FAILED' });
        }
        if (isBaseLeads) {
          if (
            finalContext.pipeline !== PIPELINE_CLOSER_ID ||
            finalContext.stage !== STAGE_EM_CONTATO_ID
          ) {
            throw hubError('Pipeline/etapa final divergente após movimentação.', {
              code: 'CONFIRMATION_FAILED',
            });
          }
        } else {
          if (
            finalContext.pipeline !== context.pipeline ||
            finalContext.stage !== context.stage
          ) {
            throw hubError('Pipeline/etapa alterados indevidamente.', {
              code: 'CONFIRMATION_FAILED',
            });
          }
        }

        const finalContacts = await associationIds('deals', dealId, 'contacts');
        if (finalContacts.length !== 1 || finalContacts[0] !== contactId) {
          throw hubError('Associação final divergente.');
        }

        return {
          dealId: String(dealId),
          dealName: finalContext.dealName,
          pipeline: finalContext.pipeline,
          stage: finalContext.stage,
          previousDealOwnerId: context.ownerId,
          previousPipeline: context.pipeline,
          previousStage: context.stage,
          movedFromBaseLeads: isBaseLeads,
          previousContactOwners,
          contactIds,
          lastUpdatedAt: finalContext.lastModifiedDate,
        };
      } catch (error) {
        error.partialResult = {
          dealId: String(dealId),
          dealWriteAttempted,
          dealUpdated,
          dealOutcomeUnknown: Boolean(error.outcomeUnknown && !dealUpdated),
          attemptedContactIds,
          completedContactIds,
          unconfirmedContactIds: contactIds.filter((value) => !completedContactIds.includes(value)),
          notAttemptedContactIds: contactIds.filter((value) => !attemptedContactIds.includes(value)),
          previousDealOwnerId: context.ownerId,
          previousContactOwners,
          expectedDestinationOwnerId: String(ownerId),
          previousPipeline: context.pipeline,
          previousStage: context.stage,
        };
        error.requiresReconciliation = dealWriteAttempted;
        error.retryable = false;
        throw error;
      }
    });
  });
}

// =====================================================================
// FLUXO NORMAL (CRM) — apenas troca de proprietário, sem tocar pipeline/etapa.
// =====================================================================
export async function reassignDealAndContactsOwner(dealId, ownerId, portalId, expectedCurrentContext) {
  id(dealId, 'Card');
  id(ownerId, 'Proprietário destino');
  return withLocks([`deal:${dealId}`], async () => {
    const initial = await getDealMovementContext(dealId, portalId);
    assertContext(expectedCurrentContext, initial);
    await activeOwner(ownerId);
    const contactIds = await associationIds('deals', dealId, 'contacts');
    if (contactIds.length !== 1) {
      throw hubError(
        contactIds.length
          ? 'Card associado a múltiplos contatos; defina o contato principal antes de reatribuir.'
          : 'Card sem contato associado.',
        { blocked: true, code: 'CONTACT_ASSOCIATION_NOT_UNIQUE' }
      );
    }
    const contactId = contactIds[0];
    return withLocks([`contact:${contactId}`], async () => {
      const linkedDeals = await associationIds('contacts', contactId, 'deals');
      if (linkedDeals.length !== 1 || linkedDeals[0] !== String(dealId)) {
        throw hubError('Contato compartilhado com outros cards. Movimentação requer revisão.', {
          blocked: true,
          code: 'SHARED_CONTACT',
        });
      }
      const previousContact = await getContact(contactId, ['hubspot_owner_id']);
      const previousContactOwners = [
        {
          contactId,
          ownerId: String(previousContact.properties?.hubspot_owner_id || ''),
        },
      ];
      const context = await getDealMovementContext(dealId, portalId);
      assertContext(expectedCurrentContext, context);
      assertContext(initial, context);
      const latestAssociations = await associationIds('deals', dealId, 'contacts');
      if (latestAssociations.length !== 1 || latestAssociations[0] !== contactId) {
        throw hubError('Associação mudou durante a validação.', { blocked: true });
      }
      const attemptedContactIds = [];
      const completedContactIds = [];
      let dealWriteAttempted = false;
      let dealUpdated = false;
      try {
        dealWriteAttempted = true;
        await request(`/crm/v3/objects/deals/${dealId}`, {
          method: 'PATCH',
          body: { properties: { hubspot_owner_id: String(ownerId) } },
        });
        dealUpdated = true;
        attemptedContactIds.push(contactId);
        await updateContactOwner(contactId, ownerId);
        const contact = await getContact(contactId, ['hubspot_owner_id']);
        if (String(contact.properties?.hubspot_owner_id || '') !== String(ownerId)) {
          throw hubError('Proprietário do contato não confirmado.');
        }
        completedContactIds.push(contactId);
        const finalContext = await getDealMovementContext(dealId, portalId);
        if (
          finalContext.ownerId !== String(ownerId) ||
          finalContext.pipeline !== context.pipeline ||
          finalContext.stage !== context.stage
        ) {
          throw hubError('Proprietário, pipeline ou etapa final divergente.', {
            code: 'CONFIRMATION_FAILED',
          });
        }
        const finalContacts = await associationIds('deals', dealId, 'contacts');
        if (finalContacts.length !== 1 || finalContacts[0] !== contactId) {
          throw hubError('Associação final divergente.');
        }
        return {
          dealId: String(dealId),
          dealName: finalContext.dealName,
          pipeline: finalContext.pipeline,
          stage: finalContext.stage,
          previousDealOwnerId: context.ownerId,
          previousContactOwners,
          contactIds,
          lastUpdatedAt: finalContext.lastModifiedDate,
        };
      } catch (error) {
        error.partialResult = {
          dealId: String(dealId),
          dealWriteAttempted,
          dealUpdated,
          dealOutcomeUnknown: Boolean(error.outcomeUnknown && !dealUpdated),
          attemptedContactIds,
          completedContactIds,
          unconfirmedContactIds: contactIds.filter((value) => !completedContactIds.includes(value)),
          notAttemptedContactIds: contactIds.filter((value) => !attemptedContactIds.includes(value)),
          previousDealOwnerId: context.ownerId,
          previousContactOwners,
          expectedDestinationOwnerId: String(ownerId),
          previousPipeline: context.pipeline,
          previousStage: context.stage,
        };
        error.requiresReconciliation = dealWriteAttempted;
        error.retryable = false;
        throw error;
      }
    });
  });
}