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
    // Chaves devem estar em minúsculo, sem acentos.
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

      // Supervisão (unidade-scoped no Link Hub)
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

      // Super Admin / visão liberada
      'desenvolvedor':           this.LEVELS.SUPER_ADMIN,
      'diretora':                this.LEVELS.SUPER_ADMIN,
      'ceo':                     this.LEVELS.SUPER_ADMIN,
      'coordenador sales ops':   this.LEVELS.SUPER_ADMIN,
    };

    // Snapshot para permitir reset (usado por resetCargoLevel)
    this.DEFAULT_CARGO_LEVELS = { ...this.CARGO_LEVELS };

    // ─────────────────────────────────────────────────────────────
    // Equipes "reservadas" — só supervisores da PRÓPRIA equipe podem
    // direcionar movimentações para elas. Chaves normalizadas.
    //
    // Regra do produto:
    //   - Unidades 2,3,4,5 → trava de destino por unidade (ver UNIDADES_TRAVADAS_EQUIPE
    //     em backend/routes/suporte.js e no frontend).
    //   - Unidade 1 → trava de destino APENAS para a Equipe Tatiane. Os
    //     demais supervisores da unidade 1 NÃO veem a Equipe Tatiane na lista
    //     de destino e não conseguem movimentar para ela.
    // Coordenador (3+) e Admin (4+) não são afetados.
    // ─────────────────────────────────────────────────────────────
    this.RESERVED_DESTINATION_TEAMS = new Set([
      'equipe tatiane', // normalizado
    ]);

    // ─────────────────────────────────────────────────────────────
    // Matriz de permissões por nível
    // ─────────────────────────────────────────────────────────────
    this.PERMISSIONS = {
      [this.LEVELS.NONE]: {
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
      [this.LEVELS.ASSESSOR]: {
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
      [this.LEVELS.SUPERVISAO]: {
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
      [this.LEVELS.COORDENADOR]: {
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
      [this.LEVELS.ADMINISTRATIVO]: {
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
      [this.LEVELS.SUPER_ADMIN]: {
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
  }

  // ─────────────────────────────────────────────────────────────
  // Utilidades
  // ─────────────────────────────────────────────────────────────
  normalize(str) {
    return String(str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  // ─────────────────────────────────────────────────────────────
  // Gerenciamento de níveis por cargo (override individual)
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // Resolução de nível
  // ─────────────────────────────────────────────────────────────
  getAccessLevel(cargo, status) {
    if (status && this.normalize(status) === 'desativado') return this.LEVELS.NONE;
    if (!cargo) return this.LEVELS.NONE;
    const key = this.normalize(cargo);
    const level = this.CARGO_LEVELS[key];
    if (level !== undefined) return level;
    console.warn(`Cargo não mapeado: "${cargo}", assumindo NONE`);
    return this.LEVELS.NONE;
  }

  // ─────────────────────────────────────────────────────────────
  // Predicados (usados pelas rotas de Suporte)
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // Permissões
  // ─────────────────────────────────────────────────────────────
  hasPermission(user, permission) {
    if (!user) return false;
    const level = this.getAccessLevel(user.cargo, user.status);
    return this.PERMISSIONS[level]?.[permission] ?? false;
  }

  getUserPermissions(user) {
    const level = this.getAccessLevel(user?.cargo, user?.status);
    const perms = this.PERMISSIONS[level];
    return {
      level,
      levelName: this.getLevelName(level),
      cargo: user?.cargo,
      grupo: user?.cargo,
      nome_equipe: user?.nome_equipe,
      ...perms,
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
      return {
        lockTeam: true,
        teamName: user.nome_equipe ?? null,
        lockCollaborator: true,
        collaboratorName: user.nome ?? null,
      };
    }
    if (level === this.LEVELS.SUPERVISAO) {
      return {
        lockTeam: true,
        teamName: user.nome_equipe ?? null,
        lockCollaborator: false,
        collaboratorName: null,
      };
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

  // ─────────────────────────────────────────────────────────────
  // Backend: banco de dados
  // ─────────────────────────────────────────────────────────────
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
   * @param {object}  params
   * @param {string}  params.requesterEmail
   * @param {string}  params.destinationName
   * @param {string} [params.destinationEmail]
   * @param {string}  params.destinationTeam
   * @param {string} [params.sourceTeam]                  - usado quando enforceSourceTeam = true
   * @param {boolean} [params.enforceSourceTeam=false]    - exige que a origem pertença à unidade do supervisor
   * @param {boolean} [params.enforceDestinationSameTeam=false]
   *        - quando true, supervisores só podem direcionar para a PRÓPRIA equipe.
   *          Usado pelo fluxo Link Hub e por unidades 2-5 no fluxo CRM.
   *          Coordenador/Admin não são afetados.
   * @param {object} [params.db=pool]
   */
  async validateHubSpotMovementAccess({
    requesterEmail,
    destinationName,
    destinationEmail,
    destinationTeam,
    sourceTeam,
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

    if (!['assessor', 'analista de pastas'].includes(this.normalize(destination.cargo))) {
      return { status: 400, error: 'O destino selecionado não é um assessor.' };
    }

    const team = this.normalize(destinationTeam);
    if (!team || team !== this.normalize(destination.nome_equipe)) {
      return { status: 400, error: 'Equipe destino não corresponde à equipe do assessor.' };
    }

    // Regra específica de SUPERVISOR (nível 2). Coordenador (3+) e admin (4+)
    // não passam por estas checagens.
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

      // Equipes reservadas: mesmo dentro da mesma unidade, apenas membros da
      // própria equipe reservada podem direcionar movimentações para ela.
      // (Hoje: "Equipe Tatiane" na unidade 1.)
      if (this.RESERVED_DESTINATION_TEAMS.has(destinationTeamNorm)
          && requesterTeamNorm !== destinationTeamNorm) {
        return {
          status: 403,
          error: 'Somente supervisores da própria equipe podem direcionar movimentações para esta equipe.',
        };
      }

      // Trava de destino na própria equipe (Link Hub sempre; CRM em unidades
      // 2–5, ou quando o solicitante pertence a uma equipe reservada).
      if (enforceDestinationSameTeam) {
        if (destinationTeamNorm !== requesterTeamNorm) {
          return {
            status: 403,
            error: 'Supervisores só podem movimentar cards para assessores da própria equipe.',
          };
        }
      }

      if (enforceSourceTeam) {
        if (!sourceTeam) {
          return { status: 403, error: 'Supervisores só podem reatribuir cards atualmente pertencentes à própria unidade.' };
        }
        const sourceResult = await db.query(
          `SELECT DISTINCT unidade_id
           FROM core.view_app_colaboradores
           WHERE LOWER(TRIM(nome_equipe)) = LOWER(TRIM($1))
             AND unidade_id IS NOT NULL
           LIMIT 1`,
          [sourceTeam]
        );
        const sourceUnidade = sourceResult.rows[0]?.unidade_id != null
          ? Number(sourceResult.rows[0].unidade_id)
          : null;
        if (sourceUnidade == null || sourceUnidade !== requesterUnidade) {
          return { status: 403, error: 'Supervisores só podem reatribuir cards atualmente pertencentes à própria unidade.' };
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