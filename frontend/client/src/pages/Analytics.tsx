// src/pages/Analytics.tsx
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, formatCurrency } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell,
} from "recharts";
import {
  TrendingUp, TrendingDown, Target, Users,
  ShoppingBag, Award, DollarSign, FileCheck,
  BarChart2, Activity, Loader2,
  Trophy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchLeadsRecebidos,
  fetchAssinados,
  fetchGanhos,
  fetchProtocolados,
  fetchPerdidos,
} from "@/lib/api";

const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3007/api";

// ========== EQUIPAS EXCLUÍDAS ==========
const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing',
  'Equipe Ariana', 'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda',
  'Equipe Reciclagem','','Equipe','Equipe Camila','Sales Ops', 'Departamento Comercial', 'Equipe Gabriela Toledo'
];

const EXCLUDED_GROUPS = [
  "Supervisor", "Salesops", "Sales ops", "Coordenador", "CEO",
  "Diretoria", "Desativado", "Juridico", "Ultravita", "Diligencia",
  "Marketing", "Gerência", "Contrato", "Dr. Felipe Marx", "Administrativo",
  "administrativo"
];

function isExcludedTeam(teamName: string): boolean { return EXCLUDED_TEAMS.includes(teamName); }
function isExcludedGroup(group: string): boolean {
  const normalized = (group || '').trim().toLowerCase();
  return EXCLUDED_GROUPS.some(g => g.toLowerCase() === normalized);
}

// ========== Função local para obter meta do colaborador ==========
// Substitui a antiga getCollaboratorMeta (obsoleta) importada de metricsHelper
type PeriodoMeta = 'diario' | 'semanal' | 'mensal';
function getMeta(c: any, periodo: PeriodoMeta, tipo: 'assinados' | 'ganhos'): number {
  const key = `meta${periodo.charAt(0).toUpperCase() + periodo.slice(1)}${tipo.charAt(0).toUpperCase() + tipo.slice(1)}`;
  return Number(c?.[key] ?? 0);
}

// ========== Utilitários de datas ==========
function getChartDateRange(period: string, currentStart: string, currentEnd: string): { start: string; end: string } {
  return { start: currentStart, end: currentEnd };
}

// ========== Utilitários gerais ==========
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-[#e2e8f0] rounded-lg p-3 shadow-lg text-xs max-h-60 overflow-y-auto">
        <p className="font-semibold text-[#0f172a] mb-1">{label}</p>
        {payload.map((entry: any, i: number) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">{entry.name}: {formatInt(entry.value)}</p>
        ))}
      </div>
    );
  }
  return null;
};

function KpiCard({ label, value, target, unit, icon: Icon, color, delay = 0, simple = false, hideValues = false }: {
  label: string; value: number; target: number; unit: string;
  icon: React.ElementType; color: string; delay?: number; simple?: boolean;
  hideValues?: boolean;
}) {
  const pct = target > 0 ? Math.round((value / target) * 100) : 0;
  const displayValue = unit === "R$" ? (hideValues ? "R$ ****" : formatCurrency(value)) : unit === "%" ? `${value.toFixed(1)}%` : formatInt(value);
  const displayTarget = unit === "R$" ? (hideValues ? "R$ ****" : formatCurrency(target)) : formatInt(target);
  return (
    <div className="card animate-fade-in-up" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${color}15` }}>
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
        {!simple && (
          <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full",
            pct >= 100 ? "bg-green-50 text-green-700" : pct >= 70 ? "bg-blue-50 text-blue-700" : "bg-gray-100 text-gray-600")}>
            {pct}%
          </span>
        )}
      </div>
      <div className="kpi-value mb-2" style={{ color: "#0f172a" }}>{displayValue}</div>
      <div className="text-xs text-[#64748b] mb-2">{label}</div>
      {!simple && (
        <>
          <div className="progress-bar"><div className="progress-fill" style={{ width: `${Math.min(pct, 100)}%` }} /></div>
          <div className="text-[10px] text-[#94a3b8] mt-1">Meta: {displayTarget}</div>
        </>
      )}
    </div>
  );
}

export default function Analytics() {
  const [, navigate] = useLocation();
  const {
    currentStartDate, currentEndDate, period,
    collaborators, currentUser,
    loadCollaboratorsAndMetrics, loadWeeklyPerformanceData,
    rawMetrics, loadRawMetrics,
    hideValues,
  } = useAppStore();
  const { hasPermission } = useAccessControl();

  useEffect(() => { if (!hasPermission("canAccessReports")) navigate("/"); }, [hasPermission, navigate]);

  const [filters, setFilters] = useState<{
    equipe: string;
    colaborador: string;
    colaboradorId?: string | number;
    produto: string;
  }>({ equipe: "todas", colaborador: "todos", produto: "Todos" });

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dailyChartData, setDailyChartData] = useState<any[]>([]);
  const [totalLeads, setTotalLeads] = useState(0);
  const [totalAssinados, setTotalAssinados] = useState(0);
  const [apiError, setApiError] = useState<string | null>(null);

  const [userBonus, setUserBonus] = useState<number | null>(null);
  const [bonusLoading, setBonusLoading] = useState(true);
  const [bonusError, setBonusError] = useState<string | null>(null);
  const [isExcluded, setIsExcluded] = useState(false);

  const equipe = filters.equipe, colaborador = filters.colaborador, colaboradorId = filters.colaboradorId, produto = filters.produto;

  const currentUserData = useMemo(() => currentUser?.id ? collaborators.find(c => c.id === currentUser.id) : null, [collaborators, currentUser]);
  useEffect(() => {
    if (!currentUserData) return;
    setIsExcluded(isExcludedTeam(currentUserData.equipeNome) || isExcludedGroup(currentUserData.cargo));
  }, [currentUserData]);

  // ========== FUNÇÃO DE RECARGA PRINCIPAL ==========
  const reloadData = useCallback(async (showRefreshing = false) => {
    if (!currentStartDate || !currentEndDate) return;
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const equipeApi = equipe === "todas" ? undefined : equipe;
      const colaboradorApi = colaborador === "todos" ? undefined : colaborador;
      const produtoApi = produto === "Todos" ? undefined : produto;

      await Promise.all([
        loadCollaboratorsAndMetrics(equipeApi, colaboradorApi, colaboradorId, produtoApi),
        loadRawMetrics({ equipeNome: equipeApi, colaboradorNome: colaboradorApi, colaboradorId, produto: produtoApi }),
        loadWeeklyPerformanceData(),
      ]);

      setDailyChartData([]);
      setTotalLeads(0);
    } catch (err: any) {
      console.error("❌ Analytics: erro ao recarregar dados:", err);
      setError(err.message || "Falha ao recarregar dados.");
    } finally {
      if (showRefreshing) setRefreshing(false);
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate, equipe, colaborador, colaboradorId, produto, loadCollaboratorsAndMetrics, loadRawMetrics, loadWeeklyPerformanceData]);

  const handleFilterChange = useCallback((newFilters: typeof filters) => {
    setFilters(newFilters);
  }, []);

  const handleRefresh = useCallback(async () => {
    await reloadData(true);
  }, [reloadData]);

  useEffect(() => {
    if (!currentStartDate || !currentEndDate) return;
    reloadData(false);
  }, [currentStartDate, currentEndDate, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  // ========== BUSCA DO BÔNUS ==========
  useEffect(() => {
    if (!currentUser?.id) { setBonusLoading(false); setUserBonus(0); return; }
    if (isExcluded) { setBonusLoading(false); setUserBonus(0); return; }
    const fetchBonus = async () => {
      setBonusLoading(true);
      try {
        const mes = (currentStartDate ?? new Date().toISOString()).substring(0,7);
        const userId = currentUser?.id ?? '';
        let url = `${API_BASE}/metricas-assessores?mes=${mes}&colaborador_id=${userId}`;
        let res = await fetch(url, { credentials: 'include' }); let data = await res.json();
        let bonus = 0, found = false;
        if (data.success && data.data?.length > 0) {
          const raw = data.data[0].comissao_bonus; bonus = typeof raw === 'number' ? raw : parseFloat(raw);
          if (!isNaN(bonus) && bonus > 0) found = true;
        }
        if (!found && currentUser.email) {
          url = `${API_BASE}/metricas-assessores?mes=${mes}&email=${encodeURIComponent(currentUser.email)}`;
          res = await fetch(url, { credentials: 'include' }); data = await res.json();
          if (data.success && data.data?.length > 0) {
            const raw = data.data[0].comissao_bonus; bonus = typeof raw === 'number' ? raw : parseFloat(raw);
            if (!isNaN(bonus)) found = true;
          }
        }
        setUserBonus(found && bonus > 0 ? bonus : 0);
        if (!found) setBonusError("Registro não encontrado.");
      } catch (err) { setUserBonus(0); setBonusError("Erro na requisição"); }
      finally { setBonusLoading(false); }
    };
    fetchBonus();
  }, [currentUser, currentStartDate, isExcluded]);

  // ========== GRÁFICO DE EVOLUÇÃO DIÁRIA ==========
  const chartDateRange = useMemo(() => getChartDateRange(period, currentStartDate, currentEndDate), [period, currentStartDate, currentEndDate]);
  const isFetchingRef = useRef(false);
  const lastFetchChartTime = useRef<number>(0);
  const CHART_CACHE_TTL = 60000;

  useEffect(() => {
    if (!chartDateRange.start || !chartDateRange.end) return;
    const abortController = new AbortController(); const signal = abortController.signal;
    const fetchChartData = async () => {
      if (isFetchingRef.current) return; isFetchingRef.current = true;
      const now = Date.now(); const shouldFetch = (now - lastFetchChartTime.current) > CHART_CACHE_TTL || dailyChartData.length === 0;
      if (!shouldFetch && dailyChartData.length > 0) { isFetchingRef.current = false; return; }
      try {
        const equipeApi = equipe === "todas" ? undefined : equipe;
        const colaboradorApi = colaborador === "todos" ? undefined : colaborador;
        const produtoApi = produto === "Todos" ? undefined : produto;
        const baseParams = { start: chartDateRange.start, end: chartDateRange.end, equipe: equipeApi, colaborador: colaboradorApi, colaboradorId, produto: produtoApi, granularity: 'daily' as const };
        const [leadsData, assinadosData, ganhosData, protocoladosData, perdidosData] = await Promise.all([
          fetchLeadsRecebidos(baseParams), fetchAssinados(baseParams), fetchGanhos(baseParams), fetchProtocolados(baseParams), fetchPerdidos(baseParams),
        ]);
        if (signal.aborted) return;
        const dataMap = new Map<string, { leads: number; assinados: number; ganhos: number; protocolados: number; perdidos: number }>();
        const processData = (data: any[], field: 'leads' | 'assinados' | 'ganhos' | 'protocolados' | 'perdidos') => {
          data.forEach(item => {
            let rawDate = item.data || item.periodo; if (!rawDate) return;
            const dateStr = rawDate.split('T')[0]; if (!dateStr) return;
            const existing = dataMap.get(dateStr) || { leads:0, assinados:0, ganhos:0, protocolados:0, perdidos:0 };
            existing[field] += Number(item.total)||0; dataMap.set(dateStr, existing);
          });
        };
        processData(leadsData,'leads'); processData(assinadosData,'assinados'); processData(ganhosData,'ganhos'); processData(protocoladosData,'protocolados'); processData(perdidosData,'perdidos');
        const allDates: string[] = [];
        const startDate = new Date(Date.UTC(parseInt(chartDateRange.start.slice(0,4)), parseInt(chartDateRange.start.slice(5,7))-1, parseInt(chartDateRange.start.slice(8,10))));
        const endDate = new Date(Date.UTC(parseInt(chartDateRange.end.slice(0,4)), parseInt(chartDateRange.end.slice(5,7))-1, parseInt(chartDateRange.end.slice(8,10))));
        const current = new Date(startDate);
        while (current < endDate) {
          const dateStr = current.toISOString().split('T')[0];
          allDates.push(dateStr);
          current.setUTCDate(current.getUTCDate() + 1);
        }
        if (allDates.length === 0 && chartDateRange.start && chartDateRange.end) { const today = new Date(endDate); today.setUTCDate(today.getUTCDate()-1); allDates.push(today.toISOString().split('T')[0]); }
        const chartArray = allDates.map(date => {
          const values = dataMap.get(date) || { leads:0, assinados:0, ganhos:0, protocolados:0, perdidos:0 };
          const [y,m,d] = date.split('-'); return { date: `${d}/${m}`, fullDate: date, leads: values.leads, assinados: values.assinados, ganhos: values.ganhos, protocolados: values.protocolados, perdidos: values.perdidos };
        });
        setDailyChartData(chartArray); lastFetchChartTime.current = Date.now();
        setTotalLeads(Array.from(dataMap.values()).reduce((s,v)=>s+v.leads,0));
        setTotalAssinados(Array.from(dataMap.values()).reduce((s,v)=>s+v.assinados,0));
        setApiError(null);
      } catch (err: any) { if (err.name !== 'AbortError') setApiError(err.message||"Erro ao carregar dados do gráfico"); }
      finally { isFetchingRef.current = false; }
    };
    fetchChartData();
    return () => { abortController.abort(); isFetchingRef.current = false; };
  }, [chartDateRange, equipe, colaborador, colaboradorId, produto, period, dailyChartData.length]);

  // ========== DADOS PARA KPIS ==========
  const totals = rawMetrics;
  const isSpecialGroup = produto === 'Quinquenio' || produto === 'Concomitante';
  const filteredCollaborators = useMemo(() => collaborators.filter(c => !isExcludedTeam(c.equipeNome) && (equipe==="todas"||c.equipeNome===equipe) && (colaborador==="todos"||c.name===colaborador)), [collaborators, equipe, colaborador]);
  const baseCollaborators = useMemo(() => filteredCollaborators.filter(c => { const g = (c.grupo||'').trim().toLowerCase(); return g!=='supervisor' && g!=='coordenador' && g!=='administrativo' && g!=='desativado'; }), [filteredCollaborators]);
  const { targetAssinados, targetGanhos } = useMemo(() => {
    if (equipe==="todas" && colaborador==="todos") {
      if (currentStartDate===currentEndDate) return { targetAssinados:100, targetGanhos:100 };
      if (new Date(currentEndDate).getTime()-new Date(currentStartDate).getTime() <= 7*86400000) return { targetAssinados:500, targetGanhos:500 };
      return { targetAssinados:2000, targetGanhos:2000 };
    }
    const periodoMeta='mensal';
    return {
      targetAssinados: baseCollaborators.reduce((sum,c)=>sum+getMeta(c, periodoMeta, 'assinados'),0),
      targetGanhos: baseCollaborators.reduce((sum,c)=>sum+getMeta(c, periodoMeta, 'ganhos'),0)
    };
  }, [baseCollaborators, equipe, colaborador, currentStartDate, currentEndDate]);
  const percentAssinados = targetAssinados>0 ? (totals.assinados/targetAssinados)*100 : 0;
  const percentGanhos = targetGanhos>0 ? (totals.ganhos/targetGanhos)*100 : 100;
  const goalProgress = Math.min(percentAssinados, percentGanhos);

  const periodoMetaUser = period==='Hoje'?'diario':period==='Semana'?'semanal':'mensal';
  const userMetasBatidas = useMemo(() => {
    if (!currentUserData) return 0;
    const assinados = currentUserData.assinados||0;
    const ganhos = isSpecialGroup ? 0 : (currentUserData.ganhos||0);
    const pesoAss = getMeta(currentUserData, periodoMetaUser, 'assinados');
    const pesoGan = getMeta(currentUserData, periodoMetaUser, 'ganhos');
    if (pesoGan===0) return Math.floor(assinados/(pesoAss||1));
    return Math.floor(Math.min(assinados/(pesoAss||1), ganhos/(pesoGan||1)));
  }, [currentUserData, periodoMetaUser, isSpecialGroup]);
  const userBonusCiclo = userBonus!==null ? userBonus : 0;
  const taxaConversaoGeral = totalLeads>0 ? (totalAssinados/totalLeads)*100 : 0;
  const mediaDiariaVendas = dailyChartData.length>0 ? totalAssinados/dailyChartData.length : 0;

  const funnelChartData = [
    { name:"Leads", value: totalLeads, color:"#3b82f6" },
    { name:"Emitidos", value:totals.emitidos, color:"#2F6FED" },
    { name:"Assinados", value:totals.assinados, color:"#16A34A" },
    { name:"Ganhos", value:totals.ganhos, color:"#EA8C1D" },
    { name:"Protocolados", value:totals.protocolados, color:"#8B5CF6" },
    { name:"Perdidos", value:totals.perdidos, color:"#DC2626" },
  ].filter(item=>item.value>0);
const conversionByStage = useMemo(() => {
  const leads = totalLeads;
  const e=totals.emitidos,a=totals.assinados,p=totals.protocolados,g=totals.ganhos,pe=totals.perdidos;
  return [
    { stage:"Leads Recebidos → Emitidos", value: leads>0?+((e/leads)*100).toFixed(1):0 },
    { stage:"Emitidos → Assinados", value: e>0?+((a/e)*100).toFixed(1):0 },
    { stage:"Assinados → Protocolados", value: a>0?+((p/a)*100).toFixed(1):0 },
    { stage:"Protocolados → Ganhos", value: p>0?+((g/p)*100).toFixed(1):0 },
    { stage:"Assinados → Ganhos", value: a>0?+((g/a)*100).toFixed(1):0 },
    { stage:"Assinados → Perdidos", value: a>0?+((pe/a)*100).toFixed(1):0 },  
  ];
}, [totals, totalLeads]);
  const hasActiveFilters = equipe!=="todas"||colaborador!=="todos"||produto!=="Todos";

  const displayCurrency = (val: number) => hideValues ? "R$ ****" : formatCurrency(val);

  const renderBonusCard = () => {
    if (isExcluded) return (<div className="card text-center"><DollarSign className="w-4 h-4 text-[#2F6FED] mx-auto mb-1" /><div className="text-lg font-black text-[#0f172a]">--</div><div className="text-xs text-[#64748b]">Esse perfil não comissiona</div></div>);
    if (bonusLoading) return (<div className="card text-center"><DollarSign className="w-4 h-4 text-[#2F6FED] mx-auto mb-1" /><div className="text-2xl font-black text-[#0f172a]">Carregando...</div></div>);
    return (<div className="card text-center"><DollarSign className="w-4 h-4 text-[#2F6FED] mx-auto mb-1" /><div className="text-2xl font-black text-[#0f172a]">{displayCurrency(userBonusCiclo)}</div><div className="text-xs text-[#64748b]">{bonusError||"valor do banco"}</div></div>);
  };

  return (
    <DashboardLayout title="Analytics" subtitle="Métricas avançadas, comissões e indicadores de performance">
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

      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg text-sm mb-4">
          <p>{error}</p>
          <button onClick={() => reloadData(true)} className="mt-2 px-4 py-2 bg-red-600 text-white rounded-lg text-xs hover:bg-red-700">
            Tentar novamente
          </button>
        </div>
      )}

      {!loading && collaborators.length === 0 && !error && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-center text-amber-800 text-sm">
          Nenhum colaborador disponível para os filtros atuais.
        </div>
      )}

      {!loading && collaborators.length > 0 && (
        <>
          {hasActiveFilters && (
            <div className="mb-4 px-4 py-2 bg-[#eff6ff] rounded-lg text-xs text-[#2F6FED] flex items-center gap-2 flex-wrap">
              <span>📊</span>
              <span>
                Mostrando dados de:
                {filters.equipe !== "todas" && ` ${filters.equipe}`}
                {filters.colaborador !== "todos" && ` - ${filters.colaborador}`}
                {filters.produto !== "Todos" && ` - Produto: ${filters.produto}`}
              </span>            </div>
          )} 

          {/* KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <KpiCard label="Comissão Estimada" value={userMetasBatidas * userBonusCiclo} target={5000} unit="R$" icon={DollarSign} color="#2F6FED" simple hideValues={hideValues} />
            <KpiCard label={isSpecialGroup ? "Assinados" : "Vendas Fechadas"} value={isSpecialGroup ? totals.assinados : totals.assinados} target={isSpecialGroup ? targetAssinados : targetAssinados} unit="" icon={FileCheck} color="#16A34A" hideValues={hideValues} />
            <KpiCard label="Protocolados" value={totals.protocolados} target={60} unit="" icon={BarChart2} color="#8B5CF6" hideValues={hideValues} />
            <KpiCard label="Progresso da Meta" value={goalProgress} target={100} unit="%" icon={Activity} color="#EA8C1D" hideValues={hideValues} />
          </div>
 
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="card animate-fade-in-up">
              <div className="flex items-center justify-between mb-2"><span className="text-xs text-[#64748b]">Performance no Período</span>{percentAssinados>=100 ? <TrendingUp className="w-4 h-4 text-[#16A34A]" /> : <TrendingDown className="w-4 h-4 text-[#DC2626]" />}</div>
              <div className="kpi-value text-[#0f172a]">{percentAssinados.toFixed(1)}%</div>
              <div className="text-xs text-[#94a3b8] mt-1">{formatInt(totals.assinados)} / {formatInt(targetAssinados)} assinados</div>
              <div className="progress-bar mt-2"><div className="progress-fill" style={{ width: `${Math.min(percentAssinados, 100)}%` }} /></div>
            </div>
            <div className="card animate-fade-in-up" style={{ animationDelay: "80ms" }}>
              <div className="flex items-center justify-between mb-2"><span className="text-xs text-[#64748b]">Taxa de Conversão</span><Target className="w-4 h-4 text-[#2F6FED]" /></div>
              <div className="kpi-value text-[#0f172a]">{taxaConversaoGeral.toFixed(1)}%</div>
              <div className="text-xs text-[#94a3b8] mt-1">{formatInt(totalAssinados)} vendas / {formatInt(totalLeads)} leads</div>
            </div>
            <div className="card animate-fade-in-up" style={{ animationDelay: "160ms" }}>
              <div className="flex items-center justify-between mb-2"><span className="text-xs text-[#64748b]">Média Diária (assinados)</span><ShoppingBag className="w-4 h-4 text-[#16A34A]" /></div>
              <div className="kpi-value text-[#0f172a]">{mediaDiariaVendas.toFixed(1)}</div>
              <div className="text-xs text-[#94a3b8] mt-1">últimos {formatInt(dailyChartData.length)} dias</div>
            </div>
            <div className="card animate-fade-in-up" style={{ animationDelay: "240ms" }}>
              <div className="flex items-center justify-between mb-2"><span className="text-xs text-[#64748b]">Total de Leads</span><Users className="w-4 h-4 text-[#EA8C1D]" /></div>
              <div className="kpi-value text-[#0f172a]">{formatInt(totalLeads)}</div>
              <div className="text-xs text-[#94a3b8] mt-1">no período</div>
            </div>
          </div>

          {/* Evolução Diária */}
          <div className="card p-5 mb-6 animate-fade-in-up" style={{ animationDelay: "320ms" }}>
            <h3 className="text-sm font-bold text-[#0f172a] mb-4">Evolução Diária {period === "Hoje" ? "(semana atual)" : period === "Semana" ? "(duas últimas semanas, apenas dias úteis)" : ""}</h3>
            <p className="text-xs text-[#64748b] mb-2">Período: {chartDateRange.start} a {chartDateRange.end}</p>
            {apiError && <div className="bg-red-50 text-red-700 p-3 rounded-lg text-sm mb-4">Erro: {apiError}</div>}
            {dailyChartData.length === 0 && !apiError && <div className="flex items-center justify-center h-[260px] text-[#94a3b8] text-sm">Nenhum dado disponível para o período</div>}
            {dailyChartData.length > 0 && (
              <ResponsiveContainer width="100%" height={320}>
                <AreaChart data={dailyChartData}>
                  <defs>
                    <linearGradient id="colorLeads" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#16A34A" stopOpacity={0.2} /><stop offset="95%" stopColor="#16A34A" stopOpacity={0} /></linearGradient>
                    <linearGradient id="colorAssinados" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#2F6FED" stopOpacity={0.2} /><stop offset="95%" stopColor="#2F6FED" stopOpacity={0} /></linearGradient>
                    <linearGradient id="colorGanhos" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#EA8C1D" stopOpacity={0.2} /><stop offset="95%" stopColor="#EA8C1D" stopOpacity={0} /></linearGradient>
                    <linearGradient id="colorProtocolados" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.2} /><stop offset="95%" stopColor="#8B5CF6" stopOpacity={0} /></linearGradient>
                    <linearGradient id="colorPerdidos" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#DC2626" stopOpacity={0.2} /><stop offset="95%" stopColor="#DC2626" stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} width={30} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                  <Area type="monotone" dataKey="leads" stroke="#16A34A" strokeWidth={2} fill="url(#colorLeads)" name="Leads" />
                  <Area type="monotone" dataKey="assinados" stroke="#2F6FED" strokeWidth={2} fill="url(#colorAssinados)" name="Assinados" />
                  <Area type="monotone" dataKey="ganhos" stroke="#EA8C1D" strokeWidth={2} fill="url(#colorGanhos)" name="Ganhos" />
                  <Area type="monotone" dataKey="protocolados" stroke="#8B5CF6" strokeWidth={2} fill="url(#colorProtocolados)" name="Protocolados" />
                  <Area type="monotone" dataKey="perdidos" stroke="#DC2626" strokeWidth={2} fill="url(#colorPerdidos)" name="Perdidos" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Distribuição (agora barras) + Conversão */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="card p-5 animate-fade-in-up" style={{ animationDelay: "480ms" }}>
              <h3 className="text-sm font-bold text-[#0f172a] mb-4">Distribuição por Etapa</h3>
              {funnelChartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={funnelChartData} margin={{ top: 10, right: 30, left: 0, bottom: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} width={30} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]} barSize={36}>
                      {funnelChartData.map((entry, index) => (
                        <Cell key={index} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[260px] text-center text-[#94a3b8] text-sm">Nenhum dado disponível</div>
              )}
              <div className="flex flex-wrap justify-center gap-3 mt-3">
                {funnelChartData.map((item,i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: item.color }} />
                    <span className="text-[10px] text-[#64748b]">{item.name}</span>
                    <span className="text-[10px] font-bold text-[#0f172a]">{formatInt(item.value)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card p-5 animate-fade-in-up" style={{ animationDelay: "560ms" }}>
              <h3 className="text-sm font-bold text-[#0f172a] mb-4">Taxa de Conversão por Estágio</h3>
              <ResponsiveContainer width="100%" height={350}>
                <BarChart data={conversionByStage} layout="vertical" margin={{ left: 10, right: 30, top: 10, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v) => `${v}%`} />
                  <YAxis type="category" dataKey="stage" tick={{ fontSize: 9, fill: "#0f172a" }} width={150} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(value: any) => [`${value}%`, "Conversão"]} contentStyle={{ fontSize: 11 }} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} name="Conversão">
                    {conversionByStage.map((entry, index) => <Cell key={index} fill={entry.value >= 60 ? "#16A34A" : entry.value >= 40 ? "#EA8C1D" : "#DC2626"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Resumo */}
          <div className="card p-5 animate-fade-in-up" style={{ animationDelay: "640ms" }}>
            <h3 className="text-sm font-bold text-[#0f172a] mb-4">Resumo de Comissões e Metas</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-[#f8fafc] rounded-xl p-4 text-center"><Award className="w-4 h-4 text-[#16A34A] mx-auto mb-1" /><div className="eyebrow">Gols</div><div className="kpi-value text-[#0f172a]">{formatInt(userMetasBatidas)}</div><div className="text-xs text-[#94a3b8]">Seus Gols</div></div>
              <div className="bg-[#f8fafc] rounded-xl p-4 text-center"><TrendingUp className="w-4 h-4 text-[#16A34A] mx-auto mb-1" /><div className="eyebrow">Assinados</div><div className="kpi-value text-[#0f172a]">{formatInt(totals.assinados)}</div><div className="text-xs text-[#94a3b8]">meta: {formatInt(targetAssinados)}</div></div>
              <div className="bg-[#f8fafc] rounded-xl p-4 text-center"><Trophy className="w-4 h-4 text-[#ffcc00] mx-auto mb-1" /><div className="eyebrow">Ganhos</div><div className="kpi-value text-[#0f172a]">{formatInt(totals.ganhos)}</div><div className="text-xs text-[#94a3b8]">{isSpecialGroup ? "Meta não se aplica" : `meta: ${formatInt(targetGanhos)}`}</div></div>
              <div className="bg-[#f8fafc] rounded-xl p-4 text-center"><FileCheck className="w-4 h-4 text-[#8B5CF6] mx-auto mb-1" /><div className="eyebrow">Protocolados</div><div className="kpi-value text-[#0f172a]">{formatInt(totals.protocolados)}</div></div>
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}