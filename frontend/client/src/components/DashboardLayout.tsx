// src/components/DashboardLayout.tsx
import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  DollarSign,
  GitBranch,
  BarChart3,
  Trophy,
  Bell,
  Menu,
  X,
  ChevronRight,
  TrendingUp,
  Settings,
  LogOut,
  FileCheck,
  Calendar,
  Headphones,
} from "lucide-react";
import { useAppStore } from "@/lib/dataStore";
import { logout } from "@/lib/auth";
import { cn } from "@/lib/utils";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/comissoes", label: "Comissões", icon: DollarSign },
  { path: "/funil", label: "Funil de Vendas", icon: GitBranch },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/ranking", label: "Ranking", icon: Trophy },
  //{ path: "/suporte", label: "Suporte", icon: Headphones },
  //{ path: "/notificacoes", label: "Notificações", icon: Bell },
  { path: "/configuration", label: "Configurações", icon: Settings },
];

const HIDE_PERIOD_FILTER_PATHS = ["/notificacoes", "/relatorio", "/configuration", "/suporte"];

interface DashboardLayoutProps {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
}

export default function DashboardLayout({ children, title, subtitle }: DashboardLayoutProps) {
  const [location, setLocation] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const {
    period,
    customStartDate,
    customEndDate,
    setPeriod,
    setCustomDateRange,
    notifications,
    currentUser,
    setCurrentUser,
    loadCollaborators,
    collaborators,
  } = useAppStore();

  // Atualiza a contagem de notificações não lidas
  useEffect(() => {
    const count = notifications.filter((n) => !n.read).length;
    setUnreadCount(count);
  }, [notifications]);

  // Carrega a lista de colaboradores assim que o usuário estiver logado e a lista estiver vazia
  useEffect(() => {
    if (currentUser && collaborators.length === 0) {
      loadCollaborators();
    }
  }, [currentUser, collaborators.length, loadCollaborators]);

  const formatBadgeCount = (count: number): string => {
    if (count === 0) return "";
    if (count > 99) return "99+";
    if (count > 9) return "9+";
    return count.toString();
  };

  const badgeValue = formatBadgeCount(unreadCount);

  const handleLogout = async () => {
    if (window.confirm("Tem certeza que deseja sair do sistema?")) {
      await logout();
      setCurrentUser(null);
      setLocation("/login");
    }
  };

  // Usa 'nome' e 'cargo' da view core.view_app_colaboradores
  const displayName = currentUser?.nome || "Carregando...";
  const displayRole = currentUser?.cargo || "Colaborador";   // ⬅️ cargo em vez de grupo
  const displayAvatar = currentUser?.avatar || displayName.charAt(0).toUpperCase();
  const displayRank = ""; // rank ainda não existe no modelo, pode ser adicionado depois

  const shouldShowPeriodFilter = !HIDE_PERIOD_FILTER_PATHS.includes(location);
  const isCustomPeriod = period === 'Custom';
  const dateInputDisabled = false;

  return (
    <div className="min-h-screen bg-[#f8f9fc] flex">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-64 flex-col transition-transform duration-300",
          "lg:flex",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
        style={{ background: "#09175b" }}
      >
        <div className="flex items-center gap-3 px-5 py-5 border-b border-white/10">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "#ffcc00" }}>
            <TrendingUp className="w-5 h-5 text-[#09175b]" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-white font-bold text-sm leading-tight">MADM Brasil</div>
            <div className="text-white/50 text-xs">Performance & Comissões</div>
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden text-white/60 hover:text-white ml-auto"
            aria-label="Fechar menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-4 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: "rgba(255,204,0,0.2)", color: "#ffcc00" }}>
              {displayAvatar}
            </div>
            <div className="min-w-0">
              <div className="text-white text-sm font-semibold truncate">{displayName}</div>
              <div className="text-white/50 text-xs truncate">{displayRole}</div>
            </div>
            {displayRank && (
              <div className="ml-auto text-xs font-bold px-2 py-0.5 rounded-full flex-shrink-0" style={{ background: "rgba(255,204,0,0.2)", color: "#ffcc00" }}>
                {displayRank}
              </div>
            )}
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.path;
            const showBadge = item.path === "/notificacoes" && unreadCount > 0;
            return (
              <Link key={item.path} href={item.path} onClick={() => setSidebarOpen(false)}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 cursor-pointer",
                    isActive
                      ? "text-[#ffcc00] bg-[rgba(255,204,0,0.2)]"
                      : "text-white/65 hover:text-white hover:bg-white/8"
                  )}
                  style={isActive ? { borderLeft: "3px solid #ffcc00", paddingLeft: "9px" } : {}}
                >
                  <Icon className="w-4.5 h-4.5 flex-shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {showBadge && (
                    <span
                      className="text-xs font-bold min-w-[20px] h-5 px-1.5 rounded-full flex items-center justify-center flex-shrink-0"
                      style={{ background: "#ef4444", color: "white" }}
                    >
                      {badgeValue}
                    </span>
                  )}
                  {isActive && <ChevronRight className="w-3.5 h-3.5 opacity-60" />}
                </div>
              </Link>
            );
          })}
        </nav>

        <div className="px-4 py-4 border-t border-white/10">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-150 text-white/65 hover:text-white hover:bg-white/8"
          >
            <LogOut className="w-4.5 h-4.5" />
            <span>Sair</span>
          </button>
          <div className="text-white/30 text-xs text-center mt-2">MADM Brasil v1.0</div>
        </div>
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="flex-1 flex flex-col lg:ml-64">
        <header className="sticky top-0 z-20 bg-white border-b border-border px-4 lg:px-8 py-4 flex items-center gap-4">
          <button
            aria-label="Abrir menu"
            type="button"
            className="lg:hidden p-2 rounded-lg hover:bg-gray-100 transition-colors"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-5 h-5 text-gray-600" />
          </button>

          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-[#09175b] leading-tight truncate">{title}</h1>
            {subtitle && <p className="text-sm text-gray-500 truncate">{subtitle}</p>}
          </div>

          <div className="flex items-center gap-3">
            {shouldShowPeriodFilter && (
              <div className="hidden sm:flex items-center gap-2 bg-gray-100 rounded-lg p-1">
                {(["Hoje", "Semana", "Mês"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-xs font-semibold transition-all",
                      period === p
                        ? "bg-white text-[#09175b] shadow-sm"
                        : "text-gray-500 hover:text-gray-700"
                    )}
                  >
                    {p}
                  </button>
                ))}
                <div className="w-px h-6 bg-gray-300 mx-1" />
                <div className="flex items-center gap-1">
                  <div className="relative">
                    <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" aria-hidden="true" />
                    <input
                      type="date"
                      value={customStartDate}
                      onChange={(e) => setCustomDateRange(e.target.value, customEndDate)}
                      disabled={dateInputDisabled}
                      className={cn(
                        "pl-7 pr-2 py-1.5 text-xs rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-[#09175b]",
                        dateInputDisabled && "bg-gray-100 text-gray-500 cursor-not-allowed"
                      )}
                      title="Data inicial"
                      aria-label="Data inicial"
                    />
                  </div>
                  <span className="text-gray-500 text-xs" aria-hidden="true">—</span>
                  <div className="relative">
                    <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" aria-hidden="true" />
                    <input
                      type="date"
                      value={customEndDate}
                      onChange={(e) => setCustomDateRange(customStartDate, e.target.value)}
                      disabled={dateInputDisabled}
                      className={cn(
                        "pl-7 pr-2 py-1.5 text-xs rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-1 focus:ring-[#09175b]",
                        dateInputDisabled && "bg-gray-100 text-gray-500 cursor-not-allowed"
                      )}
                      title="Data final"
                      aria-label="Data final"
                    />
                  </div>
                </div>
                {isCustomPeriod && (
                  <span className="ml-1 text-[10px] font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                    Personalizado
                  </span>
                )}
              </div>
            )}

            <Link href="/notificacoes">
              <button className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors" aria-label="Notificações">
                <Bell className="w-5 h-5 text-gray-600" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center px-1" style={{ background: "#ef4444", color: "white" }}>
                    {badgeValue}
                  </span>
                )}
              </button>
            </Link>

            <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={{ background: "#3e4612", color: "#ffcc00" }} aria-label="Avatar do usuário">
              {displayAvatar}
            </div>
          </div>
        </header>

        {/* Conteúdo NÃO é remontado quando as datas mudam */}
        <div className="flex-1 p-4 lg:p-8 pb-24 lg:pb-8">
          {children}
        </div>
      </div>

      <nav className="mobile-nav lg:hidden">
        <div className="flex items-center justify-around px-2 py-2">
          {navItems.slice(0, 5).map((item) => {
            const Icon = item.icon;
            const isActive = location === item.path;
            const showBadge = item.path === "/notificacoes" && unreadCount > 0;
            return (
              <Link key={item.path} href={item.path}>
                <div className="flex flex-col items-center gap-0.5 px-3 py-1.5 cursor-pointer">
                  <div className="relative">
                    <Icon className={cn("w-5 h-5 transition-colors", isActive ? "text-[#09175b]" : "text-gray-400")} aria-hidden="true" />
                    {showBadge && (
                      <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] rounded-full text-[9px] font-bold flex items-center justify-center px-0.5" style={{ background: "#ef4444", color: "white" }}>
                        {badgeValue}
                      </span>
                    )}
                  </div>
                  <span className={cn("text-[10px] font-medium transition-colors", isActive ? "text-[#09175b]" : "text-gray-400")}>
                    {item.label.split(" ")[0]}
                  </span>
                  {isActive && <div className="w-1 h-1 rounded-full bg-[#09175b]" aria-hidden="true" />}
                </div>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}