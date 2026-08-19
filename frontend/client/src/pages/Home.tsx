// src/pages/Home.tsx
import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, formatCurrency, Collaborator } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import { calculator } from "@/lib/calculator";
import { fetchDailyMetrics } from "@/lib/metrics";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  TrendingUp, Target, Zap, ArrowRight, Award,
  DollarSign, FileCheck, BarChart2, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import {
  fetchEmitidos,
  fetchAssinados,
  fetchLeadsRecebidos,
  fetchGanhos,
  fetchPerdidos,
  fetchCollaborators,
  fetchProtocolados,
} from "@/lib/api";

// ============================================================
// CONSTANTES DE EXCLUSÃO
// ============================================================
const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário','BackOffice',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro', 'Equipe Reciclagem'
];

const EXCLUDED_CARGOS_FOR_DISPLAY = [
  "desativado","assistente","analista juridico","gestor de projetos","analista",
  "analista de discadora","supervisor","coordenador","salesops","ceo",
  "analista de crm","desenvolvedor","diretora","analista de dados","desenvolvedor make",
];

// ============================================================
// FUNÇÕES AUXILIARES (mesmas da Comissões)
// ============================================================
const normalize = (str: string): string =>
  (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function isSpecialGroupColaborador(colaborador: any): boolean {
  const produto = (colaborador.produto || '').toLowerCase();
  const cargo = (colaborador.cargo || '').toLowerCase();
  const equipe = (colaborador.equipeNome || '').toLowerCase();

  const equipeQuinquenio = equipe.includes('quinquenio') || equipe.includes('quinquênio') || equipe.includes('tatiane');
  const equipeConcomitante = equipe.includes('concomitante');

  return produto === 'quinquenio' || produto === 'concomitante' ||
         cargo === 'quinquenio' || cargo === 'concomitante' ||
         equipeQuinquenio || equipeConcomitante;
}

function getFaixaProductType(colab: any): string {
  const rawProduct = (colab?.produto || '').toUpperCase().trim();
  if (rawProduct === 'JUDIT' || rawProduct === 'DISCADORA') {
    return 'AUXILIO ACIDENTE';
  }
  if (rawProduct === 'QUINQUENIO' || rawProduct === 'CONCOMITANTE') {
    return rawProduct;
  }

  const cargoNormalizado = (colab?.cargo || '').toLowerCase().trim();
  if (cargoNormalizado === 'quinquenio') return 'QUINQUENIO';
  if (cargoNormalizado === 'concomitante') return 'CONCOMITANTE';

  const equipeNormalizada = (colab?.equipeNome || '').toLowerCase().trim();
  if (equipeNormalizada.includes('quinquenio') || equipeNormalizada.includes('quinquênio') || equipeNormalizada.includes('tatiane')) {
    return 'QUINQUENIO';
  }
  if (equipeNormalizada.includes('concomitante')) {
    return 'CONCOMITANTE';
  }

  return 'AUXILIO ACIDENTE';
}

// ============================================================
// CONFIGURAÇÃO DE PESOS (ranking/score)
// ============================================================
const WEIGHTS: Record<'emitidos' | 'assinados' | 'protocolados' | 'ganhos', number> = {
  ganhos: 4,
  assinados: 3,
  protocolados: 1,
  emitidos: 2,
};

const GLOBAL_META = {
  diario: { assinados: 100, ganhos: 100 },
  semanal: { assinados: 500, ganhos: 500 },
  mensal: { assinados: 2000, ganhos: 2000 },
};

const isExcludedTeam = (teamName: string) => EXCLUDED_TEAMS.includes(teamName);
const isExcludedCargoForDisplay = (cargo: string) =>
  EXCLUDED_CARGOS_FOR_DISPLAY.some(g => normalize(g) === normalize(cargo));

const isDesativado = (c: any) => {
  const cargo = normalize(c.cargo);
  const equipe = normalize(c.equipeNome);
  return cargo === 'desativado' || equipe.includes('desativado');
};

function calculateWeightedScore(
  item: { ganhos: number; assinados: number; protocolados: number; emitidos: number }
): number {
  let score = 0;
  for (const [metric, weight] of Object.entries(WEIGHTS)) {
    const value = item[metric as keyof typeof item] || 0;
    score += value * weight;
  }
  return score;
}

// ========== UTILITÁRIOS DE DATAS UTC ==========
function parseUTCDate(dateStr: string): Date {
  if (!dateStr) return new Date(NaN);
  if (dateStr.includes('T') || dateStr.includes('Z')) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
    return new Date(dateStr + 'T00:00:00Z');
  }
  return new Date(dateStr + 'T00:00:00Z');
}

function formatUTCDate(date: Date): string {
  if (isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function getUTCMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function getCurrentWeekDatesUTC(): { start: string; end: string } {
  const now = new Date();
  const monday = getUTCMonday(now);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);
  return { start: formatUTCDate(monday), end: formatUTCDate(sunday) };
}

function getDailyChartDateRangeUTC(period: string, currentStart: string, currentEnd: string): { start: string; end: string } {
  if (period === "Hoje") {
    const today = new Date();
    const monday = getUTCMonday(today);
    const endDate = new Date(today);
    endDate.setUTCDate(today.getUTCDate() + 1);
    return { start: formatUTCDate(monday), end: formatUTCDate(endDate) };
  }
  if (period === "Semana") {
    const today = new Date();
    const monday = getUTCMonday(today);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    sunday.setUTCHours(23, 59, 59, 999);
    const endDate = new Date(sunday);
    endDate.setUTCDate(sunday.getUTCDate() + 1);
    return { start: formatUTCDate(monday), end: formatUTCDate(endDate) };
  }
  return { start: currentStart, end: currentEnd };
}

function isWeekdayUTC(dateStr: string): boolean {
  const date = parseUTCDate(dateStr);
  if (isNaN(date.getTime())) return false;
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

function countWeekdaysUTC(startDate: string, endDate: string): number {
  let start = parseUTCDate(startDate);
  const end = parseUTCDate(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
  let count = 0;
  while (start <= end) {
    const day = start.getUTCDay();
    if (day !== 0 && day !== 6) count++;
    start.setUTCDate(start.getUTCDate() + 1);
  }
  return count;
}

const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

// ========== HOOKS E COMPONENTES AUXILIARES ==========
function useCountUp(target: number, duration = 1200) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let start = 0;
    const step = target / (duration / 16);
    const timer = setInterval(() => {
      start += step;
      if (start >= target) { setValue(target); clearInterval(timer); }
      else setValue(Math.floor(start));
    }, 16);
    return () => clearInterval(timer);
  }, [target, duration]);
  return value;
}

function GoalArc({ percent, label }: { percent: number; label?: string }) {
  const radius = 54;
  const circumference = Math.PI * radius;
  const offset = circumference * (1 - Math.min(percent / 100, 1));
  const color = percent >= 100 ? "#16A34A" : percent >= 70 ? "#2F6FED" : "#2F6FED";
  return (
    <div className="w-full max-w-[160px] mx-auto">
      <svg width="100%" height="auto" viewBox="0 0 140 90" preserveAspectRatio="xMidYMid meet">
        <path d="M 10 75 A 60 60 0 0 1 130 75" fill="none" stroke="#e2e8f0" strokeWidth="10" strokeLinecap="round" />
        <path d="M 10 75 A 60 60 0 0 1 130 75" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 1.4s cubic-bezier(0.4,0,0.2,1)" }} />
        <text x="70" y="65" textAnchor="middle" fill={color} fontSize="20" fontWeight="800">{Math.round(percent)}%</text>
        <text x="70" y="80" textAnchor="middle" fill="#64748b" fontSize="9">{label || "da meta"}</text>
      </svg>
    </div>
  );
}

function KpiCard({
  label, value, target, unit, icon: Icon, color, delay = 0, simple = false,
  hideValues = false,
}: {
  label: string; value: number; target: number; unit: string;
  icon: React.ElementType; color: string; delay?: number;
  simple?: boolean;
  hideValues?: boolean;
}) {
  const animated = useCountUp(value, 1000 + delay);
  const pct = target > 0 ? Math.round((value / target) * 100) : 0;
  const displayCurrency = (val: number) => hideValues ? "R$ ****" : formatCurrency(val);
  const displayValue = () => {
    if (unit === "R$") return displayCurrency(animated);
    if (unit === "%") return `${animated.toFixed(1)}%`;
    return formatInt(animated);
  };
  const displayTarget = () => {
    if (unit === "R$") return displayCurrency(target);
    if (unit === "%") return `${target}%`;
    return formatInt(target);
  };
  return (
    <div className="card animate-fade-in-up" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${color}15` }}>
          <Icon className="w-4.5 h-4.5" style={{ color }} />
        </div>
        {!simple && (
          <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full",
            pct >= 100 ? "bg-green-50 text-green-700" : pct >= 70 ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-600")}>
            {pct}%
          </span>
        )}
      </div>
      <div className="kpi-value mb-0.5" style={{ color: "#0f172a" }}>{displayValue()}</div>
      <div className="text-xs text-[#64748b] mb-3">{label}</div>
      {!simple && (
        <>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <div className="flex justify-between mt-1.5">
            <span className="text-[10px] text-[#94a3b8]">Meta: {displayTarget()}</span>
            <span className="text-[10px] font-medium" style={{ color: pct >= 100 ? "#16A34A" : "#2F6FED" }}>
              {pct >= 100 ? "✓ Atingida" : unit === "R$" ? `Faltam ${displayCurrency(target - value)}` : `Faltam ${formatInt(target - value)}`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-[#e2e8f0] rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-[#0f172a] mb-1">{label}</p>
        {payload.map((entry: any, i: number) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {typeof entry.value === 'number' ? formatInt(entry.value) : entry.value}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

// ============================================================
// COMPONENTE PRINCIPAL
// ============================================================
export default function Home() {
  const [mounted, setMounted] = useState(false);
  const [filters, setFilters] = useState<{
    equipe: string;
    colaborador: string;
    colaboradorId?: string | number;
    produto: string;
  }>({ equipe: "todas", colaborador: "todos", produto: "Todos" });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dailyMetrics, setDailyMetrics] = useState<any[]>([]);

  const {
    currentStartDate, currentEndDate, period,
    bonusData,
    globalConfig, collaborators, currentUser,
    loadCollaboratorsAndMetrics,
    loadWeeklyPerformanceData,
    rawMetrics,
    loadRawMetrics,
    hideValues,
    tabelaComissoes,
  } = useAppStore();

  const { hasPermission, currentUser: authUser } = useAccessControl();
  const canAccessReports = hasPermission('canAccessReports');
  const canAccessCommissoes = hasPermission('canViewOwnData');

  const [allCollaborators, setAllCollaborators] = useState<any[]>([]);
  const [metricsData, setMetricsData] = useState<Record<string, { emitidos: number; assinados: number; protocolados: number; ganhos: number; perdidos: number }>>({});
  const [rankingLoading, setRankingLoading] = useState(false);
  const rankingLastFetch = useRef<number>(0);
  const RANKING_CACHE_TTL = 60000;

  const [weeklyEA, setWeeklyEA] = useState<{ day: string; emitidos: number; assinados: number }[]>([]);
  const [weeklyDetailed, setWeeklyDetailed] = useState<{
    day: string; dateExample: string; leads: number; assinados: number; ganhos: number;
  }[]>([]);
  const [dailyChartData, setDailyChartData] = useState<{ date: string; leads: number; assinados: number }[]>([]);

  const lastDatesRef = useRef({ start: currentStartDate, end: currentEndDate });

  // ============================================================
  // CARREGAMENTO DE DADOS PARA RANKING
  // ============================================================
  const loadRankingData = useCallback(async () => {
    if (!currentStartDate || !currentEndDate) return;
    const now = Date.now();
    if (allCollaborators.length > 0 && (now - rankingLastFetch.current) < RANKING_CACHE_TTL) return;
    setRankingLoading(true);
    try {
      const collabs = await fetchCollaborators();
      if (!collabs || collabs.length === 0) { setAllCollaborators([]); setMetricsData({}); setRankingLoading(false); return; }
      const endInclusive = new Date(currentEndDate + "T23:59:59");
      const endExclusive = new Date(endInclusive); endExclusive.setDate(endExclusive.getDate() + 1);
      const endParam = endExclusive.toISOString().slice(0, 10);
      const params = { start: currentStartDate, end: endParam };
      const [emitidos, assinados, protocolados, ganhos, perdidos] = await Promise.all([
        fetchEmitidos(params), fetchAssinados(params), fetchProtocolados(params), fetchGanhos(params), fetchPerdidos(params),
      ]);
      const metricsMap: Record<string, { emitidos: number; assinados: number; protocolados: number; ganhos: number; perdidos: number }> = {};
      const aggregate = (data: any[], key: keyof typeof metricsMap[string]) => {
        data.forEach((item: any) => {
          const name = item.colaborador; if (!name) return;
          if (!metricsMap[name]) metricsMap[name] = { emitidos: 0, assinados: 0, protocolados: 0, ganhos: 0, perdidos: 0 };
          metricsMap[name][key] += Number(item.total) || 0;
        });
      };
      aggregate(emitidos, 'emitidos'); aggregate(assinados, 'assinados'); aggregate(protocolados, 'protocolados');
      aggregate(ganhos, 'ganhos'); aggregate(perdidos, 'perdidos');
      setAllCollaborators(collabs); setMetricsData(metricsMap); rankingLastFetch.current = Date.now();
    } catch (err) { console.error('Erro ao carregar dados de ranking:', err); }
    finally { setRankingLoading(false); }
  }, [currentStartDate, currentEndDate, allCollaborators.length]);

  // ============================================================
  // FUNÇÃO CENTRAL DE RECARGA
  // ============================================================
  const reloadData = useCallback(async (showRefreshing = false) => {
    if (!currentStartDate || !currentEndDate) return;
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);

    try {
      const { equipeApi, colaboradorApi, colaboradorIdApi } = getChartFilterParams();
      const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;

      await loadCollaboratorsAndMetrics(equipeApi, colaboradorApi, colaboradorIdApi, produtoApi);
      await loadRawMetrics({ equipeNome: equipeApi, colaboradorNome: colaboradorApi, colaboradorId: colaboradorIdApi, produto: produtoApi });
      await loadWeeklyPerformanceData();

      const leadsData = await fetchLeadsRecebidos({
       start: currentStartDate,
       end: currentEndDate,
       equipe: equipeApi,
       colaborador: colaboradorApi,
       produto: produtoApi,
      });
      const totalLeadsRecebidos = (leadsData || []).reduce(
       (acc, item) => acc + (Number(item.total) || 0),
        0
      );
      setTotalLeads(totalLeadsRecebidos);

      await loadWeeklyPerformanceData();

      const datesChanged = currentStartDate !== lastDatesRef.current.start || currentEndDate !== lastDatesRef.current.end;
      if (datesChanged) await loadRankingData();

      // Carregar dados diários somente para assessores comuns
      if (currentUser) {
        const allColabs = useAppStore.getState().collaborators;
        const userColab = allColabs.find(c => c.id === currentUser.id);
        if (userColab) {
          const isSupervisor = (userColab.cargo || '').toLowerCase() === 'supervisor';
          const isEspecial = isSpecialGroupColaborador(userColab);
          if (!isSupervisor && !isEspecial) {
            try {
              const daily = await fetchDailyMetrics({
                start: currentStartDate,
                end: currentEndDate,
                colaborador: userColab.name,
              });
              setDailyMetrics(daily);
            } catch (err) {
              console.error('Erro ao carregar dados diários:', err);
              setDailyMetrics([]);
            }
          } else {
            setDailyMetrics([]);
          }
        }
      }

      lastDatesRef.current = { start: currentStartDate, end: currentEndDate };
    } catch (err) {
      console.error("Erro ao recarregar dados:", err);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate, filters, loadCollaboratorsAndMetrics, loadRawMetrics, loadWeeklyPerformanceData, loadRankingData, currentUser]);

  const handleFilterChange = useCallback((newFilters: typeof filters) => {
    setFilters(newFilters);
  }, []);

  const handleRefresh = useCallback(async () => {
    await reloadData(true);
  }, [reloadData]);

  const getChartFilterParams = useCallback(() => {
    let equipeApi = filters.equipe === "todas" ? undefined : filters.equipe;
    let colaboradorApi = filters.colaborador === "todos" ? undefined : filters.colaborador;
    let colaboradorIdApi = filters.colaboradorId;
    const selectedColab = filters.colaboradorId ? collaborators.find(c => c.id === filters.colaboradorId) : null;
    const isSupervisor = selectedColab?.cargo?.toLowerCase() === 'supervisor';
    if (isSupervisor && selectedColab) {
      equipeApi = selectedColab.equipeNome;
      colaboradorApi = undefined;
      colaboradorIdApi = undefined;
    }
    return { equipeApi, colaboradorApi, colaboradorIdApi };
  }, [filters, collaborators]);

  // ============================================================
  // EFEITOS
  // ============================================================
  useEffect(() => {
    if (!currentStartDate || !currentEndDate) return;
    reloadData(false);
  }, [currentStartDate, currentEndDate, filters]);

  useEffect(() => {
    if (currentStartDate && currentEndDate && allCollaborators.length === 0) {
      loadRankingData();
    }
  }, [currentStartDate, currentEndDate, allCollaborators.length, loadRankingData]);

  useEffect(() => setMounted(true), []);

  // ============================================================
  // CÁLCULOS DERIVADOS
  // ============================================================
  const globalRanking = useMemo(() => {
    const eligible = allCollaborators.filter(c => {
      if (isDesativado(c)) return false;
      if (isExcludedCargoForDisplay(c.cargo)) return false;
      if (isExcludedTeam(c.equipeNome)) return false;
      return true;
    });
    const withData = eligible.map(c => {
      const m = metricsData[c.name] || { emitidos: 0, assinados: 0, protocolados: 0, ganhos: 0, perdidos: 0 };
      const score = calculateWeightedScore({ ganhos: m.ganhos || 0, assinados: m.assinados || 0, protocolados: m.protocolados || 0, emitidos: m.emitidos || 0 });
      return { ...c, ...m, score, name: c.name, id: c.id };
    }).filter(item => item.score > 0);
    const sorted = [...withData].sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.ganhos !== b.ganhos) return b.ganhos - a.ganhos;
      if (a.assinados !== b.assinados) return b.assinados - a.assinados;
      if (a.protocolados !== b.protocolados) return b.protocolados - a.protocolados;
      return b.emitidos - a.emitidos;
    });
    return sorted.map((item, idx) => ({ ...item, position: idx + 1 }));
  }, [allCollaborators, metricsData]);

  const currentUserData = useMemo(() => {
    if (!currentUser?.id) return null;
    const allColabs = useAppStore.getState().collaborators;
    return allColabs.find(c => c.id === currentUser.id) || collaborators.find(c => c.id === currentUser.id);
  }, [currentUser, collaborators]);

  const userRank = useMemo(() => {
    if (!currentUserData) return 0;
    const found = globalRanking.find(item => item.id === currentUserData.id || item.name === currentUserData.name);
    return found ? found.position : 0;
  }, [globalRanking, currentUserData]);
  const totalRanking = globalRanking.length;
  const currentIndex = useMemo(() => userRank === 0 ? -1 : globalRanking.findIndex(item => item.position === userRank), [globalRanking, userRank]);
  const aboveUser = currentIndex > 0 ? globalRanking[currentIndex - 1] : null;
  const belowUser = currentIndex < globalRanking.length - 1 ? globalRanking[currentIndex + 1] : null;
  const userScore = useMemo(() => {
    if (!currentUserData) return 0;
    const found = globalRanking.find(item => item.id === currentUserData.id || item.name === currentUserData.name);
    return found ? found.score : 0;
  }, [globalRanking, currentUserData]);
  const diffScore = useMemo(() => {
    if (!aboveUser || currentIndex < 0) return 0;
    return aboveUser.score - (globalRanking[currentIndex]?.score || 0);
  }, [aboveUser, currentIndex, globalRanking]);

  // Grupo especial baseado no colaborador logado ou filtro
  const isSpecialGroup = useMemo(() => {
    if (filters.produto === 'Quinquenio' || filters.produto === 'Concomitante') return true;
    return currentUserData ? isSpecialGroupColaborador(currentUserData) : false;
  }, [filters.produto, currentUserData]);

  const filteredCollaborators = useMemo(() => collaborators.filter(c => {
    if (filters.equipe !== "todas" && c.equipeNome !== filters.equipe) return false;
    if (filters.colaborador !== "todos" && c.name !== filters.colaborador) return false;
    return true;
  }), [collaborators, filters.equipe, filters.colaborador]);

  const displayCollaborators = useMemo(() => filteredCollaborators.filter(c => {
    if (isDesativado(c)) return false;
    const cargo = (c.cargo || '').trim().toLowerCase();
    return cargo !== 'supervisor' && cargo !== 'coordenador' && cargo !== 'administrativo';
  }), [filteredCollaborators]);

  const totals = rawMetrics;
  const [totalLeads, setTotalLeads] = useState(0);
  const periodKey = period === 'Hoje' ? 'diario' : period === 'Semana' ? 'semanal' : 'mensal';
  const isGlobalView = filters.equipe === "todas" && filters.colaborador === "todos";

  // ============================================================
  // CÁLCULO DA COMISSÃO DO USUÁRIO LOGADO
  // ============================================================
  const userCommission = useMemo(() => {
    if (!currentUserData || !tabelaComissoes || tabelaComissoes.length === 0) {
      return 0;
    }

    const isSupervisor = (currentUserData.cargo || '').toLowerCase() === 'supervisor';
    const isSR = calculator.isSupervisorSR(currentUserData.email);
    const isEspecial = isSpecialGroupColaborador(currentUserData);

    if (isSupervisor) {
      // currentUserData.assinados já é a soma da equipe (hierarquia)
      const totalAssEquipe = currentUserData.assinados || 0;
      return calculator.calculateSupervisorCommission(totalAssEquipe, isSR, tabelaComissoes);
    }

    if (isEspecial) {
      // Quinquênio ou Concomitante
      const productType = getFaixaProductType(currentUserData);
      return calculator.calculateProductCommission(currentUserData.assinados || 0, productType, tabelaComissoes);
    }

    // Assessor comum
    if (dailyMetrics.length > 0) {
      const metaGolsAss = currentUserData.metaGolsAssinados ?? 3;
      const metaGolsGan = currentUserData.metaGolsGanhos ?? 3;
      const assinados = currentUserData.assinados || 0;
      const productType = getFaixaProductType(currentUserData);
      const result = calculator.calculateTotalCommission(
        dailyMetrics,
        metaGolsAss,
        metaGolsGan,
        assinados,
        productType,
        tabelaComissoes
      );
      return result.totalCommission;
    }

    return 0;
  }, [currentUserData, tabelaComissoes, dailyMetrics]);

  const { totalTargetAssinados, totalTargetGanhos, totalMetasBatidas } = useMemo(() => {
    if (isGlobalView) {
      const meta = GLOBAL_META[periodKey as keyof typeof GLOBAL_META] || GLOBAL_META.mensal;
      const assinados = rawMetrics.assinados, ganhos = rawMetrics.ganhos;
      let metasBatidas;
      if (isSpecialGroup) metasBatidas = Math.floor(assinados / (meta.assinados || 1));
      else metasBatidas = Math.floor(Math.min(assinados / (meta.assinados || 1), ganhos / (meta.ganhos || 1)));
      return { totalTargetAssinados: meta.assinados, totalTargetGanhos: meta.ganhos, totalMetasBatidas: metasBatidas };
    }
    let sumAss = 0, sumGan = 0, metas = 0;
    displayCollaborators.forEach(c => {
      const pesoAssKey = `meta${periodKey.charAt(0).toUpperCase() + periodKey.slice(1)}Assinados` as keyof Collaborator;
      const pesoGanKey = `meta${periodKey.charAt(0).toUpperCase() + periodKey.slice(1)}Ganhos` as keyof Collaborator;
      const pesoAss = Number(c[pesoAssKey]) || 0, pesoGan = Number(c[pesoGanKey]) || 0;
      sumAss += pesoAss; sumGan += pesoGan;
      const assinados = c.assinados || 0, ganhos = isSpecialGroup ? 0 : (c.ganhos || 0);
      if (pesoAss === 0) return;
      if (pesoGan === 0) metas += Math.floor(assinados / pesoAss);
      else metas += Math.floor(Math.min(assinados / pesoAss, ganhos / pesoGan));
    });
    return { totalTargetAssinados: sumAss, totalTargetGanhos: sumGan, totalMetasBatidas: metas };
  }, [isGlobalView, displayCollaborators, rawMetrics, isSpecialGroup, periodKey]);

  const goalProgress = useMemo(() => {
    const progressAss = totalTargetAssinados > 0 ? (totals.assinados / totalTargetAssinados) * 100 : 0;
    const progressGan = totalTargetGanhos > 0 ? (totals.ganhos / totalTargetGanhos) * 100 : 100;
    if (isSpecialGroup || totalTargetGanhos === 0) return Math.min(progressAss, 100);
    return Math.min(progressAss, progressGan, 100);
  }, [totalTargetAssinados, totalTargetGanhos, totals.assinados, totals.ganhos, isSpecialGroup]);

  // ============================================================
  // GRÁFICOS DE PERFORMANCE
  // ============================================================
  useEffect(() => {
    if (!isSpecialGroup || !currentStartDate || !currentEndDate) return;
    const { equipeApi, colaboradorApi, colaboradorIdApi } = getChartFilterParams();
    const fetchWeeklyData = async () => {
      try {
        const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;
        const [emitidosData, assinadosData] = await Promise.all([
          fetchEmitidos({ start: currentStartDate, end: currentEndDate, equipe: equipeApi, colaborador: colaboradorApi, produto: produtoApi }),
          fetchAssinados({ start: currentStartDate, end: currentEndDate, equipe: equipeApi, colaborador: colaboradorApi, produto: produtoApi, granularity: 'daily' })
        ]);
        const dayNames = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
        const emitidosMap = new Map<string, number>(), assinadosMap = new Map<string, number>();
        const aggregateEA = (data: any[], map: Map<string, number>) => {
          data.forEach((item: any) => {
            const dateStr = item.data || item.periodo; if (!dateStr) return;
            const date = parseUTCDate(dateStr); if (isNaN(date.getTime())) return;
            const dayName = dayNames[date.getUTCDay()]; map.set(dayName, (map.get(dayName) || 0) + (Number(item.total) || 0));
          });
        };
        aggregateEA(emitidosData, emitidosMap); aggregateEA(assinadosData, assinadosMap);
        const result = ['Seg','Ter','Qua','Qui','Sex','Sáb','Dom'].map(day => ({ day, emitidos: emitidosMap.get(day) || 0, assinados: assinadosMap.get(day) || 0 }));
        setWeeklyEA(result);
      } catch (err) { console.error('Erro ao carregar dados semanais emitidos/assinados:', err); }
    };
    fetchWeeklyData();
  }, [isSpecialGroup, currentStartDate, currentEndDate, filters, getChartFilterParams]);

  useEffect(() => {
    if (isSpecialGroup) return;
    const { equipeApi, colaboradorApi, colaboradorIdApi } = getChartFilterParams();
    const fetchWeeklyDetailed = async () => {
      try {
        const { start, end } = getCurrentWeekDatesUTC();
        const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;
        const commonParams = { start, end, equipe: equipeApi, colaborador: colaboradorApi, produto: produtoApi, granularity: 'daily' as const };
        const [leadsData, assinadosData, ganhosData] = await Promise.all([fetchLeadsRecebidos(commonParams), fetchAssinados(commonParams), fetchGanhos(commonParams)]);
        const weekdays = ['Seg','Ter','Qua','Qui','Sex'];
        const leadsMap = new Map<string, number>(), assinadosMap = new Map<string, number>(), ganhosMap = new Map<string, number>(), dateMap = new Map<string, string>();
        const aggregate = (data: any[], map: Map<string, number>) => {
          data.forEach(item => {
            let dateStr = item.data || item.periodo; if (!dateStr) return;
            const date = parseUTCDate(dateStr); if (isNaN(date.getTime())) return;
            const dayIndex = date.getUTCDay(); if (dayIndex === 0 || dayIndex === 6) return;
            const dayName = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][dayIndex];
            map.set(dayName, (map.get(dayName) || 0) + (Number(item.total) || 0));
            if (!dateMap.has(dayName)) { const day = String(date.getUTCDate()).padStart(2,'0'), month = String(date.getUTCMonth()+1).padStart(2,'0'); dateMap.set(dayName, `${day}/${month}`); }
          });
        };
        aggregate(leadsData, leadsMap); aggregate(assinadosData, assinadosMap); aggregate(ganhosData, ganhosMap);
        const result = weekdays.map(day => ({ day, dateExample: dateMap.get(day) || '', leads: leadsMap.get(day) || 0, assinados: assinadosMap.get(day) || 0, ganhos: ganhosMap.get(day) || 0 }));
        setWeeklyDetailed(result);
      } catch (err) { console.error('Erro ao carregar dados semanais detalhados:', err); }
    };
    fetchWeeklyDetailed();
  }, [isSpecialGroup, filters, getChartFilterParams]);

  useEffect(() => {
    if (isSpecialGroup) return;
    const { equipeApi, colaboradorApi, colaboradorIdApi } = getChartFilterParams();
    const fetchDailyData = async () => {
      try {
        const range = getDailyChartDateRangeUTC(period, currentStartDate, currentEndDate);
        const start = range.start, end = range.end; if (!start || !end) return;
        const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;
        const commonParams = { start, end, equipe: equipeApi, colaborador: colaboradorApi, produto: produtoApi, granularity: 'daily' as const };
        const [leadsData, assinadosData] = await Promise.all([fetchLeadsRecebidos(commonParams), fetchAssinados(commonParams)]);
        const leadsMap = new Map<string, number>(), assinadosMap = new Map<string, number>();
        const process = (data: any[], map: Map<string, number>) => {
          data.forEach(item => {
            const dateStr = item.data || item.periodo; if (!dateStr) return;
            const date = parseUTCDate(dateStr); if (isNaN(date.getTime())) return;
            const formatted = date.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
            map.set(formatted, (map.get(formatted) || 0) + (Number(item.total) || 0));
          });
        };
        process(leadsData, leadsMap); process(assinadosData, assinadosMap);
        const allDates: string[] = [];
        const currentDate = parseUTCDate(start), endDate = parseUTCDate(end);
        if (isNaN(currentDate.getTime()) || isNaN(endDate.getTime())) return;
        const filterWeekend = period === "Semana";
        while (currentDate < endDate) {
          const dateStr = formatUTCDate(currentDate);
          if (!filterWeekend || isWeekdayUTC(dateStr)) allDates.push(dateStr);
          currentDate.setUTCDate(currentDate.getUTCDate() + 1);
        }
        const chartData = allDates.map(dateStr => {
          const date = parseUTCDate(dateStr);
          return { date: date.toLocaleDateString('pt-BR', { timeZone: 'UTC' }), leads: leadsMap.get(date.toLocaleDateString('pt-BR', { timeZone: 'UTC' })) || 0, assinados: assinadosMap.get(date.toLocaleDateString('pt-BR', { timeZone: 'UTC' })) || 0 };
        });
        setDailyChartData(chartData);
      } catch (err) { console.error('Erro ao carregar dados diários:', err); }
    };
    fetchDailyData();
  }, [currentStartDate, currentEndDate, period, filters, isSpecialGroup, getChartFilterParams]);

  const stats = useMemo(() => {
    if (isSpecialGroup || weeklyDetailed.length === 0) return { totalAssinados: 0, totalGanhos: 0, performanceAssinados: 0, performanceGanhos: 0, bestDay: { day: '', value: 0 }, avgGanhos: 0, daysWithMeta: 0, totalDays: 0 };
    const { start, end } = getCurrentWeekDatesUTC();
    const weekdaysCount = countWeekdaysUTC(start, end);
    const totalMetaDiariaAssinados = displayCollaborators.reduce((sum, c) => sum + (c.metaDiarioAssinados || 3), 0);
    const targetAssinadosSemanal = totalMetaDiariaAssinados * weekdaysCount;
    const totalAssinados = weeklyDetailed.reduce((a, d) => a + d.assinados, 0);
    const totalGanhos = weeklyDetailed.reduce((a, d) => a + d.ganhos, 0);
    const totalDays = weeklyDetailed.length;
    const performanceAssinados = targetAssinadosSemanal > 0 ? (totalAssinados / targetAssinadosSemanal) * 100 : 0;
    const performanceGanhos = totalTargetGanhos > 0 ? (totalGanhos / totalTargetGanhos) * 100 : 0;
    const avgGanhos = totalDays > 0 ? totalGanhos / totalDays : 0;
    let best = { day: '', value: 0 }, daysWithMeta = 0;
    const dailyTarget = totalMetaDiariaAssinados;
    weeklyDetailed.forEach(d => { if (d.assinados > best.value) best = { day: d.day, value: d.assinados }; if (dailyTarget > 0 && d.assinados >= dailyTarget) daysWithMeta++; });
    return { totalAssinados, totalGanhos, performanceAssinados, performanceGanhos, bestDay: best, avgGanhos, daysWithMeta, totalDays };
  }, [isSpecialGroup, weeklyDetailed, displayCollaborators, totalTargetGanhos]);
  
  const conversaoPercentual = totalLeads > 0 ? (totals.assinados / totalLeads) * 100 : 0;

  const displayCurrency = (val: number) => hideValues ? "R$ ****" : formatCurrency(val);

  // Valor alvo para o card de comissão
  const comissaoTarget = useMemo(() => {
    if (!currentUserData || !tabelaComissoes || tabelaComissoes.length === 0) return 5000;
    const tipo = (currentUserData.cargo || '').toLowerCase() === 'supervisor' ? 'SUPERVISOR' : 'GOL';
    const faixas = tabelaComissoes.filter(f => f.tipo === tipo);
    if (faixas.length === 0) return 5000;
    const maxFaixa = faixas.reduce((max, f) => f.valor_comissao > max.valor_comissao ? f : max, faixas[0]);
    return maxFaixa.valor_comissao || 5000;
  }, [currentUserData, tabelaComissoes]);

  const kpiCards = [
    { label: "Estimativa do Mês", value: userCommission, target: comissaoTarget, unit: "R$", icon: DollarSign, color: "#2F6FED", simple: true },
    { label: "Vendas Fechadas", value: totals.assinados, target: totalTargetAssinados, unit: "", icon: FileCheck, color: "#16A34A", simple: false },
    { label: "Protocolados", value: totals.protocolados, target: 1200, unit: "", icon: BarChart2, color: "#8B5CF6", simple: false },
    { label: "Taxa de Conversão", value: conversaoPercentual, target: 100, unit: "%", icon: TrendingUp, color: "#EA8C1D", simple: false },
  ];

  const hasActiveFilters = filters.equipe !== "todas" || filters.colaborador !== "todos" || filters.produto !== "Todos";
  const firstName = currentUser?.nome?.split(" ")[0] || "Usuário";

  return (
    <DashboardLayout title={`Olá, ${firstName}! 👋`} subtitle="Aqui está o resumo do seu desempenho de hoje!">
      <FilterBar
        onFilterChange={handleFilterChange}
        showColaboradorFilter={true}
        className="mb-6"
        onRefresh={handleRefresh}
      />

      {loading && (
        <div className="flex justify-center items-center py-4">
          <Loader2 className="w-5 h-5 animate-spin text-[#2F6FED]" />
          <span className="ml-2 text-sm text-[#64748b]">Carregando dados...</span>
        </div>
      )}

      {collaborators.length === 0 && !loading && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-center text-amber-800 text-sm">
          Nenhum colaborador disponível no momento.
        </div>
      )}

      {collaborators.length > 0 && !loading && (
        <>
          {hasActiveFilters && (
            <div className="mb-4 px-4 py-2 bg-[#eff6ff] rounded-lg text-xs text-[#2F6FED] flex items-center gap-2 flex-wrap">
              <span>📊</span>
              <span>
                Mostrando dados de:
                {filters.equipe !== "todas" && ` ${filters.equipe}`}
                {filters.colaborador !== "todos" && ` - ${filters.colaborador}`}
                {filters.produto !== "Todos" && ` - Produto: ${filters.produto}`}
              </span>
            </div>
          )}

          {bonusData.active && bonusData.bonusValue > 0 && (
            <div className="rounded-xl p-4 mb-6 flex items-center gap-4 animate-fade-in-up" style={{ background: "linear-gradient(135deg, #2F6FED, #1e40af)" }}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-[#16A34A]"><Zap className="w-5 h-5 text-white" /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5"><span className="text-white font-bold text-sm">{bonusData.label || "Bônus"}</span><span className="badge success">ATIVO</span></div>
                <p className="text-white/70 text-xs">{bonusData.description || "Complete a meta para ganhar bônus extra!"}</p>
              </div>
              <div className="flex-shrink-0 text-right hidden sm:block">
                <div className="text-[#16A34A] font-black text-xl">{displayCurrency(bonusData.bonusValue)}</div>
                <div className="text-white/50 text-xs">bônus extra</div>
              </div>
              {canAccessCommissoes && <Link href="/comissoes"><button className="flex-shrink-0 flex items-center gap-1 text-[#16A34A] text-xs font-semibold hover:gap-2 transition-all">Ver <ArrowRight className="w-3.5 h-3.5" /></button></Link>}
            </div>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {kpiCards.map((kpi, i) => <KpiCard key={kpi.label} {...kpi} delay={i * 80} hideValues={hideValues} />)}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <div className="card flex flex-col items-center animate-fade-in-up" style={{ animationDelay: "320ms" }}>
              <div className="flex items-center gap-2 mb-4 self-start w-full">
                <Target className="w-4 h-4 text-[#2F6FED]" />
                <span className="text-sm font-bold text-[#0f172a]">Meta {period === 'Hoje' ? 'diária' : period === 'Semana' ? 'semanal' : 'mensal'}</span>
                {hasActiveFilters && <span className="text-[10px] text-[#EA8C1D] ml-auto">(filtrada)</span>}
              </div>
              {mounted && <GoalArc percent={goalProgress} label="progresso geral" />}
              <div className={`grid ${isSpecialGroup ? 'grid-cols-1' : 'grid-cols-2'} gap-4 w-full mt-6`}>
                <div className="text-center"><div className="eyebrow mb-1">📄 Assinados</div><div className="kpi-value text-[#0f172a]">{formatInt(totals.assinados)}<span className="text-sm font-normal text-[#64748b]">/{formatInt(totalTargetAssinados)}</span></div></div>
                {!isSpecialGroup && <div className="text-center"><div className="eyebrow mb-1">🏆 Ganhos</div><div className="kpi-value text-[#16A34A]">{formatInt(totals.ganhos)}<span className="text-sm font-normal text-[#64748b]">/{formatInt(totalTargetGanhos)}</span></div></div>}
              </div>
              <div className="mt-4 text-center"><div className="text-3xl font-black text-[#0f172a]">{formatInt(totalMetasBatidas)}</div><div className="eyebrow">Gols</div></div>
              <div className="mt-4 w-full">
                <div className="rounded-lg p-3 text-center" style={{ background: goalProgress >= 70 ? "#f0fdf4" : "#eff6ff" }}>
                  <p className="text-xs font-semibold" style={{ color: goalProgress >= 70 ? "#16A34A" : "#2F6FED" }}>
                    {goalProgress >= 100 ? "🎯 Meta atingida! Parabéns!" : `💪 Faltam ${formatInt(Math.max(0, totalTargetAssinados - totals.assinados))} assinado(s)` + (!isSpecialGroup && totalTargetGanhos > 0 ? ` e ${formatInt(Math.max(0, totalTargetGanhos - totals.ganhos))} ganho(s)` : '') + ' para atingir a meta'}
                  </p>
                </div>
              </div>
            </div>

            <div className="card lg:col-span-2 animate-fade-in-up" style={{ animationDelay: "400ms" }}>
              <div className="flex items-center justify-between mb-5">
                <div><h3 className="text-sm font-bold text-[#0f172a]">{isSpecialGroup ? "Emitidos vs Assinados" : "Performance semanal"}</h3><p className="text-xs text-[#64748b] mt-0.5">{isSpecialGroup ? "Comparativo diário" : "Leads vs Assinados vs Ganhos"}</p></div>
                <div className="flex items-center gap-4 text-xs">
                  {isSpecialGroup ? (
                    <><div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-sm bg-[#2F6FED]" /><span className="text-[#64748b]">Emitidos</span></div><div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-sm bg-[#16A34A]" /><span className="text-[#64748b]">Assinados</span></div></>
                  ) : (
                    <><div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-sm bg-[#16A34A]" /><span className="text-[#64748b]">Leads</span></div><div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-sm bg-[#2F6FED]" /><span className="text-[#64748b]">Assinados</span></div><div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-sm bg-[#EA8C1D]" /><span className="text-[#64748b]">Ganhos</span></div></>
                  )}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                {isSpecialGroup ? (
                  <BarChart data={weeklyEA} barGap={4}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} width={20} />
                    <Tooltip content={<CustomTooltip />} /><Legend />
                    <Bar dataKey="emitidos" fill="#2F6FED" name="Emitidos" radius={[4,4,0,0]} />
                    <Bar dataKey="assinados" fill="#16A34A" name="Assinados" radius={[4,4,0,0]} />
                  </BarChart>
                ) : (
                  <BarChart data={weeklyDetailed} barGap={4}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="day" tick={(props: any) => { const item = weeklyDetailed.find(d => d.day === props.payload.value); return <text x={props.x} y={props.y} dy={16} textAnchor="middle" fill="#64748b" fontSize={11}>{item ? `${item.day} (${item.dateExample})` : props.payload.value}</text>; }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} width={20} />
                    <Tooltip content={<CustomTooltip />} /><Legend />
                    <Bar dataKey="leads" fill="#16A34A" name="Leads" radius={[4,4,0,0]} />
                    <Bar dataKey="assinados" fill="#2F6FED" name="Assinados" radius={[4,4,0,0]} />
                    <Bar dataKey="ganhos" fill="#EA8C1D" name="Ganhos" radius={[4,4,0,0]} />
                  </BarChart>
                )}
              </ResponsiveContainer>
              {!isSpecialGroup && weeklyDetailed.length > 0 && (
                <div className="mt-4 pt-3 border-t border-[#e2e8f0]">
                  <div className="grid grid-cols-2 gap-4 text-xs">
                    <div>
                      <div className="flex justify-between items-center mb-2"><span className="text-[#64748b]">Total de vendas:</span><span className="font-bold text-[#0f172a]">{formatInt(stats.totalAssinados)}</span></div>
                      <div className="flex justify-between items-center mb-2"><span className="text-[#64748b]">Performance Assinados:</span><span className={cn("font-bold", stats.performanceAssinados >= 100 ? "text-[#16A34A]" : "text-[#EA8C1D]")}>{Math.round(stats.performanceAssinados)}%</span></div>
                      <div className="flex justify-between items-center mb-2"><span className="text-[#64748b]">Performance Ganhos:</span><span className={cn("font-bold", stats.performanceGanhos >= 100 ? "text-[#16A34A]" : "text-[#EA8C1D]")}>{Math.round(stats.performanceGanhos)}%</span></div>
                      <div className="flex justify-between items-center"><span className="text-[#64748b]">Média diária (ganhos):</span><span className="font-medium text-[#0f172a]">{stats.avgGanhos.toFixed(2)}</span></div>
                    </div>
                    <div>
                      <div className="flex justify-between items-center mb-2"><span className="text-[#64748b]">Melhor dia (assinados):</span><span className="font-medium text-[#0f172a]">{stats.bestDay.day} ({formatInt(stats.bestDay.value)})</span></div>
                      <div className="flex justify-between items-center"><span className="text-[#64748b]">Dias com gols realizados:</span><span className="font-medium text-[#16A34A]">{stats.daysWithMeta}/{stats.totalDays}</span></div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="card lg:col-span-2 animate-fade-in-up" style={{ animationDelay: "480ms" }}>
              <div className="flex items-center justify-between mb-5">
                <div><h3 className="text-sm font-bold text-[#0f172a]">Produção Diária</h3><p className="text-xs text-[#64748b] mt-0.5">Leads recebidos vs Assinados</p></div>
                {canAccessReports && <Link href="/analytics"><button className="text-xs text-[#2F6FED] font-semibold flex items-center gap-1 hover:gap-2 transition-all">Ver mais <ArrowRight className="w-3 h-3" /></button></Link>}
              </div>
              {dailyChartData.length === 0 ? <div className="flex items-center justify-center h-[200px] text-[#94a3b8] text-sm">Carregando dados...</div> : (
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={dailyChartData}>
                    <defs>
                      <linearGradient id="colorAssinados" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#2F6FED" stopOpacity={0.15} /><stop offset="95%" stopColor="#2F6FED" stopOpacity={0} /></linearGradient>
                      <linearGradient id="colorLeads" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#16A34A" stopOpacity={0.12} /><stop offset="95%" stopColor="#16A34A" stopOpacity={0} /></linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} width={25} />
                    <Tooltip content={<CustomTooltip />} />
                    <Area type="monotone" dataKey="leads" stroke="#16A34A" strokeWidth={2} fill="url(#colorLeads)" name="Leads" dot={false} />
                    <Area type="monotone" dataKey="assinados" stroke="#2F6FED" strokeWidth={2.5} fill="url(#colorAssinados)" name="Assinados" dot={{ r: 3, fill: "#2F6FED" }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="card animate-fade-in-up" style={{ animationDelay: "560ms" }}>
              <div className="flex items-center gap-2 mb-4"><Award className="w-4 h-4 text-[#16A34A]" /><span className="text-sm font-bold text-[#0f172a]">Ranking</span></div>
              {globalRanking.length > 0 ? (
                <>
                  {userRank > 0 && (
                    <>
                      <div className="rounded-xl p-4 text-center mb-4" style={{ background: "linear-gradient(135deg, #2F6FED, #1e40af)" }}>
                        <div className="text-5xl font-black text-[#16A34A] leading-none">#{userRank}</div>
                        <div className="text-white/70 text-xs mt-1">Sua posição entre {totalRanking} consultores</div>
                      </div>
                      <div className="space-y-2 mb-4">
                        <div className="flex items-center justify-between text-xs"><span className="text-[#64748b]">Posição acima</span><span className="font-semibold text-[#0f172a]">{aboveUser?.name || "—"}</span></div>
                        <div className="flex items-center justify-between text-xs"><span className="text-[#64748b]">Diferença (score)</span><span className="font-semibold text-[#DC2626]">{diffScore > 0 ? `-${formatInt(diffScore)} pts` : "—"}</span></div>
                        <div className="flex items-center justify-between text-xs"><span className="text-[#64748b]">Posição abaixo</span><span className="font-semibold text-[#16A34A]">{belowUser?.name || "—"}</span></div>
                      </div>
                    </>
                  )}
                  <div className="border-t border-[#e2e8f0] pt-3">
                    <p className="text-xs text-[#64748b] mb-2">{userRank > 0 ? "🏆 Top 3 do mês" : "🏆 Você não está no ranking. Conheça os líderes:"}</p>
                    <div className="space-y-2">
                      {globalRanking.slice(0, 3).map((item, idx) => {
                        const medals = ["🥇","🥈","🥉"];
                        return (
                          <div key={item.id || item.name} className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2"><span className="text-base">{medals[idx]}</span><span className="font-medium text-[#0f172a]">{item.name}</span>{item.id === currentUserData?.id && <span className="badge info">VOCÊ</span>}</div>
                            <span className="font-bold text-[#2F6FED]">{formatInt(item.score)} pts</span>
                          </div>
                        );
                      })} 
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-4 text-[#64748b] text-xs">{rankingLoading ? "Carregando ranking..." : "Nenhum dado de ranking disponível."}</div>
              )}
              {canAccessReports && <Link href="/ranking"><button className="mt-4 w-full py-2.5 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all hover:opacity-90 bg-[#2F6FED] text-white">Ver Ranking Completo <ArrowRight className="w-3.5 h-3.5" /></button></Link>}
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}