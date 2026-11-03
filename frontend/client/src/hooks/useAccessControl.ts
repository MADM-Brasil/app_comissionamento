// src/hooks/useAccessControl.ts
// ─────────────────────────────────────────────────────────────
// Hook centralizador para consultar nível/permissões do usuário logado.
//
// Histórico:
//   • Antes do ASSESSOR_PLUS, `getAccessLevel()` era suficiente porque
//     o nível efetivo coincidia com o nível do cargo.
//   • Com o ASSESSOR_PLUS (whitelist por e-mail), é preciso uma versão
//     que enxergue essa promoção → `getEffectiveAccessLevel()`.
//   • `getAccessLevel()` foi MANTIDO por compatibilidade (semântica
//     "crua": só olha cargo/status). Use `getEffectiveAccessLevel()`
//     em qualquer decisão de acesso real (menu, guard, abas etc).
// ─────────────────────────────────────────────────────────────

import { useCallback, useMemo } from "react";
import { useAppStore } from "@/lib/dataStore";
import {
  LEVELS,
  getAccessLevel as resolveAccessLevel,
  getEffectiveAccessLevel as resolveEffectiveAccessLevel,
  isAssessorPlusUser,
  getUserPermissions,
  resolveAccessUser,
} from "@/lib/accessControl";

type Level = typeof LEVELS[keyof typeof LEVELS];

export function useAccessControl() {
  const currentUser = useAppStore((s) => s.currentUser);
  const collaborators = useAppStore((s) => s.collaborators);

  // ─────────────────────────────────────────────────────────
  // Usuário enriquecido (nome_equipe / unidade_id vindos de
  // `collaborators` quando o payload do /auth/me não os traz).
  // ─────────────────────────────────────────────────────────
  const accessUser = useMemo(
    () => resolveAccessUser(currentUser, collaborators),
    [currentUser, collaborators],
  );

  // ─────────────────────────────────────────────────────────
  // Nível CRU — só olha cargo/status. Ignora a whitelist
  // ASSESSOR_PLUS. Mantido por compatibilidade com telas que
  // dependiam exclusivamente do cargo (ex.: exibir
  // `currentUser.cargo` traduzido em rótulo).
  //
  // Sem argumentos → resolve para o usuário logado.
  // Com argumentos → resolve para o cargo/status informados.
  // ─────────────────────────────────────────────────────────
  const getAccessLevel = useCallback(
    (cargo?: string, status?: string): Level => {
      if (cargo === undefined && status === undefined) {
        return resolveAccessLevel(accessUser?.cargo, accessUser?.status);
      }
      return resolveAccessLevel(cargo, status);
    },
    [accessUser],
  );

  // ─────────────────────────────────────────────────────────
  // Nível EFETIVO — considera a whitelist ASSESSOR_PLUS.
  //
  // Sem argumentos → resolve para o usuário logado (inclui a
  // promoção por e-mail).
  // Com argumentos → resolve apenas para o cargo/status
  // informados (sem promoção — não há `email` no contexto).
  //
  // **Prefira esta versão** em qualquer decisão de acesso.
  // ─────────────────────────────────────────────────────────
  const getEffectiveAccessLevel = useCallback(
    (cargo?: string, status?: string): Level => {
      if (cargo === undefined && status === undefined) {
        return resolveEffectiveAccessLevel(accessUser);
      }
      return resolveEffectiveAccessLevel({ cargo, status });
    },
    [accessUser],
  );

  // ─────────────────────────────────────────────────────────
  // Permissões (flags) do usuário logado.
  // Já refletem ASSESSOR_PLUS, bloqueio de comissões, restrição
  // de assessor de Unidade 3 / Equipe Felipe etc.
  // ─────────────────────────────────────────────────────────
  const permissions = useMemo(
    () => getUserPermissions(accessUser ?? undefined),
    [accessUser],
  );

  // ─────────────────────────────────────────────────────────
  // Atalho: o usuário logado é um ASSESSOR_PLUS?
  // (cargo === assessor E e-mail na whitelist)
  // ─────────────────────────────────────────────────────────
  const isAssessorPlus = useMemo(
    () => isAssessorPlusUser(accessUser),
    [accessUser],
  );

  return {
    // Constantes
    LEVELS,

    // Usuário (nome legado `currentUser` + alias `accessUser`)
    currentUser: accessUser,
    accessUser,

    // Permissões pré-computadas
    permissions,

    // Resolvedores de nível
    getAccessLevel,
    getEffectiveAccessLevel,

    // Atalhos de perfil
    isAssessorPlus,
  };
}

export default useAccessControl;