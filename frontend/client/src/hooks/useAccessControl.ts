// src/hooks/useAccessControl.ts
import { useAppStore } from '@/lib/dataStore';
import {
  LEVELS,
  getAccessLevel as getLevel,
  hasPermission as checkPermission,
  getUserPermissions as getPermissions, 
  getUIConfig as getUIConfigFromLib,
  filterTeamData as filterTeam,
  getFilterRestrictions,
} from '@/lib/accessControl';

/**
 * Normaliza o objeto do usuário para garantir que a propriedade 'cargo' exista,
 * independentemente de o store ainda enviar o campo como 'grupo'.
 */
function normalizeUser(raw: any) {
  if (!raw) return raw;
  // Se a view nova já traz 'cargo', nada a fazer.
  if (raw.cargo !== undefined) return raw;
  // Senão, mapeia 'grupo' → 'cargo'.
  if (raw.grupo !== undefined) {
    return { ...raw, cargo: raw.grupo };
  }
  return raw;
}

export function useAccessControl() {
  const currentUserRaw = useAppStore((state) => state.currentUser);
  const currentUser = normalizeUser(currentUserRaw);

  if (process.env.NODE_ENV === 'development') {
    console.log('🔐 [useAccessControl] currentUser:', currentUser);
  }

  const getAccessLevel = () => {
    if (!currentUser) return LEVELS.ASSESSOR;
    const level = getLevel(currentUser.cargo);
    console.log(`🔐 getAccessLevel: cargo="${currentUser.cargo}", nível=${level}`);
    return level;
  };

  const hasPermission = (permission: string) => {
    if (!currentUser) return false;
    // A função checkPermission agora espera um keyof Permissions; podemos afirmar que a string é válida.
    const result = checkPermission(currentUser, permission as any);
    console.log(`🔐 hasPermission(${permission}): ${result}`);
    return result;
  };

  const getUserPermissions = () => {
    if (!currentUser) return null;
    return getPermissions(currentUser);
  };

  const getUIConfig = () => {
    if (!currentUser) return null;
    return getUIConfigFromLib(currentUser);
  };

  const getFilterRestrictionsSafe = () => {
    if (!currentUser) {
      return { lockTeam: false, teamName: null, lockCollaborator: false, collaboratorName: null };
    }
    const restrictions = getFilterRestrictions(currentUser);
    console.log('🔐 getFilterRestrictions:', restrictions);
    return restrictions;
  };

  const filterTeamDataSafe = (teamMembers: any[]) => {
    if (!currentUser) return [];
    return filterTeam(teamMembers, currentUser);
  };

  return {
    currentUser,
    hasPermission,
    getUserPermissions,
    getUIConfig,
    getFilterRestrictions: getFilterRestrictionsSafe,
    filterTeamData: filterTeamDataSafe,
    getAccessLevel,
    LEVELS,
  };
}