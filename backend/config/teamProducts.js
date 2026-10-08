// backend/config/teamProducts.js
// =====================================================================
// MAPEAMENTO EQUIPE → PRODUTO
// ---------------------------------------------------------------------
// Os valores em PRODUCT.* são os NOMES INTERNOS usados no HubSpot
// (propriedades `produto` do deal e `contact_produto` do contato).
// NÃO altere esses valores sem alinhar com o CRM.
//
// Como ajustar:
//   1) Equipe no produto PADRÃO (auxilio_acidente): nada a fazer.
//   2) Equipe podendo ALTERNAR: adicione a chave com o nome exato da equipe.
//   3) Equipe TRAVADA em outro produto: defina allowChange: false.
//
// Lookup tolerante: as chaves do mapa são normalizadas (trim + lowercase +
// sem acentos + espaços colapsados). O nome da equipe vindo do banco pode
// variar em caixa/espaço/acento que o lookup continua funcionando.
// =====================================================================

export const PRODUCT = Object.freeze({
  QUINQUENIO:       'quinquenio',
  AUXILIO_ACIDENTE: 'auxilio_acidente',
  FATOR_K:          'Fator K',        // sem equipe no momento
  CONCOMITANTE:     'Concomitante',
  BPC_LOAS:         'BPC/LOAS',       // sem equipe específica no momento
});

export const normalizeKey = value => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ');

export const DEFAULT_PRODUCT = PRODUCT.AUXILIO_ACIDENTE;

// Mapa canônico — chaves JÁ normalizadas para lookup tolerante.
export const PRODUCTS_BY_TEAM = Object.freeze({
  [normalizeKey('Equipe Tatiane')]: {
    default: PRODUCT.QUINQUENIO,
    options: [PRODUCT.QUINQUENIO, PRODUCT.CONCOMITANTE],
    allowChange: true,
  },

  // Para adicionar mais equipes, siga o modelo acima:
  // [normalizeKey('Equipe Fulano')]: {
  //   default: PRODUCT.QUINQUENIO,
  //   options: [PRODUCT.QUINQUENIO, PRODUCT.CONCOMITANTE],
  //   allowChange: true,
  // },
});

export function getTeamProductConfig(team) {
  const config = PRODUCTS_BY_TEAM[normalizeKey(team)];
  return config
    ? { ...config, options: [...config.options] }
    : { default: DEFAULT_PRODUCT, options: [DEFAULT_PRODUCT], allowChange: false };
}

export function resolveTeamProduct(team, requested) {
  const config = getTeamProductConfig(team);
  if (requested != null && typeof requested !== 'string') {
    const error = new Error('Produto deve ser texto.');
    error.status = 400;
    throw error;
  }
  const selected = (typeof requested === 'string' ? requested.trim() : '') || config.default;
  if (!config.options.includes(selected) ||
      (!config.allowChange && selected !== config.default)) {
    const error = new Error(
      `Produto "${selected}" não é permitido para a equipe "${team}". ` +
      `Opções aceitas: ${config.options.join(', ')}.`
    );
    error.status = 400;
    throw error;
  }
  return selected;
}

// ─── Compatibilidade com imports anteriores ───
// (mantém os nomes antigos apontando para as funções novas)
export const TEAM_PRODUCTS = PRODUCTS_BY_TEAM;
export const getProductConfig = getTeamProductConfig;
export function resolveProductForTeam(team, requested) {
  try {
    const product = resolveTeamProduct(team, requested);
    return {
      ok: true,
      product,
      source: requested ? 'requested' : 'default',
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Diagnóstico: loga o mapeamento no boot (ajuda a detectar divergência de nome).
console.log(
  '[teamProducts] equipes mapeadas:',
  Object.entries(PRODUCTS_BY_TEAM).map(([k, v]) => ({
    normalizedKey: k,
    default: v.default,
    options: v.options,
    allowChange: v.allowChange,
  }))
);