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
  isUnit3HomeComissoesUser,   // [CHANGE] substitui isAssessorRestrito no LandingRedirect
  resolveAccessUser,
  type Permissions,
} from "@/lib/accessControl";

// ============================================================
// LOADER DE PERMISSÕES
// ------------------------------------------------------------
// Usado enquanto o `currentUser` ainda não trouxe `nome_equipe`
// E o `collaborators` do store está vazio. Sem isso, guards e
// landing decidem com dados incompletos e negam acesso
// indevidamente no primeiro render.
// ============================================================
function AccessBootLoader() {
  return (
    <div className="flex items-center justify-center min-h-[40vh] gap-2">
      <Loader2 className="w-5 h-5 animate-spin text-[#09175b]" />
      <span className="text-sm text-slate-500">Carregando permissões...</span>
    </div>
  );
}

/**
 * Redireciona usuário autenticado para a landing page correta
 * (definida em `getDefaultLandingPage`):
 * - Assessor/Supervisor/Coordenador da UNIDADE 3 (ou equipe liberada) → /home
 * - Supervisor fora da UNIDADE 3 (e fora das equipes liberadas) → /suporte
 * - Demais → / (comportamento anterior)
 */
function PublicRoute({ children }: { children: React.ReactNode }) {
  const currentUser = useAppStore((s) => s.currentUser);
  const collaborators = useAppStore((s) => s.collaborators);

  const accessUser = useMemo(
    () => resolveAccessUser(currentUser, collaborators),
    [currentUser, collaborators],
  );

  if (!accessUser?.email) {
    return <>{children}</>;
  }

  // [CHANGE] Aguarda o carregamento de colaboradores enquanto não
  // sabemos o nome_equipe — sem isso, um supervisor da Equipe Felipe
  // pode ser redirecionado para /suporte antes do dado chegar.
  if (!accessUser.nome_equipe && collaborators.length === 0) {
    return <AccessBootLoader />;
  }

  return <Redirect to={getDefaultLandingPage(accessUser)} />;
}

/**
 * Decisão de landing para a rota "/":
 *
 *   • Assessor / Supervisor / Coordenador da Unidade 3
 *     OU de equipe liberada (HOME_COMISSOES_ALLOWED_TEAM_NAMES) → /home
 *   • Todos os demais → <Suporte /> (comportamento histórico)
 *
 * Antes usava `isAssessorRestrito`, que retorna true apenas para
 * assessor — o que fazia supervisores e coordenadores da Unidade 3
 * (e da Equipe Felipe) caírem em Suporte em vez de Home.
 *
 * `isUnit3HomeComissoesUser` cobre os três níveis
 * (ASSESSOR/SUPERVISAO/COORDENADOR) tanto por `unidade_id === 3`
 * quanto por `nome_equipe` presente na allowlist.
 */
function LandingRedirect() {
  const currentUser = useAppStore((s) => s.currentUser);
  const collaborators = useAppStore((s) => s.collaborators);

  const accessUser = useMemo(
    () => resolveAccessUser(currentUser, collaborators),
    [currentUser, collaborators],
  );

  if (!accessUser?.email) return <Redirect to="/login" />;

  // [CHANGE] Aguarda colaboradores enquanto não sabemos nome_equipe.
  // Não condiciona mais a `!unidade_id`, porque `unidade_id` pode vir
  // preenchido no login e não ser 3 — nesse caso o usuário ainda pode
  // pertencer a uma equipe liberada.
  if (!accessUser.nome_equipe && collaborators.length === 0) {
    return <AccessBootLoader />;
  }

  // [CHANGE] Redireciona assessor, supervisor E coordenador de Unidade 3
  // / Equipe Felipe para /home.
  if (isUnit3HomeComissoesUser(accessUser)) {
    return <Redirect to="/home" />;
  }

  return <Suporte />;
}

/**
 * Protege rota verificando autenticação E permissão específica.
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

  if (!accessUser?.email) return <Redirect to="/login" />;

  // [CHANGE] Aguarda colaboradores enquanto não sabemos nome_equipe.
  if (!accessUser.nome_equipe && collaborators.length === 0) {
    return <AccessBootLoader />;
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

      {/* Home – requer permissão canAccessDashboard */}
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

      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  const { currentUser, collaborators, loadCollaboratorsAndMetrics, loadRawMetrics } = useAppStore();
  const [appLoading, setAppLoading] = useState(true);
  const initDone = useRef(false);

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

  const dataLoaded = useRef(false);
  useEffect(() => {
    if (!currentUser) return;
    if (dataLoaded.current) return;
    if (collaborators.length > 0) {
      dataLoaded.current = true;
      return;
    }

    dataLoaded.current = true;
    loadCollaboratorsAndMetrics().catch(err => console.error('Erro ao carregar métricas:', err));
    loadRawMetrics().catch(err => console.error('Erro ao carregar raw metrics:', err));
  }, [currentUser, collaborators.length, loadCollaboratorsAndMetrics, loadRawMetrics]);

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