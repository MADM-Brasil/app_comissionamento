// services/hubspot.js
import { Client } from '@hubspot/api-client';

const hubspotClient = new Client({
  accessToken: process.env.CHV_Hubspot,
});

// ==================== IDs internos do HubSpot ====================
const PIPELINE_BASE_LEADS_ID = process.env.HUBSPOT_PIPELINE_BASE_LEADS_ID || '905901447';
const PIPELINE_CLOSER_ID = process.env.HUBSPOT_PIPELINE_CLOSER_ID || '904458124';

const STAGE_EM_CONTATO_ID = process.env.HUBSPOT_STAGE_EM_CONTATO_ID || '1368997801';
const STAGE_DESQUALIFICADO_ID = process.env.HUBSPOT_STAGE_DESQUALIFICADO_ID || '1368997806';

// ⚠️ OBRIGATÓRIO preencher via env para a regra temporal funcionar:
//    HUBSPOT_STAGE_COLETA_DOCUMENTACAO_ID
//    HUBSPOT_STAGE_ENTRADA_ID
const STAGE_COLETA_DOCUMENTACAO_ID =
  process.env.HUBSPOT_STAGE_COLETA_DOCUMENTACAO_ID || 'COLOCAR_ID_AQUI';
const STAGE_ENTRADA_ID =
  process.env.HUBSPOT_STAGE_ENTRADA_ID || 'COLOCAR_ID_AQUI';

export const HUBSPOT_PIPELINE_BASE_LEADS_ID = PIPELINE_BASE_LEADS_ID;
export const HUBSPOT_PIPELINE_CLOSER_ID = PIPELINE_CLOSER_ID;
export const HUBSPOT_STAGE_EM_CONTATO_ID = STAGE_EM_CONTATO_ID;
export const HUBSPOT_STAGE_DESQUALIFICADO_ID = STAGE_DESQUALIFICADO_ID;
export const HUBSPOT_STAGE_COLETA_DOCUMENTACAO_ID = STAGE_COLETA_DOCUMENTACAO_ID;
export const HUBSPOT_STAGE_ENTRADA_ID = STAGE_ENTRADA_ID;

// Propriedades padrão do contato
const CONTACT_PROPERTIES = [
  'email',
  'firstname',
  'lastname',
  'phone',
  'hs_whatsapp_phone_number',
  'contact_cpf',
  'contact_fonte',
  'hubspot_owner_id',
];

// Propriedades padrão do deal
const DEAL_PROPERTIES = [
  'dealname',
  'pipeline',
  'dealstage',
  'hubspot_owner_id',
  'notes_last_updated',
  'motivo_da_perda',
  'hs_lastmodifieddate',
];

// Nomes legíveis
const PIPELINE_NAMES = {
  [PIPELINE_BASE_LEADS_ID]: 'Base de Leads',
  [PIPELINE_CLOSER_ID]: 'Closer',
  '905179189': 'Jurídico Auditoria de Ganho',
  '905179471': 'PRO',
  '926561825': 'Fator K',
  '925690734': 'Quinquenio/concomitante',
};

const STAGE_NAMES = {
  [STAGE_EM_CONTATO_ID]: 'Em Contato',
  [STAGE_DESQUALIFICADO_ID]: 'Desqualificado',
  [STAGE_COLETA_DOCUMENTACAO_ID]: 'Coleta de documentação',
  [STAGE_ENTRADA_ID]: 'Entrada',
};

// Regras de tempo (em horas) por etapa
const REQUIRED_HOURS_BY_STAGE = {
  [STAGE_COLETA_DOCUMENTACAO_ID]: 72,
  [STAGE_ENTRADA_ID]: 24,
  [STAGE_EM_CONTATO_ID]: 24,
};

// ==================== Helpers de telefone ====================

function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

function phonesMatch(contactPhone, inputPhone) {
  const a = normalizePhone(contactPhone);
  const b = normalizePhone(inputPhone);
  if (!a || !b) return false;
  if (a === b) return true;
  const aSem55 = a.startsWith('55') && a.length > 11 ? a.slice(2) : a;
  const bSem55 = b.startsWith('55') && b.length > 11 ? b.slice(2) : b;
  if (aSem55 === bSem55) return true;
  const aTail = aSem55.slice(-8);
  const bTail = bSem55.slice(-8);
  return aTail.length === 8 && aTail === bTail;
}

function buildPhoneVariants(phoneRaw, phoneDigits) {
  const variants = new Set();
  if (phoneRaw && String(phoneRaw).trim()) variants.add(String(phoneRaw).trim());

  const digits = normalizePhone(phoneDigits);
  if (digits) {
    variants.add(digits);
    const semPais = digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
    if (semPais) {
      variants.add(semPais);
      variants.add(`55${semPais}`);
      variants.add(`+55${semPais}`);
      if (semPais.length > 11) variants.add(semPais.slice(-11));
      if (semPais.length > 10) variants.add(semPais.slice(-10));
      if (semPais.length > 9) variants.add(semPais.slice(-9));
      if (semPais.length > 8) variants.add(semPais.slice(-8));
    }
  }
  return [...variants].filter(Boolean);
}

// ==================== Helpers de tempo ====================

/**
 * Retorna quantas horas se passaram desde uma data.
 * Retorna null se a data for ausente/inválida.
 */
function getHoursSince(dateValue) {
  if (!dateValue) return null;
  const timestamp = new Date(dateValue).getTime();
  if (Number.isNaN(timestamp)) return null;
  return (Date.now() - timestamp) / (1000 * 60 * 60);
}

/**
 * Decide se um deal pode ser movimentado com base em notes_last_updated
 * e na etapa atual:
 *   - Coleta de documentação → > 72h
 *   - Entrada               → > 24h
 *   - Em Contato            → > 24h
 *   - outras etapas         → bloqueado
 *
 * Se notes_last_updated estiver ausente/inválido → bloqueia.
 */
function canMoveByNotesLastUpdated(deal) {
  const stage = String(deal?.stage || '');
  const hoursSinceNote = getHoursSince(deal?.notesLastUpdated);

  if (hoursSinceNote === null) {
    return {
      allowed: false,
      reason: 'notes_last_updated ausente ou inválido',
      hoursSinceNote: null,
      requiredHours: null,
      lastUpdated: deal?.notesLastUpdated || null,
    };
  }

  const requiredHours = REQUIRED_HOURS_BY_STAGE[stage];

  if (requiredHours === undefined) {
    return {
      allowed: false,
      reason: 'Etapa não elegível para movimentação por tempo',
      hoursSinceNote,
      requiredHours: null,
      lastUpdated: deal.notesLastUpdated,
    };
  }

  const allowed = hoursSinceNote > requiredHours;
  const stageLabel = STAGE_NAMES[stage] || stage;

  return {
    allowed,
    reason: allowed
      ? `Card em ${stageLabel} há mais de ${requiredHours}h`
      : `Card em ${stageLabel} há menos de ${requiredHours}h`,
    hoursSinceNote,
    requiredHours,
    lastUpdated: deal.notesLastUpdated,
  };
}

// ==================== Busca de contatos ====================

/**
 * Busca contatos por um campo. Suporta operador IN.
 */
async function searchContactByField(propertyName, value, operator = 'EQ', limit = 1) {
  const filter = operator === 'IN'
    ? [{ propertyName, operator, values: Array.isArray(value) ? value : [value] }]
    : [{ propertyName, operator, value }];

  try {
    const response = await hubspotClient.crm.contacts.searchApi.doSearch({
      filterGroups: [{ filters: filter }],
      properties: CONTACT_PROPERTIES,
      limit,
    });
    return response.results || [];
  } catch (error) {
    console.error(`❌ Erro ao buscar por ${propertyName} (${operator}):`, error.message);
    return [];
  }
}

async function searchContactByPhone(phoneRaw, phoneDigits) {
  const variants = buildPhoneVariants(phoneRaw, phoneDigits);

  for (const value of variants) {
    const byPhone = await searchContactByField('phone', value, 'EQ', 5);
    const matchPhone = byPhone.find(contact => {
      const props = contact.properties || {};
      return phonesMatch(props.phone, phoneDigits) ||
             phonesMatch(props.hs_whatsapp_phone_number, phoneDigits);
    });
    if (matchPhone) {
      console.log(`✅ Contato encontrado via phone EQ "${value}" (id=${matchPhone.id})`);
      return matchPhone;
    }

    const byWhats = await searchContactByField('hs_whatsapp_phone_number', value, 'EQ', 5);
    const matchWhats = byWhats.find(contact => {
      const props = contact.properties || {};
      return phonesMatch(props.phone, phoneDigits) ||
             phonesMatch(props.hs_whatsapp_phone_number, phoneDigits);
    });
    if (matchWhats) {
      console.log(`✅ Contato encontrado via hs_whatsapp_phone_number EQ "${value}" (id=${matchWhats.id})`);
      return matchWhats;
    }
  }

  console.warn('⚠️ Busca por propriedade falhou. Tentando busca textual como fallback...');
  for (const query of variants) {
    try {
      const response = await hubspotClient.crm.contacts.searchApi.doSearch({
        query,
        properties: CONTACT_PROPERTIES,
        limit: 10,
      });
      if (response.results?.length) {
        const match = response.results.find(contact => {
          const props = contact.properties || {};
          const phoneValues = [props.phone, props.hs_whatsapp_phone_number].filter(Boolean);
          return phoneValues.some(contactPhone => phonesMatch(contactPhone, phoneDigits));
        });
        if (match) {
          console.log(`✅ Contato encontrado via query textual "${query}" (id=${match.id})`);
          return match;
        }
      }
    } catch (error) {
      console.error(`❌ Erro na busca textual por telefone "${query}":`, error.message);
    }
  }

  console.warn('⚠️ Nenhum contato encontrado pelo telefone (nem por propriedade nem textual).');
  return null;
}

/**
 * Escolhe o melhor contato entre vários resultados com base em score:
 *  - +3 se telefone bate
 *  - +2 se e-mail bate
 *  - +2 se CPF bate
 *  - +1 se tem owner atribuído
 *
 * Retorna o de maior score, ou o primeiro se todos empatarem em 0.
 */
function pickBestContact(results, { emailClean, phoneClean, cpfClean }) {
  if (!Array.isArray(results) || results.length === 0) return null;
  if (results.length === 1) return results[0];

  let best = null;
  let bestScore = -1;

  for (const contact of results) {
    const props = contact.properties || {};
    let score = 0;

    if (phoneClean) {
      const phoneValues = [props.phone, props.hs_whatsapp_phone_number].filter(Boolean);
      if (phoneValues.some(p => phonesMatch(p, phoneClean))) score += 3;
    }

    if (emailClean) {
      const contactEmail = (props.email || '').trim().toLowerCase();
      if (contactEmail && contactEmail === emailClean) score += 2;
    }

    if (cpfClean) {
      const contactCpf = normalizePhone(props.contact_cpf || '');
      if (contactCpf && contactCpf === cpfClean) score += 2;
    }

    if (props.hubspot_owner_id) score += 1;

    if (score > bestScore) {
      bestScore = score;
      best = contact;
    }
  }

  console.log(`🎯 [pickBestContact] ${results.length} candidatos, escolhido id=${best?.id} com score=${bestScore}`);
  return best || results[0];
}

function validateContact(contact, { emailClean, phoneClean, cpfClean, matchedBy }) {
  const props = contact.properties || {};
  const divergencias = [];

  if (emailClean) {
    const contactEmail = (props.email || '').trim().toLowerCase();
    if (contactEmail && contactEmail !== emailClean) divergencias.push('e-mail');
  }

  if (phoneClean && matchedBy !== 'phone') {
    const phoneValues = [props.phone, props.hs_whatsapp_phone_number].filter(Boolean);
    const matchesPhone = phoneValues.some(contactPhone => phonesMatch(contactPhone, phoneClean));
    if (phoneValues.length > 0 && !matchesPhone) divergencias.push('telefone');
  }

  if (cpfClean) {
    const contactCpf = normalizePhone(props.contact_cpf || '');
    if (contactCpf && contactCpf !== cpfClean) divergencias.push('CPF');
  }

  if (divergencias.length > 0) {
    return {
      found: true,
      divergente: true,
      contact,
      motivo: `Dados divergentes do cadastro: ${divergencias.join(', ')}`,
    };
  }

  return { found: true, divergente: false, contact };
}

export async function findContactAndValidate({ email, phone, cpf }) {
  const emailClean = (email || '').trim().toLowerCase();
  const phoneRaw = (phone || '').trim();
  const phoneClean = normalizePhone(phone);
  const cpfClean = normalizePhone(cpf);

  if (phoneClean.length >= 10) {
    const contact = await searchContactByPhone(phoneRaw, phoneClean);
    if (contact) {
      return validateContact(contact, { emailClean, phoneClean, cpfClean, matchedBy: 'phone' });
    }
  }

  if (emailClean) {
    const results = await searchContactByField('email', emailClean, 'EQ', 5);
    if (results.length > 0) {
      const best = pickBestContact(results, { emailClean, phoneClean, cpfClean });
      return validateContact(best, { emailClean, phoneClean, cpfClean, matchedBy: 'email' });
    }
  }

  if (cpfClean.length === 11) {
    const results = await searchContactByField('contact_cpf', cpfClean, 'EQ', 5);
    if (results.length > 0) {
      const best = pickBestContact(results, { emailClean, phoneClean, cpfClean });
      return validateContact(best, { emailClean, phoneClean, cpfClean, matchedBy: 'cpf' });
    }
  }

  return { found: false, divergente: false, contact: null };
}

export async function searchContact({ email, phone, cpf }) {
  const emailClean = (email || '').trim().toLowerCase();
  const phoneRaw = (phone || '').trim();
  const phoneClean = normalizePhone(phone);
  const cpfClean = normalizePhone(cpf);

  if (phoneClean.length >= 10) {
    const contact = await searchContactByPhone(phoneRaw, phoneClean);
    if (contact) return contact;
  }
  if (emailClean) {
    const results = await searchContactByField('email', emailClean, 'EQ', 5);
    if (results.length > 0) return pickBestContact(results, { emailClean, phoneClean, cpfClean });
  }
  if (cpfClean.length === 11) {
    const results = await searchContactByField('contact_cpf', cpfClean, 'EQ', 5);
    if (results.length > 0) return pickBestContact(results, { emailClean, phoneClean, cpfClean });
  }
  return null;
}

// ==================== Contatos: criar / atualizar ====================

export async function createContact({ firstName, lastName, email, phone, cpf, origem, ownerId }) {
  const properties = { firstname: firstName, lastname: lastName };

  if (email && email.trim()) properties.email = email.trim().toLowerCase();
  if (phone && phone.trim()) {
    properties.phone = phone.trim();
    properties.hs_whatsapp_phone_number = phone.trim();
  }
  if (cpf) properties.contact_cpf = normalizePhone(cpf);
  if (origem) properties.contact_fonte = origem;
  if (ownerId) properties.hubspot_owner_id = ownerId;

  console.log('✍️ [createContact] properties:', JSON.stringify(properties));

  try {
    return await hubspotClient.crm.contacts.basicApi.create({ properties, associations: [] });
  } catch (error) {
    if (error.code === 409) {
      console.warn('⚠️ [createContact] Contato já existe. Buscando ID existente...');
      const match = error.message?.match(/Existing ID: (\d+)/);
      if (match) {
        try {
          return await hubspotClient.crm.contacts.basicApi.getById(match[1], CONTACT_PROPERTIES);
        } catch (getErr) {
          console.error('❌ Erro ao buscar contato existente:', getErr.message);
        }
      }
    }
    throw error;
  }
}

export async function updateContactOwner(contactId, ownerId) {
  if (!contactId || !ownerId) return null;
  try {
    return await hubspotClient.crm.contacts.basicApi.update(contactId, {
      properties: { hubspot_owner_id: ownerId },
    });
  } catch (error) {
    console.error('❌ [updateContactOwner] Erro:', error.message);
    throw error;
  }
}

export async function findOwnerIdByEmail(email) {
  if (!email) return null;
  try {
    const url = `https://api.hubapi.com/crm/v3/owners?email=${encodeURIComponent(email)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.CHV_Hubspot}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) throw new Error(`Owners search error ${response.status}`);
    const data = await response.json();
    const owner = data.results?.[0];
    return owner ? owner.id : null;
  } catch (error) {
    console.error('❌ [findOwnerIdByEmail] Erro:', error.message);
    return null;
  }
}

// ==================== Deals: leitura ====================

async function getDealsByIds(dealIds = []) {
  if (!dealIds.length) return [];

  try {
    const dealSearchUrl = 'https://api.hubapi.com/crm/v3/objects/deals/search';
    const dealResponse = await fetch(dealSearchUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CHV_Hubspot}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filterGroups: [{
          filters: [{ propertyName: 'hs_object_id', operator: 'IN', values: dealIds }],
        }],
        properties: DEAL_PROPERTIES,
        limit: 100,
      }),
    });

    if (!dealResponse.ok) {
      throw new Error(`Deal search error ${dealResponse.status}: ${await dealResponse.text()}`);
    }

    const dealData = await dealResponse.json();
    return (dealData.results || []).map(deal => ({
      id: deal.id,
      dealName: deal.properties?.dealname || null,
      pipeline: deal.properties?.pipeline || null,
      stage: deal.properties?.dealstage || null,
      ownerId: deal.properties?.hubspot_owner_id || null,
      notesLastUpdated: deal.properties?.notes_last_updated || null,
      motivoDaPerda: deal.properties?.motivo_da_perda || null,
      lastModifiedDate: deal.properties?.hs_lastmodifieddate || null,
    }));
  } catch (error) {
    console.error('❌ [getDealsByIds] Erro:', error.message);
    throw error;
  }
}

export async function getContactDeals(contactId) {
  try {
    const assocUrl = `https://api.hubapi.com/crm/v3/associations/contacts/deals/batch/read`;
    const assocResponse = await fetch(assocUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CHV_Hubspot}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: [{ id: contactId }] }),
    });
    if (!assocResponse.ok) throw new Error(`Associação error ${assocResponse.status}`);

    const assocData = await assocResponse.json();
    const dealIds = assocData.results?.[0]?.to?.map(item => item.id) || [];
    if (dealIds.length === 0) return [];

    return await getDealsByIds(dealIds);
  } catch (error) {
    console.error('❌ [getContactDeals] Erro:', error.message);
    throw error;
  }
}

export async function getFirstStageId(pipelineId) {
  try {
    const url = `https://api.hubapi.com/crm/v3/pipelines/deals/${pipelineId}/stages`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.CHV_Hubspot}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) throw new Error(`Get stages error ${response.status}`);
    const data = await response.json();
    const stages = data.results || [];
    return stages.length > 0 ? stages[0].id : null;
  } catch (error) {
    console.error('❌ [getFirstStageId] Erro:', error.message);
    return null;
  }
}

// ==================== Deals: escrita ====================

export async function createDealForContact(contactId, dealName, pipelineId, stageId = null, ownerId = null) {
  try {
    let finalStageId = stageId;
    if (!finalStageId) {
      finalStageId = await getFirstStageId(pipelineId);
      if (!finalStageId) throw new Error('Não foi possível obter um estágio válido.');
    }

    const properties = {
      dealname: dealName,
      pipeline: pipelineId,
      dealstage: finalStageId,
      motivo_da_perda: '',
    };
    if (ownerId) properties.hubspot_owner_id = ownerId;

    const createDealUrl = 'https://api.hubapi.com/crm/v3/objects/deals';
    const createDealResponse = await fetch(createDealUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CHV_Hubspot}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties,
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
        }],
      }),
    });
    if (!createDealResponse.ok) {
      throw new Error(`Create deal error ${createDealResponse.status}: ${await createDealResponse.text()}`);
    }
    const dealData = await createDealResponse.json();
    console.log('✅ [createDealForContact] Negócio criado:', dealData.id);
    return dealData;
  } catch (error) {
    console.error('❌ [createDealForContact] Erro:', error.message);
    throw error;
  }
}

/**
 * Move um negócio para o pipeline Closer, fase Em Contato.
 *
 * - Limpa `motivo_da_perda`.
 * - Não mexe em `notes_last_updated` (essa propriedade reflete notas/engajamentos,
 *   não updates de propriedade).
 *
 * Retorna { deal, lastUpdatedAt }, onde `lastUpdatedAt` é `hs_lastmodifieddate`
 * retornado pelo HubSpot após o PATCH — ou o horário local como fallback.
 */
export async function moveDealToCloserEmContato(dealId, ownerId = null) {
  try {
    const properties = {
      pipeline: PIPELINE_CLOSER_ID,
      dealstage: STAGE_EM_CONTATO_ID,
      motivo_da_perda: '',
    };
    if (ownerId) properties.hubspot_owner_id = ownerId;

    const updateUrl = `https://api.hubapi.com/crm/v3/objects/deals/${dealId}?properties=hs_lastmodifieddate,notes_last_updated`;
    const updateResponse = await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.CHV_Hubspot}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties }),
    });

    if (!updateResponse.ok) {
      throw new Error(`Update deal error ${updateResponse.status}: ${await updateResponse.text()}`);
    }

    const updated = await updateResponse.json();
    const lastUpdatedAt =
      updated?.properties?.hs_lastmodifieddate || new Date().toISOString();

    console.log('✅ [moveDealToCloserEmContato] Negócio movido:', dealId, '| lastModifiedDate:', lastUpdatedAt);

    return { deal: updated, lastUpdatedAt };
  } catch (error) {
    console.error('❌ [moveDealToCloserEmContato] Erro:', error.message);
    throw error;
  }
}

// ==================== Regra principal ====================

/**
 * Garante o lead no pipeline Closer.
 *
 * Regra 6 (deal no Closer com outro owner): em vez de bloquear sempre,
 * avalia notes_last_updated. Se a janela expirou (72h em Coleta de documentação,
 * 24h em Entrada/Em Contato), reatribui. Caso contrário, bloqueia.
 *
 * Todas as respostas incluem `lastUpdatedAt` (data/hora da última atualização
 * do card) para devolver ao usuário.
 */
export async function garantirLeadNoCloser(contactId, dealName, ownerId = null, collaboratorName = '') {
  if (!ownerId) {
    return {
      blocked: true,
      message: 'Movimentação bloqueada: responsável de destino não informado',
      pipeline: null,
      stage: null,
      pipelineNome: null,
      stageNome: null,
      dealId: null,
      ruleApplied: 'owner_missing',
      lastUpdatedAt: null,
    };
  }

  const deals = await getContactDeals(contactId);

  // 1. Sem negócio
  if (deals.length === 0) {
    const newDeal = await createDealForContact(contactId, dealName, PIPELINE_BASE_LEADS_ID, null, ownerId);
    const { lastUpdatedAt } = await moveDealToCloserEmContato(newDeal.id, ownerId);
    await updateContactOwner(contactId, ownerId);

    return {
      blocked: false,
      dealId: newDeal.id,
      pipeline: PIPELINE_CLOSER_ID,
      stage: STAGE_EM_CONTATO_ID,
      pipelineNome: 'Closer',
      stageNome: 'Em Contato',
      ruleApplied: 'created_and_moved',
      lastUpdatedAt,
    };
  }

  // 2. Negócio no Base de Leads
  const dealBase = deals.find(d => String(d.pipeline) === String(PIPELINE_BASE_LEADS_ID));
  if (dealBase) {
    const { lastUpdatedAt } = await moveDealToCloserEmContato(dealBase.id, ownerId);
    await updateContactOwner(contactId, ownerId);

    return {
      blocked: false,
      dealId: dealBase.id,
      pipeline: PIPELINE_CLOSER_ID,
      stage: STAGE_EM_CONTATO_ID,
      pipelineNome: 'Closer',
      stageNome: 'Em Contato',
      ruleApplied: 'base_to_closer',
      lastUpdatedAt,
    };
  }

  // 3. Negócio no Closer, fase Desqualificado
  const dealDesqualificado = deals.find(
    d => String(d.pipeline) === String(PIPELINE_CLOSER_ID) &&
         String(d.stage) === String(STAGE_DESQUALIFICADO_ID)
  );
  if (dealDesqualificado) {
    const { lastUpdatedAt } = await moveDealToCloserEmContato(dealDesqualificado.id, ownerId);
    await updateContactOwner(contactId, ownerId);

    return {
      blocked: false,
      dealId: dealDesqualificado.id,
      pipeline: PIPELINE_CLOSER_ID,
      stage: STAGE_EM_CONTATO_ID,
      pipelineNome: 'Closer',
      stageNome: 'Em Contato',
      ruleApplied: 'desqualificado_to_em_contato',
      lastUpdatedAt,
    };
  }

  // 4. Negócio no Closer, sem owner
  const dealCloserSemOwner = deals.find(
    d => String(d.pipeline) === String(PIPELINE_CLOSER_ID) && !d.ownerId
  );
  if (dealCloserSemOwner) {
    const { lastUpdatedAt } = await moveDealToCloserEmContato(dealCloserSemOwner.id, ownerId);
    await updateContactOwner(contactId, ownerId);

    return {
      blocked: false,
      dealId: dealCloserSemOwner.id,
      pipeline: PIPELINE_CLOSER_ID,
      stage: STAGE_EM_CONTATO_ID,
      pipelineNome: 'Closer',
      stageNome: 'Em Contato',
      ruleApplied: 'closer_without_owner',
      lastUpdatedAt,
    };
  }

  // 5. Negócio no Closer com o mesmo owner (idempotente)
  const dealMesmoOwner = deals.find(
    d => String(d.pipeline) === String(PIPELINE_CLOSER_ID) &&
         String(d.ownerId || '') === String(ownerId || '')
  );
  if (dealMesmoOwner) {
    await updateContactOwner(contactId, ownerId);

    return {
      blocked: false,
      alreadyAssigned: true,
      dealId: dealMesmoOwner.id,
      message: `Card já está com o colaborador '${collaboratorName}'`,
      pipeline: dealMesmoOwner.pipeline,
      stage: dealMesmoOwner.stage,
      pipelineNome: PIPELINE_NAMES[dealMesmoOwner.pipeline] || dealMesmoOwner.pipeline,
      stageNome: STAGE_NAMES[dealMesmoOwner.stage] || dealMesmoOwner.stage,
      ruleApplied: 'already_assigned',
      lastUpdatedAt: dealMesmoOwner.notesLastUpdated || dealMesmoOwner.lastModifiedDate || null,
    };
  }

  // 6. Negócio no Closer com outro owner → regra temporal
  const dealCloserOutroOwner = deals.find(
    d => String(d.pipeline) === String(PIPELINE_CLOSER_ID) &&
         d.ownerId &&
         String(d.ownerId) !== String(ownerId || '')
  );
  if (dealCloserOutroOwner) {
    const movementCheck = canMoveByNotesLastUpdated(dealCloserOutroOwner);

    if (movementCheck.allowed) {
      const { lastUpdatedAt } = await moveDealToCloserEmContato(dealCloserOutroOwner.id, ownerId);
      await updateContactOwner(contactId, ownerId);

      return {
        blocked: false,
        dealId: dealCloserOutroOwner.id,
        pipeline: PIPELINE_CLOSER_ID,
        stage: STAGE_EM_CONTATO_ID,
        pipelineNome: 'Closer',
        stageNome: 'Em Contato',
        ruleApplied: 'reassigned_by_notes_last_updated',
        message: movementCheck.reason,
        notesLastUpdated: movementCheck.lastUpdated,
        hoursSinceNote: movementCheck.hoursSinceNote,
        requiredHours: movementCheck.requiredHours,
        lastUpdatedAt,
      };
    }

    return {
      blocked: true,
      dealId: dealCloserOutroOwner.id,
      message: `Movimentação bloqueada: ${movementCheck.reason}`,
      pipeline: dealCloserOutroOwner.pipeline,
      stage: dealCloserOutroOwner.stage,
      pipelineNome: PIPELINE_NAMES[dealCloserOutroOwner.pipeline] || dealCloserOutroOwner.pipeline,
      stageNome: STAGE_NAMES[dealCloserOutroOwner.stage] || dealCloserOutroOwner.stage,
      ruleApplied: 'owned_by_another_recent_activity',
      notesLastUpdated: movementCheck.lastUpdated,
      hoursSinceNote: movementCheck.hoursSinceNote,
      requiredHours: movementCheck.requiredHours,
      lastUpdatedAt: movementCheck.lastUpdated,
    };
  }

  // 7. Fallback
  const primeiro = deals[0];
  return {
    blocked: true,
    dealId: primeiro?.id || null,
    message: `Movimentação bloqueada: Card em pipeline '${PIPELINE_NAMES[primeiro?.pipeline] || primeiro?.pipeline}'`,
    pipeline: primeiro?.pipeline || null,
    stage: primeiro?.stage || null,
    pipelineNome: PIPELINE_NAMES[primeiro?.pipeline] || primeiro?.pipeline || null,
    stageNome: STAGE_NAMES[primeiro?.stage] || primeiro?.stage || null,
    ruleApplied: 'fallback_block',
    lastUpdatedAt: primeiro?.notesLastUpdated || primeiro?.lastModifiedDate || null,
  };
}

// ==================== Compatibilidade ====================

export async function verificarPipelineBaseELevio(contactId) {
  const deal = await findDealInBaseLeads(contactId);
  if (!deal) return { noPipelineBase: false, noFaseEnvio: false, pipeline: null, stage: null };
  return {
    noPipelineBase: String(deal.pipeline) === String(PIPELINE_BASE_LEADS_ID),
    noFaseEnvio: false,
    pipeline: deal.pipeline,
    stage: deal.stage,
  };
}

export async function isContactInPipeline(contactId, pipelineId) {
  const deals = await getContactDeals(contactId);
  return deals.some(deal => String(deal.pipeline) === String(pipelineId));
}

export async function findDealInBaseLeads(contactId) {
  const deals = await getContactDeals(contactId);
  return deals.find(deal => String(deal.pipeline) === String(PIPELINE_BASE_LEADS_ID)) || null;
}

// ==================== Validação final ====================

export async function validateFinalAssignment(contactId, expectedOwnerId, expectedDealId = null) {
  const deals = await getContactDeals(contactId);

  console.log('[validateFinalAssignment] contactId=', contactId,
    'expectedOwnerId=', expectedOwnerId,
    'expectedDealId=', expectedDealId);
  console.log('[validateFinalAssignment] deals associados:', deals.map(d => ({
    id: d.id,
    pipeline: d.pipeline,
    stage: d.stage,
    ownerId: d.ownerId,
    notesLastUpdated: d.notesLastUpdated,
  })));

  let targetDeal = null;
  let resolvedBy = null;

  if (expectedDealId) {
    targetDeal = deals.find(d => String(d.id) === String(expectedDealId)) || null;
    if (targetDeal) resolvedBy = 'expected_deal_id';
    else console.warn(`⚠️ [validateFinalAssignment] expectedDealId=${expectedDealId} não está entre os deals. Tentando fallback...`);
  }

  if (!targetDeal) {
    targetDeal = deals.find(d => String(d.pipeline) === String(PIPELINE_CLOSER_ID)) || null;
    if (targetDeal) resolvedBy = 'fallback_pipeline_closer';
  }

  if (!targetDeal && expectedOwnerId) {
    targetDeal = deals.find(d => String(d.ownerId || '') === String(expectedOwnerId)) || null;
    if (targetDeal) resolvedBy = 'fallback_owner_match';
  }

  if (!targetDeal) {
    console.warn(`⚠️ [validateFinalAssignment] Nenhum deal válido encontrado para contactId=${contactId}`);
    return {
      ok: false,
      error: 'Deal não encontrado',
      resolvedBy: null,
      details: {
        dealPipeline: null,
        dealStage: null,
        dealOwnerId: null,
        contactOwnerId: null,
        associatedDeals: deals,
      },
    };
  }

  try {
    const contact = await hubspotClient.crm.contacts.basicApi.getById(contactId, [
      'hubspot_owner_id',
      'email',
      'firstname',
      'lastname',
    ]);
    const contactOwnerId = contact.properties?.hubspot_owner_id || null;

    const dealPipeline = String(targetDeal.pipeline || '');
    const dealStage = String(targetDeal.stage || '');
    const dealOwnerId = String(targetDeal.ownerId || '');
    const expectedOwner = String(expectedOwnerId || '');
    const expectedPipeline = String(PIPELINE_CLOSER_ID);
    const expectedStage = String(STAGE_EM_CONTATO_ID);

    const okDeal = dealPipeline === expectedPipeline &&
                   dealStage === expectedStage &&
                   dealOwnerId === expectedOwner;

    const okContact = String(contactOwnerId || '') === expectedOwner;

    const ok = okDeal && okContact;

    console.log(
      `🔍 [validateFinalAssignment] resolvedBy=${resolvedBy} ` +
      `dealId=${targetDeal.id} dealOwner=${dealOwnerId} contactOwner=${contactOwnerId} ` +
      `okDeal=${okDeal} okContact=${okContact} ok=${ok}`
    );

    return {
      ok,
      resolvedBy,
      contactOwnerId,
      deal: targetDeal,
      lastUpdatedAt: targetDeal.notesLastUpdated || targetDeal.lastModifiedDate || null,
      details: {
        dealPipeline: targetDeal.pipeline,
        dealStage: targetDeal.stage,
        dealOwnerId: targetDeal.ownerId,
        contactOwnerId,
        associatedDeals: deals,
      },
    };
  } catch (error) {
    console.error('❌ [validateFinalAssignment] Erro:', error.message);
    return { ok: false, error: error.message, resolvedBy };
  }
}