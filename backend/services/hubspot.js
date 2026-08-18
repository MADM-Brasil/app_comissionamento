// services/hubspot.js
import { Client } from '@hubspot/api-client';

const hubspotClient = new Client({
  apiKey: process.env.CHV_Hubspot,  
});

/**
 * Procura um contacto por e‑mail, telefone ou CPF.
 * Retorna o primeiro contacto encontrado ou `null`.
 *
 * @param {Object} params
 * @param {string} [params.email]
 * @param {string} [params.phone]
 * @param {string} [params.cpf]
 * @returns {Promise<Object|null>}
 */
export async function searchContact({ email, phone, cpf }) {
  const filters = [];

  if (email) {
    filters.push({ propertyName: 'email', operator: 'EQ', value: email });
  }

  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 10) {
      // CONTAINS_TOKEN procura números parciais (ex.: últimos dígitos)
      filters.push({ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: digits });
    }
  }

  if (cpf) {
    const digits = cpf.replace(/\D/g, '');
    if (digits.length === 11) {
      // Substitua 'cpf' pelo nome exato da propriedade no seu HubSpot (ex.: 'cpf', 'tax_id')
      filters.push({ propertyName: 'cpf', operator: 'EQ', value: digits });
    }
  }

  if (filters.length === 0) return null;

  const response = await hubspotClient.crm.contacts.searchApi.doSearch({
    filterGroups: [{ filters }],
    properties: ['email', 'phone', 'firstname', 'lastname', 'cpf'],
    limit: 1,
  });

  return response.results[0] || null;
}

/**
 * Cria um novo contacto no HubSpot.
 *
 * @param {Object} params
 * @param {string} params.firstName
 * @param {string} params.lastName
 * @param {string} params.email
 * @param {string} [params.phone]
 * @param {string} [params.cpf]
 * @returns {Promise<Object>}
 */

export async function createContact({ firstName, lastName, email, phone, cpf }) {
  const properties = {
    email,
    firstname: firstName,
    lastname: lastName,
  };

  if (phone) {
    properties.phone = phone;
  }

  if (cpf) {
    // Substitua 'cpf' pelo nome exato da propriedade no seu HubSpot
    properties.cpf = cpf.replace(/\D/g, '');
  }

  const contact = await hubspotClient.crm.contacts.basicApi.create({
    properties,
    associations: [],
  });

  return contact;
}