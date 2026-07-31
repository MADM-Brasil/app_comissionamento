// src/lib/accessControl.ts

export const LEVELS = {
  NONE: 0,                // sem acesso
  ASSESSOR: 1,
  SUPERVISAO: 2,
  COORDENADOR: 3,
  ADMINISTRATIVO: 4,
} as const;

type Level = typeof LEVELS[keyof typeof LEVELS];

interface User {
  cargo?: string;
  nome_equipe?: string;
  email?: string;
  nome?: string;
  status?: string;         // necessário para verificar "desativado"
  [key: string]: any;
}

interface Permissions {
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

interface MenuItem {
  id: string;
  label: string;
  link: string;
}

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
  grupo?: string;               // compatibilidade
  nome_equipe?: string;
  menuItems: MenuItem[];
  filter: FilterRestrictions;
  accessLevel: string;
  group?: string;
  showTeamPage: boolean;
  showExportButton: boolean;
}

// ========== NOVA TABELA DE CARGOS ==========
const GROUP_MAPPING: Record<string, Level> = {
  // Nenhum acesso (Desc)
  'desativado': LEVELS.NONE,
  'assistente': LEVELS.NONE,
  'analista juridico': LEVELS.NONE,
  'gestor de projetos': LEVELS.NONE,
  'analista': LEVELS.NONE,
  'analista de discadora': LEVELS.NONE,

  // Assessor
  'assessor': LEVELS.ASSESSOR,
  'analista de pastas': LEVELS.ASSESSOR,

  // Supervisão
  'supervisor': LEVELS.SUPERVISAO,

  // Coordenador
  'coordenador': LEVELS.COORDENADOR,

  // Administrativo
  'salesops': LEVELS.ADMINISTRATIVO,
  'ceo': LEVELS.ADMINISTRATIVO,
  'analista de crm': LEVELS.ADMINISTRATIVO,
  'desenvolvedor': LEVELS.ADMINISTRATIVO,
  'diretora': LEVELS.ADMINISTRATIVO,
  'analista de dados': LEVELS.ADMINISTRATIVO,
  'desenvolvedor make': LEVELS.ADMINISTRATIVO,
};

const PERMISSIONS: Record<Level, FullPermissions> = {
  [LEVELS.NONE]: {
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
    description: 'Visualiza apenas seus próprios dados',
  },
  [LEVELS.SUPERVISAO]: {
    canAccessReports: true,
    canAccessConfiguration: true,
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
    canAccessReports: true,
    canAccessConfiguration: true,
    canViewTeam: true,
    canEditConfiguration: true,
    canEditBonus: false,
    canGenerateNextMonth: false,
    canExportData: true,
    filterLocked: false,
    lockedTeam: false,
    lockedCollaborator: false,
    description: 'Ajusta metas, não altera bônus, filtro livre',
  },
  [LEVELS.ADMINISTRATIVO]: {
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

export function getAccessLevel(cargo: string | undefined, status?: string): Level {
  // 1. Se status for "desativado", sem acesso
  if (status && normalize(status) === 'desativado') return LEVELS.NONE;

  // 2. Mapeia o cargo (case insensitive e sem espaços extras)
  if (!cargo) return LEVELS.NONE;
  const normalized = normalize(cargo);
  if (GROUP_MAPPING[normalized] !== undefined) {
    return GROUP_MAPPING[normalized];
  }
  console.warn(`Cargo não mapeado: "${cargo}", assumindo sem acesso`);
  return LEVELS.NONE;
}

function normalize(str: string): string {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
    grupo: user?.cargo,            // compatibilidade
    nome_equipe: user?.nome_equipe,
    canAccessReports: perms.canAccessReports as boolean,
    canAccessConfiguration: perms.canAccessConfiguration as boolean,
    canViewTeam: perms.canViewTeam as boolean,
    canEditConfiguration: perms.canEditConfiguration as boolean,
    canEditBonus: perms.canEditBonus as boolean,
    canGenerateNextMonth: perms.canGenerateNextMonth as boolean,
    canExportData: perms.canExportData as boolean,
    filterLocked: perms.filterLocked as boolean,
    lockedTeam: perms.lockedTeam as boolean,
    lockedCollaborator: perms.lockedCollaborator as boolean,
    description: perms.description as string,
  };
}

function getLevelName(level: Level): string {
  const names: Record<Level, string> = {
    [LEVELS.NONE]: 'SEM ACESSO',
    [LEVELS.ASSESSOR]: 'ASSESSOR',
    [LEVELS.SUPERVISAO]: 'SUPERVISAO',
    [LEVELS.COORDENADOR]: 'COORDENADOR',
    [LEVELS.ADMINISTRATIVO]: 'ADMINISTRATIVO',
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
  return [];  // NONE vê nada
}

export function getFilterRestrictions(user?: User): FilterRestrictions {
  if (!user) {
    return { lockTeam: false, teamName: null, lockCollaborator: false, collaboratorName: null };
  }
  const level = getAccessLevel(user.cargo, user.status);
  if (level === LEVELS.ASSESSOR) {
    return {
      lockTeam: true,
      teamName: user.nome_equipe ?? null,
      lockCollaborator: true,
      collaboratorName: user.nome ?? null,
    };
  }
  if (level === LEVELS.SUPERVISAO) {
    return {
      lockTeam: true,
      teamName: user.nome_equipe ?? null,
      lockCollaborator: false,
      collaboratorName: null,
    };
  }
  return { lockTeam: false, teamName: null, lockCollaborator: false, collaboratorName: null };
}

export function getUIConfig(currentUser?: User): UIConfig {
  const perms = getUserPermissions(currentUser);
  const filterRestrictions = getFilterRestrictions(currentUser);

  return {
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
  canViewTeam: boolean;
  canAccessReports: boolean;
  canAccessConfiguration: boolean;
}): MenuItem[] {
  const items: MenuItem[] = [];
  items.push({ id: 'dashboard', label: 'Dashboard', link: '/' });
  if (permissions.canViewTeam) {
    items.push({ id: 'team', label: 'Equipe', link: '/equipe' });
  }
  if (permissions.canAccessReports) {
    items.push({ id: 'reports', label: 'Relatórios', link: '/relatorios' });
  }
  if (permissions.canAccessConfiguration) {
    items.push({ id: 'configuration', label: 'Configurações', link: '/configuracoes' });
  }
  return items;
}

export const accessControl = {
  getAccessLevel,
  hasPermission,
  getUserPermissions,
  filterTeamData,
  getFilterRestrictions,
  getUIConfig,
};