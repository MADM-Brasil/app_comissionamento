// src/pages/Funil.tsx
import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, Collaborator } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import {
  FileText,
  CheckCircle,
  DollarSign,
  Archive,
  XCircle,
  ArrowDown,
  TrendingDown,
  TrendingUp,
  BarChart3,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { cn } from "@/lib/utils";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3007/api";

// ============================================================
// CONSTANTES DE EXCLUSÃO – agora baseadas em cargo
// ============================================================
const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro', 'Equipe de Reciclagem'
];

const EXCLUDED_CARGOS = [
  "desativado",
  "assistente",
  "analista juridico",
  "gestor de projetos",
  "analista",
  "analista de discadora",
  "supervisor",
  "coordenador",
  "salesops",
  "ceo",
  "analista de crm",
  "desenvolvedor",
  "diretora",
  "analista de dados",
  "desenvolvedor make",
];

const normalize = (str: string): string =>
  (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const isExcludedTeam = (teamName: string) => EXCLUDED_TEAMS.includes(teamName);
const isExcludedCargo = (cargo: string) =>
  EXCLUDED_CARGOS.some(g => normalize(g) === normalize(cargo));

const isDesativado = (c: Collaborator) => {
  const cargo = normalize(c.cargo);
  const equipe = normalize(c.equipeNome);
  return cargo === 'desativado' || equipe.includes('desativado');
};

const productToGroup: Record<string, string | string[] | undefined> = {
  "Todos": undefined,
  "Auxilio Acidente": "Elite",
  "Quinquenio": ["Quinquenio", "Quinquênio"],
  "Concomitante": "Concomitante",
};

// ========== FUNÇÃO AUXILIAR PARA FORMATAÇÃO DE INTEIROS ==========
const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

function ConversionArrow({ from, to }: { from: number; to: number }) {
  const rate = from > 0 ? ((to / from) * 100).toFixed(1) : "0";
  const isGood = parseFloat(rate) >= 60;
  return (
    <div className="flex flex-col items-center py-1">
      <div
        className={cn(
          "flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full",
          isGood ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"
        )}
      >
        {isGood ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
        {rate}%
      </div>
      <ArrowDown className="w-4 h-4 text-gray-300 mt-0.5" />
    </div>
  );
}

const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-gray-700">{payload[0].payload.etapa_lead || payload[0].payload.stage}</p>
        <p className="font-bold text-[#09175b] text-sm">{formatInt(payload[0].value)}</p>
      </div>
    );
  }
  return null;
};

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

// ========== Função para buscar leads por etapa diretamente da API ==========
async function fetchLeadsByStage(params: {
  start: string;
  end: string;
  equipe?: string;
  colaborador?: string;
  colaboradorId?: string | number;
  produto?: string;
}): Promise<{ colaborador: string; etapa_lead: string; total: number }[]> {
  const searchParams = new URLSearchParams();
  searchParams.append('start', params.start);
  searchParams.append('end', params.end);
  if (params.equipe) searchParams.append('equipe', params.equipe);
  if (params.colaborador) searchParams.append('colaborador', params.colaborador);
  if (params.colaboradorId !== undefined) searchParams.append('colaboradorId', String(params.colaboradorId));
  if (params.produto && params.produto !== 'Todos') searchParams.append('produto', params.produto);

  const url = `${API_BASE}/metrics/leads/stages?${searchParams.toString()}`;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Erro ${res.status} ao buscar leads por etapa`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Erro ao carregar leads');
  return data.data.map((item: any) => ({ ...item, total: Number(item.total) || 0 }));
}

export default function Funil() {
  const {
    currentStartDate,
    currentEndDate,
    period,
    collaborators: rawCollaborators,
    loadMetricsForPeriod,
    rawMetrics,
    loadRawMetrics,
    loadWeeklyPerformanceData,
  } = useAppStore();

  const { hasPermission } = useAccessControl();

  const [filters, setFilters] = useState<{
    equipe: string;
    colaborador: string;
    colaboradorId?: string | number;
    produto: string;
  }>({ equipe: "todas", colaborador: "todos", produto: "Todos" });

  const [isFirstFilterApplied, setIsFirstFilterApplied] = useState(false);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [leadsStageData, setLeadsStageData] = useState<{ colaborador: string; etapa_lead: string; total: number }[]>([]);

  const initialLoadDone = useRef(false);
  const lastFiltersRef = useRef(filters);
  const lastDatesRef = useRef({ start: currentStartDate, end: currentEndDate });
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastFetchLeads = useRef<number>(0);
  const LEADS_CACHE_TTL = 60000;

  useEffect(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (!isFirstFilterApplied) {
        console.warn("⏱️ Funil: timeout de segurança forçando primeiro filtro");
        setIsFirstFilterApplied(true);
      }
    }, 3000);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [isFirstFilterApplied]);

  const reloadData = useCallback(async (showRefreshing = false) => {
    const datesChanged =
      currentStartDate !== lastDatesRef.current.start ||
      currentEndDate !== lastDatesRef.current.end;
    const filtersChanged =
      filters.equipe !== lastFiltersRef.current.equipe ||
      filters.colaborador !== lastFiltersRef.current.colaborador ||
      filters.produto !== lastFiltersRef.current.produto;

    const metricsEmpty = rawMetrics.assinados === 0 && rawMetrics.emitidos === 0 && rawMetrics.ganhos === 0;
    if (!showRefreshing && initialLoadDone.current && !datesChanged && !filtersChanged && !metricsEmpty) {
      return;
    }

    if (showRefreshing) setRefreshing(true);
    try {
      const equipeApi = filters.equipe === "todas" ? undefined : filters.equipe;
      const colaboradorApi = filters.colaborador === "todos" ? undefined : filters.colaborador;
      const colaboradorIdApi = filters.colaboradorId;
      const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;

      if (datesChanged || filtersChanged || metricsEmpty) {
        await loadMetricsForPeriod({
          equipeNome: equipeApi,
          colaboradorNome: colaboradorApi,
          colaboradorId: colaboradorIdApi,
          produto: produtoApi,
        });

        await loadRawMetrics({
          equipeNome: equipeApi,
          colaboradorNome: colaboradorApi,
          colaboradorId: colaboradorIdApi,
          produto: produtoApi,
        });

        await loadWeeklyPerformanceData();
      }

      const dateRange = getChartDateRange(period, currentStartDate, currentEndDate);
      
      const now = Date.now();
      const shouldFetchLeads = datesChanged || filtersChanged || 
        (leadsStageData.length === 0) || 
        (now - lastFetchLeads.current) > LEADS_CACHE_TTL || showRefreshing;

      if (shouldFetchLeads) {
        setLoadingLeads(true);
        try {
          const stagesData = await fetchLeadsByStage({
            start: dateRange.start,
            end: dateRange.end,
            equipe: equipeApi,
            colaborador: colaboradorApi,
            colaboradorId: colaboradorIdApi,
            produto: produtoApi,
          });
          setLeadsStageData(stagesData);
          lastFetchLeads.current = Date.now();
        } catch (err) {
          console.error("Erro ao buscar leads por etapa:", err);
          setLeadsStageData([]);
        } finally {
          setLoadingLeads(false);
        }
      }

      lastDatesRef.current = { start: currentStartDate, end: currentEndDate };
      lastFiltersRef.current = { ...filters };
      initialLoadDone.current = true;
    } catch (error) {
      console.error("Erro ao recarregar dados do Funil:", error);
    } finally {
      if (showRefreshing) setRefreshing(false);
      setLoading(false);
    }
  }, [filters, period, currentStartDate, currentEndDate, rawMetrics, loadMetricsForPeriod, loadRawMetrics, loadWeeklyPerformanceData, leadsStageData.length]);

  useEffect(() => {
    if (!isFirstFilterApplied) return;

    if (!currentStartDate || !currentEndDate) {
      setLoading(false);
      return;
    }

    if (initialLoadDone.current) {
      setLoading(false);
      return;
    }

    setLoading(true);
    reloadData(false);
  }, [isFirstFilterApplied, currentStartDate, currentEndDate, reloadData]);

  const handleFilterChange = (newFilters: {
    equipe: string;
    colaborador: string;
    colaboradorId?: string | number;
    produto: string;
  }) => {
    setFilters(newFilters);
    if (!isFirstFilterApplied) {
      setIsFirstFilterApplied(true);
    }
  };

  const filteredCollaborators = useMemo(() => {
    let filtered = [...rawCollaborators];
    if (filters.equipe !== "todas") {
      filtered = filtered.filter(c => c.equipeNome === filters.equipe);
    }
    if (filters.colaborador !== "todos") {
      filtered = filtered.filter(c => c.name === filters.colaborador);
    }
    if (filters.produto !== "Todos") {
      const group = productToGroup[filters.produto];
      if (group) {
        if (Array.isArray(group)) {
          filtered = filtered.filter(c => group.includes(c.cargo));
        } else {
          filtered = filtered.filter(c => c.cargo === group);
        }
      }
    }
    return filtered;
  }, [rawCollaborators, filters]);

  const totalsForCards = rawMetrics;

  const funnelData = useMemo(() => {
    return [
      { stage: "Emitidos", count: totalsForCards.emitidos, color: "#09175b", icon: FileText, description: "Propostas emitidas" },
      { stage: "Assinados", count: totalsForCards.assinados, color: "#34a853", icon: CheckCircle, description: "Contratos assinados" },
      { stage: "Protocolados", count: totalsForCards.protocolados, color: "#045b5b", icon: Archive, description: "Processos protocolados" },
      { stage: "Ganhos", count: totalsForCards.ganhos, color: "#f59e0b", icon: DollarSign, description: "Conversões financeiras" },
      { stage: "Perdidos", count: totalsForCards.perdidos, color: "#ef4444", icon: XCircle, description: "Oportunidades perdidas" },
    ];
  }, [totalsForCards]);

  const totalBase = funnelData[0]?.count || 1;

  const conversionByStage = useMemo(() => {
    const conversions = [];
    const emitidos = funnelData[0]?.count || 0;
    const assinados = funnelData[1]?.count || 0;
    const protocolados = funnelData[2]?.count || 0;
    const ganhos = funnelData[3]?.count || 0;
    const perdidos = funnelData[4]?.count || 0;

    conversions.push({ stage: "Emitidos → Assinados", value: emitidos > 0 ? parseFloat(((assinados / emitidos) * 100).toFixed(1)) : 0 });
    conversions.push({ stage: "Assinados → Protocolados", value: assinados > 0 ? parseFloat(((protocolados / assinados) * 100).toFixed(1)) : 0 });
    conversions.push({ stage: "Assinados → Ganhos", value: assinados > 0 ? parseFloat(((ganhos / assinados) * 100).toFixed(1)) : 0 });
    conversions.push({ stage: "Protocolados → Ganhos", value: protocolados > 0 ? parseFloat(((ganhos / protocolados) * 100).toFixed(1)) : 0 });
    conversions.push({ stage: "Ganhos → Perdidos", value: ganhos > 0 ? parseFloat(((perdidos / ganhos) * 100).toFixed(1)) : 0 });

    return conversions;
  }, [funnelData]);

  const aggregatedLeadStages = useMemo(() => {
    const stageMap = new Map<string, number>();
    leadsStageData.forEach(item => {
      const etapa = item.etapa_lead || "Sem etapa";
      stageMap.set(etapa, (stageMap.get(etapa) || 0) + item.total);
    });
    return Array.from(stageMap.entries())
      .map(([etapa_lead, total]) => ({ etapa_lead, total }))
      .sort((a, b) => b.total - a.total);
  }, [leadsStageData]);

  const activeCollaboratorNames = useMemo(() => {
    return rawCollaborators
      .filter(c => !isDesativado(c) && !isExcludedTeam(c.equipeNome) && !isExcludedCargo(c.cargo))
      .map(c => c.name);
  }, [rawCollaborators]);

  const collaboratorStageSummary = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    leadsStageData
      .filter(item => activeCollaboratorNames.includes(item.colaborador))
      .forEach(item => {
        if (!map.has(item.colaborador)) {
          map.set(item.colaborador, new Map());
        }
        const stageMap = map.get(item.colaborador)!;
        const etapa = item.etapa_lead || "Sem etapa";
        stageMap.set(etapa, (stageMap.get(etapa) || 0) + item.total);
      });
    return Array.from(map.entries())
      .map(([colaborador, stages]) => ({
        colaborador,
        stages: Object.fromEntries(stages.entries()),
        totalLeads: Array.from(stages.values()).reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.totalLeads - a.totalLeads);
  }, [leadsStageData, activeCollaboratorNames]);

  const hasActiveFilters = filters.equipe !== "todas" || filters.colaborador !== "todos" || filters.produto !== "Todos";

  const getStageColor = (stage: string) => {
    const colors: Record<string, string> = {
      "Prospecção": "#3b82f6",
      "Qualificação": "#8b5cf6",
      "Proposta": "#f59e0b",
      "Negociação": "#ec489a",
      "Fechamento": "#34a853",
      "Perdido": "#ef4444",
      "Ganho": "#10b981",
    };
    return colors[stage] || "#6b7280";
  };

  const isFirstLeadLoad = loadingLeads && leadsStageData.length === 0;

  const uniqueStages = useMemo(
    () => Array.from(new Set(leadsStageData.map(d => d.etapa_lead || "Sem etapa"))).sort(),
    [leadsStageData]
  );

  // ========== RENDER ==========
  return (
    <DashboardLayout title="Funil de Vendas" subtitle="Acompanhe a jornada das oportunidades — da emissão ao resultado final">

      <FilterBar onFilterChange={handleFilterChange} showColaboradorFilter={true} className="mb-6" />

      {loading && (
        <div className="flex justify-center items-center py-4">
          <Loader2 className="w-5 h-5 animate-spin text-[#09175b]" />
          <span className="ml-2 text-sm text-gray-500">Carregando dados...</span>
        </div>
      )}

      {!loading && rawCollaborators.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-center text-amber-800 text-sm">
          Nenhum colaborador disponível no momento. Verifique sua conexão ou contate o suporte.
        </div>
      )}

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
        <button
          onClick={() => reloadData(true)}
          disabled={refreshing}
          className="ml-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#09175b] text-white hover:bg-[#09175b]/90 disabled:opacity-50 transition-colors"
          aria-label="Atualizar dados manualmente"
        >
          <RefreshCw className={cn("w-3.5 h-3.5 inline mr-1", refreshing && "animate-spin")} />
          Atualizar
        </button>
      </div>

      {rawCollaborators.length > 0 && (
        <>
          {hasActiveFilters && (
            <div className="mb-4 px-4 py-2 bg-blue-50 rounded-lg text-xs text-blue-700 flex items-center gap-2 flex-wrap">
              <span>📊</span>
              <span>
                Mostrando dados para:
                {filters.equipe !== "todas" && ` Equipe ${filters.equipe}`}
                {filters.colaborador !== "todos" && ` - ${filters.colaborador}`}
                {filters.produto !== "Todos" && ` • Produto: ${filters.produto}`}
              </span>
            </div>
          )}

          {/* Cards das etapas */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            {funnelData.map((stage, i) => {
              const Icon = stage.icon;
              const pct = totalBase > 0 ? ((stage.count / totalBase) * 100).toFixed(1) : "0";
              const color = stage.color;
              return (
                <div
                  key={stage.stage}
                  className="madm-card p-4 text-center animate-fade-in-up"
                  style={{ animationDelay: `${i * 40}ms`, borderTop: `3px solid ${color}` }}
                >
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center mx-auto mb-2" style={{ background: `${color}15` }}>
                    <Icon className="w-4 h-4" style={{ color }} />
                  </div>
                  <div className="madm-kpi-value text-xl" style={{ color }}>{formatInt(stage.count)}</div>
                  <div className="text-[10px] text-gray-500 mt-0.5 font-medium">{stage.stage}</div>
                  <div className="text-[10px] text-gray-400 mt-0.5">{pct}% do total</div>
                </div>
              );
            })}
          </div>

          {/* Pipeline Visual + Taxas */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="madm-card p-6 animate-fade-in-up" style={{ animationDelay: "360ms" }}>
              <h3 className="text-sm font-bold text-[#09175b] mb-5">Pipeline Visual (Evolução Etapas)</h3>
              <div className="flex flex-col items-center gap-0 w-full">
                {funnelData.slice(0, -1).map((stage, i) => {
                  const Icon = stage.icon;
                  const nextStage = funnelData[i + 1];
                  const widthPct = totalBase > 0 ? Math.max(30, (stage.count / totalBase) * 100) : 30;
                  const color = stage.color;
                  return (
                    <div key={stage.stage} className="w-full flex flex-col items-center">
                      <div
                        className="flex items-center justify-between gap-2 px-3 py-2 sm:px-4 sm:py-3 rounded-xl transition-all hover:scale-[1.02] flex-wrap"
                        style={{
                          width: `clamp(140px, ${Math.min(widthPct, 100)}%, 100%)`,
                          maxWidth: "100%",
                          background: `${color}15`,
                          border: `1.5px solid ${color}30`,
                        }}
                      >
                        <div className="flex items-center gap-1 sm:gap-2">
                          <Icon className="w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0" style={{ color }} />
                          <span className="text-[10px] sm:text-xs font-semibold break-words" style={{ color }}>
                            {stage.stage}
                          </span>
                        </div>
                        <span className="text-xs sm:text-sm font-black flex-shrink-0" style={{ color }}>
                          {formatInt(stage.count)}
                        </span>
                      </div>
                      {nextStage && nextStage.stage !== "Perdidos" && (
                        <ConversionArrow from={stage.count} to={nextStage.count} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="madm-card p-6 animate-fade-in-up" style={{ animationDelay: "440ms" }}>
              <h3 className="text-sm font-bold text-[#09175b] mb-1">Taxa de Conversão por Etapa</h3>
              <p className="text-xs text-gray-500 mb-5">% que avança para a próxima etapa</p>
              <ResponsiveContainer width="100%" height={380}>
                <BarChart data={conversionByStage} layout="vertical" margin={{ left: 0, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                  <YAxis type="category" dataKey="stage" tick={{ fontSize: 10, fill: "#374151" }} axisLine={false} tickLine={false} width={150} />
                  <Tooltip formatter={(value: any) => [`${value}%`, "Conversão"]} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e5e7eb" }} />
                  <Bar dataKey="value" radius={[0, 6, 6, 0]} name="Conversão">
                    {conversionByStage.map((entry, index) => (
                      <Cell key={index} fill={entry.value >= 60 ? "#34a853" : entry.value >= 40 ? "#f59e0b" : "#ef4444"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Distribuição de Leads por Etapa */}
          {aggregatedLeadStages.length > 0 && (
            <div className="madm-card p-6 mb-6 animate-fade-in-up">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-[#09175b] flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" /> Distribuição de Leads por Etapa
                  {period === "Hoje" && <span className="text-xs text-gray-400">(semana atual)</span>}
                </h3>
                {loadingLeads && !isFirstLeadLoad && <div className="text-xs text-gray-400">Atualizando...</div>}
              </div>
              {isFirstLeadLoad ? (
                <div className="flex justify-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#09175b]" />
                </div>
              ) : aggregatedLeadStages.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={aggregatedLeadStages} layout="vertical" margin={{ left: 40 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#9ca3af" }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="etapa_lead" tick={{ fontSize: 11, fill: "#374151" }} width={120} />
                    <Tooltip content={<CustomTooltip />} />
                    <Bar dataKey="total" name="Leads" radius={[0, 6, 6, 0]}>
                      {aggregatedLeadStages.map((entry, idx) => (
                        <Cell key={idx} fill={getStageColor(entry.etapa_lead)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-center py-8 text-gray-400 text-sm">
                  {period === "Hoje" 
                    ? "Nenhum lead encontrado na semana atual com os filtros atuais." 
                    : "Nenhum lead encontrado no período com os filtros atuais."}
                </div>
              )}
            </div>
          )}

          {/* ============================================================
               TABELA DETALHADA – CORRIGIDA COM SCROLL HORIZONTAL ISOLADO
               ============================================================ */}
          {collaboratorStageSummary.length > 0 && (
            <div className="madm-card animate-fade-in-up">
              <div className="p-5 border-b border-gray-100 flex justify-between items-center">
                <h3 className="text-sm font-bold text-[#09175b]">
                  Detalhamento por Colaborador
                </h3>
                <span className="text-xs text-gray-400">
                  {collaboratorStageSummary.length} colaboradores
                </span>
              </div>
              {/* WRAPPER COM SCROLL HORIZONTAL PRÓPRIO */}
              <div className="funil-table-wrapper">
                <table>
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50/50">
                      <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500 sticky left-0 bg-gray-50/50 z-10">
                        Colaborador
                      </th>
                      <th className="text-left px-5 py-3 text-xs font-semibold text-gray-500">
                        Total Leads
                      </th>
                      {uniqueStages.map(etapa => (
                        <th key={etapa} className="text-center px-2 py-3 text-xs font-semibold text-gray-500">
                          {etapa}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {collaboratorStageSummary.map((item) => (
                      <tr key={item.colaborador} className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="px-5 py-3 text-sm font-medium text-gray-800 sticky left-0 bg-white z-10">
                          {item.colaborador}
                        </td>
                        <td className="px-5 py-3 text-sm font-bold text-[#09175b]">
                          {formatInt(item.totalLeads)}
                        </td>
                        {uniqueStages.map(etapa => (
                          <td key={etapa} className="px-2 py-3 text-center text-sm text-gray-600">
                            {formatInt(item.stages[etapa] || 0)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loadingLeads && leadsStageData.length === 0 && (
            <div className="text-center py-8 text-gray-400 text-sm mt-4">
              {period === "Hoje" 
                ? "Nenhum lead encontrado na semana atual com os filtros atuais." 
                : "Nenhum lead encontrado no período com os filtros atuais."}
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
}