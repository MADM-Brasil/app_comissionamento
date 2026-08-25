// services/hubspot.js
import { Client } from '@hubspot/api-client';

const hubspotClient = new Client({
  accessToken: process.env.CHV_Hubspot,
});

// IDs internos do HubSpot
const PIPELINE_BASE_LEADS_ID = process.env.HUBSPOT_PIPELINE_BASE_LEADS_ID || '905901447';
const PIPELINE_CLOSER_ID = process.env.HUBSPOT_PIPELINE_CLOSER_ID || '904458124';
const STAGE_EM_CONTATO_ID = process.env.HUBSPOT_STAGE_EM_CONTATO_ID || '1368997801';
// Nova constante para fase Desqualificado
const STAGE_DESQUALIFICADO_ID = process.env.HUBSPOT_STAGE_DESQUALIFICADO_ID || '1368997806';

export const HUBSPOT_PIPELINE_BASE_LEADS_ID = PIPELINE_BASE_LEADS_ID;
export const HUBSPOT_PIPELINE_CLOSER_ID = PIPELINE_CLOSER_ID;
export const HUBSPOT_STAGE_EM_CONTATO_ID = STAGE_EM_CONTATO_ID;
export const HUBSPOT_STAGE_DESQUALIFICADO_ID = STAGE_DESQUALIFICADO_ID;

// Mapeamento de nomes para mensagens de bloqueio
const PIPELINE_NAMES = {
  [PIPELINE_BASE_LEADS_ID]: 'Base de Leads',
  [PIPELINE_CLOSER_ID]: 'Closer',
  '905179189': 'Jurídico Auditoria de Ganho',
  '905179471': 'PRO',
  '926561825': 'Fator K',
  '925690734': 'Quinquenio/concomitante',
};

// Mapeamento de nomes de estágios
const STAGE_NAMES = {
  [STAGE_EM_CONTATO_ID]: 'Em Contato',
  [STAGE_DESQUALIFICADO_ID]: 'Desqualificado',
};

/**
 * Normaliza o número de telefone removendo caracteres não numéricos.
 * @param {string} phone
 * @returns {string}
 */
function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, '');
}

/**
 * Busca um contato por um único campo (função interna).
 */
async function searchContactByField(propertyName, value, operator) {
  const filter = [{ propertyName, operator, value }];
  try {
    const response = await hubspotClient.crm.contacts.searchApi.doSearch({
      filterGroups: [{ filters: filter }],
      properties: ['email', 'firstname', 'lastname', 'phone', 'hs_whatsapp_phone_number', 'contact_cpf', 'contact_fonte'],
      limit: 1,
    });
    return response.results?.[0] || null;
  } catch (error) {
    console.error(`❌ Erro ao buscar por ${propertyName}:`, error.message);
    return null;
  }
}

/**
 * Busca contato por telefone usando busca textual (query) e validação manual.
 * @param {string} phoneRaw - telefone original como veio do formulário
 * @param {string} phoneDigits - telefone apenas com dígitos
 * @returns {Promise<Object|null>}
 */
async function searchContactByPhone(phoneRaw, phoneDigits) {
  const variants = [];

  if (phoneRaw?.trim()) variants.push(phoneRaw.trim());
  if (phoneDigits) {
    variants.push(phoneDigits);
    variants.push(phoneDigits.slice(-11));
    variants.push(phoneDigits.slice(-10));
    variants.push(`55${phoneDigits}`);
    variants.push(`+55${phoneDigits}`);
  }

  const uniqueVariants = [...new Set(variants)].filter(Boolean);

  for (const query of uniqueVariants) {
    try {
      const response = await hubspotClient.crm.contacts.searchApi.doSearch({
        query,
        properties: [
          'email',
          'firstname',
          'lastname',
          'phone',
          'hs_whatsapp_phone_number',
          'contact_cpf',
          'contact_fonte'
        ],
        limit: 10,
      });

      if (response.results?.length) {
        const match = response.results.find(contact => {
          const props = contact.properties || {};
          const phoneValues = [
            normalizePhone(props.phone || ''),
            normalizePhone(props.hs_whatsapp_phone_number || '')
          ].filter(Boolean);

          return phoneValues.some(contactPhone =>
            contactPhone === phoneDigits ||
            contactPhone.includes(phoneDigits) ||
            phoneDigits.includes(contactPhone)
          );
        });

        if (match) {
          console.log(`✅ Contato encontrado via query "${query}"`);
          return match;
        }
      }
    } catch (error) {
      console.error(`❌ Erro na busca textual por telefone "${query}":`, error.message);
    }
  }

  console.warn('⚠️ Nenhum contato encontrado pelo telefone usando busca textual.');
  return null;
}

/**
 * Busca contato por telefone (prioridade), e‑mail e CPF, validando divergências.
 * Retorna { found, divergente, contact, motivo? }.
 */
export async function findContactAndValidate({ email, phone, cpf }) {
  const emailClean = (email || '').trim().toLowerCase();
  const phoneRaw = (phone || '').trim();
  const phoneClean = normalizePhone(phone);
  const cpfClean = normalizePhone(cpf);

  // 1) Telefone (prioridade)
  if (phoneClean.length >= 10) {
    const contact = await searchContactByPhone(phoneRaw, phoneClean);
    if (contact) {
      return validateContact(contact, { emailClean, phoneClean, cpfClean });
    }
  }

  // 2) E-mail
  if (emailClean) {
    const contact = await searchContactByField('email', emailClean, 'EQ');
    if (contact) {
      return validateContact(contact, { emailClean, phoneClean, cpfClean });
    }
  }

  // 3) CPF
  if (cpfClean.length === 11) {
    const contact = await searchContactByField('contact_cpf', cpfClean, 'EQ');
    if (contact) {
      return validateContact(contact, { emailClean, phoneClean, cpfClean });
    }
  }

  return { found: false, divergente: false, contact: null };
}

/**
 * Compara os dados fornecidos com os do contato existente.
 */
function validateContact(contact, { emailClean, phoneClean, cpfClean }) {
  const props = contact.properties || {};
  const divergencias = [];

  if (emailClean) {
    const contactEmail = (props.email || '').trim().toLowerCase();
    if (contactEmail && contactEmail !== emailClean) {
      divergencias.push('e-mail');
    }
  }

  if (phoneClean) {
    const phoneValues = [
      normalizePhone(props.phone || ''),
      normalizePhone(props.hs_whatsapp_phone_number || '')
    ].filter(Boolean);

    const matchesPhone = phoneValues.some(contactPhone =>
      contactPhone === phoneClean ||
      contactPhone.includes(phoneClean) ||
      phoneClean.includes(contactPhone)
    );

    if (phoneValues.length > 0 && !matchesPhone) {
      divergencias.push('telefone');
    }
  }

  if (cpfClean) {
    const contactCpf = normalizePhone(props.contact_cpf || '');
    if (contactCpf && contactCpf !== cpfClean) {
      divergencias.push('CPF');
    }
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

/**
 * Busca simples (usada internamente ou por outros módulos).
 * Não valida divergências, apenas retorna o primeiro contato encontrado.
 */
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
    const contact = await searchContactByField('email', emailClean, 'EQ');
    if (contact) return contact;
  }
  if (cpfClean.length === 11) {
    const contact = await searchContactByField('contact_cpf', cpfClean, 'EQ');
    if (contact) return contact;
  }
  return null;
}

/**
 * Cria um novo contato no HubSpot.
 * Padroniza o telefone para apenas dígitos.
 */
export async function createContact({ firstName, lastName, email, phone, cpf, origem }) {
  const properties = {
    firstname: firstName,
    lastname: lastName,
  };

  if (email && email.trim()) {
    properties.email = email.trim().toLowerCase();
  }

  if (phone) {
    const phoneNormalized = normalizePhone(phone);
    properties.phone = phoneNormalized;
    properties.hs_whatsapp_phone_number = phoneNormalized;
  }

  if (cpf) {
    properties.contact_cpf = normalizePhone(cpf);
  }

  if (origem) {
    properties.contact_fonte = origem;
  }

  console.log('✍️ [createContact] properties:', JSON.stringify(properties));

  try {
    const contact = await hubspotClient.crm.contacts.basicApi.create({
      properties,
      associations: [],
    });
    return contact;
  } catch (error) {
    if (error.code === 409) {
      console.warn('⚠️ [createContact] Contato já existe. Buscando ID existente...');
      const match = error.message?.match(/Existing ID: (\d+)/);
      if (match) {
        try {
          const existingContact = await hubspotClient.crm.contacts.basicApi.getById(match[1], [
            'email', 'firstname', 'lastname', 'phone', 'hs_whatsapp_phone_number', 'contact_cpf', 'contact_fonte'
          ]);
          return existingContact;
        } catch (getErr) {
          console.error('❌ Erro ao buscar contato existente:', getErr.message);
        }
      }
    }
    throw error;
  }
}

/**
 * Busca o ID de um proprietário no HubSpot pelo e‑mail.
 */
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

/**
 * Obtém os negócios associados a um contato.
 */
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
        properties: ['pipeline', 'dealstage', 'hubspot_owner_id'],
        limit: 100,
      }),
    });
    if (!dealResponse.ok) throw new Error(`Deal search error ${dealResponse.status}`);

    const dealData = await dealResponse.json();
    return (dealData.results || []).map(deal => ({
      id: deal.id,
      pipeline: deal.properties.pipeline,
      stage: deal.properties.dealstage,
      ownerId: deal.properties.hubspot_owner_id || null,
    }));
  } catch (error) {
    console.error('❌ [getContactDeals] Erro:', error.message);
    return [];
  }
}

/**
 * Obtém o primeiro estágio de um pipeline.
 */
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

/**
 * Cria um negócio (deal) no pipeline especificado.
 */
export async function createDealForContact(contactId, dealName, pipelineId, stageId = null, ownerId = null) {
  try {
    let finalStageId = stageId;
    if (!finalStageId) {
      finalStageId = await getFirstStageId(pipelineId);
      if (!finalStageId) throw new Error('Não foi possível obter um estágio válido.');
    }

    const properties = { dealname: dealName, pipeline: pipelineId, dealstage: finalStageId };
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
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
        }]
      })
    });
    if (!createDealResponse.ok) throw new Error(`Create deal error ${createDealResponse.status}: ${await createDealResponse.text()}`);
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
 */
export async function moveDealToCloserEmContato(dealId, ownerId = null) {
  try {
    const properties = { pipeline: PIPELINE_CLOSER_ID, dealstage: STAGE_EM_CONTATO_ID };
    if (ownerId) properties.hubspot_owner_id = ownerId;

    const updateUrl = `https://api.hubapi.com/crm/v3/objects/deals/${dealId}`;
    const updateResponse = await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.CHV_Hubspot}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties })
    });
    if (!updateResponse.ok) throw new Error(`Update deal error ${updateResponse.status}: ${await updateResponse.text()}`);
    console.log('✅ [moveDealToCloserEmContato] Negócio movido:', dealId);
    return await updateResponse.json();
  } catch (error) {
    console.error('❌ [moveDealToCloserEmContato] Erro:', error.message);
    throw error;
  }
}

/**
 * Função principal para garantir o lead no pipeline Closer.
 * Regras:
 * - Sem negócio: cria no Base de Leads e move para Closer/Em Contato.
 * - Negócio no Base de Leads: move para Closer/Em Contato.
 * - Negócio no Closer, fase Desqualificado: permite movimentação (altera responsável e move para Em Contato).
 * - Negócio fora do Base de Leads (incluindo Closer):
 *   - Se já estiver com o colaborador informado (ownerId igual), bloqueia com "Card já está com o colaborador".
 *   - Senão, bloqueia com "Movimentação bloqueada: Card em pipeline".
 */
export async function garantirLeadNoCloser(contactId, dealName, ownerId = null, collaboratorName = '') {
  const deals = await getContactDeals(contactId);

  if (deals.length === 0) {
    const newDeal = await createDealForContact(contactId, dealName, PIPELINE_BASE_LEADS_ID, null, ownerId);
    await moveDealToCloserEmContato(newDeal.id, ownerId);
    return {
      blocked: false,
      pipeline: PIPELINE_CLOSER_ID,
      stage: STAGE_EM_CONTATO_ID,
      pipelineNome: 'Closer',
      stageNome: 'Em Contato',
    };
  }

  const dealBase = deals.find(d => d.pipeline === PIPELINE_BASE_LEADS_ID);
  if (dealBase) {
    await moveDealToCloserEmContato(dealBase.id, ownerId);
    return {
      blocked: false,
      pipeline: PIPELINE_CLOSER_ID,
      stage: STAGE_EM_CONTATO_ID,
      pipelineNome: 'Closer',
      stageNome: 'Em Contato',
    };
  }

  const firstDeal = deals[0];
  const pipelineName = PIPELINE_NAMES[firstDeal.pipeline] || firstDeal.pipeline;
  const stageName = STAGE_NAMES[firstDeal.stage] || firstDeal.stage;

  // Nova exceção: se estiver no Closer e na fase Desqualificado, permitir movimentação
  if (firstDeal.pipeline === PIPELINE_CLOSER_ID && firstDeal.stage === STAGE_DESQUALIFICADO_ID) {
    await moveDealToCloserEmContato(firstDeal.id, ownerId);
    return {
      blocked: false,
      pipeline: PIPELINE_CLOSER_ID,
      stage: STAGE_EM_CONTATO_ID,
      pipelineNome: 'Closer',
      stageNome: 'Em Contato',
    };
  }

  // Regras de bloqueio existentes
  if (ownerId && firstDeal.ownerId === ownerId) {
    return {
      blocked: true,
      message: `Card já está com o colaborador '${collaboratorName}'`,
      pipeline: firstDeal.pipeline,
      stage: firstDeal.stage,
      pipelineNome: pipelineName,
      stageNome: stageName,
    };
  }

  return {
    blocked: true,
    message: `Movimentação bloqueada: Card em pipeline '${pipelineName}'`,
    pipeline: firstDeal.pipeline,
    stage: firstDeal.stage,
    pipelineNome: pipelineName,
    stageNome: stageName,
  };
}

/**
 * Função de compatibilidade.
 */
export async function verificarPipelineBaseELevio(contactId) {
  const deal = await findDealInBaseLeads(contactId);
  if (!deal) return { noPipelineBase: false, noFaseEnvio: false, pipeline: null, stage: null };
  return { noPipelineBase: deal.pipeline === PIPELINE_BASE_LEADS_ID, noFaseEnvio: false, pipeline: deal.pipeline, stage: deal.stage };
}

/**
 * Verifica se o contato está em um pipeline específico.
 */
export async function isContactInPipeline(contactId, pipelineId) {
  const deals = await getContactDeals(contactId);
  return deals.some(deal => deal.pipeline === pipelineId);
}

/**
 * Encontra um negócio no pipeline Base de Leads.
 */
export async function findDealInBaseLeads(contactId) {
  const deals = await getContactDeals(contactId);
  return deals.find(deal => deal.pipeline === PIPELINE_BASE_LEADS_ID) || null;
}