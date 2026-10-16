// backend/services/access-control.js
// Sistema de Controle de Acesso unificado (backend).
// Fonte única de verdade: CARGO_LEVELS.
//
// Para alterar o nível de um cargo individualmente em runtime:
//   import { accessControl } from './access-control.js';
//   accessControl.setCargoLevel('desenvolvedor', accessControl.LEVELS.SUPERVISAO);
//
// Para alterar permanentemente: edite o objeto CARGO_LEVELS abaixo.

import { pool } from './db.js';

class AccessControl {
  constructor() {
    this.LEVELS = Object.freeze({
      NONE: 0,
      ASSESSOR: 1,
      SUPERVISAO: 2,
      COORDENADOR: 3,
      ADMINISTRATIVO: 4,
      SUPER_ADMIN: 5,
    });

    // ─────────────────────────────────────────────────────────────
    // FONTE ÚNICA DE VERDADE: cargo (normalizado) → nível
    // ─────────────────────────────────────────────────────────────
    this.CARGO_LEVELS = {
      // Nenhum acesso
      'desativado':              this.LEVELS.NONE,
      'analista juridico':       this.LEVELS.NONE,
      'gestor de projetos':      this.LEVELS.NONE,
      'analista':                this.LEVELS.NONE,

      // Assessor
      'assessor':                this.LEVELS.ASSESSOR,
      'analista de pastas':      this.LEVELS.ASSESSOR,

      // Supervisão
      'supervisor':              this.LEVELS.SUPERVISAO,
      'Supervisor':              this.LEVELS.SUPERVISAO,
      'assistente':              this.LEVELS.SUPERVISAO,

      // Coordenador
      'coordenador':             this.LEVELS.COORDENADOR,

      // Administrativo
      'salesops':                this.LEVELS.ADMINISTRATIVO,
      'analista de crm':         this.LEVELS.ADMINISTRATIVO,
      'analista de dados':       this.LEVELS.ADMINISTRATIVO,
      'analista de discadora':   this.LEVELS.ADMINISTRATIVO,
      'desenvolvedor make':      this.LEVELS.ADMINISTRATIVO,
      'supervisor sales ops':    this.LEVELS.ADMINISTRATIVO,
      'administrativo':          this.LEVELS.ADMINISTRATIVO,
      'administrador':           this.LEVELS.ADMINISTRATIVO,

      // Super Admin
      'desenvolvedor':           this.LEVELS.SUPER_ADMIN,
      'diretora':                this.LEVELS.SUPER_ADMIN,
      'ceo':                     this.LEVELS.SUPER_ADMIN,
      'coordenador sales ops':   this.LEVELS.SUPER_ADMIN,
    };

    this.DEFAULT_CARGO_LEVELS = { ...this.CARGO_LEVELS };

    // Equipes reservadas — só supervisores da própria equipe direcionam.
    // (Chaves normalizadas.)
    this.RESERVED_DESTINATION_TEAMS = new Set([
      'equipe tatiane',
    ]);

    this.PERMISSIONS = {
      [this.LEVELS.NONE]: {
        canAccessDashboard: false, canAccessComissoes: false, canAccessRanking: false,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: false, filterLocked: true, lockedTeam: true,
        lockedCollaborator: true, description: 'Sem acesso',
      },
      [this.LEVELS.ASSESSOR]: {
        canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: true,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: false, filterLocked: true, lockedTeam: true,
        lockedCollaborator: true, description: 'Visualiza seus próprios dados',
      },
      [this.LEVELS.SUPERVISAO]: {
        canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: false,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: true,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: false, filterLocked: true, lockedTeam: true,
        lockedCollaborator: false,
        description: 'Visualiza dados da equipe; vê configurações sem editar',
      },
      [this.LEVELS.COORDENADOR]: {
        canAccessDashboard: false, canAccessComissoes: false, canAccessRanking: false,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: true, filterLocked: false, lockedTeam: false,
        lockedCollaborator: false,
        description: 'Ajusta metas, não altera bônus, filtro livre',
      },
      [this.LEVELS.ADMINISTRATIVO]: {
        canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: true,
        canAccessReports: true, canAccessConfiguration: true, canViewTeam: true,
        canEditConfiguration: true, canEditBonus: true, canGenerateNextMonth: true,
        canExportData: true, filterLocked: false, lockedTeam: false,
        lockedCollaborator: false, description: 'Acesso total',
      },
      [this.LEVELS.SUPER_ADMIN]: {
        canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: true,
        canAccessReports: true, canAccessConfiguration: true, canViewTeam: true,
        canEditConfiguration: true, canEditBonus: true, canGenerateNextMonth: true,
        canExportData: true, filterLocked: false, lockedTeam: false,
        lockedCollaborator: false, description: 'Acesso total',
      },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Regra Home/Comissões:
  //   (assessor OU supervisor) da UNIDADE 3
  //   OU nível >= ADMINISTRATIVO (qualquer unidade)
  // ─────────────────────────────────────────────────────────────
  get HOME_COMISSOES_ALLOWED_UNIT() {
    return 3;
  }

  get HOME_COMISSOES_ALLOWED_LEVELS() {
    return [this.LEVELS.ASSESSOR, this.LEVELS.SUPERVISAO];
  }

  /** Assessor OU supervisor E da unidade 3. */
  isUnit3AssessorOrSupervisor(user) {
    if (!user) return false;
    const level = this.getAccessLevel(user.cargo, user.status);
    if (!this.HOME_COMISSOES_ALLOWED_LEVELS.includes(level)) return false;
    const unidade = user.unidade_id != null ? Number(user.unidade_id) : null;
    return unidade === this.HOME_COMISSOES_ALLOWED_UNIT;
  }

  /**
   * Regra consolidada: quem pode ver Home e Comissões.
   * - Assessor/Supervisor da unidade 3 → SIM
   * - Administrativo ou Super Admin (qualquer unidade) → SIM
   * - Demais → NÃO
   */
  canSeeHomeComissoes(user) {
    if (!user) return false;
    const level = this.getAccessLevel(user.cargo, user.status);
    if (level >= this.LEVELS.ADMINISTRATIVO) return true;
    return this.isUnit3AssessorOrSupervisor(user);
  }

  /**
   * Rota inicial recomendada após o login:
   * - Assessor/Supervisor da UNIDADE 3 → "/home"
   * - Supervisor fora da UNIDADE 3 → "/suporte"
   * - Demais → "/" (comportamento anterior)
   */
  getDefaultLandingPage(user) {
    if (!user) return '/login';

    // 1) Assessor/Supervisor da unidade 3 → /home
    if (this.isUnit3AssessorOrSupervisor(user)) return '/home';

    // 2) Supervisor fora da unidade 3 → /suporte
    const level = this.getAccessLevel(user.cargo, user.status);
    if (level === this.LEVELS.SUPERVISAO) return '/suporte';

    // 3) Demais (admins, coordenadores, etc.) → /
    return '/';
  }

  normalize(str) {
    return String(str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  setCargoLevel(cargo, level) {
    if (typeof level !== 'number' || level < 0 || level > 5) {
      throw new Error(`Nível inválido para "${cargo}": ${level}. Use 0–5.`);
    }
    this.CARGO_LEVELS[this.normalize(cargo)] = level;
    console.log(`[accessControl] setCargoLevel("${cargo}") → ${level}`);
  }

  getCargoLevel(cargo) {
    return this.CARGO_LEVELS[this.normalize(cargo)];
  }

  resetCargoLevel(cargo) {
    const key = this.normalize(cargo);
    const def = this.DEFAULT_CARGO_LEVELS[key];
    if (def === undefined) delete this.CARGO_LEVELS[key];
    else this.CARGO_LEVELS[key] = def;
  }

  listCargoLevels() {
    return { ...this.CARGO_LEVELS };
  }

  getAccessLevel(cargo, status) {
    if (status && this.normalize(status) === 'desativado') return this.LEVELS.NONE;
    if (!cargo) return this.LEVELS.NONE;
    const key = this.normalize(cargo);
    const level = this.CARGO_LEVELS[key];
    if (level !== undefined) return level;
    console.warn(`Cargo não mapeado: "${cargo}", assumindo NONE`);
    return this.LEVELS.NONE;
  }

  isSupervisor(cargo, status) {
    return this.getAccessLevel(cargo, status) === this.LEVELS.SUPERVISAO;
  }

  isCoordinatorOrAbove(cargo, status) {
    return this.getAccessLevel(cargo, status) >= this.LEVELS.COORDENADOR;
  }

  isAdmin(cargo, status) {
    return this.getAccessLevel(cargo, status) >= this.LEVELS.ADMINISTRATIVO;
  }

  canAccessSupport(cargo, status) {
    return this.getAccessLevel(cargo, status) >= this.LEVELS.SUPERVISAO;
  }

  hasPermission(user, permission) {
    if (!user) return false;
    const level = this.getAccessLevel(user.cargo, user.status);
    return this.PERMISSIONS[level]?.[permission] ?? false;
  }

  getUserPermissions(user) {
    const level = this.getAccessLevel(user?.cargo, user?.status);
    const perms = this.PERMISSIONS[level];

    // Regra consolidada: assessor/supervisor u3 OU nível >= ADMINISTRATIVO
    const allowHomeComissoes = this.canSeeHomeComissoes(user);

    return {
      level,
      levelName: this.getLevelName(level),
      cargo: user?.cargo,
      grupo: user?.cargo,
      nome_equipe: user?.nome_equipe,
      unidade_id: user?.unidade_id,
      ...perms,
      canAccessDashboard: perms.canAccessDashboard && allowHomeComissoes,
      canAccessComissoes: perms.canAccessComissoes && allowHomeComissoes,
    };
  }

  getLevelName(level) {
    const names = {
      [this.LEVELS.NONE]: 'SEM ACESSO',
      [this.LEVELS.ASSESSOR]: 'ASSESSOR',
      [this.LEVELS.SUPERVISAO]: 'SUPERVISAO',
      [this.LEVELS.COORDENADOR]: 'COORDENADOR',
      [this.LEVELS.ADMINISTRATIVO]: 'ADMINISTRATIVO',
      [this.LEVELS.SUPER_ADMIN]: 'SUPER ADMIN',
    };
    return names[level] || 'SEM ACESSO';
  }

  filterTeamData(teamMembers, currentUser) {
    if (!currentUser || !teamMembers) return [];
    const userLevel = this.getAccessLevel(currentUser.cargo, currentUser.status);
    if (userLevel >= this.LEVELS.COORDENADOR) return teamMembers;
    if (userLevel === this.LEVELS.SUPERVISAO) {
      return teamMembers.filter(m => m.nome_equipe === currentUser.nome_equipe);
    }
    if (userLevel === this.LEVELS.ASSESSOR) {
      return teamMembers.filter(m => m.email === currentUser.email);
    }
    return [];
  }

  getFilterRestrictions(user) {
    if (!user) {
      return { lockTeam: false, teamName: null, lockCollaborator: false, collaboratorName: null };
    }
    const level = this.getAccessLevel(user.cargo, user.status);
    if (level === this.LEVELS.ASSESSOR) {
      return { lockTeam: true, teamName: user.nome_equipe ?? null, lockCollaborator: true, collaboratorName: user.nome ?? null };
    }
    if (level === this.LEVELS.SUPERVISAO) {
      return { lockTeam: true, teamName: user.nome_equipe ?? null, lockCollaborator: false, collaboratorName: null };
    }
    return { lockTeam: false, teamName: null, lockCollaborator: false, collaboratorName: null };
  }

  getUIConfig(currentUser) {
    const permissions = this.getUserPermissions(currentUser);
    const filterRestrictions = this.getFilterRestrictions(currentUser);
    return {
      ...permissions,
      filter: filterRestrictions,
      accessLevel: permissions.levelName,
      group: currentUser?.cargo,
      showTeamPage: permissions.canViewTeam,
      showExportButton: permissions.canExportData,
      menuItems: this.getMenuItems(permissions),
    };
  }

  getMenuItems(permissions) {
    const items = [];
    if (permissions.canAccessDashboard) items.push({ id: 'dashboard', label: 'Home', link: '/' });
    if (permissions.canAccessComissoes) items.push({ id: 'comissoes', label: 'Comissões', link: '/comissoes' });
    if (permissions.canViewTeam || permissions.canAccessReports) {
      items.push({ id: 'dashboard-group', label: 'Dashboard', link: '' });
    }
    if (permissions.canAccessRanking) items.push({ id: 'ranking', label: 'Ranking', link: '/ranking' });
    if (permissions.canAccessConfiguration) items.push({ id: 'configuration', label: 'Configurações', link: '/configuration' });
    return items;
  }

  async getActiveSupportUser(email, db = pool) {
    if (!email) return null;
    const result = await db.query(
      `SELECT nome, email, cargo, status, nome_equipe, unidade_id
       FROM core.view_app_colaboradores
       WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
       LIMIT 1`,
      [email]
    );
    const user = result.rows[0];
    return this.normalize(user?.status) === 'ativo' ? user : null;
  }

  /**
   * Valida se o solicitante pode movimentar cards para um destino.
   *
   * CORREÇÃO: aceita `sourceUnitId` — a unidade do owner atual do card,
   * já resolvida pelo worker a partir do próprio registro dele na view.
   * Quando informado, evita a consulta por `nome_equipe` (que era ambígua
   * quando a mesma equipe existia com unidades diferentes na view).
   */
  async validateHubSpotMovementAccess({
    requesterEmail,
    destinationName,
    destinationEmail,
    destinationTeam,
    sourceTeam,
    sourceUnitId = null,
    enforceSourceTeam = false,
    enforceDestinationSameTeam = false,
    db = pool,
  }) {
    const requester = await this.getActiveSupportUser(requesterEmail, db);
    if (!requester) return { status: 403, error: 'Usuário ativo não encontrado.' };

    const isSupervisor = this.isSupervisor(requester.cargo, requester.status);
    if (!isSupervisor && !this.isCoordinatorOrAbove(requester.cargo, requester.status)) {
      return { status: 403, error: 'Somente supervisores e coordenadores podem movimentar cards por Link Hub.' };
    }

    const destinationResult = await db.query(
      `SELECT nome, email, cargo, status, nome_equipe, unidade_id
       FROM core.view_app_colaboradores
       WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
         AND LOWER(TRIM(nome))  = LOWER(TRIM($2))
       LIMIT 1`,
      [destinationEmail, destinationName]
    );
    const destination = destinationResult.rows[0];
    if (!destination || this.normalize(destination.status) !== 'ativo') {
      return { status: 400, error: 'Assessor destino não encontrado ou inativo.' };
    }

    const team = this.normalize(destinationTeam);
    if (!team || team !== this.normalize(destination.nome_equipe)) {
      return { status: 400, error: 'Equipe destino não corresponde à equipe do assessor.' };
    }

    if (isSupervisor) {
      const requesterUnidade   = requester.unidade_id   != null ? Number(requester.unidade_id)   : null;
      const destinationUnidade = destination.unidade_id != null ? Number(destination.unidade_id) : null;

      if (requesterUnidade == null) {
        return { status: 403, error: 'Supervisor sem unidade definida. Contate o administrador.' };
      }
      if (destinationUnidade == null) {
        return { status: 400, error: 'Assessor destino sem unidade definida.' };
      }
      if (requesterUnidade !== destinationUnidade) {
        return { status: 403, error: 'Supervisores só podem movimentar cards para assessores da própria unidade.' };
      }

      const requesterTeamNorm   = this.normalize(requester.nome_equipe);
      const destinationTeamNorm = this.normalize(destination.nome_equipe);

      if (this.RESERVED_DESTINATION_TEAMS.has(destinationTeamNorm)
          && requesterTeamNorm !== destinationTeamNorm) {
        return {
          status: 403,
          error: 'Somente supervisores da própria equipe podem direcionar movimentações para esta equipe.',
        };
      }

      if (enforceDestinationSameTeam) {
        if (destinationTeamNorm !== requesterTeamNorm) {
          return {
            status: 403,
            error: 'Supervisores só podem movimentar cards para assessores da própria equipe.',
          };
        }
      }

      // ─── enforceSourceTeam ───
      // Prioriza o `sourceUnitId` resolvido no worker (do owner atual do
      // card). Só cai na consulta por `nome_equipe` quando ele não veio — e,
      // nesse caso, com mensagens distintas para cada causa.
      if (enforceSourceTeam) {
        let sourceUnidade = sourceUnitId != null ? Number(sourceUnitId) : null;

        if (sourceUnidade == null) {
          if (!sourceTeam) {
            return {
              status: 403,
              error:
                'Owner atual do card não informado ao validar a origem. ' +
                'Provável causa: o card está sem proprietário no HubSpot ou o e-mail do ' +
                'proprietário não existe como colaborador(a) ativo(a) na view de colaboradores.',
            };
          }
          const sourceResult = await db.query(
            `SELECT DISTINCT unidade_id
             FROM core.view_app_colaboradores
             WHERE LOWER(TRIM(nome_equipe)) = LOWER(TRIM($1))
               AND unidade_id IS NOT NULL
             LIMIT 1`,
            [sourceTeam]
          );
          sourceUnidade = sourceResult.rows[0]?.unidade_id != null
            ? Number(sourceResult.rows[0].unidade_id)
            : null;

          if (sourceUnidade == null) {
            return {
              status: 403,
              error:
                `A equipe "${sourceTeam}" não tem unidade_id definido na view. ` +
                `Ajuste o cadastro da equipe antes de movimentar.`,
            };
          }
        }

        if (sourceUnidade !== requesterUnidade) {
          return {
            status: 403,
            error:
              `Card pertence à unidade ${sourceUnidade}, mas o supervisor é da unidade ${requesterUnidade}.`,
          };
        }
      }
    }

    return { requester, destination };
  }
}

// ─────────────────────────────────────────────────────────────
// Singleton + reexports
// ─────────────────────────────────────────────────────────────
const instance = new AccessControl();

export const accessControl = instance;
export default instance;
export const normalizeAccessValue = (v) => instance.normalize(v);
export const getActiveSupportUser = (email, db) => instance.getActiveSupportUser(email, db);
export const isSupportSupervisor = (cargo) => instance.isSupervisor(cargo);
export const isSupportCoordinatorOrAbove = (cargo) => instance.isCoordinatorOrAbove(cargo);
export const isSupportAdmin = (cargo) => instance.isAdmin(cargo);
export const validateHubSpotMovementAccess = (params) => instance.validateHubSpotMovementAccess(params);

// ─────────────────────────────────────────────────────────────
// Regra Home/Comissões:
//   (assessor OU supervisor) da UNIDADE 3
//   OU nível >= ADMINISTRATIVO (qualquer unidade)
// ─────────────────────────────────────────────────────────────
export const HOME_COMISSOES_ALLOWED_UNIT = 3;
export const isUnit3AssessorOrSupervisor = (user) => instance.isUnit3AssessorOrSupervisor(user);
export const canSeeHomeComissoes = (user) => instance.canSeeHomeComissoes(user);
export const getDefaultLandingPage = (user) => instance.getDefaultLandingPage(user);