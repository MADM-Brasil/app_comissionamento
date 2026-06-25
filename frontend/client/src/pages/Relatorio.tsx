// src/pages/Relatorio.tsx
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import {
  FileText, FileCheck, Archive, TrendingUp, XCircle, Calendar, Download, Layers, Table as TableIcon, RefreshCw, Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchCollaborators } from "@/lib/api";

// ============================================================
// CONSTANTES DE EXCLUSÃO
// ============================================================
const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário','BackOffice',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro'
];

const EXCLUDED_GROUPS = [
  "Supervisor", "Salesops", "Sales ops", "Coordenador", "CEO",
  "Diretoria", "Desativado", "Juridico", "Ultravita", "Diligencia",
  "Marketing", "Gerência", "Contrato", "Dr. Felipe Marx", "Administrativo",
  "administrativo"
];

const normalize = (str: string): string =>
  (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const isExcludedTeam = (teamName: string) => EXCLUDED_TEAMS.includes(teamName);
const isExcludedGroup = (group: string) =>
  EXCLUDED_GROUPS.some(g => normalize(g) === normalize(group));

// ============================================================
// TIPOS
// ============================================================
interface MetricDataPoint {
  data: string;
  total: number;
  colaborador?: string;
  equipe?: string;
}

type MetricKey = "emitidos" | "assinados" | "protocolados" | "ganhos" | "perdidos";
type Granularity = "daily" | "weekly" | "monthly";
type MetaPeriodType = "daily" | "weekly" | "monthly";

const FULL_METRIC_CONFIG: Record<MetricKey, { label: string; icon: any; color: string }> = {
  emitidos: { label: "Emitidos", icon: FileText, color: "#3b82f6" },
  assinados: { label: "Assinados", icon: FileCheck, color: "#34a853" },
  protocolados: { label: "Protocolados", icon: Archive, color: "#045b5b" },
  ganhos: { label: "Ganhos", icon: TrendingUp, color: "#f59e0b" },
  perdidos: { label: "Perdidos", icon: XCircle, color: "#ef4444" },
};

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3007/api";

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================
function getWeekNumber(date: Date): string {
  const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
  const pastDays = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
  const week = Math.ceil((pastDays + firstDayOfYear.getDay() + 1) / 7);
  return `${date.getFullYear()}-S${week}`;
}

/**
 * Retorna o intervalo de datas padrão com base na granularidade:
 * - daily   → semana atual (segunda a domingo)
 * - weekly  → mês atual
 * - monthly → últimos 12 meses
 */
function getDefaultDateRange(granularity: Granularity): { start: string; end: string } {
  const today = new Date();
  let start: Date, end: Date = new Date(today);
  end.setHours(23, 59, 59, 999);

  switch (granularity) {
    case "daily": {
      // Semana atual (segunda a domingo)
      const day = today.getDay();
      const diff = day === 0 ? -6 : 1 - day; // se domingo (0), vai para segunda (-6)
      start = new Date(today);
      start.setDate(today.getDate() + diff);
      start.setHours(0, 0, 0, 0);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case "weekly": {
      // Mês atual (primeiro ao último dia)
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      end.setHours(23, 59, 59, 999);
      break;
    }
    case "monthly": {
      // Últimos 12 meses (a partir do primeiro dia do mês atual, 12 meses atrás)
      start = new Date(today.getFullYear() - 1, today.getMonth(), 1);
      end = today;
      break;
    }
    default: {
      start = new Date(today.getFullYear(), 0, 1);
      end = today;
    }
  }

  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

/**
 * Agrupa dados diários em semanais ou mensais.
 */
function aggregateDailyData(
  dailyData: { date: string; [key: string]: any }[],
  granularity: Granularity
): { label: string; [key: string]: any }[] {
  if (granularity === "daily") return dailyData.map(d => ({ label: d.date, ...d }));

  const groups = new Map<string, any>();
  const metrics = Object.keys(FULL_METRIC_CONFIG);

  for (const day of dailyData) {
    let groupKey: string;
    if (granularity === "weekly") {
      const d = new Date(day.date);
      groupKey = getWeekNumber(d);
    } else {
      const d = new Date(day.date);
      groupKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
    if (!groups.has(groupKey)) {
      const init: any = { label: groupKey };
      for (const m of metrics) init[m] = 0;
      groups.set(groupKey, init);
    }
    const group = groups.get(groupKey)!;
    for (const m of metrics) {
      if (day[m] !== undefined) group[m] += day[m];
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
}

// ============================================================
// COMPONENTE PRINCIPAL
// ============================================================
export default function Relatorio() {
  const [, navigate] = useLocation();
  const { globalConfig } = useAppStore();
  const { hasPermission } = useAccessControl();

  useEffect(() => {
    if (!hasPermission("canAccessReports")) navigate("/");
  }, [hasPermission, navigate]);

  // ===== ESTADOS =====
  const [granularity, setGranularity] = useState<Granularity>("daily");
  const [selectedMetrics, setSelectedMetrics] = useState<MetricKey[]>(["emitidos", "assinados", "ganhos"]);
  const [metaPeriodType, setMetaPeriodType] = useState<MetaPeriodType>("daily");
  const [filters, setFilters] = useState<{
    equipe: string; colaborador: string; colaboradorId?: number; produto: string;
  }>({ equipe: "todas", colaborador: "todos", produto: "Todos" });

  // Datas – inicializadas conforme a granularidade
  const defaultRange = getDefaultDateRange("daily");
  const [startDate, setStartDate] = useState(defaultRange.start);
  const [endDate, setEndDate] = useState(defaultRange.end);
  const [manuallySetDates, setManuallySetDates] = useState(false);

  const [rawDailyData, setRawDailyData] = useState<Record<MetricKey, MetricDataPoint[]>>({
    emitidos: [], assinados: [], protocolados: [], ganhos: [], perdidos: [],
  });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSpecialProduct = filters.produto === 'Quinquenio' || filters.produto === 'Concomitante';

  const initialLoadDone = useRef(false);
  const lastFiltersRef = useRef(filters);
  const lastDatesRef = useRef({ start: startDate, end: endDate });

  // ============================================================
  // CARREGA COLABORADORES
  // ============================================================
  const [collaborators, setCollaboratorsLocal] = useState<any[]>([]);
  useEffect(() => {
    if (!startDate) return;
    const mes = startDate.substring(0, 7);
    fetchCollaborators(`?mes=${mes}`)
      .then(data => setCollaboratorsLocal(data || []))
      .catch(err => console.error("Erro ao carregar colaboradores:", err));
  }, [startDate]);

  const validCollaboratorNames = useMemo(() => {
    return collaborators
      .filter(c => !isExcludedGroup(c.grupo) && !isExcludedTeam(c.equipeNome))
      .map(c => c.name);
  }, [collaborators]);

  // ============================================================
  // REQUISIÇÃO DE MÉTRICAS
  // ============================================================
  const fetchData = useCallback(async () => {
    if (!startDate || !endDate) return;
    setLoading(true);
    setError(null);

    try {
      const endInclusive = new Date(endDate + "T23:59:59");
      const endExclusive = new Date(endInclusive);
      endExclusive.setDate(endExclusive.getDate() + 1);
      const endParam = endExclusive.toISOString().slice(0, 10);

      const baseParams: Record<string, string> = { start: startDate, end: endParam, granularity: "daily" };
      if (filters.colaborador !== "todos") baseParams.colaborador = filters.colaborador;
      if (filters.colaboradorId !== undefined) baseParams.colaboradorId = String(filters.colaboradorId);
      if (filters.equipe !== "todas") baseParams.equipe = filters.equipe;
      if (filters.produto !== "Todos") baseParams.produto = filters.produto;

      const fetchMetric = async (metric: MetricKey) => {
        const searchParams = new URLSearchParams(baseParams);
        const url = `${API_BASE}/metrics/${metric}?${searchParams.toString()}`;
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`Erro ${res.status} ao buscar ${metric}`);
        const json = await res.json();
        const array = Array.isArray(json.data) ? json.data : (Array.isArray(json) ? json : []);
        return array.map((item: any) => {
          const raw = item.periodo || item.data || item.semana || "";
          const dateOnly = raw.includes("T") ? raw.slice(0, 10) : raw;
          return { data: dateOnly, total: Number(item.total) || 0, colaborador: item.colaborador, equipe: item.equipe };
        });
      };

      const [emitidos, assinados, protocolados, ganhos, perdidos] = await Promise.all([
        fetchMetric("emitidos"), fetchMetric("assinados"), fetchMetric("protocolados"), fetchMetric("ganhos"), fetchMetric("perdidos"),
      ]);

      const filterByValidColabs = (data: MetricDataPoint[]) =>
        data.filter(point => !point.colaborador || validCollaboratorNames.includes(point.colaborador));

      setRawDailyData({
        emitidos: filterByValidColabs(emitidos),
        assinados: filterByValidColabs(assinados),
        protocolados: filterByValidColabs(protocolados),
        ganhos: filterByValidColabs(ganhos),
        perdidos: filterByValidColabs(perdidos),
      });
    } catch (err: any) {
      console.error("❌ [Relatório] Erro:", err);
      setError(err.message || "Erro desconhecido");
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, filters, validCollaboratorNames]);

  // ===== ATUALIZAÇÃO QUANDO FILTROS/DATAS MUDAM =====
  useEffect(() => {
    if (!startDate || !endDate) return;

    const datesChanged =
      startDate !== lastDatesRef.current.start ||
      endDate !== lastDatesRef.current.end;
    const filtersChanged =
      filters.equipe !== lastFiltersRef.current.equipe ||
      filters.colaborador !== lastFiltersRef.current.colaborador ||
      filters.produto !== lastFiltersRef.current.produto;

    if (initialLoadDone.current && !datesChanged && !filtersChanged) return;

    lastDatesRef.current = { start: startDate, end: endDate };
    lastFiltersRef.current = { ...filters };

    fetchData().then(() => {
      initialLoadDone.current = true;
    });
  }, [startDate, endDate, filters, fetchData]);

  // ===== POLLING A CADA 60s =====
  useEffect(() => {
    if (!initialLoadDone.current || !startDate || !endDate) return;

    const refresh = async () => {
      if (refreshing) return;
      if (document.visibilityState === 'visible') {
        setRefreshing(true);
        try {
          await fetchData();
        } catch (err) {
          console.error("Erro ao atualizar relatório:", err);
        } finally {
          setRefreshing(false);
        }
      }
    };

    const intervalId = setInterval(refresh, 60000);
    return () => clearInterval(intervalId);
  }, [startDate, endDate, fetchData, refreshing]);

  // ============================================================
  // AGREGAÇÃO E CÁLCULOS
  // ============================================================
  const dailyAggregated = useMemo(() => {
    const dateMap = new Map<string, Record<MetricKey, number>>();
    for (const metric of Object.keys(FULL_METRIC_CONFIG) as MetricKey[]) {
      for (const point of rawDailyData[metric]) {
        const day = point.data;
        if (!day) continue;
        if (!dateMap.has(day)) {
          dateMap.set(day, { emitidos: 0, assinados: 0, protocolados: 0, ganhos: 0, perdidos: 0 });
        }
        dateMap.get(day)![metric] += point.total;
      }
    }
    return Array.from(dateMap.entries()).map(([date, values]) => ({ date, ...values })).sort((a, b) => a.date.localeCompare(b.date));
  }, [rawDailyData]);

  const chartData = useMemo(() => aggregateDailyData(dailyAggregated, granularity), [dailyAggregated, granularity]);

  const totals = useMemo(() => {
    const result: Partial<Record<MetricKey, number>> = {};
    for (const metric of selectedMetrics) {
      result[metric] = chartData.reduce((sum, item) => sum + (item[metric] || 0), 0);
    }
    return result;
  }, [chartData, selectedMetrics]);

  const pesoAssKey = metaPeriodType === 'daily' ? 'metaDiarioAssinados'
    : metaPeriodType === 'weekly' ? 'metaSemanalAssinados'
    : 'metaMensalAssinados';
  const pesoGanKey = metaPeriodType === 'daily' ? 'metaDiarioGanhos'
    : metaPeriodType === 'weekly' ? 'metaSemanalGanhos'
    : 'metaMensalGanhos';

  const targetAssinados = useMemo(() => {
    return collaborators
      .filter(c => validCollaboratorNames.includes(c.name))
      .reduce((sum, c) => sum + (Number(c[pesoAssKey]) || 0), 0);
  }, [collaborators, validCollaboratorNames, pesoAssKey]);

  const targetGanhos = useMemo(() => {
    if (isSpecialProduct) return 0;
    return collaborators
      .filter(c => validCollaboratorNames.includes(c.name))
      .reduce((sum, c) => sum + (Number(c[pesoGanKey]) || 0), 0);
  }, [collaborators, validCollaboratorNames, pesoGanKey, isSpecialProduct]);

  const totalMetasBatidas = useMemo(() => {
    const colabTotals = new Map<string, { assinados: number; ganhos: number }>();
    rawDailyData.assinados.forEach(item => {
      const name = item.colaborador || '';
      if (!validCollaboratorNames.includes(name)) return;
      const cur = colabTotals.get(name) || { assinados: 0, ganhos: 0 };
      cur.assinados += item.total;
      colabTotals.set(name, cur);
    });
    rawDailyData.ganhos.forEach(item => {
      const name = item.colaborador || '';
      if (!validCollaboratorNames.includes(name)) return;
      const cur = colabTotals.get(name) || { assinados: 0, ganhos: 0 };
      cur.ganhos += item.total;
      colabTotals.set(name, cur);
    });

    if (isSpecialProduct) {
      colabTotals.forEach(v => v.ganhos = 0);
    }

    let totalMetas = 0;
    for (const [name, totals] of colabTotals.entries()) {
      const colab = collaborators.find(c => c.name === name);
      if (!colab) continue;
      const pesoAss = Number(colab[pesoAssKey]) || 0;
      const pesoGan = isSpecialProduct ? 0 : (Number(colab[pesoGanKey]) || 0);
      if (pesoAss === 0) continue;
      if (pesoGan === 0) {
        totalMetas += Math.floor(totals.assinados / pesoAss);
      } else {
        totalMetas += Math.floor(Math.min(totals.assinados / pesoAss, totals.ganhos / pesoGan));
      }
    }
    return totalMetas;
  }, [rawDailyData, collaborators, validCollaboratorNames, pesoAssKey, pesoGanKey, isSpecialProduct]);

  // ============================================================
  // HANDLERS
  // ============================================================
  const handleFilterChange = useCallback((newFilters: {
    equipe: string; colaborador: string; colaboradorId?: number; produto: string;
  }) => setFilters(newFilters), []);

  const toggleMetric = (metric: MetricKey) => {
    if (!availableMetrics.includes(metric)) return;
    setSelectedMetrics(prev => prev.includes(metric) ? prev.filter(m => m !== metric) : [...prev, metric]);
  };

  const exportPrincipalCSV = () => {
    const headers = ["Data", ...selectedMetrics.map(m => FULL_METRIC_CONFIG[m].label)];
    const rows = chartData.map(item => [item.label, ...selectedMetrics.map(m => item[m] as number)]);
    const csvContent = [headers, ...rows].map(row => row.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `relatorio_${startDate}_a_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportTableCSV = () => {
    const headers = ["Período", ...selectedMetrics.map(m => FULL_METRIC_CONFIG[m].label), "Metas Batida"];
    const rows = chartData.map(item => [item.label, ...selectedMetrics.map(m => item[m] || 0), getRowMetasBatidas(item)]);
    const csvContent = [headers, ...rows].map(row => row.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `detalhado_${granularity}_${startDate}_a_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getRowMetasBatidas = (row: any) => {
    const assinados = row.assinados || 0;
    const ganhos = row.ganhos || 0;
    if (targetAssinados === 0) return 0;
    const proportion = totals.assinados && totals.assinados > 0 ? assinados / totals.assinados : 0;
    return Math.floor(totalMetasBatidas * proportion);
  };

  const availableMetrics = useMemo(() => {
    const all = Object.keys(FULL_METRIC_CONFIG) as MetricKey[];
    if (isSpecialProduct) return all.filter(m => m !== 'ganhos' && m !== 'protocolados');
    return all;
  }, [isSpecialProduct]);

  useEffect(() => {
    setSelectedMetrics(prev => prev.filter(m => availableMetrics.includes(m)));
    if (selectedMetrics.length === 0 && availableMetrics.length > 0) {
      setSelectedMetrics(availableMetrics.slice(0, 2) as MetricKey[]);
    }
  }, [availableMetrics]);

  useEffect(() => {
    if (startDate === endDate && granularity !== "daily") setGranularity("daily");
  }, [startDate, endDate, granularity]);

  // ===== QUANDO A GRANULARIDADE MUDA, RESETA AS DATAS (SE NÃO FOR MANUAL) =====
  const handleGranularityChange = (newGranularity: Granularity) => {
    setGranularity(newGranularity);
    if (!manuallySetDates) {
      const { start, end } = getDefaultDateRange(newGranularity);
      setStartDate(start);
      setEndDate(end);
      // Não resetamos manuallySetDates para false, pois se o usuário já tinha definido datas manualmente, ele não quer perder.
      // Se ele nunca definiu, permanece false.
    }
  };

  // ===== QUANDO O USUÁRIO MUDA AS DATAS MANUALMENTE =====
  const handleDateChange = (type: 'start' | 'end', value: string) => {
    setManuallySetDates(true);
    if (type === 'start') setStartDate(value);
    else setEndDate(value);
  };

  // ===== BOTÃO PARA RESETAR DATAS AO CICLO ATUAL =====
  const resetDatesToCycle = () => {
    const { start, end } = getDefaultDateRange(granularity);
    setStartDate(start);
    setEndDate(end);
    setManuallySetDates(false);
  };

  const hasActiveFilters = filters.equipe !== "todas" || filters.colaborador !== "todos" || filters.produto !== "Todos";

  // Label do ciclo para exibição
  const cycleLabel = granularity === 'daily' ? 'Semana atual' : granularity === 'weekly' ? 'Mês atual' : 'Últimos 12 meses';

  return (
    <DashboardLayout title="Relatório Avançado" subtitle={`Analise o desempenho por período personalizado — ${cycleLabel}`}>
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
            Mostrando dados para:
            {filters.equipe !== "todas" && ` Equipe ${filters.equipe}`}
            {filters.colaborador !== "todos" && ` - ${filters.colaborador}`}
            {filters.produto !== "Todos" && ` • Produto: ${filters.produto}`}
          </span>
        </div>
      )}

      <div className="madm-card p-5 mb-6 animate-fade-in-up">
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between mb-4 pb-3 border-b border-gray-100">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
              <Calendar className="w-4 h-4 text-gray-500" aria-hidden="true" />
              <input
                type="date"
                value={startDate}
                onChange={(e) => handleDateChange('start', e.target.value)}
                className="bg-transparent text-sm border-none focus:ring-0 p-0"
                aria-label="Data inicial"
                title="Data inicial do relatório"
              />
              <span className="text-gray-400">—</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => handleDateChange('end', e.target.value)}
                className="bg-transparent text-sm border-none focus:ring-0 p-0"
                aria-label="Data final"
                title="Data final do relatório"
              />
              <button
                type="button"
                onClick={resetDatesToCycle}
                className="text-xs text-[#09175b] font-medium hover:underline ml-1"
                title="Resetar para o ciclo atual"
              >
                Resetar ciclo
              </button>
            </div>
            <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
              <Layers className="w-4 h-4 text-gray-500" aria-hidden="true" />
              <select
                value={granularity}
                onChange={(e) => handleGranularityChange(e.target.value as Granularity)}
                className="bg-transparent text-sm border-none focus:ring-0 p-0 pr-6"
                aria-label="Agrupar dados por período"
                title="Agrupamento dos dados (diário, semanal ou mensal)"
              >
                <option value="daily">Diário (semana atual)</option>
                <option value="weekly">Semanal (mês atual)</option>
                <option value="monthly">Mensal (12 meses)</option>
              </select>
            </div>
            <div className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
              <span className="text-xs text-gray-500">Meta baseada em:</span>
              <select
                value={metaPeriodType}
                onChange={(e) => setMetaPeriodType(e.target.value as MetaPeriodType)}
                className="bg-transparent text-sm border-none focus:ring-0 p-0 pr-6"
                aria-label="Período base para cálculo de metas"
                title="Período utilizado para calcular as metas (diário, semanal ou mensal)"
              >
                <option value="daily">Ciclo Diário</option>
                <option value="weekly">Ciclo Semanal</option>
                <option value="monthly">Ciclo Mensal</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            onClick={exportPrincipalCSV}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold border border-gray-200 hover:bg-gray-50"
            aria-label="Exportar dados dos gráficos para CSV"
          >
            <Download className="w-4 h-4" aria-hidden="true" /> Exportar CSV (Gráficos)
          </button>
        </div>

        <div className="mb-4 pb-3 border-b border-gray-100">
          <label className="block text-xs font-semibold text-gray-500 mb-2">Métricas para gráficos</label>
          <div className="flex flex-wrap gap-2">
            {availableMetrics.map((key) => {
              const metric = key as MetricKey;
              const config = FULL_METRIC_CONFIG[metric];
              const isSelected = selectedMetrics.includes(metric);
              return (
                <button
                  key={metric}
                  type="button"
                  onClick={() => toggleMetric(metric)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all",
                    isSelected ? "bg-[#09175b] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  )}
                  aria-label={`${isSelected ? "Remover" : "Adicionar"} métrica ${config.label}`}
                >
                  <config.icon className="w-3.5 h-3.5" aria-hidden="true" /> {config.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#09175b]" role="status" aria-label="Carregando dados" />
        </div>
      )}

      {error && <div className="bg-red-50 text-red-700 p-4 rounded-lg text-sm mb-6" role="alert">{error}</div>}

      {!loading && !error && (
        <>
          {/* Cards resumo */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
            {selectedMetrics.map((metric) => {
              const config = FULL_METRIC_CONFIG[metric];
              const total = totals[metric] || 0;
              let target = 0, percent = 0;
              if (metric === "assinados") { target = targetAssinados; percent = targetAssinados > 0 ? Math.min((total / targetAssinados) * 100, 100) : 0; }
              if (metric === "ganhos") { target = targetGanhos; percent = targetGanhos > 0 ? Math.min((total / targetGanhos) * 100, 100) : 0; }
              return (
                <div key={metric} className="madm-card p-4 animate-fade-in-up" style={{ borderLeft: `4px solid ${config.color}` }}>
                  <div className="flex items-center justify-between mb-2">
                    <config.icon className="w-5 h-5" style={{ color: config.color }} aria-hidden="true" />
                    <span className="text-xs text-gray-500">{config.label}</span>
                  </div>
                  <div className="text-2xl font-black text-gray-800">{total}</div>
                  {target > 0 && (
                    <div className="mt-2">
                      <div className="madm-progress-bar" aria-label={`Progresso para meta de ${config.label}`}>
                        <div className="madm-progress-fill" style={{ width: `${Math.min(percent, 100)}%`, background: config.color }} />
                      </div>
                      <div className="flex justify-between text-[10px] text-gray-400 mt-1">
                        <span>Meta: {Math.round(target)}</span>
                        <span>{percent.toFixed(0)}%</span>
                      </div>
                    </div>
                  )}
                  {target === 0 && metric === "ganhos" && (
                    <div className="text-[10px] text-gray-400 mt-1">Meta de ganhos não se aplica</div>
                  )}
                </div>
              );
            })}
            {/* Card de Metas Batidas */}
            <div className="madm-card p-4 animate-fade-in-up" style={{ borderLeft: `4px solid #34a853` }}>
              <div className="flex items-center justify-between mb-2">
                <TrendingUp className="w-5 h-5 text-[#34a853]" aria-hidden="true" />
                <span className="text-xs text-gray-500">Metas Batidas</span>
              </div>
              <div className="text-2xl font-black text-gray-800">{totalMetasBatidas}</div>
              <div className="text-[10px] text-gray-400 mt-1">Total de ciclos completos</div>
            </div>
          </div>

          {/* Gráficos */}
          <div className="madm-card p-5 mb-6 animate-fade-in-up">
            <h3 className="text-sm font-bold text-[#09175b] mb-4">
              Evolução {granularity === "daily" ? "Diária (Semana atual)" : granularity === "weekly" ? "Semanal (Mês atual)" : "Mensal (12 meses)"}
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} height={60} angle={-30} textAnchor="end" />
                <YAxis />
                <Tooltip />
                <Legend />
                {selectedMetrics.map((metric) => (
                  <Bar key={metric} dataKey={metric} name={FULL_METRIC_CONFIG[metric].label} fill={FULL_METRIC_CONFIG[metric].color} radius={[4, 4, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="madm-card p-5 mb-6 animate-fade-in-up">
            <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
              <h3 className="text-sm font-bold text-[#09175b] flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Tendência</h3>
              <div className="flex gap-4 text-xs">
                {selectedMetrics.map((metric) => (
                  <div key={metric} className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-full" style={{ background: FULL_METRIC_CONFIG[metric].color }} />
                    <span className="text-gray-600">{FULL_METRIC_CONFIG[metric].label}</span>
                  </div>
                ))}
              </div>
            </div>
            <ResponsiveContainer width="100%" height={350}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis />
                <Tooltip />
                <Legend />
                {selectedMetrics.map((metric) => (
                  <Line key={metric} type="monotone" dataKey={metric} name={FULL_METRIC_CONFIG[metric].label} stroke={FULL_METRIC_CONFIG[metric].color} strokeWidth={2} dot={{ r: 3 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Tabela detalhada */}
          <div className="madm-card p-5 animate-fade-in-up">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <h3 className="text-sm font-bold text-[#09175b] flex items-center gap-2"><TableIcon className="w-4 h-4" /> Dados Detalhados</h3>
              <button
                type="button"
                onClick={exportTableCSV}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border border-gray-200 hover:bg-gray-50"
                aria-label="Exportar tabela detalhada para CSV"
              >
                <Download className="w-3.5 h-3.5" aria-hidden="true" /> Exportar CSV (Tabela)
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold text-gray-600">Período</th>
                    {selectedMetrics.map(metric => (
                      <th key={metric} className="px-4 py-2 text-left font-semibold text-gray-600">{FULL_METRIC_CONFIG[metric].label}</th>
                    ))}
                    <th className="px-4 py-2 text-left font-semibold text-gray-600">Metas Batida</th>
                  </tr>
                </thead>
                <tbody>
                  {chartData.length === 0 ? (
                    <tr>
                      <td colSpan={selectedMetrics.length + 2} className="text-center py-8 text-gray-400">
                        Nenhum dado encontrado no período selecionado.
                      </td>
                    </tr>
                  ) : (
                    chartData.map((row, idx) => (
                      <tr key={idx} className="border-b border-gray-100 hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs text-gray-800">{row.label}</td>
                        {selectedMetrics.map(metric => (
                          <td key={metric} className="px-4 py-2 text-gray-700">{row[metric] || 0}</td>
                        ))}
                        <td className="px-4 py-2 font-semibold text-[#09175b]">{getRowMetasBatidas(row)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="text-xs text-gray-400 mt-3 text-right">Total de registros: {chartData.length}</div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}