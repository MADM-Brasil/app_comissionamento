// Overrides de acesso aplicados apenas na aplicação (sessão), sem alterar o banco.
// Uso: colaboradores cujo cadastro (cargo/equipe) em core.colaboradores não pode
// ser editado por este app (tabela fora do nosso controle de escrita).
const CARGO_OVERRIDES = {
  'irene.silva@madmbrasil.com.br': { cargo: 'Supervisor', nome_equipe: null },
};

export function applyCargoOverride(user) {
  if (!user) return user;
  const override = CARGO_OVERRIDES[(user.email || '').trim().toLowerCase()];
  return override ? { ...user, ...override } : user;
}
