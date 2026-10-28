// src/lib/accessControl.ts
// Alinhado com backend/services/access-control.js.
// Se alterar CARGO_LEVELS aqui, replique no backend.

export const LEVELS = {
  NONE: 0,
  JURIDICO: 1,        // [NOVO] acesso apenas à Busca Cliente do Suporte
  ASSESSOR: 2,
  SUPERVISAO: 3,
  COORDENADOR: 4,
  ADMINISTRATIVO: 5,
  SUPER_ADMIN: 6,
} as const;

type Level = typeof LEVELS[keyof typeof LEVELS];

interface User {
  cargo?: string;
  nome_equipe?: string;
  email?: string;
  nome?: string;
  status?: string;
  unidade_id?: number | string | null;
  [key: string]: any;
}

export interface Permissions {
  canAccessDashboard: boolean;
  canAccessComissoes: boolean;
  canAccessRanking: boolean;
  canAccessReports: boolean;
  canAccessConfiguration: boolean;
  canViewTeam: boolean;
  canEditConfiguration: boolean;
  canEditBonus: boolean;
  canGenerateNextMonth: boolean;
  canExportData: boolean;
  filterLocked: boolean;
  lockedTeam: boolean;
  lockedCollaborator: boolean;

  // [NOVO] flags de Suporte
  canAccessSuporte: boolean;
  canAccessSuporteBuscaCliente: boolean;
  canAccessSuporteMovimentar: boolean;
  canAccessSuporteReportar: boolean;
  canAccessSuporteSalesOps: boolean;
}

interface FullPermissions extends Permissions {
  description: string;
}

interface MenuItem { id: string; label: string; link: string; }

interface FilterRestrictions {
  lockTeam: boolean;
  teamName: string | null;
  lockCollaborator: boolean;
  collaboratorName: string | null;
}

interface UIConfig extends FullPermissions {
  level: Level;
  levelName: string;
  cargo?: string;
  grupo?: string;
  nome_equipe?: string;
  menuItems: MenuItem[];
  filter: FilterRestrictions;
  accessLevel: string;
  group?: string;
  showTeamPage: boolean;
  showExportButton: boolean;
}

// ─────────────────────────────────────────────────────────────
// FONTE ÚNICA DE VERDADE: cargo (normalizado) → nível
// Mantenha IDÊNTICO ao backend/services/access-control.js.
// ─────────────────────────────────────────────────────────────
const CARGO_LEVELS: Record<string, Level> = {
  // ── Jurídico ──────────────────────────────────────────────
  // Acesso APENAS à página /suporte → aba "Busca Cliente".
  'analista juridico':       LEVELS.JURIDICO,
  'analista':                LEVELS.JURIDICO,
  'coordenador juridico':    LEVELS.JURIDICO,
  'supervisor juridico':     LEVELS.JURIDICO,
  'assistente sac':          LEVELS.JURIDICO,
  'supervisor sac':          LEVELS.JURIDICO,

  // ── Nenhum acesso ─────────────────────────────────────────
  'desativado':              LEVELS.NONE,
  'gestor de projetos':      LEVELS.NONE,

  // ── Assessor ──────────────────────────────────────────────
  'assessor':                LEVELS.ASSESSOR,
  'analista de pastas':      LEVELS.ASSESSOR,

  // ── Supervisão ────────────────────────────────────────────
  'supervisor':              LEVELS.SUPERVISAO,
  'Supervisor':              LEVELS.SUPERVISAO,
  'assistente':              LEVELS.SUPERVISAO,

  // ── Coordenador ───────────────────────────────────────────
  'coordenador':             LEVELS.COORDENADOR,

  // ── Administrativo ────────────────────────────────────────
  'salesops':                LEVELS.ADMINISTRATIVO,
  'analista de crm':         LEVELS.ADMINISTRATIVO,
  'analista de dados':       LEVELS.ADMINISTRATIVO,
  'analista de discadora':   LEVELS.ADMINISTRATIVO,
  'desenvolvedor make':      LEVELS.ADMINISTRATIVO,
  'supervisor sales ops':    LEVELS.ADMINISTRATIVO,
  'administrativo':          LEVELS.ADMINISTRATIVO,
  'administrador':           LEVELS.ADMINISTRATIVO,

  // ── Super Admin ───────────────────────────────────────────
  'desenvolvedor':           LEVELS.SUPER_ADMIN,
  'diretora':                LEVELS.SUPER_ADMIN,
  'ceo':                     LEVELS.SUPER_ADMIN,
  'coordenador sales ops':   LEVELS.SUPER_ADMIN,
};

let cargoLevels: Record<string, Level> = { ...CARGO_LEVELS };

// ─────────────────────────────────────────────────────────────
// Override individual de cargo
// ─────────────────────────────────────────────────────────────
export function setCargoLevel(cargo: string, level: Level) {
  const key = normalize(cargo);
  cargoLevels[key] = level;
  console.log(`[accessControl] setCargoLevel("${cargo}") → ${level}`);
}

export function getCargoLevel(cargo: string): Level | undefined {
  return cargoLevels[normalize(cargo)];
}

export function resetCargoLevel(cargo: string) {
  const key = normalize(cargo);
  const def = CARGO_LEVELS[key];
  if (def === undefined) delete cargoLevels[key];
  else cargoLevels[key] = def;
}

export function listCargoLevels(): Record<string, Level> {
  return { ...cargoLevels };
}

// ─────────────────────────────────────────────────────────────
// Permissões por nível (idênticas ao backend)
// ─────────────────────────────────────────────────────────────
const PERMISSIONS: Record<Level, FullPermissions> = {
  [LEVELS.NONE]: {
    canAccessDashboard: false, canAccessComissoes: false, canAccessRanking: false,
    canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
    canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
    canExportData: false, filterLocked: true, lockedTeam: true, lockedCollaborator: true,
    description: 'Sem acesso',

    canAccessSuporte: false,
    canAccessSuporteBuscaCliente: false,
    canAccessSuporteMovimentar: false,
    canAccessSuporteReportar: false,
    canAccessSuporteSalesOps: false,
  },

  // ── [NOVO] JURIDICO ────────────────────────────────────────
  [LEVELS.JURIDICO]: {
    canAccessDashboard: false, canAccessComissoes: false, canAccessRanking: false,
    canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
    canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
    canExportData: false, filterLocked: true, lockedTeam: true, lockedCollaborator: true,
    description: 'Acesso somente à Busca Cliente do Suporte',

    canAccessSuporte: true,
    canAccessSuporteBuscaCliente: true,
    canAccessSuporteMovimentar: false,
    canAccessSuporteReportar: false,
    canAccessSuporteSalesOps: false,
  },

  [LEVELS.ASSESSOR]: {
    canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: true,
    canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
    canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
    canExportData: false, filterLocked: true, lockedTeam: true, lockedCollaborator: true,
    description: 'Visualiza seus próprios dados',

    canAccessSuporte: false,
    canAccessSuporteBuscaCliente: false,
    canAccessSuporteMovimentar: false,
    canAccessSuporteReportar: false,
    canAccessSuporteSalesOps: false,
  },

  [LEVELS.SUPERVISAO]: {
    canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: false,
    canAccessReports: false, canAccessConfiguration: false, canViewTeam: true,
    canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
    canExportData: false, filterLocked: true, lockedTeam: true, lockedCollaborator: false,
    description: 'Visualiza dados da equipe; vê configurações sem editar',

    canAccessSuporte: true,
    canAccessSuporteBuscaCliente: true,
    canAccessSuporteMovimentar: true,
    canAccessSuporteReportar: true,
    canAccessSuporteSalesOps: false,
  },

  [LEVELS.COORDENADOR]: {
    canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: false,
    canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
    canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
    canExportData: true, filterLocked: false, lockedTeam: false, lockedCollaborator: false,
    description: 'Ajusta metas, não altera bônus, filtro livre',

    canAccessSuporte: true,
    canAccessSuporteBuscaCliente: true,
    canAccessSuporteMovimentar: true,
    canAccessSuporteReportar: true,
    canAccessSuporteSalesOps: false,
  },

  [LEVELS.ADMINISTRATIVO]: {
    canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: true,
    canAccessReports: true, canAccessConfiguration: true, canViewTeam: true,
    canEditConfiguration: true, canEditBonus: true, canGenerateNextMonth: true,
    canExportData: true, filterLocked: false, lockedTeam: false, lockedCollaborator: false,
    description: 'Acesso total',

    canAccessSuporte: true,
    canAccessSuporteBuscaCliente: true,
    canAccessSuporteMovimentar: true,
    canAccessSuporteReportar: true,
    canAccessSuporteSalesOps: true,
  },

  [LEVELS.SUPER_ADMIN]: {
    canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: true,
    canAccessReports: true, canAccessConfiguration: true, canViewTeam: true,
    canEditConfiguration: true, canEditBonus: true, canGenerateNextMonth: true,
    canExportData: true, filterLocked: false, lockedTeam: false, lockedCollaborator: false,
    description: 'Acesso total',

    canAccessSuporte: true,
    canAccessSuporteBuscaCliente: true,
    canAccessSuporteMovimentar: true,
    canAccessSuporteReportar: true,
    canAccessSuporteSalesOps: true,
  },
};

function normalize(str: string): string {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─────────────────────────────────────────────────────────────
// RESOLUÇÃO DO "USUÁRIO DE ACESSO"
// ─────────────────────────────────────────────────────────────
export function resolveAccessUser(
  user: any,
  collaborators: any[] | null | undefined,
): User | null {
  if (!user) return null;

  const email = String(user.email || '').toLowerCase().trim();
  const match =
    email && Array.isArray(collaborators)
      ? collaborators.find(
          (c: any) => String(c?.email || '').toLowerCase().trim() === email,
        )
      : undefined;

  return {
    ...(user as User),
    nome_equipe:
      user.nome_equipe ??
      user.nomeEquipe ??
      user.equipeNome ??
      (match as any)?.equipeNome ??
      (match as any)?.nome_equipe ??
      (match as any)?.nomeEquipe ??
      null,
    unidade_id:
      user.unidade_id ??
      user.unidadeId ??
      (match as any)?.unidadeId ??
      (match as any)?.unidade_id ??
      null,
  };
}

// ─────────────────────────────────────────────────────────────
// Regra Home/Comissões:
//   (assessor OU supervisor OU coordenador) da UNIDADE 3
//   OU (assessor OU supervisor OU coordenador) de uma EQUIPE
//      liberada em HOME_COMISSOES_ALLOWED_TEAM_NAMES
//   OU nível >= ADMINISTRATIVO (qualquer unidade)
// ─────────────────────────────────────────────────────────────
export const HOME_COMISSOES_ALLOWED_UNIT = 3;
export const HOME_COMISSOES_ALLOWED_LEVELS: Level[] = [
  LEVELS.ASSESSOR,
  LEVELS.SUPERVISAO,
  LEVELS.COORDENADOR,
];

export const HOME_COMISSOES_ALLOWED_TEAM_NAMES: readonly string[] = [
  'Equipe Felipe',
];
const HOME_COMISSOES_ALLOWED_TEAMS = new Set(
  HOME_COMISSOES_ALLOWED_TEAM_NAMES.map(normalize),
);

// ─────────────────────────────────────────────────────────────
// [NOVO] Bloqueio individual da página de Comissões
// ------------------------------------------------------------
// Lista de e-mails que NÃO podem acessar /comissoes mesmo
// estando em HOME_COMISSOES_ALLOWED_TEAM_NAMES (ou em qualquer
// outra regra que liberaria a página).
//
// ⚠️ Substitua o e-mail de exemplo pelo e-mail REAL do supervisor
//    da Equipe Felipe que deve ser bloqueado. A comparação usa
//    normalize() (trim + lowercase), então o case não importa.
//
// Comentário acima dele(a) no banco? Adicione o e-mail real aqui.
// ─────────────────────────────────────────────────────────────
export const COMISSOES_BLOCKED_EMAILS: readonly string[] = [
  'wallace.batista@madmbrasil.com.br', // ← TROQUE PELO E-MAIL REAL
];
const COMISSOES_BLOCKED_EMAILS_SET = new Set(
  COMISSOES_BLOCKED_EMAILS.map(normalize),
);

/** Retorna `true` quando o e-mail do usuário está em COMISSOES_BLOCKED_EMAILS. */
export function isComissoesBlockedByEmail(user?: User | null): boolean {
  if (!user?.email) return false;
  return COMISSOES_BLOCKED_EMAILS_SET.has(normalize(user.email));
}

/** Retorna `true` quando o usuário pertence a uma equipe liberada. */
export function isHomeComissoesTeam(user?: User | null): boolean {
  if (!user) return false;
  const team = normalize(user.nome_equipe || '');
  if (!team) return false;
  return HOME_COMISSOES_ALLOWED_TEAMS.has(team);
}

/** (Assessor OU supervisor OU coordenador) E (da unidade 3 OU de equipe liberada). */
export function isUnit3HomeComissoesUser(user?: User | null): boolean {
  if (!user) return false;
  const level = getAccessLevel(user.cargo, user.status);
  if (!HOME_COMISSOES_ALLOWED_LEVELS.includes(level)) return false;
  const unidade = user.unidade_id != null ? Number(user.unidade_id) : null;
  if (unidade === HOME_COMISSOES_ALLOWED_UNIT) return true;
  return isHomeComissoesTeam(user);
}

/** Alias retrocompatível. */
export const isUnit3AssessorOrSupervisor = isUnit3HomeComissoesUser;

/**
 * Regra consolidada: quem pode ver Home e Comissões.
 * (Obs.: esta função NÃO aplica COMISSOES_BLOCKED_EMAILS — o bloqueio
 *  individual é aplicado em getUserPermissions, que é o ponto que
 *  alimenta o guard e o menu.)
 */
export function canSeeHomeComissoes(user?: User | null): boolean {
  if (!user) return false;
  const level = getAccessLevel(user.cargo, user.status);
  if (level >= LEVELS.ADMINISTRATIVO) return true;
  return isUnit3HomeComissoesUser(user);
}

/**
 * Rota inicial recomendada após o login:
 * - Assessor/Supervisor/Coordenador da UNIDADE 3 (ou equipe liberada) → "/home"
 * - JURIDICO → "/suporte"
 * - Supervisor fora da UNIDADE 3 / fora das equipes liberadas → "/suporte"
 * - Demais → "/"
 *
 * ⚠️ Usuários em COMISSOES_BLOCKED_EMAILS continuam caindo em "/home"
 *    (Home não é bloqueada), mas o item "Comissões" some do menu e a
 *    rota /comissoes é bloqueada pelo guard.
 */
export function getDefaultLandingPage(user?: User | null): string {
  if (!user) return "/login";
  if (isUnit3HomeComissoesUser(user)) return "/home";
  const level = getAccessLevel(user.cargo, user.status);
  if (level === LEVELS.JURIDICO)   return "/suporte";
  if (level === LEVELS.SUPERVISAO) return "/suporte";
  return "/";
}

// ============================================================
//  RESTRIÇÃO DE NAVEGAÇÃO — ASSESSOR DA UNIDADE 3 (OU EQUIPE LIBERADA)
// ============================================================
export const RESTRICTED_ASSESSOR_UNITS: readonly number[] = [HOME_COMISSOES_ALLOWED_UNIT];

export const RESTRICTED_ASSESSOR_ALLOWED_PATHS: readonly string[] = [
  "/home",
  "/comissoes",
];

export function isAssessorRestrito(user?: User | null): boolean {
  if (!user) return false;
  const level = getAccessLevel(user.cargo, user.status);
  if (level !== LEVELS.ASSESSOR) return false;
  const unidade = user.unidade_id != null ? Number(user.unidade_id) : null;
  if (unidade != null && RESTRICTED_ASSESSOR_UNITS.includes(unidade)) return true;
  return isHomeComissoesTeam(user);
}

export function canAccessPathForRestrictedAssessor(
  user: User | null | undefined,
  path: string
): boolean {
  if (!isAssessorRestrito(user)) return true;
  return RESTRICTED_ASSESSOR_ALLOWED_PATHS.includes(path);
}

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────
export function getAccessLevel(
  cargo: string | undefined | null,
  status?: string
): Level {
  if (status && normalize(status) === 'desativado') return LEVELS.NONE;
  if (!cargo) return LEVELS.NONE;
  const key = normalize(cargo);
  const level = cargoLevels[key];
  if (level !== undefined) return level;
  console.warn(`Cargo não mapeado: "${cargo}", assumindo NONE`);
  return LEVELS.NONE;
}

export function isJuridico(user?: User | null): boolean {
  if (!user) return false;
  return getAccessLevel(user.cargo, user.status) === LEVELS.JURIDICO;
}

export function hasPermission(
  user: User | null | undefined,
  permission: keyof Permissions
): boolean {
  if (!user) return false;
  const perms = getUserPermissions(user);
  return Boolean((perms as any)[permission]);
}

export function getUserPermissions(user?: User | null) {
  const level = getAccessLevel(user?.cargo, user?.status);
  const perms = PERMISSIONS[level];

  const allowHomeComissoes = canSeeHomeComissoes(user);
  const restrito = isAssessorRestrito(user);

  // [NOVO] Bloqueio individual da página de Comissões.
  const bloqueadoComissoes = isComissoesBlockedByEmail(user);

  return {
    level,
    levelName: getLevelName(level),
    cargo: user?.cargo,
    grupo: user?.cargo,
    nome_equipe: user?.nome_equipe,
    unidade_id: user?.unidade_id,

    canAccessDashboard: perms.canAccessDashboard && allowHomeComissoes,

    // [NOVO] canAccessComissoes agora respeita a lista de bloqueio.
    canAccessComissoes:
      perms.canAccessComissoes && allowHomeComissoes && !bloqueadoComissoes,

    canAccessRanking: perms.canAccessRanking && !restrito,

    canAccessReports: perms.canAccessReports,
    canAccessConfiguration: perms.canAccessConfiguration,
    canViewTeam: perms.canViewTeam,
    canEditConfiguration: perms.canEditConfiguration,
    canEditBonus: perms.canEditBonus,
    canGenerateNextMonth: perms.canGenerateNextMonth,
    canExportData: perms.canExportData,
    filterLocked: perms.filterLocked,
    lockedTeam: perms.lockedTeam,
    lockedCollaborator: perms.lockedCollaborator,
    description: perms.description,

    // Suporte
    canAccessSuporte: perms.canAccessSuporte,
    canAccessSuporteBuscaCliente: perms.canAccessSuporteBuscaCliente,
    canAccessSuporteMovimentar: perms.canAccessSuporteMovimentar,
    canAccessSuporteReportar: perms.canAccessSuporteReportar,
    canAccessSuporteSalesOps: perms.canAccessSuporteSalesOps,
  };
}

function getLevelName(level: Level): string {
  const names: Record<Level, string> = {
    [LEVELS.NONE]: 'SEM ACESSO',
    [LEVELS.JURIDICO]: 'JURIDICO',
    [LEVELS.ASSESSOR]: 'ASSESSOR',
    [LEVELS.SUPERVISAO]: 'SUPERVISAO',
    [LEVELS.COORDENADOR]: 'COORDENADOR',
    [LEVELS.ADMINISTRATIVO]: 'ADMINISTRATIVO',
    [LEVELS.SUPER_ADMIN]: 'SUPER ADMIN',
  };
  return names[level] || 'SEM ACESSO';
}

export function filterTeamData(
  teamMembers: User[],
  currentUser?: User | null
): User[] {
  if (!currentUser || !teamMembers) return [];
  const userLevel = getAccessLevel(currentUser.cargo, currentUser.status);
  if (userLevel >= LEVELS.COORDENADOR) return teamMembers;
  if (userLevel === LEVELS.SUPERVISAO) {
    return teamMembers.filter(m => m.nome_equipe === currentUser.nome_equipe);
  }
  if (userLevel === LEVELS.ASSESSOR) {
    return teamMembers.filter(m => m.email === currentUser.email);
  }
  return [];
}

export function getFilterRestrictions(user?: User | null): FilterRestrictions {
  if (!user) {
    return { lockTeam: false, teamName: null, lockCollaborator: false, collaboratorName: null };
  }
  const level = getAccessLevel(user.cargo, user.status);
  if (level === LEVELS.ASSESSOR) {
    return { lockTeam: true, teamName: user.nome_equipe ?? null, lockCollaborator: true, collaboratorName: user.nome ?? null };
  }
  if (level === LEVELS.SUPERVISAO) {
    return { lockTeam: true, teamName: user.nome_equipe ?? null, lockCollaborator: false, collaboratorName: null };
  }
  return { lockTeam: false, teamName: null, lockCollaborator: false, collaboratorName: null };
}

export function getUIConfig(currentUser?: User | null): UIConfig {
  const perms = getUserPermissions(currentUser);
  const filterRestrictions = getFilterRestrictions(currentUser);

  return {
    canAccessDashboard: perms.canAccessDashboard,
    canAccessComissoes: perms.canAccessComissoes,
    canAccessRanking: perms.canAccessRanking,
    canAccessReports: perms.canAccessReports,
    canAccessConfiguration: perms.canAccessConfiguration,
    canViewTeam: perms.canViewTeam,
    canEditConfiguration: perms.canEditConfiguration,
    canEditBonus: perms.canEditBonus,
    canGenerateNextMonth: perms.canGenerateNextMonth,
    canExportData: perms.canExportData,
    filterLocked: perms.filterLocked,
    lockedTeam: perms.lockedTeam,
    lockedCollaborator: perms.lockedCollaborator,
    description: perms.description,

    canAccessSuporte: perms.canAccessSuporte,
    canAccessSuporteBuscaCliente: perms.canAccessSuporteBuscaCliente,
    canAccessSuporteMovimentar: perms.canAccessSuporteMovimentar,
    canAccessSuporteReportar: perms.canAccessSuporteReportar,
    canAccessSuporteSalesOps: perms.canAccessSuporteSalesOps,

    level: perms.level,
    levelName: perms.levelName,
    cargo: perms.cargo,
    grupo: perms.grupo,
    nome_equipe: perms.nome_equipe,
    filter: filterRestrictions,
    accessLevel: perms.levelName,
    group: currentUser?.cargo,
    showTeamPage: perms.canViewTeam,
    showExportButton: perms.canExportData,
    menuItems: getMenuItems(perms),
  } as UIConfig;
}

function getMenuItems(permissions: {
  level: Level;
  canAccessDashboard: boolean;
  canAccessComissoes: boolean;
  canAccessRanking: boolean;
  canViewTeam: boolean;
  canAccessReports: boolean;
  canAccessConfiguration: boolean;
  canAccessSuporte: boolean;
}): MenuItem[] {
  const items: MenuItem[] = [];

  if (permissions.level === LEVELS.JURIDICO) {
    if (permissions.canAccessSuporte) {
      items.push({ id: 'suporte', label: 'Suporte', link: '/suporte' });
    }
    return items;
  }

  if (permissions.canAccessDashboard) items.push({ id: 'dashboard', label: 'Home', link: '/' });
  // O item de Comissões só aparece se canAccessComissoes === true
  // (o que já leva em conta COMISSOES_BLOCKED_EMAILS).
  if (permissions.canAccessComissoes) items.push({ id: 'comissoes', label: 'Comissões', link: '/comissoes' });
  if (permissions.canViewTeam || permissions.canAccessReports) {
    items.push({ id: 'dashboard-group', label: 'Dashboard', link: '' });
  }
  if (permissions.canAccessRanking) items.push({ id: 'ranking', label: 'Ranking', link: '/ranking' });
  if (permissions.canAccessSuporte) items.push({ id: 'suporte', label: 'Suporte', link: '/suporte' });
  if (permissions.canAccessConfiguration) items.push({ id: 'configuration', label: 'Configurações', link: '/configuration' });
  return items;
}

// ─────────────────────────────────────────────────────────────
// Objeto agregador
// ─────────────────────────────────────────────────────────────
export const accessControl = {
  LEVELS,
  getAccessLevel,
  hasPermission,
  getUserPermissions,
  filterTeamData,
  getFilterRestrictions,
  getUIConfig,
  setCargoLevel,
  getCargoLevel,
  resetCargoLevel,
  listCargoLevels,

  resolveAccessUser,

  isUnit3HomeComissoesUser,
  isUnit3AssessorOrSupervisor,
  isHomeComissoesTeam,
  canSeeHomeComissoes,
  getDefaultLandingPage,
  HOME_COMISSOES_ALLOWED_UNIT,
  HOME_COMISSOES_ALLOWED_LEVELS,
  HOME_COMISSOES_ALLOWED_TEAM_NAMES,

  isAssessorRestrito,
  canAccessPathForRestrictedAssessor,
  RESTRICTED_ASSESSOR_UNITS,
  RESTRICTED_ASSESSOR_ALLOWED_PATHS,

  isJuridico,

  isComissoesBlockedByEmail,
  COMISSOES_BLOCKED_EMAILS,
};