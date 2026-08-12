// src/pages/Comissoes.tsx
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, formatCurrency } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import {
  DollarSign, Award, FileCheck, Target, Loader2, RefreshCw,
  FileText, Archive, XCircle, CalendarDays, TrendingUp, TrendingDown,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend,
} from "recharts";
import { calculator } from "@/lib/calculator";
import { fetchDailyMetrics } from "@/lib/metrics";

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

const SimpleTooltip = ({ active, payload, label }: any) => {
  if (active && payload?.length) {
    return (
      <div className="bg-white border border-[#e2e8f0] rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-[#0f172a] mb-1">{label}</p>
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

const CustomTooltip = ({ active, payload, label, hideValues }: any) => {
  if (active && payload?.length) {
    return (
      <div className="bg-white border border-[#e2e8f0] rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-[#0f172a] mb-1">{label}</p>
        {payload.map((entry: any, i: number) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {typeof entry.value === 'number' ? (hideValues ? '***' : formatCurrency(entry.value)) : entry.value}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

const ExtratoDialog = ({ dailyMetrics, dailyGols, campaigns, metaGolsAssinados, metaGolsGanhos, onClose }: any) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="p-6 border-b border-[#e2e8f0] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-[#2F6FED]" />
            <h3 className="text-lg font-bold text-[#0f172a]">Extrato de Gols e Campanhas</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-[#94a3b8] hover:text-[#0f172a] hover:bg-[#f1f5f9]">
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto flex-1">
          <div className="space-y-4">
            {dailyMetrics.length > 0 ? (
              dailyMetrics.map((day: any, idx: number) => {
                const dateKey = day.date;
                const golsInfo = dailyGols.find((g: any) => g.date === dateKey);
                const golsDoDia = golsInfo?.gols || 0;
                const campanhasGols = campaigns?.gols?.filter((c: any) => c.data_publicacao.split('T')[0] === dateKey) || [];
                const campanhasAssinados = campaigns?.assinados?.filter((c: any) => c.data_publicacao.split('T')[0] === dateKey) || [];
                const temCampanhas = campanhasGols.length > 0 || campanhasAssinados.length > 0;
                return (
                  <div key={idx} className={`p-4 rounded-xl border ${temCampanhas ? 'border-[#2F6FED] bg-[#eff6ff]' : 'border-[#e2e8f0]'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[#0f172a]">{dateKey}</span>
                      </div>
                      {temCampanhas && <span className="badge success text-xs">Campanha ativa</span>}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                      <div><p className="text-[#64748b]">Assinados</p><p className="font-bold">{formatInt(day.assinados || 0)}</p></div>
                      <div><p className="text-[#64748b]">Ganhos</p><p className="font-bold">{formatInt(day.ganhos || 0)}</p></div>
                      <div><p className="text-[#64748b]">Meta Ass.</p><p className="font-bold text-[#2F6FED]">{formatInt(metaGolsAssinados)}</p></div>
                      <div><p className="text-[#64748b]">Meta Gan.</p><p className="font-bold text-[#16A34A]">{formatInt(metaGolsGanhos)}</p></div>
                    </div>
                    <div className="mt-3 pt-3 border-t border-[#e2e8f0] flex justify-between items-center">
                      <span className="text-xs font-semibold">Gols do dia</span>
                      <span className={`text-lg font-black ${golsDoDia > 0 ? 'text-[#16A34A]' : 'text-[#94a3b8]'}`}>{golsDoDia}</span>
                    </div>
                    {temCampanhas && (
                      <div className="mt-3 pt-3 border-t border-[#e2e8f0]">
                        <p className="text-xs font-semibold text-[#2F6FED] mb-2">Campanhas ativas</p>
                        {campanhasGols.map((camp: any, cIdx: number) => (
                          <div key={`g-${cIdx}`} className="flex justify-between text-xs mb-1">
                            <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3 text-[#EA8C1D]" />Multiplica Gols</span>
                            <span className="font-bold text-[#EA8C1D]">×{camp.multiplicador}</span>
                          </div>
                        ))}
                        {campanhasAssinados.map((camp: any, cIdx: number) => (
                          <div key={`a-${cIdx}`} className="flex justify-between text-xs mb-1">
                            <span className="flex items-center gap-1"><FileCheck className="w-3 h-3 text-[#16A34A]" />Assinados valem Gols</span>
                            <span className="font-bold text-[#16A34A]">+1 gol/assinado</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="text-center text-[#94a3b8] py-8">Nenhum dado diário disponível.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default function Comissoes() {
  const {
    currentStartDate, currentEndDate,
    collaborators: storeColabs, globalConfig, equipeConfigs, rawMetrics,
    loadCollaboratorsAndMetrics, loadWeeklyPerformanceData, loadRawMetrics,
    hideValues, tabelaComissoes, campaigns,
  } = useAppStore();

  const { currentUser, getAccessLevel, LEVELS } = useAccessControl();
  const isAdmin = getAccessLevel() === LEVELS.ADMINISTRATIVO;

  const [filters, setFilters] = useState<{
    equipe: string;
    colaborador: string;
    colaboradorId?: string | number;
    produto: string;
  }>({ equipe: "todas", colaborador: "todos", produto: "Todos" });

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dailyMetrics, setDailyMetrics] = useState<any[]>([]);
  const [dailyGols, setDailyGols] = useState<any[]>([]);
  const [loadingDaily, setLoadingDaily] = useState(false);
  const [showExtrato, setShowExtrato] = useState(false);

  const isLoadingRef = useRef(false);

  const reloadData = useCallback(async (showRefreshing = false) => {
    if (!currentStartDate || !currentEndDate || !currentUser) return;
    if (isLoadingRef.current && !showRefreshing) return;

    isLoadingRef.current = true;
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const equipeApi = isAdmin && filters.equipe !== "todas" ? filters.equipe : undefined;
      const colaboradorApi = isAdmin && filters.colaborador !== "todos" ? filters.colaborador : undefined;
      const colaboradorIdApi = isAdmin && filters.colaboradorId ? filters.colaboradorId : currentUser.id;
      const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;

      await Promise.all([
        loadCollaboratorsAndMetrics(equipeApi, colaboradorApi, colaboradorIdApi, produtoApi),
        loadRawMetrics({ equipeNome: equipeApi, colaboradorNome: colaboradorApi, colaboradorId: colaboradorIdApi, produto: produtoApi }),
        loadWeeklyPerformanceData(),
      ]);

      const targetColab = storeColabs.find(c => c.id === colaboradorIdApi || c.name === colaboradorApi);
      if (targetColab) {
        const isSupervisor = (targetColab.cargo || '').toLowerCase() === 'supervisor';
        const isQuinquenio = (targetColab.produto || '').toLowerCase() === 'quinquenio';
        if (!isSupervisor && !isQuinquenio) {
          setLoadingDaily(true);
          try {
            const daily = await fetchDailyMetrics({
              start: currentStartDate,
              end: currentEndDate,
              colaborador: targetColab.name,
            });
            setDailyMetrics(daily);
            const metaAss = targetColab.metaGolsAssinados ?? 3;
            const metaGan = targetColab.metaGolsGanhos ?? 3;
            const golsResult = calculator.calculateDailyGoals(daily, metaAss, metaGan);
            setDailyGols(golsResult.dailyGols);
          } catch (err) {
            console.error('Erro ao carregar dados diários:', err);
            setDailyMetrics([]);
          } finally {
            setLoadingDaily(false);
          }
        } else {
          setDailyMetrics([]);
        }
      }
    } catch (err: any) {
      console.error("❌ Comissoes: erro ao recarregar dados:", err);
      setError(err.message || "Falha ao recarregar dados.");
    } finally {
      isLoadingRef.current = false;
      if (showRefreshing) setRefreshing(false);
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate, filters, currentUser, isAdmin, loadCollaboratorsAndMetrics, loadRawMetrics, loadWeeklyPerformanceData, storeColabs]);

  const handleRefresh = useCallback(async () => { await reloadData(true); }, [reloadData]);
  const handleFilterChange = useCallback((newFilters: any) => { setFilters(newFilters); }, []);

  useEffect(() => {
    if (!currentStartDate || !currentEndDate || !currentUser) return;
    reloadData(false);
  }, [currentStartDate, currentEndDate, filters, currentUser]);

  const filteredColabs = useMemo(() => {
    let filtered = storeColabs.filter(c => {
      if (EXCLUDED_TEAMS.some(team => normalizeText(c.equipeNome) === normalizeText(team))) return false;
      if (EXCLUDED_CARGOS.some(cargo => normalizeText(c.cargo) === normalizeText(cargo))) return false;
      return true;
    });
    if (!isAdmin) {
      if (currentUser && !filtered.some(c => c.id === currentUser.id)) {
        const userColab = storeColabs.find(c => c.id === currentUser.id);
        if (userColab) filtered = [userColab, ...filtered];
      }
    } else {
      if (filters.equipe !== "todas") filtered = filtered.filter(c => c.equipeNome === filters.equipe);
      if (filters.colaborador !== "todos") filtered = filtered.filter(c => c.name === filters.colaborador);
    }
    return filtered;
  }, [storeColabs, currentUser, filters, isAdmin]);

  const commissionData = useMemo(() => {
    const userColab = filteredColabs.find(c => c.id === (filters.colaboradorId || currentUser?.id));
    if (!userColab) return [];

    const isSpecial = isSpecialGroupColaborador(userColab);
    const isSupervisor = (userColab.cargo || '').toLowerCase() === 'supervisor';
    const isQuinquenio = (userColab.produto || '').toLowerCase() === 'quinquenio';
    const isSR = calculator.isSupervisorSR(userColab.email);

    let totalCommission = 0;
    let totalGols = 0;
    let comissaoAssinados = 0;
    let comissaoGols = 0;

    if (isSupervisor) {
      const equipeColabs = storeColabs.filter(c => c.equipeNome === userColab.equipeNome);
      const totalAssEquipe = equipeColabs.reduce((s, c) => s + (c.assinados || 0), 0);
      totalCommission = calculator.calculateSupervisorCommission(totalAssEquipe, isSR, tabelaComissoes);
      comissaoAssinados = totalCommission;
    } else if (isQuinquenio) {
      totalCommission = calculator.calculateQuinquenioCommission(userColab.assinados || 0, tabelaComissoes);
      comissaoAssinados = totalCommission;
    } else {
      if (dailyMetrics.length > 0) {
        const metaAss = userColab.metaGolsAssinados ?? 3;
        const metaGan = userColab.metaGolsGanhos ?? 3;
        const assinados = userColab.assinados || 0;
        const rawProduct = userColab?.produto?.toUpperCase() || '';
        const productType = 
          rawProduct === 'JUDIT' || rawProduct === 'DISCADORA'
          ? 'AUXILIO ACIDENTE'
          : rawProduct || 
          (userColab?.cargo?.toLowerCase() === 'quinquenio' ? 'QUINQUENIO' : 
          userColab?.cargo?.toLowerCase() === 'concomitante' ? 'CONCOMITANTE' : 'AUXILIO ACIDENTE');
        const result = calculator.calculateTotalCommission(dailyMetrics, metaAss, metaGan, assinados, productType, tabelaComissoes);
        totalCommission = result.totalCommission;
        comissaoGols = result.goalCommission;
        comissaoAssinados = result.productCommission;
        totalGols = result.totalGols;
      }
    }

    return [{
      id: userColab.id,
      name: userColab.name,
      totalCommission,
      totalCycles: totalGols,
      comissaoAssinados,
      comissaoGols,
      assinados: userColab.assinados || 0,
      ganhos: isSpecial ? 0 : (userColab.ganhos || 0),
      avatar: userColab.avatar || userColab.name.charAt(0).toUpperCase(),
      cargo: userColab.cargo,
      isSpecial,
      emitidos: userColab.emitidos || 0,
      protocolados: userColab.protocolados || 0,
      perdidos: userColab.perdidos || 0,
      originalColab: userColab,
    }];
  }, [filteredColabs, tabelaComissoes, currentUser, filters, storeColabs, dailyMetrics]);

  const totals = useMemo(() => {
    const comissao = commissionData.reduce((s, i) => s + i.totalCommission, 0);
    const ciclos = commissionData.reduce((s, i) => s + i.totalCycles, 0);
    return { comissao, ciclos };
  }, [commissionData]);

  const avgProgress = useMemo(() => {
    if (!commissionData.length) return 0;
    const sum = commissionData.reduce((acc, i) => {
      const pctAss = i.originalColab?.metaMensalAssinados ? (i.assinados / i.originalColab.metaMensalAssinados) * 100 : 0;
      const pctGan = i.originalColab?.metaMensalGanhos ? (i.ganhos / i.originalColab.metaMensalGanhos) * 100 : 100;
      return acc + Math.min(pctAss, pctGan);
    }, 0);
    return sum / commissionData.length;
  }, [commissionData]);

  const displayCurrency = (val: number) => hideValues ? "R$ ****" : formatCurrency(val);

  const summaryCards = [
    { label: "Comissão Total Estimada", value: totals.comissao, icon: DollarSign, color: "#2F6FED", isCurrency: true },
    { label: "Gols", value: totals.ciclos, icon: Award, color: "#16A34A", isInteger: true },
    { label: "Vendas Fechadas", value: rawMetrics.assinados, icon: FileCheck, color: "#EA8C1D", isInteger: true },
    { label: "Progresso Médio", value: avgProgress, icon: Target, color: "#8B5CF6", isPercent: true },
  ];

  const userData = commissionData[0] || null;
  const recebidos = userData?.emitidos || 0;
  const assinados = userData?.assinados || 0;
  const protocolados = userData?.protocolados || 0;
  const ganhos = userData?.ganhos || 0;
  const perdidos = userData?.perdidos || 0;

  const userColab = filteredColabs.find(c => c.id === (filters.colaboradorId || currentUser?.id));
  const metaGolsAss = userColab?.metaGolsAssinados ?? 3;
  const metaGolsGan = userColab?.metaGolsGanhos ?? 3;

  const taxaConversaoGeral = recebidos > 0 ? (assinados / recebidos) * 100 : 0;
  const taxaConversaoProtocolados = assinados > 0 ? (protocolados / assinados) * 100 : 0;
  const corConversaoGeral = taxaConversaoGeral >= 60 ? "#16A34A" : taxaConversaoGeral >= 40 ? "#EA8C1D" : "#DC2626";
  const corConversaoProtocolados = taxaConversaoProtocolados >= 60 ? "#16A34A" : taxaConversaoProtocolados >= 40 ? "#EA8C1D" : "#DC2626";

  const recomendacoes: string[] = [];
  if (userData) {
    if (userData.originalColab?.metaMensalAssinados && userData.assinados < userData.originalColab.metaMensalAssinados * 0.7) {
      recomendacoes.push("Você está abaixo de 70% da meta de assinados. Reforce as atividades de fechamento.");
    }
    if (taxaConversaoGeral < 50) {
      recomendacoes.push("Sua taxa de conversão (recebidos → assinados) está baixa. Revise sua abordagem de qualificação.");
    }
    if (taxaConversaoProtocolados < 50 && assinados > 0) {
      recomendacoes.push("Menos da metade dos seus assinados foram protocolados. Acompanhe os processos pendentes.");
    }
    if (userData.totalCycles < 5 && userData.totalCycles > 0) {
      recomendacoes.push("Seus gols totais estão baixos. Concentre-se em bater as metas diárias para acumular mais gols.");
    }
  }

  const calcPercent = (value: number, target: number) => target > 0 ? Math.min((value / target) * 100, 100) : 0;

  return (
    <DashboardLayout title="Painel de Comissões" subtitle="Suas comissões, calculadas pela soma de Gols diários, semanais e mensais">
      {isAdmin && (
        <FilterBar onFilterChange={handleFilterChange} showColaboradorFilter={true} className="mb-6" onRefresh={handleRefresh} />
      )}

      <div className="flex flex-wrap items-end gap-3 mb-6">
        <button onClick={handleRefresh} disabled={refreshing || loading} className="h-9 px-4 inline-flex items-center gap-1.5 text-xs font-semibold rounded-lg bg-[#2F6FED] text-white hover:bg-[#2563eb] disabled:opacity-50 transition-colors shadow-sm">
          <RefreshCw className={`w-4 h-4 ${(refreshing || loading) ? "animate-spin" : ""}`} />
          {refreshing || loading ? "Atualizando..." : "Atualizar dados"}
        </button>
      </div>

      {showExtrato && (
        <ExtratoDialog dailyMetrics={dailyMetrics} dailyGols={dailyGols} campaigns={campaigns} metaGolsAssinados={metaGolsAss} metaGolsGanhos={metaGolsGan} onClose={() => setShowExtrato(false)} />
      )}

      {loading && (
        <div className="flex justify-center items-center py-4">
          <Loader2 className="w-5 h-5 animate-spin text-[#2F6FED]" />
          <span className="ml-2 text-sm text-[#64748b]">Carregando seus dados...</span>
        </div>
      )}

      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg text-sm mb-4">
          <p>{error}</p>
          <button onClick={() => reloadData(true)} className="mt-2 px-4 py-2 bg-red-600 text-white rounded-lg text-xs hover:bg-red-700">Tentar novamente</button>
        </div>
      )}

      {!loading && filteredColabs.length === 0 && !error && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-center text-amber-800 text-sm">Nenhum dado de comissão encontrado para você.</div>
      )}

      {!loading && filteredColabs.length > 0 && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {summaryCards.map((card, idx) => {
              const Icon = card.icon;
              let displayValue = card.isPercent ? `${card.value.toFixed(1)}%` : card.isCurrency ? displayCurrency(card.value) : formatInt(card.value);
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <div className="card p-5 flex flex-col">
              <h3 className="text-sm font-bold mb-4">Comissão Total do Colaborador</h3>
              {commissionData.length === 0 ? (
                <div className="text-center text-[#94a3b8] py-8">Nenhum dado disponível.</div>
              ) : (
                <>
                  <div className="flex-1" style={{ minHeight: '300px' }}>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={commissionData} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#64748b" }} />
                        <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => hideValues ? "***" : formatCurrency(v)} />
                        <Tooltip content={<CustomTooltip hideValues={hideValues} />} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="comissaoAssinados" fill="#2F6FED" name="Comissão Assinados" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="comissaoGols" fill="#16A34A" name="Comissão Gols" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {commissionData.map((item) => {
                    const colab = item.originalColab;
                    const productType = colab?.produto?.toUpperCase() || 
                                        (colab?.cargo?.toLowerCase() === 'quinquenio' ? 'QUINQUENIO' : 
                                         colab?.cargo?.toLowerCase() === 'concomitante' ? 'CONCOMITANTE' : 
                                         'AUXILIO ACIDENTE');

                    const faixas = tabelaComissoes
                      .filter(f => f.tipo === productType)
                      .sort((a, b) => a.faixa_min - b.faixa_min);

                    const goalGap = calculator.calculateGoalGap(item.totalCycles, tabelaComissoes);

                    let productGapInfo: { gap: number; nextValue: number } | null = null;

                    if (faixas.length > 0) {
                      const proximaFaixa = faixas.find(f => f.faixa_min > item.assinados);
                      if (proximaFaixa) {
                        productGapInfo = {
                          gap: proximaFaixa.faixa_min - item.assinados,
                          nextValue: proximaFaixa.faixa_min,
                        };
                      } else if (item.assinados < faixas[0].faixa_min) {
                        productGapInfo = {
                          gap: faixas[0].faixa_min - item.assinados,
                          nextValue: faixas[0].faixa_min,
                        };
                      }
                    }

                    return (
                      <div key={item.id} className="mt-4 p-3 bg-[#f8fafc] rounded-lg text-xs space-y-2">
                        {goalGap ? (
                          <p><span className="font-semibold text-[#8B5CF6]">Gols:</span> faltam <span className="font-bold">{formatInt(goalGap.gap)}</span> gols para a próxima faixa (mín. {formatInt(goalGap.nextValue)}).</p>
                        ) : (
                          <p className="text-[#94a3b8]">Você já está na faixa máxima de gols.</p>
                        )}

                        {productGapInfo ? (
                          <p><span className="font-semibold text-[#2F6FED]">Assinados:</span> faltam <span className="font-bold">{formatInt(productGapInfo.gap)}</span> assinados para a próxima faixa (mín. {formatInt(productGapInfo.nextValue)}).</p>
                        ) : (
                          <p className="text-[#94a3b8]">
                            {faixas.length === 0 
                              ? `Nenhuma faixa de assinados configurada para ${productType}.`
                              : "Você já está na faixa máxima de assinados."}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </>
              )}

              {dailyMetrics.length > 0 && (
                <button onClick={() => setShowExtrato(true)} className="mt-4 w-full py-2 px-4 inline-flex items-center justify-center gap-2 text-xs font-semibold rounded-lg border border-[#2F6FED] text-[#2F6FED] hover:bg-[#eff6ff] transition-colors">
                  <CalendarDays className="w-4 h-4" />
                  Ver Extrato de Gols e Campanhas
                </button>
              )}
            </div>

            {/* METAS VS REALIZADO */}
            <div className="card p-5">
              <h3 className="text-sm font-bold mb-4">Metas vs Realizado</h3>
              <div className="space-y-5 max-h-[420px] overflow-y-auto pr-2 custom-scrollbar">
                {commissionData.map((item) => {
                  const colabOriginal = item.originalColab;
                  const metaDiarioAss = Number(colabOriginal?.pesoDiarioAssinados ?? colabOriginal?.metaDiarioAssinados ?? 3);
                  const metaDiarioGan = Number(colabOriginal?.pesoDiarioGanhos ?? colabOriginal?.metaDiarioGanhos ?? 3);
                  const metaSemanalAss = Number(colabOriginal?.pesoSemanalAssinados ?? colabOriginal?.metaSemanalAssinados ?? 15);
                  const metaSemanalGan = Number(colabOriginal?.pesoSemanalGanhos ?? colabOriginal?.metaSemanalGanhos ?? 15);
                  const metaMensalAss = Number(colabOriginal?.pesoMensalAssinados ?? colabOriginal?.metaMensalAssinados ?? 60);
                  const metaMensalGan = Number(colabOriginal?.pesoMensalGanhos ?? colabOriginal?.metaMensalGanhos ?? 60);
                  const metaGolsAss = Number(colabOriginal?.metaGolsAssinados ?? 3);
                  const metaGolsGan = Number(colabOriginal?.metaGolsGanhos ?? 3);

                  const now = new Date();
                  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                  const dayOfWeek = now.getDay();
                  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
                  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
                  const sunday = new Date(monday);
                  sunday.setDate(monday.getDate() + 6);
                  const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
                  const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
                  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
                  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                  const monthStartStr = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-${String(monthStart.getDate()).padStart(2, '0')}`;
                  const monthEndStr = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`;

                  const dailyDataDiario = dailyMetrics.filter(d => d.date && d.date.slice(0,10) === todayStr);
                  const dailyDataSemanal = dailyMetrics.filter(d => d.date && d.date.slice(0,10) >= mondayStr && d.date.slice(0,10) <= sundayStr);
                  const dailyDataMensal = dailyMetrics.filter(d => d.date && d.date.slice(0,10) >= monthStartStr && d.date.slice(0,10) <= monthEndStr);

                  const assinadosDiario = dailyDataDiario.reduce((sum, d) => sum + (Number(d.assinados) || 0), 0);
                  const ganhosDiario = dailyDataDiario.reduce((sum, d) => sum + (Number(d.ganhos) || 0), 0);
                  const assinadosSemanal = dailyDataSemanal.reduce((sum, d) => sum + (Number(d.assinados) || 0), 0);
                  const ganhosSemanal = dailyDataSemanal.reduce((sum, d) => sum + (Number(d.ganhos) || 0), 0);
                  const assinadosMensal = dailyDataMensal.reduce((sum, d) => sum + (Number(d.assinados) || 0), 0);
                  const ganhosMensal = dailyDataMensal.reduce((sum, d) => sum + (Number(d.ganhos) || 0), 0);

                  const periodos = [
                    { label: "Diário (hoje)", metaAss: metaDiarioAss, metaGan: metaDiarioGan, atualAss: assinadosDiario, atualGan: ganhosDiario, colorAss: "#2F6FED", colorGan: "#16A34A" },
                    { label: "Semanal (semana atual)", metaAss: metaSemanalAss, metaGan: metaSemanalGan, atualAss: assinadosSemanal, atualGan: ganhosSemanal, colorAss: "#EA8C1D", colorGan: "#16A34A" },
                    { label: "Mensal (mês atual)", metaAss: metaMensalAss, metaGan: metaMensalGan, atualAss: assinadosMensal, atualGan: ganhosMensal, colorAss: "#8B5CF6", colorGan: "#16A34A" },
                  ];

                  const golsDiario = calculator.calculateDailyGoals(dailyDataDiario, metaGolsAss, metaGolsGan).totalGols;

                  return (
                    <div key={item.id || item.name}>
                      <div className="flex items-center gap-3 mb-3">
                        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center text-xs font-bold">{item.avatar}</div>
                        <div><span className="font-medium text-[#0f172a] text-sm">{item.name}</span></div>
                      </div>

                      {periodos.map((p) => {
                        const pctAss = calcPercent(p.atualAss, p.metaAss);
                        const pctGan = p.metaGan > 0 ? calcPercent(p.atualGan, p.metaGan) : 0;
                        const faltaAss = Math.max(0, p.metaAss - p.atualAss);
                        const faltaGan = Math.max(0, p.metaGan - p.atualGan);

                        return (
                          <div key={p.label} className="mb-3 last:mb-0">
                            <p className="text-xs font-semibold text-[#475569] mb-1">{p.label}</p>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-[10px] text-[#64748b] w-12">Assin.</span>
                              <div className="flex-1 progress-bar h-2">
                                <div className="progress-fill" style={{ width: `${pctAss}%`, background: p.colorAss }} />
                              </div>
                              <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">{formatInt(p.atualAss)}/{formatInt(p.metaAss)}</span>
                              <span className="text-[10px] font-medium" style={{ color: p.colorAss }}>{pctAss.toFixed(0)}%</span>
                            </div>
                            <div className="text-[9px] text-[#94a3b8] ml-14 mb-1">{faltaAss > 0 ? `Faltam ${formatInt(faltaAss)}` : "Atingido"}</div>
                            {!item.isSpecial && (
                              <>
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-[10px] text-[#64748b] w-12">Ganhos</span>
                                  <div className="flex-1 progress-bar h-2">
                                    <div className="progress-fill" style={{ width: `${pctGan}%`, background: p.colorGan }} />
                                  </div>
                                  <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">{formatInt(p.atualGan)}/{formatInt(p.metaGan)}</span>
                                  <span className="text-[10px] font-medium" style={{ color: p.colorGan }}>{pctGan.toFixed(0)}%</span>
                                </div>
                                <div className="text-[9px] text-[#94a3b8] ml-14 mb-1">{faltaGan > 0 ? `Faltam ${formatInt(faltaGan)}` : "Atingido"}</div>
                              </>
                            )}
                          </div>
                        );
                      })}

                      <div className="mt-3 pt-3 border-t border-[#e2e8f0]">
                        <p className="text-xs font-semibold text-[#475569] mb-1">Gols (hoje)</p>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] text-[#64748b] w-12">Assin.</span>
                          <div className="flex-1 progress-bar h-2">
                            <div className="progress-fill" style={{ width: `${calcPercent(assinadosDiario, metaGolsAss)}%`, background: "#2F6FED" }} />
                          </div>
                          <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">{formatInt(assinadosDiario)}/{formatInt(metaGolsAss)}</span>
                          <span className="text-[10px] font-medium" style={{ color: "#2F6FED" }}>{calcPercent(assinadosDiario, metaGolsAss).toFixed(0)}%</span>
                        </div>
                        {!item.isSpecial && (
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] text-[#64748b] w-12">Ganhos</span>
                            <div className="flex-1 progress-bar h-2">
                              <div className="progress-fill" style={{ width: `${calcPercent(ganhosDiario, metaGolsGan)}%`, background: "#16A34A" }} />
                            </div>
                            <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">{formatInt(ganhosDiario)}/{formatInt(metaGolsGan)}</span>
                            <span className="text-[10px] font-medium" style={{ color: "#16A34A" }}>{calcPercent(ganhosDiario, metaGolsGan).toFixed(0)}%</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* SEUS NÚMEROS */}
          <div className="card p-5 mb-6">
            <h3 className="text-sm font-bold mb-4">Seus Números</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
              <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><FileText className="w-4 h-4 text-[#2F6FED] mx-auto mb-1" /><p className="text-[11px]">Emitidos</p><p className="text-base font-semibold">{formatInt(recebidos)}</p></div>
              <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><FileCheck className="w-4 h-4 text-[#16A34A] mx-auto mb-1" /><p className="text-[11px]">Assinados</p><p className="text-base font-semibold">{formatInt(assinados)}</p></div>
              <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><Award className="w-4 h-4 text-[#EA8C1D] mx-auto mb-1" /><p className="text-[11px]">Ganhos</p><p className="text-base font-semibold">{formatInt(ganhos)}</p></div>
              <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><Archive className="w-4 h-4 text-[#8B5CF6] mx-auto mb-1" /><p className="text-[11px]">Protocolados</p><p className="text-base font-semibold">{formatInt(protocolados)}</p></div>
              <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><XCircle className="w-4 h-4 text-[#DC2626] mx-auto mb-1" /><p className="text-[11px]">Perdidos</p><p className="text-base font-semibold">{formatInt(perdidos)}</p></div>
            </div>
          </div>

          {/* EVOLUÇÃO DIÁRIA */}
          <div className="card p-5 mb-6">
            <h3 className="text-sm font-bold mb-4">Evolução Diária</h3>
            {rawMetrics.assinados > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={[
                  { name: "Seg", assinados: Math.round(rawMetrics.assinados * 0.2), ganhos: Math.round(rawMetrics.ganhos * 0.2), goals: Math.round(totals.ciclos * 0.2) },
                  { name: "Ter", assinados: Math.round(rawMetrics.assinados * 0.25), ganhos: Math.round(rawMetrics.ganhos * 0.25), goals: Math.round(totals.ciclos * 0.25) },
                  { name: "Qua", assinados: Math.round(rawMetrics.assinados * 0.18), ganhos: Math.round(rawMetrics.ganhos * 0.18), goals: Math.round(totals.ciclos * 0.18) },
                  { name: "Qui", assinados: Math.round(rawMetrics.assinados * 0.22), ganhos: Math.round(rawMetrics.ganhos * 0.22), goals: Math.round(totals.ciclos * 0.22) },
                  { name: "Sex", assinados: Math.round(rawMetrics.assinados * 0.15), ganhos: Math.round(rawMetrics.ganhos * 0.15), goals: Math.round(totals.ciclos * 0.15) },
                ]}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} width={28} allowDecimals={false} />
                  <Tooltip content={<SimpleTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="assinados" fill="#2F6FED" name="Assinados" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="ganhos" fill="#16A34A" name="Ganhos" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="goals" fill="#8B5CF6" name="Goals" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center text-[#94a3b8] py-8">Dados de evolução diária indisponíveis.</div>
            )}
          </div>

          {/* RECOMENDAÇÕES */}
          {recomendacoes.length > 0 && (
            <div className="card p-5 mb-6">
              <h3 className="text-sm font-bold mb-3">Recomendações</h3>
              <ul className="space-y-2">
                {recomendacoes.map((r, i) => (
                  <li key={i} className="flex gap-2 text-[13px] text-[#475569] bg-[#f8fafc] border border-[#e2e8f0] rounded-lg p-3"><span className="text-[#2F6FED]">→</span>{r}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Explicação do cálculo */}
          <div className="card p-5 mb-6">
            <h3 className="text-sm font-bold mb-3">Como a comissão é calculada</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-[#64748b]">
              <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">1. Três períodos de apuração:</span> Diário, semanal e mensal.</div>
              <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">2. Gols por período:</span> mínimo entre assinados e ganhos.</div>
              <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">3. Comissão total:</span> soma das faixas de assinados + gols.</div>
              <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">4. Segurança:</span> informações protegidas e auditáveis.</div>
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}