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
  LEVELS,
  type Permissions,
} from "@/lib/accessControl";

/**
 * Redireciona usuário autenticado para a landing page correta
 * (definida em `getDefaultLandingPage`):
 * - Assessor/Supervisor/Coordenador da UNIDADE 3 (ou equipe liberada) → /home
 * - JURIDICO → /suporte (aba Busca Cliente)
 * - Supervisor fora da UNIDADE 3 / equipes liberadas → /suporte
 * - Demais → / (comportamento anterior)
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
 *
 *   • Assessor unidade 3 → redireciona para /home
 *   • Todos os demais     → <Suporte /> (comportamento histórico)
 *
 * Importante: `isAssessorRestrito` retorna `true` SOMENTE para
 * `getAccessLevel === ASSESSOR && unidade_id === 3`. Portanto, este
 * wrapper NÃO altera o comportamento de:
 *   - supervisores (qualquer unidade)
 *   - coordenadores (qualquer unidade)
 *   - assessores de outras unidades
 *   - administrativo e super admin
 * Todos esses continuam caindo em <Suporte /> como antes.
 *
 * ⚠️ JURIDICO nunca chega aqui — o guard `ProtectedRouteWithPermission`
 * (permission="canAccessDashboard") já redireciona para "/suporte"
 * antes deste componente ser avaliado.
 */
function LandingRedirect() {
  const currentUser = useAppStore((s) => s.currentUser);
  if (isAssessorRestrito(currentUser)) {
    return <Redirect to="/home" />;
  }
  return <Suporte />;
}

/**
 * Protege rota verificando autenticação E permissão específica.
 *
 * Se o usuário não tem a permissão:
 *   • JURIDICO  → redireciona automaticamente para "/suporte"
 *                 (única rota que ele pode acessar).
 *   • Demais    → mostra uma tela segura com link para o Suporte
 *                 (que é acessível por qualquer autenticado).
 *
 * ⚠️ Não redirecionamos todos para "/": quem não tem Home também
 *    não poderia ver "/", entrando em loop de redirecionamento.
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
    // [NOVO] JURIDICO: qualquer rota protegida leva a "/suporte".
    // Evita que o Analista Jurídico veja "Acesso não autorizado"
    // ao abrir a raiz da aplicação (ex.: refresh em "/" ou URL digitada).
    if (perms.level === LEVELS.JURIDICO) {
      return <Redirect to="/suporte" />;
    }

    // Demais: tela segura com link para o Suporte.
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

      {/* Home – requer permissão canAccessDashboard
          (unidade 3: assessor/supervisor/coordenador; ou nível >= ADMINISTRATIVO)
          A rota "/" decide:
            • assessor unidade 3 → /home
            • JURIDICO            → /suporte (via guard)
            • todos os demais     → <Suporte /> (comportamento atual) */}
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

      {/* Comissões – requer permissão canAccessComissoes
          (mesma regra da Home) */}
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
      <Route path="/Visao_geral">
        <PeriodProvider>
          <ProtectedRouteWithPermission permission="canAccessReports">
            <Visao_geral />
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

      {/* Suporte
          - Landing de JURIDICO (aba Busca Cliente) e de supervisores
            fora da unidade 3 / das equipes liberadas.
          - Acessível por qualquer autenticado; a própria página faz a
            checagem de nível (>= SUPERVISAO OU === JURIDICO) e
            redireciona para "/" se necessário. */}
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

  // 3. Bootstrap: carrega APENAS a lista de colaboradores.
  //
  // ⚠️ NÃO chamar `loadCollaboratorsAndMetrics()` ou `loadRawMetrics()`
  // aqui. Essas funções aceitam `equipe`/`colaborador` como parâmetros,
  // mas, ao serem chamadas sem filtro, populam `collaborators` e
  // `rawMetrics` com dados GLOBAIS. Como cada página (Home, Analytics,
  // Funil, Visão Geral, Comissões) dispara seu próprio fetch escopado
  // em paralelo, a chamada global do App podia terminar DEPOIS e
  // sobrescrever os dados escopados — é a origem do bug "dados gerais
  // no primeiro login / em alguns momentos".
  //
  // `loadCollaborators()` apenas lista os colaboradores (sem métricas),
  // o que é suficiente para popular FilterBar, DashboardLayout, Ranking
  // e afins. As métricas ficam a cargo de cada página.
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