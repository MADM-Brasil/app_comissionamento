// backend/services/access-control.js

import { pool } from './bd/db.js';

class AccessControl {
  constructor() {
    this.LEVELS = Object.freeze({
      NONE: 0,
      JURIDICO: 1,
      ASSESSOR: 2,
      SUPERVISAO: 3,
      ASSESSOR_PLUS: 4,
      COORDENADOR: 5,
      ADMINISTRATIVO: 6,
      SUPER_ADMIN: 7,
    });

    this.CARGO_LEVELS = {
      // ── Jurídico ──────────────────────────────────────────────
      'analista juridico':       this.LEVELS.JURIDICO,
      'analista':                this.LEVELS.JURIDICO,
      'coordenador juridico':    this.LEVELS.JURIDICO,
      'supervisor juridico':     this.LEVELS.JURIDICO,
      'assistente sac':          this.LEVELS.JURIDICO,
      'supervisor sac':          this.LEVELS.JURIDICO,

      // ── Nenhum acesso ─────────────────────────────────────────
      'desativado':              this.LEVELS.NONE,
      'gestor de projetos':      this.LEVELS.NONE,

      // ── Assessor ──────────────────────────────────────────────
      'assessor':                this.LEVELS.ASSESSOR,
      'analista de pastas':      this.LEVELS.ASSESSOR,

      // ── Supervisão ────────────────────────────────────────────
      'supervisor':              this.LEVELS.SUPERVISAO,
      'Supervisor':              this.LEVELS.SUPERVISAO,
      'assistente':              this.LEVELS.SUPERVISAO,

      // ── Coordenador ───────────────────────────────────────────
      'coordenador':             this.LEVELS.COORDENADOR,

      // ── Administrativo ────────────────────────────────────────
      'salesops':                this.LEVELS.ADMINISTRATIVO,
      'analista de crm':         this.LEVELS.ADMINISTRATIVO,
      'analista de dados':       this.LEVELS.ADMINISTRATIVO,
      'analista de discadora':   this.LEVELS.ADMINISTRATIVO,
      'desenvolvedor make':      this.LEVELS.ADMINISTRATIVO,
      'supervisor sales ops':    this.LEVELS.ADMINISTRATIVO,
      'administrativo':          this.LEVELS.ADMINISTRATIVO,
      'administrador':           this.LEVELS.ADMINISTRATIVO,

      // ── Super Admin ───────────────────────────────────────────
      'desenvolvedor':           this.LEVELS.SUPER_ADMIN,
      'diretora':                this.LEVELS.SUPER_ADMIN,
      'ceo':                     this.LEVELS.SUPER_ADMIN,
      'coordenador sales ops':   this.LEVELS.SUPER_ADMIN,
    };

    this.DEFAULT_CARGO_LEVELS = { ...this.CARGO_LEVELS };

    this.RESERVED_DESTINATION_TEAMS = new Set([
      'equipe tatiane',
      'equipe leticia mathias',
    ]);

    this.HOME_COMISSOES_ALLOWED_TEAM_NAMES = [
      'Equipe Felipe',
    ];
    this.HOME_COMISSOES_ALLOWED_TEAMS = new Set(
      this.HOME_COMISSOES_ALLOWED_TEAM_NAMES.map((t) => this.normalize(t))
    );

    // ─────────────────────────────────────────────────────────
    // Bloqueio individual da página de Comissões.
    // ─────────────────────────────────────────────────────────
    this.COMISSOES_BLOCKED_EMAILS = [
      'wallace.batista@madmbrasil.com.br',
      'lilian.luz@madmbrasil.com.br',
      'bianca.ferreira@madmbrasil.com.br',   
    ];
    this.COMISSOES_BLOCKED_EMAILS_SET = new Set(
      this.COMISSOES_BLOCKED_EMAILS.map((e) => this.normalize(e))
    );

    this.ASSESSOR_PLUS_EMAILS = [
      'larissa.tayna@madmbrasil.com.br',
      'alessandra.grob@madmbrasil.com.br',
      'igor.santos@madmbrasil.com.br',
      'tayane.jesus@madmbrasil.com.br',
      'bianca.ferreira@madmbrasil.com.br',
    ];
    this.ASSESSOR_PLUS_EMAILS_SET = new Set(
      this.ASSESSOR_PLUS_EMAILS.map((e) => this.normalize(e))
    );

    // ─────────────────────────────────────────────────────────
    // [NOVO] Colaboradores liberados para as demais páginas
    // com permissões/filtros do NÍVEL BASE (ASSESSOR).
    // ─────────────────────────────────────────────────────────
    this.FULL_ACCESS_EMAILS = [
      'gabriela.moura@madmbrasil.com.br',
      'bianca.ferreira@madmbrasil.com.br',
      'irene.silva@madmbrasil.com.br',
    ];
    this.FULL_ACCESS_EMAILS_SET = new Set(
      this.FULL_ACCESS_EMAILS.map((e) => this.normalize(e))
    );

    this.PERMISSIONS = {
      [this.LEVELS.NONE]: {
        canAccessDashboard: false, canAccessComissoes: false, canAccessRanking: false,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: false, filterLocked: true, lockedTeam: true,
        lockedCollaborator: true, description: 'Sem acesso',

        canAccessSuporte: false,
        canAccessSuporteBuscaCliente: false,
        canAccessSuporteMovimentar: false,
        canAccessSuporteReportar: false,
        canAccessSuporteSalesOps: false,
      },

      [this.LEVELS.JURIDICO]: {
        canAccessDashboard: false, canAccessComissoes: false, canAccessRanking: false,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: false, filterLocked: true, lockedTeam: true,
        lockedCollaborator: true,
        description: 'Acesso somente à Busca Cliente do Suporte',

        canAccessSuporte: true,
        canAccessSuporteBuscaCliente: true,
        canAccessSuporteMovimentar: false,
        canAccessSuporteReportar: false,
        canAccessSuporteSalesOps: false,
      },

      [this.LEVELS.ASSESSOR]: {
        canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: true,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: false, filterLocked: true, lockedTeam: true,
        lockedCollaborator: true, description: 'Visualiza seus próprios dados',

        canAccessSuporte: false,
        canAccessSuporteBuscaCliente: false,
        canAccessSuporteMovimentar: false,
        canAccessSuporteReportar: false,
        canAccessSuporteSalesOps: false,
      },

      [this.LEVELS.SUPERVISAO]: {
        canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: false,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: true,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: false, filterLocked: true, lockedTeam: true,
        lockedCollaborator: false,
        description: 'Visualiza dados da equipe; vê configurações sem editar',

        canAccessSuporte: true,
        canAccessSuporteBuscaCliente: true,
        canAccessSuporteMovimentar: true,
        canAccessSuporteReportar: true,
        canAccessSuporteSalesOps: false,
      },

      [this.LEVELS.ASSESSOR_PLUS]: {
        canAccessDashboard: false, canAccessComissoes: false, canAccessRanking: false,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: true, filterLocked: false, lockedTeam: false,
        lockedCollaborator: false,
        description: 'Suporte com permissões de coordenador (somente Suporte)',

        canAccessSuporte: true,
        canAccessSuporteBuscaCliente: true,
        canAccessSuporteMovimentar: true,
        canAccessSuporteReportar: true,
        canAccessSuporteSalesOps: false,
      },

      [this.LEVELS.COORDENADOR]: {
        canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: false,
        canAccessReports: false, canAccessConfiguration: false, canViewTeam: false,
        canEditConfiguration: false, canEditBonus: false, canGenerateNextMonth: false,
        canExportData: true, filterLocked: false, lockedTeam: false,
        lockedCollaborator: false,
        description: 'Ajusta metas, não altera bônus, filtro livre',

        canAccessSuporte: true,
        canAccessSuporteBuscaCliente: true,
        canAccessSuporteMovimentar: true,
        canAccessSuporteReportar: true,
        canAccessSuporteSalesOps: false,
      },

      [this.LEVELS.ADMINISTRATIVO]: {
        canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: true,
        canAccessReports: true, canAccessConfiguration: true, canViewTeam: true,
        canEditConfiguration: true, canEditBonus: true, canGenerateNextMonth: true,
        canExportData: true, filterLocked: false, lockedTeam: false,
        lockedCollaborator: false, description: 'Acesso total',

        canAccessSuporte: true,
        canAccessSuporteBuscaCliente: true,
        canAccessSuporteMovimentar: true,
        canAccessSuporteReportar: true,
        canAccessSuporteSalesOps: true,
      },

      [this.LEVELS.SUPER_ADMIN]: {
        canAccessDashboard: true, canAccessComissoes: true, canAccessRanking: true,
        canAccessReports: true, canAccessConfiguration: true, canViewTeam: true,
        canEditConfiguration: true, canEditBonus: true, canGenerateNextMonth: true,
        canExportData: true, filterLocked: false, lockedTeam: false,
        lockedCollaborator: false, description: 'Acesso total',

        canAccessSuporte: true,
        canAccessSuporteBuscaCliente: true,
        canAccessSuporteMovimentar: true,
        canAccessSuporteReportar: true,
        canAccessSuporteSalesOps: true,
      },
    };
  }

  get HOME_COMISSOES_ALLOWED_UNIT() {
    return 3;
  }

  get HOME_COMISSOES_ALLOWED_LEVELS() {
    return [this.LEVELS.ASSESSOR, this.LEVELS.SUPERVISAO, this.LEVELS.COORDENADOR];
  }

  isUnit3HomeComissoesUser(user) {
    if (!user) return false;
    const level = this.getFunctionalAccessLevel(user);
    if (!this.HOME_COMISSOES_ALLOWED_LEVELS.includes(level)) return false;
    const unidade = user.unidade_id != null ? Number(user.unidade_id) : null;
    if (unidade === this.HOME_COMISSOES_ALLOWED_UNIT) return true;
    return this.isHomeComissoesTeam(user);
  }

  isHomeComissoesTeam(user) {
    if (!user) return false;
    const team = this.normalize(user.nome_equipe);
    if (!team) return false;
    return this.HOME_COMISSOES_ALLOWED_TEAMS.has(team);
  }

  isComissoesBlockedByEmail(user) {
    if (!user?.email) return false;
    return this.COMISSOES_BLOCKED_EMAILS_SET.has(this.normalize(user.email));
  }

  isAssessorPlusUser(user) {
    if (!user?.email) return false;
    if (!this.ASSESSOR_PLUS_EMAILS_SET.has(this.normalize(user.email))) return false;
    return this.getAccessLevel(user.cargo, user.status) === this.LEVELS.ASSESSOR;
  }

  isFullAccessUser(user) {
    if (!user?.email) return false;
    return this.FULL_ACCESS_EMAILS_SET.has(this.normalize(user.email));
  }

  getBaseAccessLevel(user) {
    return this.getAccessLevel(user?.cargo, user?.status);
  }

  getFunctionalAccessLevel(user) {
    const effectiveLevel = this.getEffectiveAccessLevel(user);
    if (
      effectiveLevel === this.LEVELS.ASSESSOR_PLUS &&
      this.isFullAccessUser(user)
    ) {
      return this.LEVELS.ASSESSOR;
    }
    return effectiveLevel;
  }

  getEffectiveAccessLevel(user) {
    const baseLevel = this.getAccessLevel(user?.cargo, user?.status);
    if (baseLevel !== this.LEVELS.ASSESSOR) return baseLevel;
    if (this.isAssessorPlusUser(user)) return this.LEVELS.ASSESSOR_PLUS;
    return baseLevel;
  }

  isUnit3AssessorOrSupervisor(user) {
    return this.isUnit3HomeComissoesUser(user);
  }

  canSeeHomeComissoes(user) {
    if (!user) return false;
    const level = this.getFunctionalAccessLevel(user);
    if (level >= this.LEVELS.ADMINISTRATIVO) return true;
    return this.isUnit3HomeComissoesUser(user);
  }

  getDefaultLandingPage(user) {
    if (!user) return '/login';

    if (this.isUnit3HomeComissoesUser(user)) return '/home';

    const effectiveLevel  = this.getEffectiveAccessLevel(user);
    const functionalLevel = this.getFunctionalAccessLevel(user);

    const isFullAccessPlus =
      effectiveLevel === this.LEVELS.ASSESSOR_PLUS &&
      functionalLevel !== this.LEVELS.ASSESSOR_PLUS;

    if (!isFullAccessPlus) {
      if (effectiveLevel === this.LEVELS.JURIDICO)      return '/suporte';
      if (effectiveLevel === this.LEVELS.ASSESSOR_PLUS) return '/suporte';
      if (effectiveLevel === this.LEVELS.SUPERVISAO)    return '/suporte';
    }

    return '/';
  }

  normalize(str) {
    return String(str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  setCargoLevel(cargo, level) {
    if (typeof level !== 'number' || level < 0 || level > 7) {
      throw new Error(`Nível inválido para "${cargo}": ${level}. Use 0–7.`);
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

  isJuridico(cargo, status) {
    return this.getAccessLevel(cargo, status) === this.LEVELS.JURIDICO;
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
    const level = this.getAccessLevel(cargo, status);
    return level >= this.LEVELS.SUPERVISAO || level === this.LEVELS.JURIDICO;
  }

  canAccessSupportByUser(user) {
    const level = this.getEffectiveAccessLevel(user);
    return level >= this.LEVELS.SUPERVISAO || level === this.LEVELS.JURIDICO;
  }

  canAccessSuportePage(cargo, status) {
    return this.canAccessSupport(cargo, status);
  }

  canAccessSuporteBuscaCliente(cargo, status) {
    const level = this.getAccessLevel(cargo, status);
    return level >= this.LEVELS.SUPERVISAO || level === this.LEVELS.JURIDICO;
  }

  canAccessSuporteMovimentar(cargo, status) {
    return this.getAccessLevel(cargo, status) >= this.LEVELS.SUPERVISAO;
  }

  canAccessSuporteReportar(cargo, status) {
    return this.getAccessLevel(cargo, status) >= this.LEVELS.SUPERVISAO;
  }

  canAccessSuporteSalesOps(cargo, status) {
    return this.getAccessLevel(cargo, status) >= this.LEVELS.ADMINISTRATIVO;
  }

  hasPermission(user, permission) {
    if (!user) return false;
    const perms = this.getUserPermissions(user);
    return Boolean(perms?.[permission]);
  }

  getUserPermissions(user) {
    const effectiveLevel  = this.getEffectiveAccessLevel(user);
    const functionalLevel = this.getFunctionalAccessLevel(user);

    let perms;
    if (functionalLevel !== effectiveLevel) {
      const basePerms = this.PERMISSIONS[functionalLevel];
      const plusPerms = this.PERMISSIONS[effectiveLevel];
      perms = {
        ...basePerms,
        canAccessSuporte:              plusPerms.canAccessSuporte,
        canAccessSuporteBuscaCliente:  plusPerms.canAccessSuporteBuscaCliente,
        canAccessSuporteMovimentar:    plusPerms.canAccessSuporteMovimentar,
        canAccessSuporteReportar:      plusPerms.canAccessSuporteReportar,
        canAccessSuporteSalesOps:      plusPerms.canAccessSuporteSalesOps,
      };
    } else {
      perms = this.PERMISSIONS[effectiveLevel];
    }

    const allowHomeComissoes = this.canSeeHomeComissoes(user);
    const bloqueadoComissoes = this.isComissoesBlockedByEmail(user);

    return {
      level: effectiveLevel,
      levelName: this.getLevelName(effectiveLevel),
      functionalLevel,
      functionalLevelName: this.getLevelName(functionalLevel),

      cargo: user?.cargo,
      grupo: user?.cargo,
      nome_equipe: user?.nome_equipe,
      unidade_id: user?.unidade_id,
      ...perms,

      canAccessDashboard: perms.canAccessDashboard && allowHomeComissoes,
      canAccessComissoes:
        perms.canAccessComissoes && allowHomeComissoes && !bloqueadoComissoes,
    };
  }

  getLevelName(level) {
    const names = {
      [this.LEVELS.NONE]: 'SEM ACESSO',
      [this.LEVELS.JURIDICO]: 'JURIDICO',
      [this.LEVELS.ASSESSOR]: 'ASSESSOR',
      [this.LEVELS.SUPERVISAO]: 'SUPERVISAO',
      [this.LEVELS.ASSESSOR_PLUS]: 'ASSESSOR PLUS',
      [this.LEVELS.COORDENADOR]: 'COORDENADOR',
      [this.LEVELS.ADMINISTRATIVO]: 'ADMINISTRATIVO',
      [this.LEVELS.SUPER_ADMIN]: 'SUPER ADMIN',
    };
    return names[level] || 'SEM ACESSO';
  }

  filterTeamData(teamMembers, currentUser) {
    if (!currentUser || !teamMembers) return [];
    const userLevel = this.getFunctionalAccessLevel(currentUser);
    if (userLevel >= this.LEVELS.COORDENADOR || userLevel === this.LEVELS.ASSESSOR_PLUS) {
      return teamMembers;
    }
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
    const level = this.getFunctionalAccessLevel(user);
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
    if (
      permissions.level === this.LEVELS.JURIDICO ||
      (permissions.canAccessSuporte && !permissions.canAccessDashboard)
    ) {
      if (permissions.canAccessSuporte) items.push({ id: 'suporte', label: 'Suporte', link: '/suporte' });
      return items;
    }

    if (permissions.canAccessDashboard) items.push({ id: 'dashboard', label: 'Home', link: '/' });
    if (permissions.canAccessComissoes) items.push({ id: 'comissoes', label: 'Comissões', link: '/comissoes' });
    if (permissions.canViewTeam || permissions.canAccessReports) {
      items.push({ id: 'dashboard-group', label: 'Dashboard', link: '' });
    }
    if (permissions.canAccessRanking) items.push({ id: 'ranking', label: 'Ranking', link: '/ranking' });
    if (permissions.canAccessSuporte) items.push({ id: 'suporte', label: 'Suporte', link: '/suporte' });
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

    const isSupervisor   = this.isSupervisor(requester.cargo, requester.status);
    const isCoordOrAbove = this.isCoordinatorOrAbove(requester.cargo, requester.status);
    const isAssessorPlus = this.isAssessorPlusUser(requester);

    if (!isSupervisor && !isCoordOrAbove && !isAssessorPlus) {
      return {
        status: 403,
        error: 'Somente supervisores, coordenadores e assessores autorizados podem movimentar cards por Link Hub.',
      };
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

    // ─────────────────────────────────────────────────────────
    // Este bloco roda APENAS para supervisores. Coordenadores e
    // ASSESSOR_PLUS não entram aqui — livres de restrição de
    // unidade/equipe por este método.
    // ─────────────────────────────────────────────────────────
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
export const isSupportJuridico = (cargo, status) => instance.isJuridico(cargo, status);
export const canAccessSupport = (cargo, status) => instance.canAccessSupport(cargo, status);
export const validateHubSpotMovementAccess = (params) => instance.validateHubSpotMovementAccess(params);

export const COMISSOES_BLOCKED_EMAILS = [...instance.COMISSOES_BLOCKED_EMAILS];
export const isComissoesBlockedByEmail = (user) => instance.isComissoesBlockedByEmail(user);

export const HOME_COMISSOES_ALLOWED_UNIT = 3;
export const HOME_COMISSOES_ALLOWED_TEAM_NAMES = [...instance.HOME_COMISSOES_ALLOWED_TEAM_NAMES];
export const isUnit3HomeComissoesUser = (user) => instance.isUnit3HomeComissoesUser(user);
export const isUnit3AssessorOrSupervisor = (user) => instance.isUnit3HomeComissoesUser(user);
export const isHomeComissoesTeam = (user) => instance.isHomeComissoesTeam(user);
export const canSeeHomeComissoes = (user) => instance.canSeeHomeComissoes(user);
export const getDefaultLandingPage = (user) => instance.getDefaultLandingPage(user);

export const ASSESSOR_PLUS_EMAILS = [...instance.ASSESSOR_PLUS_EMAILS];
export const isAssessorPlusUser = (user) => instance.isAssessorPlusUser(user);
export const getEffectiveAccessLevel = (user) => instance.getEffectiveAccessLevel(user);
export const canAccessSupportByUser = (user) => instance.canAccessSupportByUser(user);

export const FULL_ACCESS_EMAILS = [...instance.FULL_ACCESS_EMAILS];
export const isFullAccessUser = (user) => instance.isFullAccessUser(user);
export const getBaseAccessLevel = (user) => instance.getBaseAccessLevel(user);
export const getFunctionalAccessLevel = (user) => instance.getFunctionalAccessLevel(user);