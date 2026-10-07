// src/lib/accessControl.ts
// Alinhado com backend/services/access-control.js.
// Se alterar CARGO_LEVELS aqui, replique no backend.

export const LEVELS = {
  NONE: 0,
  ASSESSOR: 1,
  SUPERVISAO: 2,
  COORDENADOR: 3,
  ADMINISTRATIVO: 4,
  SUPER_ADMIN: 5,
} as const;

type Level = typeof LEVELS[keyof typeof LEVELS];

interface User {
  cargo?: string;
  nome_equipe?: string;
  email?: string;
  nome?: string;
  status?: string;
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
  // Nenhum acesso
  'desativado':              LEVELS.NONE,
  'assistente':              LEVELS.NONE,
  'analista juridico':       LEVELS.NONE,
  'gestor de projetos':      LEVELS.NONE,
  'analista':                LEVELS.NONE,

  // Assessor
  'assessor':                LEVELS.ASSESSOR,
  'analista de pastas':      LEVELS.ASSESSOR,

  // Supervisão
  'supervisor':              LEVELS.SUPERVISAO,
  'Supervisor':              LEVELS.SUPERVISAO,

  // Coordenador
  'coordenador':             LEVELS.COORDENADOR,

  // Administrativo
  'salesops':                LEVELS.ADMINISTRATIVO,
  'analista de crm':         LEVELS.ADMINISTRATIVO,
  'analista de dados':       LEVELS.ADMINISTRATIVO,
  'analista de discadora':   LEVELS.ADMINISTRATIVO,
  'desenvolvedor make':      LEVELS.ADMINISTRATIVO,
  'supervisor sales ops':    LEVELS.ADMINISTRATIVO,
  'administrativo':          LEVELS.ADMINISTRATIVO,
  'administrador':           LEVELS.ADMINISTRATIVO,

  // Super Admin / visão liberada
  'desenvolvedor':           LEVELS.SUPER_ADMIN, 
  'diretora':                LEVELS.SUPER_ADMIN,
  'ceo':                     LEVELS.SUPER_ADMIN,
  'coordenador sales ops':   LEVELS.SUPER_ADMIN,
};

// Cópia mutável em runtime (permite setCargoLevel no client se precisar)
let cargoLevels: Record<string, Level> = { ...CARGO_LEVELS };

// ─────────────────────────────────────────────────────────────
// Override individual de cargo (mesma API do backend)
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
    canAccessDashboard: false,
    canAccessComissoes: false,
    canAccessRanking: false,
    canAccessReports: false,
    canAccessConfiguration: false,
    canViewTeam: false,
    canEditConfiguration: false,
    canEditBonus: false,
    canGenerateNextMonth: false,
    canExportData: false,
    filterLocked: true,
    lockedTeam: true,
    lockedCollaborator: true,
    description: 'Sem acesso',
  },
  [LEVELS.ASSESSOR]: {
    canAccessDashboard: true,
    canAccessComissoes: true,
    canAccessRanking: true,
    canAccessReports: false,
    canAccessConfiguration: false,
    canViewTeam: false,
    canEditConfiguration: false,
    canEditBonus: false,
    canGenerateNextMonth: false,
    canExportData: false,
    filterLocked: true,
    lockedTeam: true,
    lockedCollaborator: true,
    description: 'Visualiza seus próprios dados',
  },
  [LEVELS.SUPERVISAO]: {
    canAccessDashboard: false,
    canAccessComissoes: false,
    canAccessRanking: false,
    canAccessReports: false,
    canAccessConfiguration: false,
    canViewTeam: true,
    canEditConfiguration: false,
    canEditBonus: false,
    canGenerateNextMonth: false,
    canExportData: false,
    filterLocked: true,
    lockedTeam: true,
    lockedCollaborator: false,
    description: 'Visualiza dados da equipe; vê configurações sem editar',
  },
  [LEVELS.COORDENADOR]: {
    canAccessDashboard: false,
    canAccessComissoes: false,
    canAccessRanking: false,
    canAccessReports: false,
    canAccessConfiguration: false,
    canViewTeam: false,
    canEditConfiguration: false,
    canEditBonus: false,
    canGenerateNextMonth: false,
    canExportData: true,
    filterLocked: false,
    lockedTeam: false,
    lockedCollaborator: false,
    description: 'Ajusta metas, não altera bônus, filtro livre',
  },
  [LEVELS.ADMINISTRATIVO]: {
    canAccessDashboard: true,
    canAccessComissoes: true,
    canAccessRanking: true,
    canAccessReports: true,
    canAccessConfiguration: true,
    canViewTeam: true,
    canEditConfiguration: true,
    canEditBonus: true,
    canGenerateNextMonth: true,
    canExportData: true,
    filterLocked: false,
    lockedTeam: false,
    lockedCollaborator: false,
    description: 'Acesso total',
  },
  [LEVELS.SUPER_ADMIN]: {
    canAccessDashboard: true,
    canAccessComissoes: true,
    canAccessRanking: true,
    canAccessReports: true,
    canAccessConfiguration: true,
    canViewTeam: true,
    canEditConfiguration: true,
    canEditBonus: true,
    canGenerateNextMonth: true,
    canExportData: true,
    filterLocked: false,
    lockedTeam: false,
    lockedCollaborator: false,
    description: 'Acesso total',
  },
};

function normalize(str: string): string {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────
export function getAccessLevel(cargo: string | undefined, status?: string): Level {
  if (status && normalize(status) === 'desativado') return LEVELS.NONE;
  if (!cargo) return LEVELS.NONE;
  const key = normalize(cargo);
  const level = cargoLevels[key];
  if (level !== undefined) return level;
  console.warn(`Cargo não mapeado: "${cargo}", assumindo NONE`);
  return LEVELS.NONE;
}

export function hasPermission(user: User, permission: keyof Permissions): boolean {
  if (!user) return false;
  const level = getAccessLevel(user.cargo, user.status);
  return PERMISSIONS[level]?.[permission] ?? false;
}

export function getUserPermissions(user?: User) {
  const level = getAccessLevel(user?.cargo, user?.status);
  const perms = PERMISSIONS[level];
  return {
    level,
    levelName: getLevelName(level),
    cargo: user?.cargo,
    grupo: user?.cargo,
    nome_equipe: user?.nome_equipe,
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
  };
}

function getLevelName(level: Level): string {
  const names: Record<Level, string> = {
    [LEVELS.NONE]: 'SEM ACESSO',
    [LEVELS.ASSESSOR]: 'ASSESSOR',
    [LEVELS.SUPERVISAO]: 'SUPERVISAO',
    [LEVELS.COORDENADOR]: 'COORDENADOR',
    [LEVELS.ADMINISTRATIVO]: 'ADMINISTRATIVO',
    [LEVELS.SUPER_ADMIN]: 'SUPER ADMIN',
  };
  return names[level] || 'SEM ACESSO';
}

export function filterTeamData(teamMembers: User[], currentUser?: User): User[] {
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

export function getFilterRestrictions(user?: User): FilterRestrictions {
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

export function getUIConfig(currentUser?: User): UIConfig {
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
  canAccessDashboard: boolean;
  canAccessComissoes: boolean;
  canAccessRanking: boolean;
  canViewTeam: boolean;
  canAccessReports: boolean;
  canAccessConfiguration: boolean;
}): MenuItem[] {
  const items: MenuItem[] = [];
  if (permissions.canAccessDashboard) items.push({ id: 'dashboard', label: 'Home', link: '/' });
  if (permissions.canAccessComissoes) items.push({ id: 'comissoes', label: 'Comissões', link: '/comissoes' });
  if (permissions.canViewTeam || permissions.canAccessReports) {
    items.push({ id: 'dashboard-group', label: 'Dashboard', link: '' });
  }
  if (permissions.canAccessRanking) items.push({ id: 'ranking', label: 'Ranking', link: '/ranking' });
  if (permissions.canAccessConfiguration) items.push({ id: 'configuration', label: 'Configurações', link: '/configuration' });
  return items;
}

export const accessControl = {
  LEVELS,
  getAccessLevel,
  hasPermission,
  getUserPermissions,
  filterTeamData,
  getFilterRestrictions,
  getUIConfig,
  // Override por cargo:
  setCargoLevel,
  getCargoLevel,
  resetCargoLevel,
  listCargoLevels,
};