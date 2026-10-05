import { pool } from './db.js';

export function normalizeAccessValue(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export async function getActiveSupportUser(email, db = pool) {
  if (!email) return null;
  const result = await db.query(
    `SELECT nome, email, cargo, status, nome_equipe
     FROM core.view_app_colaboradores
     WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
     LIMIT 1`,
    [email]
  );
  const user = result.rows[0];
  return normalizeAccessValue(user?.status) === 'ativo' ? user : null;
}

export function isSupportSupervisor(cargo) {
  const role = normalizeAccessValue(cargo);
  return role.startsWith('supervisor') && role !== 'supervisor sales ops';
}

export function isSupportCoordinatorOrAbove(cargo) {
  return [
    'coordenador', 'coordenador sales ops', 'administrativo', 'administrador',
    'salesops', 'analista de crm', 'analista de dados', 'analista de discadora',
    'desenvolvedor make', 'desenvolvedor', 'diretora', 'ceo', 'supervisor sales ops',
  ].includes(normalizeAccessValue(cargo));
}

export function isSupportAdmin(cargo) {
  return [
    'administrativo', 'administrador', 'salesops', 'analista de crm',
    'analista de dados', 'analista de discadora', 'desenvolvedor make',
    'desenvolvedor', 'diretora', 'ceo', 'coordenador sales ops', 'supervisor sales ops',
  ].includes(normalizeAccessValue(cargo));
}

export async function validateHubSpotMovementAccess({
  requesterEmail,
  destinationName,
  destinationEmail,
  destinationTeam,
  sourceTeam,
  enforceSourceTeam = false,
  db = pool,
}) {
  const requester = await getActiveSupportUser(requesterEmail, db);
  if (!requester) return { status: 403, error: 'Usuário ativo não encontrado.' };

  const isSupervisor = isSupportSupervisor(requester.cargo);
  if (!isSupervisor && !isSupportCoordinatorOrAbove(requester.cargo)) {
    return { status: 403, error: 'Somente supervisores e coordenadores podem movimentar cards por Link Hub.' };
  }

  const destinationResult = await db.query(
    `SELECT nome, email, cargo, status, nome_equipe
     FROM core.view_app_colaboradores
     WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
       AND LOWER(TRIM(nome)) = LOWER(TRIM($2))
     LIMIT 1`,
    [destinationEmail, destinationName]
  );
  const destination = destinationResult.rows[0];
  if (!destination || normalizeAccessValue(destination.status) !== 'ativo') {
    return { status: 400, error: 'Assessor destino não encontrado ou inativo.' };
  }
  if (!['assessor', 'analista de pastas'].includes(normalizeAccessValue(destination.cargo))) {
    return { status: 400, error: 'O destino selecionado não é um assessor.' };
  }

  const team = normalizeAccessValue(destinationTeam);
  if (!team || team !== normalizeAccessValue(destination.nome_equipe)) {
    return { status: 400, error: 'Equipe destino não corresponde à equipe do assessor.' };
  }
  if (isSupervisor && team !== normalizeAccessValue(requester.nome_equipe)) {
    return { status: 403, error: 'Supervisores só podem movimentar cards para assessores da própria equipe.' };
  }
  if (isSupervisor && enforceSourceTeam && (!sourceTeam || normalizeAccessValue(sourceTeam) !== normalizeAccessValue(requester.nome_equipe))) {
    return { status: 403, error: 'Supervisores só podem reatribuir cards atualmente pertencentes à própria equipe.' };
  }

  return { requester, destination };
}
