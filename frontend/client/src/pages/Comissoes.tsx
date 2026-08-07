// src/pages/Comissoes.tsx
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, formatCurrency } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import {
  DollarSign, Award, FileCheck, Target, Loader2, RefreshCw,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { cn } from "@/lib/utils";

type PeriodoMeta = 'diario' | 'semanal' | 'mensal';

const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário','BackOffice',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro', 'Equipe Reciclagem'
];

const EXCLUDED_CARGOS = [
  "desativado","assistente","analista juridico","gestor de projetos","analista",
  "analista de discadora","supervisor","coordenador","salesops","ceo",
  "analista de crm","desenvolvedor","diretora","analista de dados","desenvolvedor make",
];

const normalizeText = (text: string) => (text || '').trim().toLowerCase();

function isSpecialGroupColaborador(colaborador: any): boolean {
  const produto = (colaborador.produto || '').toLowerCase();
  const cargo = (colaborador.cargo || '').toLowerCase();
  return produto === 'quinquenio' || produto === 'concomitante' ||
         cargo === 'quinquenio' || cargo === 'concomitante';
}

function obterMetaPorPeriodo(colaborador: any, periodo: PeriodoMeta) {
  switch (periodo) {
    case 'diario': return { assinados: colaborador.metaDiarioAssinados ?? 3, ganhos: colaborador.metaDiarioGanhos ?? 3 };
    case 'semanal': return { assinados: colaborador.metaSemanalAssinados ?? 15, ganhos: colaborador.metaSemanalGanhos ?? 15 };
    default: return { assinados: colaborador.metaMensalAssinados ?? 60, ganhos: colaborador.metaMensalGanhos ?? 60 };
  }
}

function calcularCiclosPeriodo(colaborador: any, periodo: PeriodoMeta, isSpecial: boolean): number {
  const meta = obterMetaPorPeriodo(colaborador, periodo);
  const assinados = colaborador.assinados || 0;
  const ganhos = isSpecial ? 0 : (colaborador.ganhos || 0);
  if (meta.assinados <= 0) return 0;
  if (isSpecial) return Math.floor(assinados / meta.assinados);
  if (meta.ganhos <= 0) return 0;
  return Math.floor(Math.min(assinados / meta.assinados, ganhos / meta.ganhos));
}

function obterBonusCiclo(colaborador: any, configEquipe: any[], configGlobal: any): number {
  if (colaborador.bonusComissao && colaborador.bonusComissao > 0) return colaborador.bonusComissao;
  const equipe = configEquipe.find((e: any) => e.nome === colaborador.equipeNome);
  return equipe?.bonus || configGlobal.valorBonus;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload?.length) {
    return (
      <div className="bg-white border border-[#e2e8f0] rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-[#0f172a] mb-1">{label}</p>
        {payload.map((entry: any, i: number) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {typeof entry.value === 'number' ? formatCurrency(entry.value) : entry.value}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

export default function Comissoes() {
  const {
    currentStartDate, currentEndDate,
    collaborators: storeColabs, globalConfig, equipeConfigs, rawMetrics,
    loadCollaboratorsAndMetrics,
    loadWeeklyPerformanceData,
    loadRawMetrics,
  } = useAppStore();

  const { currentUser } = useAccessControl();

  const [filters, setFilters] = useState<{
    equipe: string;
    colaborador: string;
    colaboradorId?: string | number;
    produto: string;
  }>({ equipe: "todas", colaborador: "todos", produto: "Todos" });

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Removido isFirstFilterApplied e timeout – agora reage diretamente

  const isLoadingRef = useRef(false);

  const reloadData = useCallback(async (showRefreshing = false) => {
    if (!currentStartDate || !currentEndDate) return;
    if (isLoadingRef.current && !showRefreshing) return;

    isLoadingRef.current = true;
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const equipeApi = filters.equipe === "todas" ? undefined : filters.equipe;
      const colaboradorApi = filters.colaborador === "todos" ? undefined : filters.colaborador;
      const colaboradorIdApi = filters.colaboradorId;
      const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;

      await Promise.all([
        loadCollaboratorsAndMetrics(equipeApi, colaboradorApi, colaboradorIdApi, produtoApi),
        loadRawMetrics({ equipeNome: equipeApi, colaboradorNome: colaboradorApi, colaboradorId: colaboradorIdApi, produto: produtoApi }),
        loadWeeklyPerformanceData(),
      ]);
    } catch (err: any) {
      console.error("❌ Comissoes: erro ao recarregar dados:", err);
      setError(err.message || "Falha ao recarregar dados.");
    } finally {
      isLoadingRef.current = false;
      if (showRefreshing) setRefreshing(false);
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate, filters, loadCollaboratorsAndMetrics, loadRawMetrics, loadWeeklyPerformanceData]);

  const handleFilterChange = useCallback((newFilters: typeof filters) => {
    setFilters(newFilters);
  }, []);

  const handleRefresh = useCallback(async () => {
    await reloadData(true);
  }, [reloadData]);

  // Efeito que reage imediatamente a mudanças nos filtros ou datas
  useEffect(() => {
    if (!currentStartDate || !currentEndDate) return;
    reloadData(false);
  }, [currentStartDate, currentEndDate, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredColabs = useMemo(() => {
    let filtered = storeColabs.filter(c => {
      if (EXCLUDED_TEAMS.some(team => normalizeText(c.equipeNome) === normalizeText(team))) return false;
      if (EXCLUDED_CARGOS.some(cargo => normalizeText(c.cargo) === normalizeText(cargo))) return false;
      if (filters.equipe !== "todas" && c.equipeNome !== filters.equipe) return false;
      if (filters.colaborador !== "todos" && c.name !== filters.colaborador) return false;
      return true;
    });
    // Garantir que o usuário logado sempre apareça nos seus próprios dados
    const hasCurrentUser = filtered.some(c => c.id === currentUser?.id);
    if (currentUser && !hasCurrentUser) {
      const userColab = storeColabs.find(c => c.id === currentUser.id);
      if (userColab) filtered = [userColab, ...filtered];
    }
    return filtered;
  }, [storeColabs, filters, currentUser]);

  const commissionData = useMemo(() => {
    const periods: PeriodoMeta[] = ['diario', 'semanal', 'mensal'];
    return filteredColabs.map(col => {
      const isSpecial = isSpecialGroupColaborador(col);
      let totalCommission = 0;
      let totalCycles = 0;
      const periodDetails: any = {};
      for (const period of periods) {
        const cycles = calcularCiclosPeriodo(col, period, isSpecial);
        const bonus = obterBonusCiclo(col, equipeConfigs, globalConfig);
        const commissionPeriod = cycles * bonus;
        totalCommission += commissionPeriod;
        totalCycles += cycles;
        periodDetails[period] = { cycles, commission: commissionPeriod, bonus };
      }
      const monthlyMeta = obterMetaPorPeriodo(col, 'mensal');
      return {
        id: col.id,
        name: col.name,
        totalCommission,
        totalCycles,
        assinados: col.assinados || 0,
        ganhos: isSpecial ? 0 : (col.ganhos || 0),
        metaAssinados: monthlyMeta.assinados,
        metaGanhos: isSpecial ? 0 : monthlyMeta.ganhos,
        avatar: col.avatar || col.name.charAt(0).toUpperCase(),
        cargo: col.cargo,
        periodDetails,
        isSpecial,
      };
    }).sort((a, b) => b.totalCommission - a.totalCommission);
  }, [filteredColabs, equipeConfigs, globalConfig]);

  const totals = useMemo(() => {
    const comissao = commissionData.reduce((s, i) => s + i.totalCommission, 0);
    const ciclos = commissionData.reduce((s, i) => s + i.totalCycles, 0);
    return { comissao, ciclos };
  }, [commissionData]);

  const avgProgress = useMemo(() => {
    if (!commissionData.length) return 0;
    const sum = commissionData.reduce((acc, i) => {
      const pctAss = i.metaAssinados ? (i.assinados / i.metaAssinados) * 100 : 0;
      const pctGan = i.metaGanhos ? (i.ganhos / i.metaGanhos) * 100 : 100;
      return acc + Math.min(pctAss, pctGan);
    }, 0);
    return sum / commissionData.length;
  }, [commissionData]);

  const summaryCards = [
    { label: "Comissão Total Estimada", value: totals.comissao, icon: DollarSign, color: "#2F6FED", isCurrency: true },
    { label: "Gols", value: totals.ciclos, icon: Award, color: "#16A34A", isInteger: true },
    { label: "Vendas Fechadas", value: rawMetrics.assinados, icon: FileCheck, color: "#EA8C1D", isInteger: true },
    { label: "Progresso Médio", value: avgProgress, icon: Target, color: "#8B5CF6", isPercent: true },
  ];

  const hasActiveFilters = filters.equipe !== "todas" || filters.colaborador !== "todos" || filters.produto !== "Todos";

  return (
    <DashboardLayout title="Painel de Comissões" subtitle="Comissão calculada pela soma de metas batidas diárias, semanais e mensais">
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

      {!loading && filteredColabs.length === 0 && !error && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-center text-amber-800 text-sm">
          Nenhum colaborador disponível para os filtros atuais.
        </div>
      )}

      {!loading && filteredColabs.length > 0 && (
        <>
          {hasActiveFilters && (
            <div className="mb-4 px-4 py-2 bg-[#eff6ff] rounded-lg text-xs text-[#2F6FED] flex gap-2 flex-wrap">
              <span>📊</span>
              <span>
                Mostrando dados de: {filters.equipe !== "todas" && ` ${filters.equipe}`}
                {filters.colaborador !== "todos" && ` - ${filters.colaborador}`}
                {filters.produto !== "Todos" && ` - Produto: ${filters.produto}`}
              </span>
            </div>
          )}

          {/* Cards resumo */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {summaryCards.map((card, idx) => {
              const Icon = card.icon;
              let displayValue: string;
              if (card.isPercent) displayValue = `${card.value.toFixed(1)}%`;
              else if (card.isCurrency) displayValue = formatCurrency(card.value);
              else displayValue = formatInt(card.value);
              return (
                <div key={card.label} className="card animate-fade-in-up" style={{ animationDelay: `${idx * 80}ms` }}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${card.color}15` }}>
                      <Icon className="w-4.5 h-4.5" style={{ color: card.color }} />
                    </div>
                    <span className="text-xs text-[#64748b] font-medium">{card.label}</span>
                  </div>
                  <div className="kpi-value mb-1" style={{ color: "#0f172a" }}>{displayValue}</div>
                </div>
              );
            })}
          </div>

          {/* Gráfico + Metas individuais */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="card p-5 animate-fade-in-up" style={{ animationDelay: "320ms" }}>
              <h3 className="text-sm font-bold text-[#0f172a] mb-4">Comissão Total por Colaborador</h3>
              {commissionData.length === 0 ? (
                <div className="text-center text-[#94a3b8] text-sm py-8">Nenhum colaborador com os filtros atuais.</div>
              ) : (
                <div className="max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                  <ResponsiveContainer width="100%" height={Math.max(300, commissionData.length * 35)}>
                    <BarChart data={commissionData} layout="vertical" margin={{ left: 20, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                      <XAxis type="number" tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => formatCurrency(v)} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: "#0f172a" }} width={120} interval={0} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="totalCommission" name="Comissão Total" radius={[0, 6, 6, 0]} barSize={24}>
                        {commissionData.map((entry, i) => (
                          <Cell key={i} fill={entry.totalCommission > 0 ? "#16A34A" : "#e2e8f0"} stroke={entry.totalCommission > 0 ? "#16A34A" : "#cbd5e1"} strokeWidth={1} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div className="card p-5 animate-fade-in-up" style={{ animationDelay: "400ms" }}>
              <h3 className="text-sm font-bold text-[#0f172a] mb-4">Metas Mensais vs Realizado</h3>
              <div className="space-y-4 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                {commissionData.map(item => {
                  const pctAss = item.metaAssinados ? (item.assinados / item.metaAssinados) * 100 : 0;
                  const pctGan = item.isSpecial ? 100 : (item.metaGanhos ? (item.ganhos / item.metaGanhos) * 100 : 100);
                  const pct = Math.min(pctAss, pctGan);
                  const showGanhos = !item.isSpecial;
                  return (
                    <div key={item.name} className="flex flex-col gap-1">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center text-xs font-bold flex-shrink-0 shadow-sm">
                          {item.avatar}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between text-sm mb-1">
                            <span className="font-medium text-[#0f172a] truncate">{item.name}</span>
                            <span className="text-[#64748b] text-xs ml-2">
                              {formatInt(item.assinados)}/{formatInt(item.metaAssinados)} A {showGanhos && `| ${formatInt(item.ganhos)}/${formatInt(item.metaGanhos)} G`}
                              {item.isSpecial && <span className="text-[#2F6FED] ml-1">(só A)</span>}
                            </span>
                          </div>
                          <div className="progress-bar h-2">
                            <div
                              className="progress-fill"
                              style={{
                                width: `${Math.min(pct, 100)}%`,
                                background: pct >= 100 ? "#16A34A" : pct >= 70 ? "#EA8C1D" : "#2F6FED",
                              }}
                            />
                          </div>
                        </div>
                        <span className="text-sm font-bold text-[#0f172a] w-18 text-right">{formatCurrency(item.totalCommission)}</span>
                      </div>
                      <div className="text-xs text-[#64748b] ml-11 mt-0.5">
                        Metas batidas (total): <span className="font-semibold text-[#0f172a]">{formatInt(item.totalCycles)}</span>
                        {item.periodDetails && (
                          <span className="text-[#94a3b8] ml-1">
                            (D: {formatInt(item.periodDetails.diario?.cycles || 0)}, S: {formatInt(item.periodDetails.semanal?.cycles || 0)}, M: {formatInt(item.periodDetails.mensal?.cycles || 0)})
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
                {commissionData.length === 0 && <div className="text-center text-[#94a3b8] text-sm py-4">Nenhum colaborador com os filtros atuais.</div>}
              </div>
            </div>
          </div>

          {/* Explicação do cálculo */}
          <div className="card p-5 animate-fade-in-up mb-6" style={{ animationDelay: "480ms" }}>
            <h3 className="text-sm font-bold text-[#0f172a] mb-3">Como a comissão é calculada</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-[#64748b]">
              <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">1. Três períodos independentes:</span> diário, semanal e mensal. Cada um possui seu próprio peso e bônus.</div>
              <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">2. Gols por período:</span> mínimo entre (assinados ÷ peso_assinados) e (ganhos ÷ peso_ganhos).</div>
              <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">3. Comissão total:</span> soma das comissões dos três períodos (cada uma = metas_batidas × bônus_do_período).</div>
              <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">4. Hierarquia:</span> supervisores somam os pesos de sua equipe; coordenadores/administrativos somam todos os ativos.</div>
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}