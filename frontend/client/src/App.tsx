// src/App.tsx
import { useEffect, useState, useRef } from "react";
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
import Vgeral from "./pages/Visao_geral";
import Gargalos from "./pages/Gargalos";
import Equipe from "./pages/Equipe";
import Verify2FA from "./pages/ResetPassword/Verify2FA";
import ProtectedRoute from "./components/ProtectedRoute";
import ForgotPassword from "./pages/ResetPassword/ForgotPassword";
import ResetPassword from "./pages/ResetPassword/ResetPassword";
import { API_BASE } from "@/lib/api";
import { useAppStore } from "@/lib/dataStore";
import { fetchCurrentUser } from "@/lib/auth";
import { Loader2 } from "lucide-react";
import { getUserPermissions, type Permissions } from "@/lib/accessControl";

/**
 * Redireciona usuário autenticado para Home ao acessar páginas públicas
 */
function PublicRoute({ children }: { children: React.ReactNode }) {
  const currentUser = useAppStore((s) => s.currentUser);
  if (currentUser?.email) return <Redirect to="/" />;
  return <>{children}</>;
}

/**
 * Protege rota verificando autenticação E permissão específica.
 * Se o usuário não tem a permissão, redireciona para Home (ou mostra mensagem).
 */
function ProtectedRouteWithPermission({
  permission,
  children,
}: {
  permission: keyof Permissions;
  children: React.ReactNode;
}) {
  const currentUser = useAppStore((s) => s.currentUser);
  const perms = getUserPermissions(currentUser ?? undefined);

  if (!currentUser?.email) return <Redirect to="/login" />;
  if (!perms[permission]) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
        <p className="text-slate-500">Acesso não autorizado a esta página.</p>
        <Redirect to="/" />
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
            <Home />
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

      {/* Comissões – requer permissão canAccessComissoes */}
      <Route path="/comissoes">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessComissoes">
            <Comissoes />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Ranking – requer permissão canAccessRanking */}
      <Route path="/ranking">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessRanking">
            <Ranking />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Dashboard / Analytics – requer permissão canAccessReports */}
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
      <Route path="/Vgeral">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessReports">
            <Vgeral />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>
      <Route path="/Gargalos">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessReports">
            <Gargalos />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Equipe – requer permissão canViewTeam */}
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

      {/* Configuração – requer permissão canAccessConfiguration */}
      <Route path="/configuration">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessConfiguration">
            <Configuration />
          </ProtectedRouteWithPermission>
        </PeriodProvider>
      </Route>

      {/* Suporte (mantido protegido apenas por autenticação) */}
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
  const { currentUser, collaborators, loadCollaboratorsAndMetrics, loadRawMetrics } = useAppStore();
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
        await fetchCurrentUser();   // já atualiza a store se houver sessão
      } catch (err) {
        console.error('Erro ao restaurar sessão:', err);
      } finally {
        setAppLoading(false);
      }
    };

    restore();

    // Timeout de segurança
    const timer = setTimeout(() => {
      if (appLoading) {
        console.warn('⏱️ Timeout de inicialização – forçando fim do carregamento');
        setAppLoading(false);
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [appLoading]);

  // 3. Carrega dados em segundo plano quando usuário autenticado
  const dataLoaded = useRef(false);
  useEffect(() => {
    if (!currentUser) return;
    if (dataLoaded.current) return;
    if (collaborators.length > 0) {
      dataLoaded.current = true;
      return;
    }

    dataLoaded.current = true; // evita múltiplas chamadas
    loadCollaboratorsAndMetrics().catch(err => console.error('Erro ao carregar métricas:', err));
    loadRawMetrics().catch(err => console.error('Erro ao carregar raw metrics:', err));
  }, [currentUser, collaborators.length, loadCollaboratorsAndMetrics, loadRawMetrics]);

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