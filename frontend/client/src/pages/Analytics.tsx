// src/pages/Analytics.tsx
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, formatCurrency } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import { getCollaboratorMeta } from "@/lib/metricsHelper";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from "recharts";
import {
  TrendingUp, TrendingDown, Target, Users,
  ShoppingBag, Award, DollarSign, FileCheck,
  BarChart2, Activity, RefreshCw, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchLeadsRecebidos,
  fetchAssinados,
  fetchGanhos,
  fetchProtocolados,
  fetchPerdidos,
  fetchCollaborators,
} from "@/lib/api";

// ========== FUNÇÃO AUXILIAR PARA FORMATAÇÃO DE INTEIROS ==========
const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3007/api";

// ========== EQUIPAS EXCLUÍDAS ==========
const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário','BackOffice',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro'
];

const EXCLUDED_CARGOS = [
  // Nenhum acesso (NONE)
  "desativado",
  "assistente",
  "analista juridico",
  "gestor de projetos",
  "analista",
  "analista de discadora",
  
  // Supervisão
  "supervisor",
  
  // Coordenador
  "coordenador",
  
  // Administrativo
  "salesops",
  "ceo",
  "analista de crm",
  "desenvolvedor",
  "diretora",
  "analista de dados",
  "desenvolvedor make",
];

function isExcludedTeam(teamName: string): boolean {
  return EXCLUDED_TEAMS.includes(teamName);
}

function isExcludedCargo(cargo: string): boolean {
  const normalized = (cargo || '').trim().toLowerCase();
  return EXCLUDED_CARGOS.some(g => g.toLowerCase() === normalized);
}

// ========== Utilitários de datas ==========
function getMonday(date: Date): Date {
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(date);
  monday.setDate(date.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function getSunday(date: Date): Date {
  const monday = getMonday(date);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return sunday;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getChartDateRange(period: string, currentStart: string, currentEnd: string): { start: string; end: string } {
  if (period === "Hoje") {
    const today = new Date();
    const monday = getMonday(today);
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 1);
    return {
      start: formatDate(monday),
      end: formatDate(endDate),
    };
  }
  if (period === "Semana") {
    const today = new Date();
    const currentSunday = getSunday(today);
    const previousMonday = getMonday(today);
    previousMonday.setDate(previousMonday.getDate() - 7);
    const endDate = new Date(currentSunday);
    endDate.setDate(currentSunday.getDate() + 1);
    return {
      start: formatDate(previousMonday),
      end: formatDate(endDate),
    };
  }
  return { start: currentStart, end: currentEnd };
}

function isWeekday(dateStr: string): boolean {
  const date = new Date(dateStr + "T12:00:00Z");
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

// ========== Utilitários gerais ==========
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs max-h-60 overflow-y-auto">
        <p className="font-semibold text-gray-700 mb-1">{label}</p>
        {payload.map((entry: any, i: number) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {formatInt(entry.value)}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

function KpiCard({
  label, value, target, unit, icon: Icon, color, delay = 0, simple = false,
}: {
  label: string; value: number; target: number; unit: string;
  icon: React.ElementType; color: string; delay?: number; simple?: boolean;
}) {
  const pct = target > 0 ? Math.round((value / target) * 100) : 0;
  const displayValue = unit === "R$" ? formatCurrency(value) : unit === "%" ? `${value.toFixed(1)}%` : formatInt(value);

  return (
    <div className="madm-card p-4 animate-fade-in-up" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${color}15` }}>
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
        {!simple && (
          <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full",
            pct >= 100 ? "bg-green-50 text-green-700" : pct >= 70 ? "bg-yellow-50 text-yellow-700" : "bg-blue-50 text-blue-700")}>
            {pct}%
          </span>
        )}
      </div>
      <div className="text-xl font-black text-[#09175b]">{displayValue}</div>
      <div className="text-xs text-gray-500 mb-2">{label}</div>
      {!simple && (
        <>
          <div className="madm-progress-bar">
            <div className="madm-progress-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <div className="text-[10px] text-gray-400 mt-1">
            Meta: {unit === "R$" ? formatCurrency(target) : formatInt(target)}
          </div>
        </>
      )}
    </div>
  );
}

export default function Analytics() {
  const [, navigate] = useLocation();
  const {
    currentStartDate, currentEndDate, period,
    collaborators, globalConfig, currentUser,
    loadCollaboratorsAndMetrics,
    loadWeeklyPerformanceData,
    rawMetrics,
    loadRawMetrics,
  } = useAppStore();

  const { hasPermission } = useAccessControl();

  useEffect(() => {
    if (!hasPermission("canAccessReports")) navigate("/");
  }, [hasPermission, navigate]);

  const [filters, setFilters] = useState<{
    equipe: string; colaborador: string; colaboradorId?: number; produto: string;
  }>({ equipe: "todas", colaborador: "todos", produto: "Todos" });

  const [dailyChartData, setDailyChartData] = useState<any[]>([]);
  const [totalLeads, setTotalLeads] = useState(0);
  const [totalAssinados, setTotalAssinados] = useState(0);
  const [isFirstLoad, setIsFirstLoad] = useState(true);
  const [userBonus, setUserBonus] = useState<number | null>(null);
  const [bonusLoading, setBonusLoading] = useState(true);
  const [bonusError, setBonusError] = useState<string | null>(null);
  const [isExcluded, setIsExcluded] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Controle para evitar carregamento com filtros iniciais vazios
  const [isFirstFilterApplied, setIsFirstFilterApplied] = useState(false);

  const equipe = filters.equipe;
  const colaborador = filters.colaborador;
  const colaboradorId = filters.colaboradorId;
  const produto = filters.produto;

  const initialLoadDone = useRef(false);
  const lastFiltersRef = useRef(filters);
  const lastDatesRef = useRef({ start: currentStartDate, end: currentEndDate });
  const isFetchingRef = useRef(false);
  const timeoutIdRef = useRef<NodeJS.Timeout | null>(null);
  const lastFetchChartTime = useRef<number>(0);
  const CHART_CACHE_TTL = 60000; // 1 minuto

  // ========== TIMEOUT DE SEGURANÇA: FORÇA O PRIMEIRO FILTRO APÓS 3 SEGUNDOS ==========
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!isFirstFilterApplied) {
        console.warn("⏱️ Analytics: timeout de segurança forçando primeiro filtro");
        setIsFirstFilterApplied(true);
      }
    }, 3000);
    return () => clearTimeout(timeout);
  }, [isFirstFilterApplied]);

  // ========== Verificar se o usuário é excluído ==========
  const currentUserData = useMemo(() => {
    if (!currentUser?.id) return null;
    return collaborators.find(c => c.id === currentUser.id);
  }, [collaborators, currentUser]);

  useEffect(() => {
    if (!currentUserData) return;
    const teamExcluded = isExcludedTeam(currentUserData.equipeNome);
    const cargoExcluded = isExcludedCargo(currentUserData.cargo);
    setIsExcluded(teamExcluded || cargoExcluded);
  }, [currentUserData]);

  // ========== Função de recarga dos dados (com verificação de necessidade) ==========
  const reloadData = useCallback(async (showRefreshing = false) => {
    const datesChanged =
      currentStartDate !== lastDatesRef.current.start ||
      currentEndDate !== lastDatesRef.current.end;
    const filtersChanged =
      filters.equipe !== lastFiltersRef.current.equipe ||
      filters.colaborador !== lastFiltersRef.current.colaborador ||
      filters.produto !== lastFiltersRef.current.produto;

    // Se nada mudou e já carregou, não recarrega (exceto se rawMetrics estiver vazio)
    const metricsEmpty = rawMetrics.assinados === 0 && rawMetrics.emitidos === 0 && rawMetrics.ganhos === 0;
    if (initialLoadDone.current && !datesChanged && !filtersChanged && !metricsEmpty) {
      return;
    }

    if (showRefreshing) setRefreshing(true);
    try {
      const equipeApi = equipe === "todas" ? undefined : equipe;
      const colaboradorApi = colaborador === "todos" ? undefined : colaborador;
      const produtoApi = produto === "Todos" ? undefined : produto;

      if (datesChanged || filtersChanged || metricsEmpty) {
        await loadCollaboratorsAndMetrics(equipeApi, colaboradorApi, colaboradorId, produtoApi);
        await loadRawMetrics({
          equipeNome: equipeApi,
          colaboradorNome: colaboradorApi,
          colaboradorId: colaboradorId,
          produto: produtoApi,
        });
        await loadWeeklyPerformanceData();
      }

      lastDatesRef.current = { start: currentStartDate, end: currentEndDate };
      lastFiltersRef.current = { ...filters };
      initialLoadDone.current = true;
    } catch (err) {
      console.error("❌ Analytics: erro ao recarregar dados:", err);
    } finally {
      if (showRefreshing) setRefreshing(false);
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate, filters, equipe, colaborador, colaboradorId, produto, rawMetrics, loadCollaboratorsAndMetrics, loadRawMetrics, loadWeeklyPerformanceData]);

  // ========== CARREGAMENTO INICIAL – SÓ ACONTECE APÓS O PRIMEIRO FILTRO ==========
  useEffect(() => {
    if (!currentStartDate || !currentEndDate) return;

    const datesChanged =
      currentStartDate !== lastDatesRef.current.start ||
      currentEndDate !== lastDatesRef.current.end;
    const filtersChanged =
      filters.equipe !== lastFiltersRef.current.equipe ||
      filters.colaborador !== lastFiltersRef.current.colaborador ||
      filters.produto !== lastFiltersRef.current.produto;

    // Só carrega se já recebeu o primeiro filtro ou se já carregou antes
    const shouldLoad = isFirstFilterApplied || initialLoadDone.current;

    if (!shouldLoad) return;

    if (initialLoadDone.current && !datesChanged && !filtersChanged) return;

    lastDatesRef.current = { start: currentStartDate, end: currentEndDate };
    lastFiltersRef.current = { ...filters };
    setIsFirstLoad(true);

    // Timeout de segurança
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    timeoutIdRef.current = setTimeout(() => {
      if (loading) {
        console.warn("⏱️ Analytics: timeout de segurança forçando fim do loading");
        setLoading(false);
        setIsFirstLoad(false);
      }
    }, 15000);

    const load = async () => {
      setLoading(true);
      try {
        await reloadData(false);
        initialLoadDone.current = true;
        setIsFirstLoad(false);
      } catch (err) {
        console.error("❌ Analytics: erro ao carregar dados:", err);
      } finally {
        setLoading(false);
        if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
      }
    };

    load();
  }, [currentStartDate, currentEndDate, filters, reloadData, loading, isFirstFilterApplied]);

  // ========== HANDLER DO FILTERBAR ==========
  const handleFilterChange = (newFilters: any) => {
    setFilters(newFilters);
    if (!isFirstFilterApplied) {
      setIsFirstFilterApplied(true);
    }
  };

  // ========== BUSCA DO BÔNUS ==========
  useEffect(() => {
    if (!currentUser?.id) {
      setBonusLoading(false);
      setUserBonus(0);
      return;
    }

    if (isExcluded) {
      setBonusLoading(false);
      setUserBonus(0);
      setBonusError(null);
      return;
    }

    const fetchBonus = async () => {
      setBonusLoading(true);
      setBonusError(null);
      try {
        const mes = currentStartDate?.substring(0, 7) || new Date().toISOString().slice(0, 7);
        let url = `${API_BASE}/metricas-assessores?mes=${mes}&colaborador_id=${currentUser.id}`;
        let res = await fetch(url, { credentials: 'include' });
        let data = await res.json();

        let bonus = 0;
        let found = false;

        if (data.success && data.data && data.data.length > 0) {
          const raw = data.data[0].comissao_bonus;
          bonus = typeof raw === 'number' ? raw : parseFloat(raw);
          if (!isNaN(bonus) && bonus > 0) found = true;
        }

        if (!found && currentUser.email) {
          url = `${API_BASE}/metricas-assessores?mes=${mes}&email=${encodeURIComponent(currentUser.email)}`;
          res = await fetch(url, { credentials: 'include' });
          data = await res.json();
          if (data.success && data.data && data.data.length > 0) {
            const raw = data.data[0].comissao_bonus;
            bonus = typeof raw === 'number' ? raw : parseFloat(raw);
            if (!isNaN(bonus)) found = true;
          }
        }

        if (found && bonus > 0) {
          setUserBonus(bonus);
        } else {
          setUserBonus(0);
          setBonusError("Registro não encontrado.");
        }
      } catch (err) {
        console.error("❌ [BÔNUS] Erro na requisição:", err);
        setUserBonus(0);
        setBonusError("Erro na requisição");
      } finally {
        setBonusLoading(false);
      }
    };

    fetchBonus();
  }, [currentUser, currentStartDate, isExcluded]);

  // ========== GRÁFICO DE EVOLUÇÃO DIÁRIA (COM CACHE) ==========
  const chartDateRange = useMemo(() => {
    return getChartDateRange(period, currentStartDate, currentEndDate);
  }, [period, currentStartDate, currentEndDate]);

  const [chartVersion, setChartVersion] = useState(0);

  const reloadDataWithChart = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    try {
      const equipeApi = equipe === "todas" ? undefined : equipe;
      const colaboradorApi = colaborador === "todos" ? undefined : colaborador;
      const produtoApi = produto === "Todos" ? undefined : produto;
      await loadCollaboratorsAndMetrics(equipeApi, colaboradorApi, colaboradorId, produtoApi);
      await loadRawMetrics({
        equipeNome: equipeApi,
        colaboradorNome: colaboradorApi,
        colaboradorId: colaboradorId,
        produto: produtoApi,
      });
      await loadWeeklyPerformanceData();
      setChartVersion(prev => prev + 1);
    } catch (err) {
      console.error("❌ Analytics: erro ao recarregar dados com gráfico:", err);
    } finally {
      if (showRefreshing) setRefreshing(false);
      setLoading(false);
    }
  }, [equipe, colaborador, colaboradorId, produto, loadCollaboratorsAndMetrics, loadRawMetrics, loadWeeklyPerformanceData]);

  // Efeito principal do gráfico (com cache)
  useEffect(() => {
    if (!chartDateRange.start || !chartDateRange.end) return;

    const abortController = new AbortController();
    const signal = abortController.signal;

    const fetchChartData = async () => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;

      const now = Date.now();
      const shouldFetch = (now - lastFetchChartTime.current) > CHART_CACHE_TTL || dailyChartData.length === 0;

      if (!shouldFetch && dailyChartData.length > 0) {
        isFetchingRef.current = false;
        return;
      }

      try {
        const equipeApi = equipe === "todas" ? undefined : equipe;
        const colaboradorApi = colaborador === "todos" ? undefined : colaborador;
        const produtoApi = produto === "Todos" ? undefined : produto;

        const baseParams = {
          start: chartDateRange.start,
          end: chartDateRange.end,
          equipe: equipeApi,
          colaborador: colaboradorApi,
          colaboradorId: colaboradorId,
          produto: produtoApi,
          granularity: 'daily' as const,
        };

        const [leadsData, assinadosData, ganhosData, protocoladosData, perdidosData] = await Promise.all([
          fetchLeadsRecebidos(baseParams),
          fetchAssinados(baseParams),
          fetchGanhos(baseParams),
          fetchProtocolados(baseParams),
          fetchPerdidos(baseParams),
        ]);

        if (signal.aborted) return;

        const dataMap = new Map<string, { leads: number; assinados: number; ganhos: number; protocolados: number; perdidos: number }>();

        const processData = (data: any[], field: 'leads' | 'assinados' | 'ganhos' | 'protocolados' | 'perdidos') => {
          data.forEach(item => {
            let rawDate = item.data || item.periodo;
            if (!rawDate) return;
            const dateStr = rawDate.split('T')[0];
            if (!dateStr) return;
            const existing = dataMap.get(dateStr) || { leads: 0, assinados: 0, ganhos: 0, protocolados: 0, perdidos: 0 };
            existing[field] += Number(item.total) || 0;
            dataMap.set(dateStr, existing);
          });
        };

        processData(leadsData, 'leads');
        processData(assinadosData, 'assinados');
        processData(ganhosData, 'ganhos');
        processData(protocoladosData, 'protocolados');
        processData(perdidosData, 'perdidos');

        const allDates: string[] = [];
        const startDate = new Date(Date.UTC(
          parseInt(chartDateRange.start.slice(0,4)),
          parseInt(chartDateRange.start.slice(5,7)) - 1,
          parseInt(chartDateRange.start.slice(8,10))
        ));
        const endDate = new Date(Date.UTC(
          parseInt(chartDateRange.end.slice(0,4)),
          parseInt(chartDateRange.end.slice(5,7)) - 1,
          parseInt(chartDateRange.end.slice(8,10))
        ));
        const current = new Date(startDate);
        while (current < endDate) {
          const dateStr = current.toISOString().split('T')[0];
          if (period === "Semana") {
            if (isWeekday(dateStr)) {
              allDates.push(dateStr);
            }
          } else {
            allDates.push(dateStr);
          }
          current.setUTCDate(current.getUTCDate() + 1);
        }

        if (allDates.length === 0 && chartDateRange.start && chartDateRange.end) {
          const today = new Date(endDate);
          today.setUTCDate(today.getUTCDate() - 1);
          allDates.push(today.toISOString().split('T')[0]);
        }

        const chartArray = allDates.map(date => {
          const values = dataMap.get(date) || { leads: 0, assinados: 0, ganhos: 0, protocolados: 0, perdidos: 0 };
          const [year, month, day] = date.split('-');
          const displayDate = `${day}/${month}`;
          return {
            date: displayDate,
            fullDate: date,
            leads: values.leads,
            assinados: values.assinados,
            ganhos: values.ganhos,
            protocolados: values.protocolados,
            perdidos: values.perdidos,
          };
        });

        setDailyChartData(chartArray);
        lastFetchChartTime.current = Date.now();

        const totalLeadsSum = Array.from(dataMap.values()).reduce((s, v) => s + v.leads, 0);
        const totalAssinadosSum = Array.from(dataMap.values()).reduce((s, v) => s + v.assinados, 0);
        setTotalLeads(totalLeadsSum);
        setTotalAssinados(totalAssinadosSum);
        setApiError(null);
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.error("❌ Analytics: erro no gráfico:", err);
          setApiError(err.message || "Erro ao carregar dados do gráfico");
        }
      } finally {
        isFetchingRef.current = false;
      }
    };

    fetchChartData();
    return () => {
      abortController.abort();
      isFetchingRef.current = false;
    };
  }, [chartDateRange, equipe, colaborador, colaboradorId, produto, period, chartVersion, dailyChartData.length]);

  // ========== DADOS PARA KPIS ==========
  const totals = rawMetrics;
  const isSpecialGroup = produto === 'Quinquenio' || produto === 'Concomitante';

  // ========== METAS DO CONJUNTO FILTRADO ==========
  const filteredCollaborators = useMemo(() => {
    return collaborators.filter(c => {
      if (isExcludedTeam(c.equipeNome)) return false;
      if (equipe !== "todas" && c.equipeNome !== equipe) return false;
      if (colaborador !== "todos" && c.name !== colaborador) return false;
      return true;
    });
  }, [collaborators, equipe, colaborador]);

  const baseCollaborators = useMemo(() => {
    return filteredCollaborators.filter(c => {
      const cargo = (c.cargo || '').trim().toLowerCase();
      if (cargo === 'supervisor' || cargo === 'coordenador' || cargo === 'administrativo') return false;
      if (cargo === 'desativado') return false;
      return true;
    });
  }, [filteredCollaborators]);

  const { targetAssinados, targetGanhos } = useMemo(() => {
    if (equipe === "todas" && colaborador === "todos") {
      if (currentStartDate === currentEndDate) return { targetAssinados: 100, targetGanhos: 100 };
      if (new Date(currentEndDate).getTime() - new Date(currentStartDate).getTime() <= 7 * 86400000) return { targetAssinados: 500, targetGanhos: 500 };
      return { targetAssinados: 2000, targetGanhos: 2000 };
    }
    const periodoMeta = 'mensal';
    const ass = baseCollaborators.reduce((sum, c) => sum + getCollaboratorMeta(c, periodoMeta, 'assinados'), 0);
    const gan = baseCollaborators.reduce((sum, c) => sum + getCollaboratorMeta(c, periodoMeta, 'ganhos'), 0);
    return { targetAssinados: ass, targetGanhos: gan };
  }, [baseCollaborators, equipe, colaborador, currentStartDate, currentEndDate]);

  const percentAssinados = targetAssinados > 0 ? (totals.assinados / targetAssinados) * 100 : 0;
  const percentGanhos = targetGanhos > 0 ? (totals.ganhos / targetGanhos) * 100 : 100;
  const goalProgress = Math.min(percentAssinados, percentGanhos);

  // ========== DADOS DO USUÁRIO (metas batidas) ==========
  const periodoMetaUser = period === 'Hoje' ? 'diario' : period === 'Semana' ? 'semanal' : 'mensal';
  const userMetasBatidas = useMemo(() => {
    if (!currentUserData) return 0;
    const assinados = currentUserData.assinados || 0;
    const ganhos = isSpecialGroup ? 0 : (currentUserData.ganhos || 0);
    const pesoAss = getCollaboratorMeta(currentUserData, periodoMetaUser, 'assinados');
    const pesoGan = getCollaboratorMeta(currentUserData, periodoMetaUser, 'ganhos');
    if (pesoGan === 0) return Math.floor(assinados / (pesoAss || 1));
    return Math.floor(Math.min(assinados / (pesoAss || 1), ganhos / (pesoGan || 1)));
  }, [currentUserData, periodoMetaUser, isSpecialGroup]);

  const userBonusCiclo = userBonus !== null ? userBonus : 0;

  const taxaConversaoGeral = totalLeads > 0 ? (totalAssinados / totalLeads) * 100 : 0;
  const mediaDiariaVendas = dailyChartData.length > 0 ? totalAssinados / dailyChartData.length : 0;

  // Gráficos de funil e conversão
  const funnelChartData = [
    { name: "Emitidos", value: totals.emitidos, color: "#09175b" },
    { name: "Assinados", value: totals.assinados, color: "#34a853" },
    { name: "Protocolados", value: totals.protocolados, color: "#045b5b" },
    { name: "Ganhos", value: totals.ganhos, color: "#f59e0b" },
    { name: "Perdidos", value: totals.perdidos, color: "#ef4444" },
  ].filter(item => item.value > 0);

  const conversionByStage = useMemo(() => {
    const conversions = [];
    const emitidos = totals.emitidos;
    const assinados = totals.assinados;
    const protocolados = totals.protocolados;
    const ganhos = totals.ganhos;
    const perdidos = totals.perdidos;
    if (emitidos > 0) conversions.push({ stage: "Emitidos → Assinados", value: parseFloat(((assinados / emitidos) * 100).toFixed(1)) });
    else conversions.push({ stage: "Emitidos → Assinados", value: 0 });
    if (assinados > 0) conversions.push({ stage: "Assinados → Protocolados", value: parseFloat(((protocolados / assinados) * 100).toFixed(1)) });
    else conversions.push({ stage: "Assinados → Protocolados", value: 0 });
    if (protocolados > 0) conversions.push({ stage: "Protocolados → Ganhos", value: parseFloat(((ganhos / protocolados) * 100).toFixed(1)) });
    else conversions.push({ stage: "Protocolados → Ganhos", value: 0 });
    if (assinados > 0) conversions.push({ stage: "Assinados → Ganhos", value: parseFloat(((ganhos / assinados) * 100).toFixed(1)) });
    else conversions.push({ stage: "Assinados → Ganhos", value: 0 });
    if (ganhos > 0) conversions.push({ stage: "Ganhos → Perdidos", value: parseFloat(((perdidos / ganhos) * 100).toFixed(1)) });
    else conversions.push({ stage: "Ganhos → Perdidos", value: 0 });
    return conversions;
  }, [totals]);

  const COLORS = ["#09175b", "#34a853", "#045b5b", "#f59e0b", "#ef4444"];
  const hasActiveFilters = equipe !== "todas" || colaborador !== "todos" || produto !== "Todos";

  const renderBonusCard = () => {
    if (isExcluded) {
      return (
        <div className="bg-gray-50 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-[#09175b]" />
            <span className="text-xs font-semibold text-gray-700">Bônus por Ciclo</span>
          </div>
          <div className="text-lg font-black text-[#09175b]">--</div>
          <div className="text-xs text-gray-500">Esse tipo de perfil não comissiona</div>
        </div>
      );
    }

    if (bonusLoading) {
      return (
        <div className="bg-gray-50 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-[#09175b]" />
            <span className="text-xs font-semibold text-gray-700">Bônus por Ciclo</span>
          </div>
          <div className="text-2xl font-black text-[#09175b]">Carregando...</div>
          <div className="text-xs text-gray-500"> </div>
        </div>
      );
    }

    return (
      <div className="bg-gray-50 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <DollarSign className="w-4 h-4 text-[#09175b]" />
          <span className="text-xs font-semibold text-gray-700">Bônus por Ciclo</span>
        </div>
        <div className="text-2xl font-black text-[#09175b]">{formatCurrency(userBonusCiclo)}</div>
        <div className="text-xs text-gray-500">
          {bonusError || "valor do banco (comissao_bonus)"}
        </div>
      </div>
    );
  };

  const chartPeriodDesc = period === "Hoje" ? "(semana atual)" : period === "Semana" ? "(duas últimas semanas, apenas dias úteis)" : "";
  const isGraphLoading = isFirstLoad && dailyChartData.length === 0 && !apiError;

  // Se o primeiro filtro ainda não foi aplicado, exibe um loader
  if (!isFirstFilterApplied) {
    return (
      <DashboardLayout title="Analytics" subtitle="Métricas avançadas, comissões e indicadores de performance">
        <div className="flex justify-center items-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-[#09175b]" />
          <span className="ml-2 text-gray-500">Aguardando configuração dos filtros...</span>
        </div>
      </DashboardLayout>
    );
  }

  if (loading && collaborators.length === 0) {
    return (
      <DashboardLayout title="Analytics" subtitle="Métricas avançadas...">
        <div className="flex justify-center items-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-[#09175b]" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title="Analytics" subtitle="Métricas avançadas, comissões e indicadores de performance">
      {/* Indicador de atualização em tempo real */}
      <div className="flex items-center justify-end gap-2 mb-2">
        {refreshing && (
          <div className="flex items-center gap-1.5 text-xs text-gray-500 animate-pulse">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Atualizando dados...</span>
          </div>
        )}
        <span className="text-[10px] text-gray-400">
          Atualizado {new Date().toLocaleTimeString()}
        </span>
      </div>

      <FilterBar onFilterChange={handleFilterChange} showColaboradorFilter={true} className="mb-6" />

      {hasActiveFilters && (
        <div className="mb-4 px-4 py-2 bg-blue-50 rounded-lg text-xs text-blue-700 flex items-center gap-2 flex-wrap">
          <span>📊</span>
          <span>
            Dados filtrados por:
            {equipe !== "todas" && ` Equipe ${equipe}`}
            {colaborador !== "todos" && ` - ${colaborador}`}
            {produto !== "Todos" && ` • Produto: ${produto}`}
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KpiCard label="Comissão Estimada" value={userMetasBatidas * userBonusCiclo} target={5000} unit="R$" icon={DollarSign} color="#09175b" simple />
        <KpiCard label={isSpecialGroup ? "Assinados" : "Vendas Fechadas"} value={isSpecialGroup ? totals.assinados : totals.ganhos}
          target={isSpecialGroup ? targetAssinados : targetGanhos} unit="" icon={FileCheck} color="#34a853" />
        <KpiCard label="Protocolados" value={totals.protocolados} target={60} unit="" icon={BarChart2} color="#045b5b" />
        <KpiCard label="Progresso da Meta" value={goalProgress} target={100} unit="%" icon={Activity} color="#f59e0b" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div className="madm-card p-4 animate-fade-in-up">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-500">Performance no Período</span>
            {percentAssinados >= 100 ? <TrendingUp className="w-4 h-4 text-green-500" /> : <TrendingDown className="w-4 h-4 text-red-500" />}
          </div>
          <div className="text-2xl font-black text-[#09175b]">{percentAssinados.toFixed(1)}%</div>
          <div className="text-xs text-gray-400 mt-1">{formatInt(totals.assinados)} / {formatInt(targetAssinados)} assinados</div>
          <div className="madm-progress-bar mt-2"><div className="madm-progress-fill" style={{ width: `${Math.min(percentAssinados, 100)}%` }} /></div>
        </div>
        <div className="madm-card p-4 animate-fade-in-up" style={{ animationDelay: "80ms" }}>
          <div className="flex items-center justify-between mb-2"><span className="text-xs text-gray-500">Taxa de Conversão</span><Target className="w-4 h-4 text-[#09175b]" /></div>
          <div className="text-2xl font-black text-[#09175b]">{taxaConversaoGeral.toFixed(1)}%</div>
          <div className="text-xs text-gray-400 mt-1">{formatInt(totalAssinados)} vendas / {formatInt(totalLeads)} leads</div>
        </div>
        <div className="madm-card p-4 animate-fade-in-up" style={{ animationDelay: "160ms" }}>
          <div className="flex items-center justify-between mb-2"><span className="text-xs text-gray-500">Média Diária (assinados)</span><ShoppingBag className="w-4 h-4 text-[#34a853]" /></div>
          <div className="text-2xl font-black text-[#09175b]">{mediaDiariaVendas.toFixed(1)}</div>
          <div className="text-xs text-gray-400 mt-1">últimos {formatInt(dailyChartData.length)} dias</div>
        </div>
        <div className="madm-card p-4 animate-fade-in-up" style={{ animationDelay: "240ms" }}>
          <div className="flex items-center justify-between mb-2"><span className="text-xs text-gray-500">Total de Leads</span><Users className="w-4 h-4 text-[#f59e0b]" /></div>
          <div className="text-2xl font-black text-[#09175b]">{formatInt(totalLeads)}</div>
          <div className="text-xs text-gray-400 mt-1">no período</div>
        </div>
      </div>

      <div className="madm-card p-5 mb-6 animate-fade-in-up" style={{ animationDelay: "320ms" }}>
        <h3 className="text-sm font-bold text-[#09175b] mb-4">Evolução Diária {chartPeriodDesc}</h3>
        <p className="text-xs text-gray-500 mb-2">
          Período: {chartDateRange.start} a {chartDateRange.end}
        </p>
        {isGraphLoading && (
          <div className="flex justify-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-[#09175b]" />
          </div>
        )}
        {apiError && (
          <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm mb-4">
            Erro: {apiError}
          </div>
        )}
        {!isGraphLoading && dailyChartData.length === 0 && !apiError && (
          <div className="flex items-center justify-center h-[260px] text-gray-400 text-sm">Nenhum dado disponível para o período</div>
        )}
        {dailyChartData.length > 0 && (
          <ResponsiveContainer width="100%" height={320}>
            <AreaChart data={dailyChartData}>
              <defs>
                <linearGradient id="colorLeads" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#34a853" stopOpacity={0.2} /><stop offset="95%" stopColor="#34a853" stopOpacity={0} /></linearGradient>
                <linearGradient id="colorAssinados" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#09175b" stopOpacity={0.2} /><stop offset="95%" stopColor="#09175b" stopOpacity={0} /></linearGradient>
                <linearGradient id="colorGanhos" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f59e0b" stopOpacity={0.2} /><stop offset="95%" stopColor="#f59e0b" stopOpacity={0} /></linearGradient>
                <linearGradient id="colorProtocolados" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#045b5b" stopOpacity={0.2} /><stop offset="95%" stopColor="#045b5b" stopOpacity={0} /></linearGradient>
                <linearGradient id="colorPerdidos" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#ef4444" stopOpacity={0.2} /><stop offset="95%" stopColor="#ef4444" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} width={30} />
              <Tooltip content={<CustomTooltip />} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="leads" stroke="#34a853" strokeWidth={2} fill="url(#colorLeads)" name="Leads" />
              <Area type="monotone" dataKey="assinados" stroke="#09175b" strokeWidth={2} fill="url(#colorAssinados)" name="Assinados" />
              <Area type="monotone" dataKey="ganhos" stroke="#f59e0b" strokeWidth={2} fill="url(#colorGanhos)" name="Ganhos" />
              <Area type="monotone" dataKey="protocolados" stroke="#045b5b" strokeWidth={2} fill="url(#colorProtocolados)" name="Protocolados" />
              <Area type="monotone" dataKey="perdidos" stroke="#ef4444" strokeWidth={2} fill="url(#colorPerdidos)" name="Perdidos" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div className="madm-card p-5 animate-fade-in-up" style={{ animationDelay: "480ms" }}>
          <h3 className="text-sm font-bold text-[#09175b] mb-4">Distribuição por Etapa</h3>
          {funnelChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <PieChart>
                <Pie data={funnelChartData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={2} dataKey="value"
                  label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`} labelLine={true}>
                  {funnelChartData.map((entry, index) => <Cell key={index} fill={entry.color || COLORS[index % COLORS.length]} />)}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          ) : <div className="h-[260px] text-center text-gray-400 text-sm">Nenhum dado disponível</div>}
          <div className="flex flex-wrap justify-center gap-3 mt-3">
            {funnelChartData.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: item.color || COLORS[i % COLORS.length] }} />
                <span className="text-[10px] text-gray-600">{item.name}</span>
                <span className="text-[10px] font-bold text-gray-800">{formatInt(item.value)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="madm-card p-5 animate-fade-in-up" style={{ animationDelay: "560ms" }}>
          <h3 className="text-sm font-bold text-[#09175b] mb-4">Taxa de Conversão por Estágio</h3>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={conversionByStage} layout="vertical" margin={{ left: 10, right: 30, top: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: "#9ca3af" }} tickFormatter={(v) => `${v}%`} />
              <YAxis type="category" dataKey="stage" tick={{ fontSize: 9, fill: "#374151" }} width={150} axisLine={false} tickLine={false} />
              <Tooltip formatter={(value: any) => [`${value}%`, "Conversão"]} contentStyle={{ fontSize: 11 }} />
              <Bar dataKey="value" radius={[0, 6, 6, 0]} name="Conversão">
                {conversionByStage.map((entry, index) => <Cell key={index} fill={entry.value >= 60 ? "#34a853" : entry.value >= 40 ? "#f59e0b" : "#ef4444"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="madm-card p-5 animate-fade-in-up" style={{ animationDelay: "640ms" }}>
        <h3 className="text-sm font-bold text-[#09175b] mb-4">Resumo de Comissões e Metas</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-gray-50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2"><Award className="w-4 h-4 text-[#34a853]" /><span className="text-xs font-semibold text-gray-700">Metas Batidas</span></div>
            <div className="text-2xl font-black text-[#09175b]">{formatInt(userMetasBatidas)}</div>
            <div className="text-xs text-gray-500">suas metas batidas</div>
          </div>
          {renderBonusCard()}
          <div className="bg-gray-50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2"><TrendingUp className="w-4 h-4 text-[#34a853]" /><span className="text-xs font-semibold text-gray-700">Assinados</span></div>
            <div className="text-2xl font-black text-[#09175b]">{formatInt(totals.assinados)}</div>
            <div className="text-xs text-gray-500">meta: {formatInt(targetAssinados)}</div>
          </div>
          <div className="bg-gray-50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2"><FileCheck className="w-4 h-4 text-[#045b5b]" /><span className="text-xs font-semibold text-gray-700">Ganhos</span></div>
            <div className="text-2xl font-black text-[#09175b]">{formatInt(totals.ganhos)}</div>
            <div className="text-xs text-gray-500">{isSpecialGroup ? "Meta não se aplica" : `meta: ${formatInt(targetGanhos)}`}</div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}