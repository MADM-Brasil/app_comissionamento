// access-control.js – Sistema de Controle de Acesso (visão views)
// Atualizado conforme os novos cargos e níveis (inclui NONE para desativados)

class AccessControl {
    constructor() {
        this.LEVELS = {
            NONE: 0,            
            ASSESSOR: 1,
            SUPERVISAO: 2,
            COORDENADOR: 3,
            ADMINISTRATIVO: 4,
            SUPER_ADMIN: 5
        };

        // Mapeamento de cargos normalizados → nível
        this.GROUP_MAPPING = {
            // Nenhum acesso
            'desativado': this.LEVELS.NONE,
            'assistente': this.LEVELS.NONE,
            'analista juridico': this.LEVELS.NONE,
            'gestor de projetos': this.LEVELS.NONE,
            'analista': this.LEVELS.NONE,
            'analista de discadora': this.LEVELS.NONE,

            // Assessor
            'assessor': this.LEVELS.ASSESSOR,
            'analista de pastas': this.LEVELS.ASSESSOR,

            // Supervisão
            'supervisor': this.LEVELS.SUPERVISAO,

            // Coordenador
            'coordenador': this.LEVELS.COORDENADOR,

            // Administrativo
            'salesops': this.LEVELS.ADMINISTRATIVO,
            'analista de crm': this.LEVELS.ADMINISTRATIVO,
            'analista de dados': this.LEVELS.ADMINISTRATIVO,
            'desenvolvedor make': this.LEVELS.ADMINISTRATIVO,

            // Super Admin
            'ceo': this.LEVELS.SUPER_ADMIN,
            'desenvolvedor': this.LEVELS.SUPER_ADMIN,
            'diretora': this.LEVELS.SUPER_ADMIN,
        };

        // Permissões por nível
        this.PERMISSIONS = {
            [this.LEVELS.NONE]: {
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
                description: 'Sem acesso'
            },
            [this.LEVELS.ASSESSOR]: {
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
                description: 'Visualiza apenas seus próprios dados'
            },
            [this.LEVELS.SUPERVISAO]: {
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
                description: 'Visualiza dados da equipe; vê configurações sem editar'
            },
            [this.LEVELS.COORDENADOR]: {
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
                description: 'Ajusta metas, não altera bônus, filtro livre'
            },
            [this.LEVELS.ADMINISTRATIVO]: {
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
                description: 'Acesso total'
            },
            [this.LEVELS.SUPER_ADMIN]: {
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
                description: 'Acesso total'
            }

        };
    }

    /**
     * Normaliza string para comparação (lowercase, sem acentos)
     */
    normalize(str) {
        if (!str) return '';
        return str.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    /**
     * Retorna o nível de acesso para um cargo e status (campos da view)
     * @param {string} cargo - campo cargo da view core.view_app_colaboradores
     * @param {string} [status] - campo status da view
     * @returns {number} nível de acesso
     */
    getAccessLevel(cargo, status) {
        // Se status for 'desativado', retorna NONE
        if (status && this.normalize(status) === 'desativado') {
            return this.LEVELS.NONE;
        }
        if (!cargo) return this.LEVELS.NONE;
        const key = this.normalize(cargo);
        if (this.GROUP_MAPPING[key] !== undefined) {
            return this.GROUP_MAPPING[key];
        }
        console.warn(`Cargo não mapeado: "${cargo}", assumindo NONE`);
        return this.LEVELS.NONE;
    }

    /**
     * Verifica se o usuário tem uma determinada permissão
     * @param {object} user - objeto do colaborador (campos cargo e status)
     * @param {string} permission - nome da permissão
     * @returns {boolean}
     */
    hasPermission(user, permission) {
        if (!user) return false;
        const level = this.getAccessLevel(user.cargo, user.status);
        return this.PERMISSIONS[level]?.[permission] ?? false;
    }

    /**
     * Retorna todas as permissões e dados do nível do usuário
     * @param {object} user
     * @returns {object}
     */
    getUserPermissions(user) {
        const level = this.getAccessLevel(user?.cargo, user?.status);
        const perms = this.PERMISSIONS[level];
        return {
            level,
            levelName: this.getLevelName(level),
            cargo: user?.cargo,
            grupo: user?.cargo,         // compatibilidade
            nome_equipe: user?.nome_equipe,
            ...perms
        };
    }

    /**
     * Converte o código do nível para um nome legível
     * @param {number} level
     * @returns {string}
     */
    getLevelName(level) {
        const names = {
            [this.LEVELS.NONE]: 'SEM ACESSO',
            [this.LEVELS.ASSESSOR]: 'ASSESSOR',
            [this.LEVELS.SUPERVISAO]: 'SUPERVISAO',
            [this.LEVELS.COORDENADOR]: 'COORDENADOR',
            [this.LEVELS.ADMINISTRATIVO]: 'ADMINISTRATIVO'
        };
        return names[level] || 'SEM ACESSO';
    }

    /**
     * Filtra membros da equipe conforme o nível do usuário
     * @param {Array} teamMembers - lista de objetos com nome_equipe, email
     * @param {object} currentUser - usuário logado
     * @returns {Array}
     */
    filterTeamData(teamMembers, currentUser) {
        if (!currentUser || !teamMembers) return [];
        const userLevel = this.getAccessLevel(currentUser.cargo, currentUser.status);
        // Administrativo e Coordenador veem todos
        if (userLevel >= this.LEVELS.COORDENADOR) return teamMembers;
        // Supervisão vê apenas sua equipe
        if (userLevel === this.LEVELS.SUPERVISAO) {
            return teamMembers.filter(m => m.nome_equipe === currentUser.nome_equipe);
        }
        // Assessor vê apenas a si mesmo (identificado por email)
        if (userLevel === this.LEVELS.ASSESSOR) {
            return teamMembers.filter(m => m.email === currentUser.email);
        }
        // NONE não vê nada
        return [];
    }

    /**
     * Retorna as restrições de filtro (equipe/colaborador)
     * @param {object} user - usuário logado
     * @returns {{ lockTeam, teamName, lockCollaborator, collaboratorName }}
     */
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
                collaboratorName: user.nome ?? null
            };
        }
        if (level === this.LEVELS.SUPERVISAO) {
            return {
                lockTeam: true,
                teamName: user.nome_equipe ?? null,
                lockCollaborator: false,
                collaboratorName: null
            };
        }
        // Coordenador/Admin/NONE: sem restrições (NONE já é bloqueado em outras camadas)
        return { lockTeam: false, teamName: null, lockCollaborator: false, collaboratorName: null };
    }

    /**
     * Configuração de UI baseada no nível
     * @param {object} currentUser
     * @returns {object}
     */
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
            menuItems: this.getMenuItems(permissions)
        };
    }

    /**
     * Itens de menu baseados nas permissões
     * @param {object} permissions
     * @returns {Array}
     */
    getMenuItems(permissions) {
        const items = [];
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
}

export const accessControl = new AccessControl();