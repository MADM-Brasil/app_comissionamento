// src/components/ProtectedRoute.tsx
import { useMemo } from "react";
import { Redirect } from "wouter";
import { Loader2 } from "lucide-react";
import { useAppStore } from "@/lib/dataStore";
import {
  getUserPermissions,
  resolveAccessUser,
  type Permissions,
} from "@/lib/accessControl";

interface ProtectedRouteProps {
  children: React.ReactNode;

  /**
   * Permissão opcional.
   *
   * - Quando informada, além de autenticação, o guard exige a permissão
   *   (`Permissions[permission] === true`). Se o usuário não tiver,
   *   exibe a tela "Acesso não autorizado" com link para /suporte.
   *
   * - Quando omitida, valida apenas autenticação — comportamento
   *   histórico (usado em /suporte, onde a própria página faz a
   *   checagem de nível).
   */
  permission?: keyof Permissions;
}

export default function ProtectedRoute({
  children,
  permission,
}: ProtectedRouteProps) {
  const currentUser = useAppStore((state) => state.currentUser);
  const collaborators = useAppStore((state) => state.collaborators);

  // [NOVO] Enriquecer o usuário com `nome_equipe` e `unidade_id` a
  // partir de `collaborators` (match por e-mail), para que
  // `getUserPermissions` enxergue as regras de Unidade 3 / equipes
  // liberadas quando o payload do `/auth/login` não trouxer esses
  // campos.
  const accessUser = useMemo(
    () => resolveAccessUser(currentUser, collaborators),
    [currentUser, collaborators],
  );

  // 1. Autenticação
  if (!accessUser?.email) {
    return <Redirect to="/login" />;
  }

  // 2. Permissão opcional
  if (permission) {
    // Se o currentUser ainda não trouxe nome_equipe/unidade_id e o
    // store ainda não carregou colaboradores, aguardar — evita
    // negar acesso indevidamente no primeiro render.
    if (
      !accessUser.nome_equipe &&
      !accessUser.unidade_id &&
      collaborators.length === 0
    ) {
      return (
        <div className="flex items-center justify-center min-h-[40vh] gap-2">
          <Loader2 className="w-5 h-5 animate-spin text-[#09175b]" />
          <span className="text-sm text-slate-500">Carregando permissões...</span>
        </div>
      );
    }

    const perms = getUserPermissions(accessUser);
    if (!perms[permission]) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-2">
          <p className="text-slate-500">Acesso não autorizado a esta página.</p>
          <a
            href="/suporte"
            className="text-[#2F6FED] text-sm font-medium hover:underline"
          >
            Ir para o Suporte
          </a>
        </div>
      );
    }
  }

  // 3. Autorizado
  return <>{children}</>;
}