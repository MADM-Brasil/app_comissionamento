// src/pages/Analytics.tsx – Eixo Y fixo com ticks [0,15,30,45,60,75]
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, formatCurrency } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell, LineChart, Line,
} from "recharts";
import {
  TrendingUp, TrendingDown, Target, Users,
  ShoppingBag, Award, DollarSign, FileCheck,
  BarChart2, Activity, RefreshCw, Loader2,
  FileText, CheckCircle, Archive, XCircle,
  ArrowDown, Table as TableIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchLeadsRecebidos,
  fetchAssinados,
  fetchGanhos,
  fetchProtocolados,
  fetchPerdidos,
  fetchEmitidos,
  fetchCollaborators,
} from "@/lib/api";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3007/api";

// ======================== CONSTANTES DE EXCLUSÃO ========================
const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário','BackOffice',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro'
];

const EXCLUDED_CARGOS = [
  "desativado","assistente","analista juridico","gestor de projetos","analista",
  "analista de discadora","supervisor","coordenador","salesops","ceo",
  "analista de crm","desenvolvedor","diretora","analista de dados","desenvolvedor make",
];

const normalize = (str: string) => (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const isExcludedTeam = (name: string) => EXCLUDED_TEAMS.includes(name);
const isExcludedCargo = (cargo: string) => EXCLUDED_CARGOS.some(g => normalize(g) === normalize(cargo));

type MetricKey = "emitidos" | "assinados" | "protocolados" | "ganhos" | "perdidos";

const FULL_METRIC_CONFIG: Record<MetricKey, { label: string; icon: any; color: string }> = {
  emitidos:  { label: "Emitidos",    icon: FileText,    color: "#3b82f6" },
  assinados: { label: "Assinados",   icon: FileCheck,   color: "#34a853" },
  protocolados:{ label: "Protocolados", icon: Archive,  color: "#045b5b" },
  ganhos:    { label: "Ganhos",      icon: TrendingUp,  color: "#f59e0b" },
  perdidos:  { label: "Perdidos",    icon: XCircle,     color: "#ef4444" },
};

const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

// ---------- UTILITÁRIOS DE DATA ----------
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
function formatDate(d: Date): string { return d.toISOString().slice(0, 10); }

function getChartDateRange(period: string, currentStart: string, currentEnd: string): { start: string; end: string } {
  if (period === "Hoje") {
    const today = new Date();
    const monday = getMonday(today);
    const endDate = new Date(today);
    endDate.setDate(today.getDate() + 1);
    return { start: formatDate(monday), end: formatDate(endDate) };
  }
  if (period === "Semana") {
    const today = new Date();
    const currentSunday = getSunday(today);
    const previousMonday = getMonday(today);
    previousMonday.setDate(previousMonday.getDate() - 7);
    const endDate = new Date(currentSunday);
    endDate.setDate(currentSunday.getDate() + 1);
    return { start: formatDate(previousMonday), end: formatDate(endDate) };
  }
  return { start: currentStart, end: currentEnd };
}

function isWeekday(dateStr: string): boolean {
  const date = new Date(dateStr + "T12:00:00Z");
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

// Cálculo de regressão linear
function computeTrendLine(data: { label: string; value: number }[]): { label: string; trend: number }[] | null {
  if (data.length < 2) return null;
  const n = data.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  data.forEach((point, i) => {
    const x = i;
    const y = point.value;
    sumX += x; sumY += y; sumXY += x*y; sumX2 += x*x;
  });
  const slope = (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX);
  const intercept = (sumY - slope*sumX) / n;
  return data.map((point, i) => ({
    label: point.label,
    trend: Math.max(0, slope * i + intercept)  // evita valores negativos
  }));
}

// ---------- COMPONENTES AUXILIARES ----------
function ConversionArrow({ from, to }: { from: number; to: number }) {
  const rate = from>0 ? ((to/from)*100).toFixed(1) : "0";
  const good = parseFloat(rate)>=60;
  return (
    <div className="flex flex-col items-center py-1">
      <div className={cn("flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full", good?"bg-green-50 text-green-700":"bg-red-50 text-red-600")}>
        {good ? <TrendingUp className="w-3 h-3"/> : <TrendingDown className="w-3 h-3"/>} {rate}%
      </div>
      <ArrowDown className="w-4 h-4 text-gray-300 mt-0.5"/>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload?.length) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-gray-700 mb-1">{label}</p>
        {payload.map((e: any,i: number) => (
          <p key={i} style={{color:e.color}} className="font-medium">{e.name}: {formatInt(e.value)}</p>
        ))}
      </div>
    );
  }
  return null;
};

function KpiCard({ label, value, target, unit, icon: Icon, color, simple=false }: any) {
  const pct = target>0 ? Math.round((value/target)*100) : 0;
  const display = unit==="R$" ? formatCurrency(value) : unit==="%" ? `${value.toFixed(1)}%` : formatInt(value);
  return (
    <div className="madm-card p-4 animate-fade-in-up">
      <div className="flex items-start justify-between mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{background:`${color}15`}}>
          <Icon className="w-4 h-4" style={{color}}/>
        </div>
        {!simple && (
          <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", pct>=100?"bg-green-50 text-green-700":pct>=70?"bg-yellow-50 text-yellow-700":"bg-blue-50 text-blue-700")}>{pct}%</span>
        )}
      </div>
      <div className="text-xl font-black text-[#09175b]">{display}</div>
      <div className="text-xs text-gray-500 mb-2">{label}</div>
      {!simple && (
        <>
          <div className="madm-progress-bar"><div className="madm-progress-fill" style={{width:`${Math.min(pct,100)}%`}}/></div>
          <div className="text-[10px] text-gray-400 mt-1">Meta: {unit==="R$"?formatCurrency(target):formatInt(target)}</div>
        </>
      )}
    </div>
  );
}

// ======================== COMPONENTE PRINCIPAL ========================
export default function Analytics() {
  const [, navigate] = useLocation();
  const { currentUser, globalConfig, currentStartDate, currentEndDate, period } = useAppStore();
  const { hasPermission } = useAccessControl();
  useEffect(() => { if (!hasPermission("canAccessReports")) navigate("/"); }, [hasPermission, navigate]);

  const [filters, setFilters] = useState<{equipe:string; colaborador:string; colaboradorId?:string|number; produto:string}>({equipe:"todas",colaborador:"todos",produto:"Todos"});
  const [isFirstFilterApplied, setIsFirstFilterApplied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const allMetrics: MetricKey[] = ["emitidos","assinados","protocolados","ganhos","perdidos"];
  const [selectedMetrics, setSelectedMetrics] = useState<MetricKey[]>(allMetrics);

  const [rawDailyData, setRawDailyData] = useState<Record<MetricKey, any[]>>({emitidos:[],assinados:[],protocolados:[],ganhos:[],perdidos:[]});
  const [leadsStageData, setLeadsStageData] = useState<any[]>([]);
  const [dailyChartData, setDailyChartData] = useState<any[]>([]);
  const [totalLeadsSum, setTotalLeadsSum] = useState(0);
  const [totalAssinadosSum, setTotalAssinadosSum] = useState(0);
  const [error, setError] = useState<string|null>(null);

  const [collaborators, setCollaboratorsLocal] = useState<any[]>([]);
  useEffect(() => {
    if (!currentStartDate) return;
    const mes = currentStartDate.substring(0,7);
    fetchCollaborators(`?mes=${mes}`).then(d => setCollaboratorsLocal(d||[])).catch(console.error);
  }, [currentStartDate]);

  const validCollaboratorNames = useMemo(() => {
    return collaborators.filter(c => !isExcludedCargo(c.cargo) && !isExcludedTeam(c.equipeNome)).map(c => c.name);
  }, [collaborators]);

  const chartDateRange = useMemo(() => getChartDateRange(period, currentStartDate, currentEndDate), [period, currentStartDate, currentEndDate]);

  // ========== RECARGA ==========
  const reloadData = useCallback(async (showRefreshing = false) => {
    if (!chartDateRange.start || !chartDateRange.end) return;
    if (showRefreshing) setRefreshing(true);
    setLoading(true); setError(null);
    try {
      const equipeApi = filters.equipe === "todas" ? undefined : filters.equipe;
      const colaboradorApi = filters.colaborador === "todos" ? undefined : filters.colaborador;
      const colaboradorIdApi = filters.colaboradorId;
      const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;
      const baseParams = {
        start: chartDateRange.start, end: chartDateRange.end,
        equipe: equipeApi, colaborador: colaboradorApi, colaboradorId: colaboradorIdApi,
        produto: produtoApi, granularity: 'daily' as const,
      };
      const [leadsData, assinadosData, ganhosData, protocoladosData, perdidosData, emitidosData] = await Promise.all([
        fetchLeadsRecebidos(baseParams), fetchAssinados(baseParams), fetchGanhos(baseParams),
        fetchProtocolados(baseParams), fetchPerdidos(baseParams), fetchEmitidos(baseParams),
      ]);
      type DataPointFields = 'leads' | 'assinados' | 'ganhos' | 'protocolados' | 'perdidos' | 'emitidos';
      const dataMap = new Map<string, Record<DataPointFields, number>>();
      const processData = (data: any[], field: DataPointFields) => {
        data.forEach(item => {
          let rawDate = item.data || item.periodo; if (!rawDate) return;
          const dateStr = rawDate.split('T')[0]; if (!dateStr) return;
          const existing = dataMap.get(dateStr) || { leads:0, assinados:0, ganhos:0, protocolados:0, perdidos:0, emitidos:0 };
          existing[field] += Number(item.total)||0;
          dataMap.set(dateStr, existing);
        });
      };
      processData(leadsData, 'leads'); processData(assinadosData, 'assinados'); processData(ganhosData, 'ganhos');
      processData(protocoladosData, 'protocolados'); processData(perdidosData, 'perdidos'); processData(emitidosData, 'emitidos');
      const allDates: string[] = [];
      const startDate = new Date(Date.UTC(parseInt(chartDateRange.start.slice(0,4)), parseInt(chartDateRange.start.slice(5,7))-1, parseInt(chartDateRange.start.slice(8,10))));
      const endDate = new Date(Date.UTC(parseInt(chartDateRange.end.slice(0,4)), parseInt(chartDateRange.end.slice(5,7))-1, parseInt(chartDateRange.end.slice(8,10))));
      const current = new Date(startDate);
      while (current < endDate) {
        const dateStr = current.toISOString().split('T')[0];
        if (period === "Semana") { if (isWeekday(dateStr)) allDates.push(dateStr); }
        else allDates.push(dateStr);
        current.setUTCDate(current.getUTCDate() + 1);
      }
      if (allDates.length === 0 && chartDateRange.start && chartDateRange.end) {
        const today = new Date(endDate); today.setUTCDate(today.getUTCDate()-1); allDates.push(today.toISOString().split('T')[0]);
      }
      const chartArray = allDates.map(date => {
        const values = dataMap.get(date) || { leads:0, assinados:0, ganhos:0, protocolados:0, perdidos:0, emitidos:0 };
        const [y,m,d] = date.split('-');
        return {
          date: `${d}/${m}`, fullDate: date,
          leads: values.leads, assinados: values.assinados, ganhos: values.ganhos,
          protocolados: values.protocolados, perdidos: values.perdidos, emitidos: values.emitidos,
        };
      });
      setDailyChartData(chartArray);
      setRawDailyData({
        emitidos: emitidosData.map((i:any)=>({ data: (i.data||i.periodo||"").split("T")[0], total: Number(i.total)||0, colaborador: i.colaborador })),
        assinados: assinadosData.map((i:any)=>({ data: (i.data||i.periodo||"").split("T")[0], total: Number(i.total)||0, colaborador: i.colaborador })),
        protocolados: protocoladosData.map((i:any)=>({ data: (i.data||i.periodo||"").split("T")[0], total: Number(i.total)||0, colaborador: i.colaborador })),
        ganhos: ganhosData.map((i:any)=>({ data: (i.data||i.periodo||"").split("T")[0], total: Number(i.total)||0, colaborador: i.colaborador })),
        perdidos: perdidosData.map((i:any)=>({ data: (i.data||i.periodo||"").split("T")[0], total: Number(i.total)||0, colaborador: i.colaborador })),
      });
      const totalLeads = Array.from(dataMap.values()).reduce((s,v)=>s+v.leads,0);
      const totalAss = Array.from(dataMap.values()).reduce((s,v)=>s+v.assinados,0);
      setTotalLeadsSum(totalLeads); setTotalAssinadosSum(totalAss);
      const lsParams = new URLSearchParams({ start: chartDateRange.start, end: chartDateRange.end });
      if (equipeApi) lsParams.append('equipe', equipeApi);
      if (colaboradorApi) lsParams.append('colaborador', colaboradorApi);
      if (produtoApi) lsParams.append('produto', produtoApi);
      const lsUrl = `${API_BASE}/metrics/leads/stages?${lsParams}`;
      const lsRes = await fetch(lsUrl, { credentials:"include" });
      const lsData = await lsRes.json();
      if (lsData.success) setLeadsStageData(lsData.data.map((i:any)=>({...i, total:Number(i.total)||0})));
    } catch (err: any) { setError(err.message); }
    finally { if (showRefreshing) setRefreshing(false); setLoading(false); }
  }, [chartDateRange, filters]);

  useEffect(() => { if (!currentStartDate || !currentEndDate) return; reloadData(false); }, [currentStartDate, currentEndDate, reloadData]);

  // ---------- AGREGAÇÕES ----------
  const totals = useMemo(() => {
    const res: Partial<Record<MetricKey, number>> = {};
    for (const m of selectedMetrics) res[m] = dailyChartData.reduce((s,i)=>s+(i[m]||0),0);
    return res;
  }, [dailyChartData, selectedMetrics]);

  const totalAssinados = totals.assinados || 0;
  const totalGanhos = totals.ganhos || 0;
  const totalProtocolados = totals.protocolados || 0;
  const totalEmitidos = totals.emitidos || 0;
  const totalPerdidos = totals.perdidos || 0;

  const totalLeadsCount = useMemo(() => leadsStageData.reduce((s:any,i:any)=>s+(i.total||0),0), [leadsStageData]);
  const taxaConversao = totalLeadsCount > 0 ? (totalAssinadosSum / totalLeadsCount) * 100 : 0;

  const daysDiff = useMemo(() => {
    if (!chartDateRange.start || !chartDateRange.end) return 1;
    const d1 = new Date(chartDateRange.start), d2 = new Date(chartDateRange.end);
    return Math.max(1, Math.ceil((d2.getTime()-d1.getTime())/(1000*60*60*24)) + 1);
  }, [chartDateRange]);
  const mediaDiaria = totalAssinados / daysDiff;

  const isSpecialProduct = filters.produto === 'Quinquenio' || filters.produto === 'Concomitante';
  const targetAssinados = useMemo(() => collaborators.filter(c => validCollaboratorNames.includes(c.name)).reduce((sum, c) => sum + (Number(c.metaMensalAssinados) || 0), 0), [collaborators, validCollaboratorNames]);
  const targetGanhos = useMemo(() => isSpecialProduct ? 0 : collaborators.filter(c => validCollaboratorNames.includes(c.name)).reduce((sum, c) => sum + (Number(c.metaMensalGanhos) || 0), 0), [collaborators, validCollaboratorNames, isSpecialProduct]);
  const percentAssinados = targetAssinados > 0 ? (totalAssinados / targetAssinados) * 100 : 0;
  const percentGanhos = targetGanhos > 0 ? (totalGanhos / targetGanhos) * 100 : 100;
  const goalProgress = isSpecialProduct ? Math.min(percentAssinados, 100) : Math.min(percentAssinados, percentGanhos, 100);

  const totalMetasBatidas = useMemo(() => {
    const colabTotals = new Map<string, { assinados: number; ganhos: number }>();
    rawDailyData.assinados.forEach(item => {
      if (!item.colaborador || !validCollaboratorNames.includes(item.colaborador)) return;
      const cur = colabTotals.get(item.colaborador) || { assinados: 0, ganhos: 0 };
      cur.assinados += item.total; colabTotals.set(item.colaborador, cur);
    });
    rawDailyData.ganhos.forEach(item => {
      if (!item.colaborador || !validCollaboratorNames.includes(item.colaborador)) return;
      const cur = colabTotals.get(item.colaborador) || { assinados: 0, ganhos: 0 };
      cur.ganhos += item.total; colabTotals.set(item.colaborador, cur);
    });
    if (isSpecialProduct) colabTotals.forEach(v => v.ganhos = 0);
    let metas = 0;
    for (const [name, {assinados,ganhos}] of colabTotals.entries()) {
      const colab = collaborators.find(c => c.name === name); if (!colab) continue;
      const pesoAss = Number(colab.metaMensalAssinados) || 0;
      const pesoGan = isSpecialProduct ? 0 : (Number(colab.metaMensalGanhos) || 0);
      if (pesoAss === 0) continue;
      if (pesoGan === 0) metas += Math.floor(assinados / pesoAss);
      else metas += Math.floor(Math.min(assinados / pesoAss, ganhos / pesoGan));
    }
    return metas;
  }, [rawDailyData, collaborators, validCollaboratorNames, isSpecialProduct]);

  const userBonusCiclo = globalConfig.valorBonus || 150;

  const funnelData = useMemo(() => [
    {stage:"Emitidos", count:totalEmitidos, color:"#09175b", icon:FileText},
    {stage:"Assinados", count:totalAssinados, color:"#34a853", icon:CheckCircle},
    {stage:"Protocolados", count:totalProtocolados, color:"#045b5b", icon:Archive},
    {stage:"Ganhos", count:totalGanhos, color:"#f59e0b", icon:DollarSign},
    {stage:"Perdidos", count:totalPerdidos, color:"#ef4444", icon:XCircle},
  ].filter(s => s.count > 0), [totalEmitidos,totalAssinados,totalProtocolados,totalGanhos,totalPerdidos]);

  const totalBase = funnelData.length>0 ? funnelData[0].count : 1;
  const conversionByStage = useMemo(() => {
    const e=totalEmitidos,a=totalAssinados,p=totalProtocolados,g=totalGanhos,pe=totalPerdidos;
    return [
      {stage:"Emitidos → Assinados", value: e>0?+((a/e)*100).toFixed(1):0},
      {stage:"Assinados → Protocolados", value: a>0?+((p/a)*100).toFixed(1):0},
      {stage:"Assinados → Ganhos", value: a>0?+((g/a)*100).toFixed(1):0},
      {stage:"Protocolados → Ganhos", value: p>0?+((g/p)*100).toFixed(1):0},
      {stage:"Ganhos → Perdidos", value: g>0?+((pe/g)*100).toFixed(1):0},
    ];
  }, [totalEmitidos,totalAssinados,totalProtocolados,totalGanhos,totalPerdidos]);

  // Dados para linha de tendência
  const trendData = useMemo(() => {
    if (dailyChartData.length < 2 || selectedMetrics.length === 0) return null;
    const firstMetric = selectedMetrics[0];
    const points = dailyChartData.map(d => ({ label: d.date, value: d[firstMetric] || 0 }));
    return computeTrendLine(points);
  }, [dailyChartData, selectedMetrics]);

  const handleFilterChange = (newFilters: any) => { setFilters(newFilters); if (!isFirstFilterApplied) setIsFirstFilterApplied(true); };
  const hasActiveFilters = filters.equipe!=="todas" || filters.colaborador!=="todos" || filters.produto!=="Todos";

  // ========== RENDER ==========
  return (
    <DashboardLayout title="Analytics" subtitle="Métricas avançadas, pipeline e relatórios">
      <FilterBar onFilterChange={handleFilterChange} showColaboradorFilter={true} className="mb-6"/>

      {hasActiveFilters && (
        <div className="mb-4 px-4 py-2 bg-blue-50 rounded-lg text-xs text-blue-700 flex items-center gap-2 flex-wrap">
          <span>📊</span>
          <span>
            Dados filtrados por:
            {filters.equipe !== "todas" && ` Equipe ${filters.equipe}`}
            {filters.colaborador !== "todos" && ` - ${filters.colaborador}`}
            {filters.produto !== "Todos" && ` • Produto: ${filters.produto}`}
          </span>
        </div>
      )}

      {/* 1️⃣ Métricas para gráficos */}
      <div className="madm-card p-5 mb-6 animate-fade-in-up">
        <div className="mb-2">
          <label className="block text-xs font-semibold text-gray-500 mb-2">Métricas para gráficos</label>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(FULL_METRIC_CONFIG) as MetricKey[]).map(metric => {
              const cfg = FULL_METRIC_CONFIG[metric];
              const sel = selectedMetrics.includes(metric);
              return (
                <button key={metric} onClick={() => setSelectedMetrics(prev => prev.includes(metric) ? prev.filter(m=>m!==metric) : [...prev, metric])}
                  className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all", sel ? "bg-[#09175b] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}>
                  <cfg.icon className="w-3.5 h-3.5"/> {cfg.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* 2️⃣ Linha com timestamp e botão Atualizar */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          {refreshing && (
            <span className="flex items-center gap-1.5 animate-pulse">
              <RefreshCw className="w-3.5 h-3.5 animate-spin"/> Atualizando...
            </span>
          )}
          <span>Atualizado {new Date().toLocaleTimeString()}</span>
        </div>
        <button onClick={() => reloadData(true)} disabled={refreshing}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#09175b] text-white hover:bg-[#09175b]/90 disabled:opacity-50">
          <RefreshCw className={cn("w-3.5 h-3.5 inline mr-1", refreshing&&"animate-spin")}/> Atualizar Dados
        </button>
      </div>

      {loading && <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-[#09175b]"/></div>}
      {error && <div className="bg-red-50 text-red-700 p-4 rounded-lg text-sm mb-6">{error}</div>}

      {!loading && !error && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <KpiCard label="Comissão Estimada" value={totalMetasBatidas * userBonusCiclo} target={5000} unit="R$" icon={DollarSign} color="#09175b" simple />
            <KpiCard label="Vendas Fechadas" value={totalAssinados} target={targetAssinados} unit="" icon={FileCheck} color="#34a853" />
            <KpiCard label="Protocolados" value={totalProtocolados} target={60} unit="" icon={BarChart2} color="#045b5b" />
            <KpiCard label="Progresso da Meta" value={goalProgress} target={100} unit="%" icon={Activity} color="#f59e0b" />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            <div className="madm-card p-4 animate-fade-in-up">
              <div className="flex items-center justify-between mb-2"><span className="text-xs text-gray-500">Performance no Período</span>{percentAssinados>=100?<TrendingUp className="w-4 h-4 text-green-500"/>:<TrendingDown className="w-4 h-4 text-red-500"/>}</div>
              <div className="text-2xl font-black text-[#09175b]">{percentAssinados.toFixed(1)}%</div>
              <div className="text-xs text-gray-400 mt-1">{formatInt(totalAssinados)} / {formatInt(targetAssinados)} assinados</div>
              <div className="madm-progress-bar mt-2"><div className="madm-progress-fill" style={{width:`${Math.min(percentAssinados,100)}%`}}/></div>
            </div>
            <div className="madm-card p-4 animate-fade-in-up" style={{animationDelay:"80ms"}}>
              <div className="flex items-center justify-between mb-2"><span className="text-xs text-gray-500">Taxa de Conversão</span><Target className="w-4 h-4 text-[#09175b]"/></div>
              <div className="text-2xl font-black text-[#09175b]">{taxaConversao.toFixed(1)}%</div>
              <div className="text-xs text-gray-400 mt-1">{formatInt(totalAssinadosSum)} vendas / {formatInt(totalLeadsCount)} leads</div>
            </div>
            <div className="madm-card p-4 animate-fade-in-up" style={{animationDelay:"160ms"}}>
              <div className="flex items-center justify-between mb-2"><span className="text-xs text-gray-500">Média Diária (assinados)</span><ShoppingBag className="w-4 h-4 text-[#34a853]"/></div>
              <div className="text-2xl font-black text-[#09175b]">{mediaDiaria.toFixed(1)}</div>
              <div className="text-xs text-gray-400 mt-1">últimos {formatInt(daysDiff)} dias</div>
            </div>
            <div className="madm-card p-4 animate-fade-in-up" style={{animationDelay:"240ms"}}>
              <div className="flex items-center justify-between mb-2"><span className="text-xs text-gray-500">Total de Leads</span><Users className="w-4 h-4 text-[#f59e0b]"/></div>
              <div className="text-2xl font-black text-[#09175b]">{formatInt(totalLeadsSum)}</div>
              <div className="text-xs text-gray-400 mt-1">no período</div>
            </div>
          </div>

          {/* Pipeline Visual */}
          <div className="madm-card p-5 mb-6 animate-fade-in-up" style={{animationDelay:"320ms"}}>
            <h3 className="text-sm font-bold text-[#09175b] mb-5">Pipeline Visual</h3>
            <div className="flex flex-col items-center gap-0 w-full">
              {funnelData.map((stage,i) => {
                const Icon = stage.icon;
                const next = funnelData[i+1];
                const width = totalBase>0 ? Math.max(30, (stage.count/totalBase)*100) : 30;
                return (
                  <div key={stage.stage} className="w-full flex flex-col items-center">
                    <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl transition-all hover:scale-[1.02]" style={{width:`clamp(140px,${Math.min(width,100)}%,100%)`, background:`${stage.color}15`, border:`1.5px solid ${stage.color}30`}}>
                      <div className="flex items-center gap-1"><Icon className="w-3 h-3" style={{color:stage.color}}/><span className="text-[10px] font-semibold" style={{color:stage.color}}>{stage.stage}</span></div>
                      <span className="text-xs font-black" style={{color:stage.color}}>{formatInt(stage.count)}</span>
                    </div>
                    {next && <ConversionArrow from={stage.count} to={next.count}/>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Distribuição por Etapa + Taxa de Conversão por Estágio */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="madm-card p-5 animate-fade-in-up" style={{animationDelay:"480ms"}}>
              <h3 className="text-sm font-bold text-[#09175b] mb-4">Distribuição por Etapa</h3>
              {funnelData.length>0 ? (
                <ResponsiveContainer width="100%" height={320}>
                  <PieChart><Pie data={funnelData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={2} dataKey="count" label={({name,percent})=>`${name}: ${(percent*100).toFixed(0)}%`} labelLine={true}>{funnelData.map((entry,index)=><Cell key={index} fill={entry.color}/>)}</Pie><Tooltip content={<CustomTooltip/>}/></PieChart>
                </ResponsiveContainer>
              ) : <div className="h-[260px] text-center text-gray-400 text-sm">Nenhum dado</div>}
              <div className="flex flex-wrap justify-center gap-3 mt-3">{funnelData.map((item,i)=>(<div key={i} className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full" style={{background:item.color}}/><span className="text-[10px] text-gray-600">{item.stage}</span><span className="text-[10px] font-bold text-gray-800">{formatInt(item.count)}</span></div>))}</div>
            </div>
            <div className="madm-card p-5 animate-fade-in-up" style={{animationDelay:"560ms"}}>
              <h3 className="text-sm font-bold text-[#09175b] mb-4">Taxa de Conversão por Estágio</h3>
              <ResponsiveContainer width="100%" height={350}>
                <BarChart data={conversionByStage} layout="vertical" margin={{left:10,right:30,top:10,bottom:10}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false}/>
                  <XAxis type="number" domain={[0,100]} tick={{fontSize:10,fill:"#9ca3af"}} tickFormatter={v=>`${v}%`}/>
                  <YAxis type="category" dataKey="stage" tick={{fontSize:9,fill:"#374151"}} width={150} axisLine={false} tickLine={false}/>
                  <Tooltip formatter={(value:any)=>[`${value}%`,"Conversão"]} contentStyle={{fontSize:11}}/>
                  <Bar dataKey="value" radius={[0,6,6,0]} name="Conversão">
                    {conversionByStage.map((entry,index)=><Cell key={index} fill={entry.value>=60?"#34a853":entry.value>=40?"#f59e0b":"#ef4444"}/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Tendência (eixo Y com ticks fixos 0-15-30-45-60-75) */}
          <div className="madm-card p-5 mb-6 animate-fade-in-up">
            <h3 className="text-sm font-bold text-[#09175b] mb-4">Tendência</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={dailyChartData}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="4 4" vertical={false} />
                <XAxis dataKey="date" tick={{fontSize:11}} interval={0} angle={-20} textAnchor="end" height={40} />
                <YAxis domain={[0, 75]} ticks={[0, 15, 30, 45, 60, 75]} tickFormatter={v => formatInt(v)} />
                <Tooltip formatter={(v:any)=>formatInt(v)} />
                <Legend />
                {selectedMetrics.map(m => (
                  <Line key={m} type="monotone" dataKey={m} name={FULL_METRIC_CONFIG[m].label} stroke={FULL_METRIC_CONFIG[m].color} strokeWidth={2} dot={{r:3}} />
                ))}
                {trendData && (
                  <Line data={trendData} type="monotone" dataKey="trend" name="Tendência (linear)" stroke="#8884d8" strokeWidth={2} strokeDasharray="5 5" dot={false} legendType="line" />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Dados Detalhados */}
          <div className="madm-card p-5 animate-fade-in-up mb-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <h3 className="text-sm font-bold text-[#09175b] flex items-center gap-2"><TableIcon className="w-4 h-4"/> Dados Detalhados</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr>
                    <th className="px-4 py-2 text-left">Período</th>
                    {selectedMetrics.map(m => <th key={m} className="px-4 py-2 text-left">{FULL_METRIC_CONFIG[m].label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {dailyChartData.length === 0 ? (
                    <tr><td colSpan={selectedMetrics.length+1} className="text-center py-8 text-gray-400">Nenhum dado</td></tr>
                  ) : (
                    dailyChartData.map((row, idx) => (
                      <tr key={idx} className="border-b hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs">{row.date}</td>
                        {selectedMetrics.map(m => <td key={m} className="px-4 py-2">{formatInt(row[m] || 0)}</td>)}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-gray-400 mt-3 text-right">Total de registros: {formatInt(dailyChartData.length)}</div>
          </div>

          {/* Resumo de Comissões e Metas */}
          <div className="madm-card p-5 animate-fade-in-up">
            <h3 className="text-sm font-bold text-[#09175b] mb-4">Resumo de Comissões e Metas</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-gray-50 rounded-xl p-4"><div className="flex items-center gap-2 mb-2"><Award className="w-4 h-4 text-[#34a853]"/><span className="text-xs font-semibold text-gray-700">Metas Batidas</span></div><div className="text-2xl font-black text-[#09175b]">{formatInt(totalMetasBatidas)}</div><div className="text-xs text-gray-500">suas metas batidas</div></div>
              <div className="bg-gray-50 rounded-xl p-4"><div className="flex items-center gap-2 mb-2"><DollarSign className="w-4 h-4 text-[#09175b]"/><span className="text-xs font-semibold text-gray-700">Bônus por Ciclo</span></div><div className="text-2xl font-black text-[#09175b]">{formatCurrency(userBonusCiclo)}</div><div className="text-xs text-gray-500">valor do bônus</div></div>
              <div className="bg-gray-50 rounded-xl p-4"><div className="flex items-center gap-2 mb-2"><TrendingUp className="w-4 h-4 text-[#34a853]"/><span className="text-xs font-semibold text-gray-700">Assinados</span></div><div className="text-2xl font-black text-[#09175b]">{formatInt(totalAssinados)}</div><div className="text-xs text-gray-500">meta: {formatInt(targetAssinados)}</div></div>
              <div className="bg-gray-50 rounded-xl p-4"><div className="flex items-center gap-2 mb-2"><FileCheck className="w-4 h-4 text-[#045b5b]"/><span className="text-xs font-semibold text-gray-700">Ganhos</span></div><div className="text-2xl font-black text-[#09175b]">{formatInt(totalGanhos)}</div><div className="text-xs text-gray-500">{isSpecialProduct ? "Meta não se aplica" : `meta: ${formatInt(targetGanhos)}`}</div></div>
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}