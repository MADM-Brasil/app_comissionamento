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
  Calendar,
  RefreshCw,
} from "lucide-react";
import { useAppStore } from "@/lib/dataStore";
import { logout } from "@/lib/auth";
import { cn } from "@/lib/utils";
import logoBranca from './img/LogoBranca.png';

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/comissoes", label: "Comissões", icon: DollarSign },
  { path: "/funil", label: "Funil de Vendas", icon: GitBranch },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/ranking", label: "Ranking", icon: Trophy },
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

  useEffect(() => {
    const count = notifications.filter((n) => !n.read).length;
    setUnreadCount(count);
  }, [notifications]);

  useEffect(() => {
    if (currentUser && collaborators.length === 0) {
      loadCollaborators();
    }
  }, [currentUser, collaborators.length, loadCollaborators]);

  const handleLogout = async () => {
    if (window.confirm("Tem certeza que deseja sair do sistema?")) {
      await logout();
      setCurrentUser(null);
      setLocation("/login");
    }
  };

  const displayName = currentUser?.nome || "Carregando...";
  const displayRole = currentUser?.cargo || "Colaborador";
  const displayAvatar = currentUser?.avatar || displayName.charAt(0).toUpperCase();

  const shouldShowPeriodFilter = !HIDE_PERIOD_FILTER_PATHS.includes(location);
  const isCustomPeriod = period === "Custom";

  const formatBadgeCount = (count: number): string => {
    if (count === 0) return "";
    if (count > 99) return "99+";
    if (count > 9) return "9+";
    return count.toString();
  };
  const badgeValue = formatBadgeCount(unreadCount);

  return (
    <div className="min-h-screen bg-[#f8fafc] flex">
      {/* Sidebar - 256px, fundo branco, borda direita */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-64 flex-col transition-transform duration-300",
          "lg:flex",
          "bg-white border-r border-[#e2e8f0]",
          sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
 {/* Marca */}
<div className="flex items-center gap-3 px-5 py-5 border-b border-[#e2e8f0]">
    <img src={logoBranca} alt="MADM Brasil" className="w-10 h-10 object-contain" />

  <div>
    <div className="text-[#0f172a] font-bold text-sm leading-tight">MADM Brasil</div>
    <div className="text-[#64748b] text-xs">Performance & Comissões</div>
  </div>
  <button
    type="button"
    onClick={() => setSidebarOpen(false)}
    className="lg:hidden text-[#64748b] hover:text-[#0f172a] ml-auto"
    aria-label="Fechar menu"
  >
    <X className="w-5 h-5" />
  </button>
</div>

        {/* Perfil do usuário */}
        <div className="px-4 py-4 border-b border-[#e2e8f0]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 bg-[#2F6FED] text-white">
              {displayAvatar}
            </div>
            <div className="min-w-0">
              <div className="text-[#0f172a] text-sm font-semibold truncate">{displayName}</div>
              <div className="text-[#64748b] text-xs truncate">{displayRole}</div>
            </div>
          </div>
        </div>

        {/* Navegação */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.path;
            return (
              <Link key={item.path} href={item.path} onClick={() => setSidebarOpen(false)}>
                <div
                  className={cn(
                    "sidebar-item",
                    isActive && "active"
                  )}
                >
                  <Icon className="w-4.5 h-4.5 flex-shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  {isActive && <ChevronRight className="w-3.5 h-3.5 opacity-60" />}
                </div>
              </Link>
            );
          })}
        </nav>

        {/* Logout */}
        <div className="px-4 py-4 border-t border-[#e2e8f0]">
          <button
            onClick={handleLogout}
            className="sidebar-item w-full text-[#DC2626] hover:bg-red-50"
          >
            <LogOut className="w-4.5 h-4.5" />
            <span>Sair</span>
          </button>
          <div className="text-[#94a3b8] text-xs text-center mt-2">MADM Brasil v1.0</div>
        </div>
      </aside>

      {/* Overlay mobile */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Conteúdo principal */}
      <div className="flex-1 flex flex-col lg:ml-64">
        {/* Topbar */}
        <header className="sticky top-0 z-20 bg-white border-b border-[#e2e8f0] px-4 lg:px-8 py-3 flex items-center gap-4">
          <button
            aria-label="Abrir menu"
            type="button"
            className="lg:hidden p-2 rounded-lg hover:bg-[#f1f5f9] transition-colors"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-5 h-5 text-[#334155]" />
          </button>

          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-[#0f172a] leading-tight truncate">{title}</h1>
            {subtitle && <p className="text-sm text-[#64748b] truncate">{subtitle}</p>}
          </div>

          <div className="flex items-center gap-3">
            {/* Seletor de período */}
            {shouldShowPeriodFilter && (
              <div className="hidden sm:flex items-center gap-2 bg-[#f1f5f9] rounded-lg p-1">
                {(["Hoje", "Semana", "Mês"] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={cn(
                      "px-3 py-1.5 rounded-md text-xs font-semibold transition-all",
                      period === p
                        ? "bg-white text-[#2F6FED] shadow-sm"
                        : "text-[#64748b] hover:text-[#0f172a]"
                    )}
                  >
                    {p}
                  </button>
                ))}
                <div className="w-px h-6 bg-[#cbd5e1] mx-1" />
                <div className="flex items-center gap-1">
                  <div className="relative">
                    <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#94a3b8]" aria-hidden="true" />
                    <input
                      type="date"
                      value={customStartDate}
                      onChange={(e) => setCustomDateRange(e.target.value, customEndDate)}
                      className="pl-7 pr-2 py-1.5 text-xs rounded-md border border-[#e2e8f0] bg-white focus:outline-none focus:ring-1 focus:ring-[#2F6FED]"
                      title="Data inicial"
                      aria-label="Data inicial"
                    />
                  </div>
                  <span className="text-[#94a3b8] text-xs" aria-hidden="true">—</span>
                  <div className="relative">
                    <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#94a3b8]" aria-hidden="true" />
                    <input
                      type="date"
                      value={customEndDate}
                      onChange={(e) => setCustomDateRange(customStartDate, e.target.value)}
                      className="pl-7 pr-2 py-1.5 text-xs rounded-md border border-[#e2e8f0] bg-white focus:outline-none focus:ring-1 focus:ring-[#2F6FED]"
                      title="Data final"
                      aria-label="Data final"
                    />
                  </div>
                </div>
                {isCustomPeriod && (
                  <span className="ml-1 text-[10px] font-medium text-[#2F6FED] bg-[#eff6ff] px-2 py-0.5 rounded-full">
                    Personalizado
                  </span>
                )}
              </div>
            )}

            {/* Botão Atualizar */}
            <button
              onClick={() => window.location.reload()}
              className="p-2 rounded-lg hover:bg-[#f1f5f9] transition-colors text-[#64748b]"
              aria-label="Atualizar dados"
              title="Atualizar dados"
            >
              <RefreshCw className="w-4 h-4" />
            </button>

            {/* Notificações */}
            <Link href="/notificacoes">
              <button className="relative p-2 rounded-lg hover:bg-[#f1f5f9] transition-colors" aria-label="Notificações">
                <Bell className="w-5 h-5 text-[#334155]" />
                {unreadCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center px-1 bg-[#DC2626] text-white">
                    {badgeValue}
                  </span>
                )}
              </button>
            </Link>

            {/* Avatar */}
            <div className="w-8 h-8 rounded-full bg-[#2F6FED] text-white flex items-center justify-center text-xs font-bold flex-shrink-0" aria-label="Avatar do usuário">
              {displayAvatar}
            </div>
          </div>
        </header>

        {/* Conteúdo rolável */}
        <main className="flex-1 p-4 lg:p-8 pb-24 lg:pb-8">
          {children}
        </main>
      </div>

      {/* Navegação mobile inferior */}
      <nav className="mobile-nav lg:hidden">
        <div className="flex items-center justify-around px-2 py-2">
          {navItems.slice(0, 5).map((item) => {
            const Icon = item.icon;
            const isActive = location === item.path;
            return (
              <Link key={item.path} href={item.path}>
                <div className="flex flex-col items-center gap-0.5 px-3 py-1.5 cursor-pointer">
                  <Icon className={cn("w-5 h-5 transition-colors", isActive ? "text-[#2F6FED]" : "text-[#94a3b8]")} aria-hidden="true" />
                  <span className={cn("text-[10px] font-medium transition-colors", isActive ? "text-[#2F6FED]" : "text-[#94a3b8]")}>
                    {item.label.split(" ")[0]}
                  </span>
                  {isActive && <div className="w-1 h-1 rounded-full bg-[#2F6FED]" aria-hidden="true" />}
                </div>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}