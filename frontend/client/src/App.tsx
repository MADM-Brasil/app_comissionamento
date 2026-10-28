// src/App.tsx
import { useEffect, useState, useRef, useMemo } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { PeriodProvider } from '@/contexts/period';
import Home from "./pages/Home";
import Comissoes from "./pages/Comissoes";
import Funil from "./pages/Funil";
import Analytics from "./pages/Analytics";
import Ranking from "./pages/Ranking";
import Configuration from "./pages/Configuration";
import Suporte from "./pages/Suporte";
import Login from "./pages/Login";
import Visao_geral from "./pages/Visao_geral";
import Equipe from "./pages/Equipe";
import Verify2FA from "./pages/ResetPassword/Verify2FA";
import ProtectedRoute from "./components/ProtectedRoute";
import ForgotPassword from "./pages/ResetPassword/ForgotPassword";
import ResetPassword from "./pages/ResetPassword/ResetPassword";
import { API_BASE } from "@/lib/api";
import { useAppStore } from "@/lib/dataStore";
import { fetchCurrentUser } from "@/lib/auth";
import { Loader2 } from "lucide-react";
import {
  getUserPermissions,
  getDefaultLandingPage,
  isAssessorRestrito,
  resolveAccessUser,
  LEVELS,
  type Permissions,
} from "@/lib/accessControl";

/**
 * Redireciona usuário autenticado para a landing page correta
 * (definida em `getDefaultLandingPage`):
 *   • Assessor/Supervisor/Coordenador da UNIDADE 3 (ou equipe liberada) → /home
 *   • JURIDICO                                                          → /suporte
 *   • Supervisor fora da UNIDADE 3 / equipes liberadas                  → /suporte
 *   • Demais                                                            → /
 */
function PublicRoute({ children }: { children: React.ReactNode }) {
  const currentUser = useAppStore((s) => s.currentUser);
  if (currentUser?.email) {
    return <Redirect to={getDefaultLandingPage(currentUser)} />;
  }
  return <>{children}</>;
}

/**
 * Decisão de landing para a rota "/":
 *   • Assessor unidade 3 (ou equipe liberada) → /home
 *   • Demais                                   → <Suporte />
 *
 * ⚠️ JURIDICO nunca chega aqui — o guard `ProtectedRouteWithPermission`
 *    (permission="canAccessDashboard") já redireciona para "/suporte"
 *    antes deste componente ser avaliado.
 *
 * ⚠️ Usa `resolveAccessUser` para não depender de `currentUser.nome_equipe`
 *    (pode faltar dependendo da origem do payload).
 */
function LandingRedirect() {
  const currentUser = useAppStore((s) => s.currentUser);
  const collaborators = useAppStore((s) => s.collaborators);
  const accessUser = useMemo(
    () => resolveAccessUser(currentUser, collaborators),
    [currentUser, collaborators],
  );

  if (isAssessorRestrito(accessUser)) {
    return <Redirect to="/home" />;
  }
  return <Suporte />;
}

/**
 * Guard genérico de permissão.
 *
 * ⚠️ CORREÇÃO: usa `resolveAccessUser(currentUser, collaborators)` —
 *    o mesmo enrichment aplicado pelo DashboardLayout.
 *
 * Sem isso, `getUserPermissions(currentUser)` enxergava apenas o payload
 * bruto do `/auth/me` (que, em sessões antigas ou fluxos legados, pode não
 * trazer `nome_equipe`/`unidade_id`). Sem esses campos:
 *   • canSeeHomeComissoes → false
 *   • canAccessDashboard / canAccessComissoes → false
 *   • guard retorna "Acesso não autorizado"
 *
 * É exatamente o sintoma observado em supervisores da Equipe Felipe
 * (equipe liberada depende 100% de `nome_equipe` bater com a lista).
 *
 * Enquanto `collaborators` ainda não carregou E o payload não trouxe os
 * campos, renderizamos um loader curto em vez de negar — evita o "flash"
 * de acesso negado na primeira renderização.
 */
function ProtectedRouteWithPermission({
  permission,
  children,
}: {
  permission: keyof Permissions;
  children: React.ReactNode;
}) {
  const currentUser = useAppStore((s) => s.currentUser);
  const collaborators = useAppStore((s) => s.collaborators);

  const accessUser = useMemo(
    () => resolveAccessUser(currentUser, collaborators),
    [currentUser, collaborators],
  );

  if (!currentUser?.email) return <Redirect to="/login" />;

  // Se o currentUser ainda não tem os campos necessários e collaborators
  // ainda não carregou, aguarda em vez de negar acesso.
  const missingEnrichment =
    !accessUser?.nome_equipe || accessUser?.unidade_id == null;
  if (missingEnrichment && collaborators.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-6 h-6 animate-spin text-[#2F6FED]" />
        <span className="ml-2 text-sm text-slate-500">Carregando dados de acesso...</span>
      </div>
    );
  }

  const perms = getUserPermissions(accessUser ?? undefined);

  if (!perms[permission]) {
    // JURIDICO: qualquer rota protegida leva a "/suporte".
    if (perms.level === LEVELS.JURIDICO) {
      return <Redirect to="/suporte" />;
    }

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

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      {/* Rotas públicas */}
      <Route path="/login">
        <PublicRoute>
          <Login />
        </PublicRoute>
      </Route>
      <Route path="/verify-2fa">
        <PublicRoute>
          <Verify2FA />
        </PublicRoute>
      </Route>
      <Route path="/forgot-password">
        <PublicRoute>
          <ForgotPassword />
        </PublicRoute>
      </Route>
      <Route path="/reset-password">
        <PublicRoute>
          <ResetPassword />
        </PublicRoute>
      </Route>

      <Route path="/404" component={NotFound} />

      {/* Home */}
      <Route path="/">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessDashboard">
            <LandingRedirect />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>
      <Route path="/home">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessDashboard">
            <Home />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Comissões */}
      <Route path="/comissoes">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessComissoes">
            <Comissoes />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Ranking */}
      <Route path="/ranking">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessRanking">
            <Ranking />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Dashboard / Analytics */}
      <Route path="/funil">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessReports">
            <Funil />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>
      <Route path="/analytics">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessReports">
            <Analytics />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>
      <Route path="/Visao_geral">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessReports">
            <Visao_geral />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Equipe */}
      <Route path="/Equipe">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canViewTeam">
            <Equipe />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>
      <Route path="/Equipe/:supervisor">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canViewTeam">
            <Equipe />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>
      <Route path="/equipe">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canViewTeam">
            <Equipe />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>
      <Route path="/equipe/:supervisor">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canViewTeam">
            <Equipe />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>
      <Route path="/colaboradores/:id">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canViewTeam">
            <Equipe />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>
      <Route path="/colaborador/:id">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canViewTeam">
            <Equipe />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Configuração */}
      <Route path="/configuration">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessConfiguration">
            <Configuration />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Suporte */}
      <Route path="/suporte">
        <PeriodProvider>
          <ProtectedRoute>
            <Suporte />
          </ProtectedRoute>
        </PeriodProvider>
      </Route>

      {/* Fallback */}
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  const { currentUser, collaborators, loadCollaborators } = useAppStore();
  const [appLoading, setAppLoading] = useState(true);
  const initDone = useRef(false);

  // 1. Token CSRF
  useEffect(() => {
    fetch(`${API_BASE}/csrf-token`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.csrfToken && data.csrfToken !== 'disabled') {
          localStorage.setItem('csrfToken', data.csrfToken);
        }
      })
      .catch(() => {});
  }, []);

  // 2. Restaura sessão apenas uma vez
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    const restore = async () => {
      try {
        const existing = useAppStore.getState().currentUser;
        if (existing?.email) {
          setAppLoading(false);
          return;
        }
        await fetchCurrentUser();
      } catch (err) {
        console.error('Erro ao restaurar sessão:', err);
      } finally {
        setAppLoading(false);
      }
    };

    restore();

    const timer = setTimeout(() => {
      if (appLoading) {
        console.warn('⏱️ Timeout de inicialização – forçando fim do carregamento');
        setAppLoading(false);
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [appLoading]);

  // 3. Bootstrap: carrega APENAS a lista de colaboradores.
  //
  // ⚠️ NÃO chamar `loadCollaboratorsAndMetrics()` ou `loadRawMetrics()`
  // aqui. Essas funções aceitam `equipe`/`colaborador` como parâmetros,
  // mas, ao serem chamadas sem filtro, populam `collaborators` e
  // `rawMetrics` com dados GLOBAIS. Como cada página (Home, Analytics,
  // Funil, Visão Geral, Comissões) dispara seu próprio fetch escopado
  // em paralelo, a chamada global do App podia terminar DEPOIS e
  // sobrescrever os dados escopados.
  const dataLoaded = useRef(false);
  useEffect(() => {
    if (!currentUser) return;
    if (dataLoaded.current) return;
    if (collaborators.length > 0) {
      dataLoaded.current = true;
      return;
    }

    dataLoaded.current = true;
    loadCollaborators().catch((err) =>
      console.error('Erro ao carregar colaboradores:', err)
    );
  }, [currentUser, collaborators.length, loadCollaborators]);

  // 4. Heartbeat
  useEffect(() => {
    if (!currentUser) return;
    const interval = setInterval(() => {
      fetch(`${API_BASE}/auth/ping`, {
        credentials: 'include',
        headers: { 'x-csrf-token': localStorage.getItem('csrfToken') || '' },
      }).catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [currentUser]);

  // 5. Atualiza CSRF após login
  useEffect(() => {
    if (!currentUser) return;
    fetch(`${API_BASE}/csrf-token`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (data.csrfToken && data.csrfToken !== 'disabled') {
          localStorage.setItem('csrfToken', data.csrfToken);
        }
      })
      .catch(() => {});
  }, [currentUser]);

  if (appLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-[#09175b]" />
        <span className="ml-2 text-gray-500">Carregando sistema...</span>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster position="top-right" richColors />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}