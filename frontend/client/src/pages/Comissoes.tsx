// src/pages/Comissoes.tsx
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, formatCurrency } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import {
  DollarSign, Award, FileCheck, Target, Loader2, RefreshCw,
  FileText, Archive, XCircle, CalendarDays, TrendingUp, TrendingDown,
  Users,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend,
} from "recharts";
import { calculator } from "@/lib/calculator";
import { fetchDailyMetrics } from "@/lib/metrics";
import { toast } from "sonner";

const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário','BackOffice',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro', 'Equipe Reciclagem',''
];

const EXCLUDED_CARGOS = [
  "desativado","assistente","analista juridico","gestor de projetos","analista",
  "analista de discadora","supervisor","coordenador","salesops","ceo",
  "analista de crm","desenvolvedor","diretora","analista de dados","desenvolvedor make",
];

const normalizeText = (text: string) => (text || '').trim().toLowerCase();

/**
 * Verifica se o colaborador pertence a grupo especial (Quinquênio ou Concomitante)
 * considerando produto, cargo e equipe.
 */
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

/**
 * Retorna o tipo de produto para a tabela de comissões,
 * mapeando JUDIT/DISCADORA para AUXILIO ACIDENTE e reconhecendo equipes Quinquênio/Concomitante.
 */
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

const ExtratoDialog = ({ dailyMetrics, dailyGols, campaigns, metaGolsAssinados, metaGolsGanhos, isSupervisor, onClose }: any) => {
  const allDates = new Set<string>();
  dailyMetrics.forEach((d: any) => allDates.add(d.date.slice(0, 10)));
  (campaigns || []).forEach((c: any) => {
    if (c.validacao_financeiro) {
      allDates.add(c.data_publicacao.split('T')[0]);
    }
  });

  const sortedDates = Array.from(allDates).sort();

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
            {sortedDates.length > 0 ? (
              sortedDates.map((dateKey, idx) => {
                const day = dailyMetrics.find((d: any) => d.date.slice(0, 10) === dateKey) || {
                  date: dateKey,
                  assinados: 0,
                  ganhos: 0,
                  perdidos: 0,
                  emitidos: 0,
                  protocolados: 0,
                };
                const golsInfo = dailyGols.find((g: any) => (g.date || '').slice(0, 10) === dateKey);
                const golsDoDia = golsInfo?.gols || 0;

                const campanhasAprovadas = (campaigns || []).filter((c: any) => c.validacao_financeiro);
                const campanhasGols = campanhasAprovadas.filter((c: any) =>
                  c.tipo?.toUpperCase() === 'GOLS' && c.data_publicacao.split('T')[0] === dateKey
                );
                const campanhasAssinados = campanhasAprovadas.filter((c: any) =>
                  c.tipo?.toUpperCase() === 'ASSINADOS' && c.data_publicacao.split('T')[0] === dateKey
                );
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
                      {!isSupervisor && (
                        <>
                          <div><p className="text-[#64748b]">Meta Ass.</p><p className="font-bold text-[#2F6FED]">{formatInt(Math.round(Number(metaGolsAssinados)))}</p></div>
                          <div><p className="text-[#64748b]">Meta Gan.</p><p className="font-bold text-[#16A34A]">{formatInt(Math.round(Number(metaGolsGanhos)))}</p></div>
                        </>
                      )}
                    </div>
                    <div className="mt-3 pt-3 border-t border-[#e2e8f0] flex justify-between items-center">
                      <span className="text-xs font-semibold">{isSupervisor ? "Total de assinados" : "Gols do dia"}</span>
                      <span className={`text-lg font-black ${golsDoDia > 0 ? 'text-[#16A34A]' : 'text-[#94a3b8]'}`}>{isSupervisor ? formatInt(day.assinados || 0) : golsDoDia}</span>
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
                        {campanhasAssinados.map((camp: any, cIdx: number) => {
                          const proporcao = Number(camp.multiplicador) || 1;
                          return (
                            <div key={`a-${cIdx}`} className="flex justify-between text-xs mb-1">
                              <span className="flex items-center gap-1"><FileCheck className="w-3 h-3 text-[#16A34A]" />Assinados valem Gols</span>
                              <span className="font-bold text-[#16A34A]">
                                {proporcao === 1 ? '+1 gol/assinado' : `+1 gol a cada ${proporcao} assinados`}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="text-center text-[#94a3b8] py-8">Nenhum dado diário ou campanha disponível.</div>
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
  const isAdmin = getAccessLevel() === LEVELS.SUPER_ADMIN;

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
  const [weeklyMetrics, setWeeklyMetrics] = useState<any[]>([]);
  const [weeklyGols, setWeeklyGols] = useState<any[]>([]);
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
      let equipeApi: string | undefined;
      let colaboradorApi: string | undefined;
      let colaboradorIdApi: string | number | undefined;
      const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;

      if (isAdmin) {
        equipeApi = filters.equipe !== "todas" ? filters.equipe : undefined;
        colaboradorApi = filters.colaborador !== "todos" ? filters.colaborador : undefined;
        colaboradorIdApi = filters.colaboradorId;
      } else {
        const userColab = storeColabs.find(c => c.id === currentUser.id);
        if (userColab) {
          const isSupervisorUser = (userColab.cargo || '').toLowerCase() === 'supervisor';
          if (isSupervisorUser) {
            equipeApi = userColab.equipeNome;
            colaboradorApi = undefined;
            colaboradorIdApi = undefined;
          } else {
            equipeApi = undefined;
            colaboradorApi = userColab.name;
            colaboradorIdApi = currentUser.id;
          }
        } else {
          colaboradorIdApi = currentUser.id;
        }
      }

      await Promise.all([
        loadCollaboratorsAndMetrics(equipeApi, colaboradorApi, colaboradorIdApi, produtoApi),
        loadRawMetrics({ equipeNome: equipeApi, colaboradorNome: colaboradorApi, colaboradorId: colaboradorIdApi, produto: produtoApi }),
        loadWeeklyPerformanceData(),
      ]);

      const colaboradoresAtualizados = useAppStore.getState().collaborators;
      let targetColab: any;

      if (isAdmin) {
        targetColab = colaboradoresAtualizados.find(c => c.id === colaboradorIdApi || c.name === colaboradorApi);
      } else {
        targetColab = colaboradoresAtualizados.find(c => c.id === currentUser.id);
      }

      setDailyMetrics([]);
      setDailyGols([]);
      setWeeklyMetrics([]);
      setWeeklyGols([]);

      if (targetColab) {
        const isSupervisor = (targetColab.cargo || '').toLowerCase() === 'supervisor';
        const isQuinquenio = (() => {
          const produto = (targetColab.produto || '').toLowerCase();
          const cargo = (targetColab.cargo || '').toLowerCase();
          const equipe = (targetColab.equipeNome || '').toLowerCase();
          return produto === 'quinquenio' || cargo === 'quinquenio' ||
                 equipe.includes('quinquenio') || equipe.includes('quinquênio') || equipe.includes('tatiane');
        })();
        const isConcomitante = (() => {
          const produto = (targetColab.produto || '').toLowerCase();
          const cargo = (targetColab.cargo || '').toLowerCase();
          const equipe = (targetColab.equipeNome || '').toLowerCase();
          return produto === 'concomitante' || cargo === 'concomitante' || equipe.includes('concomitante');
        })();

        if (isSupervisor) {
          setLoadingDaily(true);
          try {
            const equipeMembros = colaboradoresAtualizados.filter(c => c.equipeNome === targetColab.equipeNome && c.id !== targetColab.id);
            if (equipeMembros.length > 0) {
              const allDaily: any[] = [];
              for (const membro of equipeMembros) {
                const dailyMembro = await fetchDailyMetrics({
                  start: currentStartDate,
                  end: currentEndDate,
                  colaborador: membro.name,
                });
                allDaily.push(...dailyMembro);
              }
              const aggregated = new Map<string, any>();
              allDaily.forEach(day => {
                const key = day.date;
                if (!aggregated.has(key)) {
                  aggregated.set(key, { date: key, assinados: 0, ganhos: 0, perdidos: 0, emitidos: 0, protocolados: 0 });
                }
                const entry = aggregated.get(key)!;
                entry.assinados += day.assinados || 0;
                entry.ganhos += day.ganhos || 0;
                entry.perdidos += day.perdidos || 0;
                entry.emitidos += day.emitidos || 0;
                entry.protocolados += day.protocolados || 0;
              });
              const dailyAgregado = Array.from(aggregated.values()).sort((a, b) => a.date.localeCompare(b.date));
              setDailyMetrics(dailyAgregado);
              setDailyGols([]);
            }
          } catch (err) {
            console.error('Erro ao carregar dados diários da equipe:', err);
          } finally {
            setLoadingDaily(false);
          }
        } else if (!isQuinquenio && !isConcomitante) {
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

            const activeCampaigns = campaigns.filter(c => c.validacao_financeiro);

            const golsResult = calculator.applyCampaignsToDailyGoals(daily, metaAss, metaGan, activeCampaigns);
            setDailyGols(golsResult.dailyGols);

            const now = new Date();
            const dayOfWeek = now.getDay();
            const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
            const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);

            const formatDateKey = (date: Date) => {
              const y = date.getFullYear();
              const m = String(date.getMonth() + 1).padStart(2, '0');
              const d = String(date.getDate()).padStart(2, '0');
              return `${y}-${m}-${d}`;
            };

            const weekly = await fetchDailyMetrics({
              start: formatDateKey(monday),
              end: formatDateKey(sunday),
              colaborador: targetColab.name,
            });
            setWeeklyMetrics(weekly);
            const weeklyGolsResult = calculator.applyCampaignsToDailyGoals(weekly, metaAss, metaGan, activeCampaigns);
            setWeeklyGols(weeklyGolsResult.dailyGols);
          } catch (err) {
            console.error('Erro ao carregar dados diários:', err);
          } finally {
            setLoadingDaily(false);
          }
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
  }, [currentStartDate, currentEndDate, filters, currentUser, isAdmin, loadCollaboratorsAndMetrics, loadRawMetrics, loadWeeklyPerformanceData, storeColabs, campaigns]);

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

  const userColab = useMemo(() => {
    if (isAdmin) {
      return filteredColabs.find(c => c.id === (filters.colaboradorId || filters.colaborador));
    }
    return filteredColabs.find(c => c.id === currentUser?.id);
  }, [filteredColabs, currentUser, filters, isAdmin]);

  const isSupervisorUser = (userColab?.cargo || '').toLowerCase() === 'supervisor';
  const isSpecialUser = userColab ? isSpecialGroupColaborador(userColab) : false;

  const commissionData = useMemo(() => {
    if (!userColab) return [];

    const isSpecial = isSpecialGroupColaborador(userColab);
    const isSupervisor = (userColab.cargo || '').toLowerCase() === 'supervisor';
    const isQuinquenio = (() => {
      const produto = (userColab.produto || '').toLowerCase();
      const cargo = (userColab.cargo || '').toLowerCase();
      const equipe = (userColab.equipeNome || '').toLowerCase();
      return produto === 'quinquenio' || cargo === 'quinquenio' ||
             equipe.includes('quinquenio') || equipe.includes('quinquênio') || equipe.includes('tatiane');
    })();
    const isConcomitante = (() => {
      const produto = (userColab.produto || '').toLowerCase();
      const cargo = (userColab.cargo || '').toLowerCase();
      const equipe = (userColab.equipeNome || '').toLowerCase();
      return produto === 'concomitante' || cargo === 'concomitante' || equipe.includes('concomitante');
    })();
    const isSR = calculator.isSupervisorSR(userColab.email);

    let totalCommission = 0;
    let totalGols = 0;
    let comissaoAssinados = 0;
    let comissaoGols = 0;

    if (isSupervisor) {
      const equipeColabs = storeColabs.filter(c => c.equipeNome === userColab.equipeNome && c.id !== userColab.id);
      const totalAssEquipe = equipeColabs.reduce((s, c) => s + (c.assinados || 0), 0);
      totalCommission = calculator.calculateSupervisorCommission(totalAssEquipe, isSR, tabelaComissoes);
      comissaoAssinados = totalCommission;
      totalGols = 0;
      comissaoGols = 0;
    } else if (isQuinquenio || isConcomitante) {
      const tipoTabela = isQuinquenio ? 'QUINQUENIO' : 'CONCOMITANTE';
      totalCommission = calculator.calculateProductCommission(userColab.assinados || 0, tipoTabela, tabelaComissoes);
      comissaoAssinados = totalCommission;
    } else {
      if (dailyMetrics.length > 0) {
        const metaAss = userColab.metaGolsAssinados ?? 3;
        const metaGan = userColab.metaGolsGanhos ?? 3;
        const assinados = userColab.assinados || 0;
        const productType = getFaixaProductType(userColab);

        const activeCampaigns = campaigns.filter(c => c.validacao_financeiro);

        const golsResult = calculator.applyCampaignsToDailyGoals(dailyMetrics, metaAss, metaGan, activeCampaigns);
        totalGols = golsResult.totalGols;
        comissaoGols = calculator.calculateGoalCommission(totalGols, tabelaComissoes);
        comissaoAssinados = calculator.calculateProductCommission(assinados, productType, tabelaComissoes);
        totalCommission = comissaoGols + comissaoAssinados;
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
  }, [filteredColabs, tabelaComissoes, currentUser, filters, storeColabs, dailyMetrics, userColab, campaigns]);

  const teamMembers = useMemo(() => {
    if (!isSupervisorUser || !userColab) return [];
    return storeColabs.filter(c => c.equipeNome === userColab.equipeNome && c.id !== userColab.id);
  }, [isSupervisorUser, userColab, storeColabs]);

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

  const metaGolsAss = userColab?.metaGolsAssinados ?? 3;
  const metaGolsGan = userColab?.metaGolsGanhos ?? 3;

  const taxaConversaoGeral = recebidos > 0 ? (assinados / recebidos) * 100 : 0;
  const taxaConversaoProtocolados = assinados > 0 ? (protocolados / assinados) * 100 : 0;

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

  // ========== EVOLUÇÃO DIÁRIA ==========
  const evolucaoDiariaData = useMemo(() => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

    const days = Array.from({ length: 5 }, (_, i) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      return date;
    });

    const formatKey = (date: Date) => {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };

    const formatLabel = (date: Date) => {
      const dayName = diasSemana[date.getDay()];
      const dd = String(date.getDate()).padStart(2, '0');
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      return `${dayName} ${dd}/${mm}`;
    };

    const metricsMap = new Map(
      weeklyMetrics.map(d => [d.date?.slice(0, 10), d])
    );
    const golsMap = new Map(
      weeklyGols.map(g => [g.date?.slice(0, 10), g.gols])
    );

    return days.map(date => {
      const key = formatKey(date);
      const metricas = metricsMap.get(key) || {};
      return {
        label: formatLabel(date),
        assinados: metricas.assinados || 0,
        ganhos: metricas.ganhos || 0,
        goals: golsMap.get(key) || 0,
      };
    });
  }, [weeklyMetrics, weeklyGols]);

  return (
    <DashboardLayout title="Painel de Comissões" subtitle="Suas comissões, calculadas pela soma de Gols diários, semanais e mensais">
      {isAdmin && (
        <FilterBar onFilterChange={handleFilterChange} showColaboradorFilter={true} className="mb-6" onRefresh={handleRefresh} />
      )}

      {showExtrato && (
        <ExtratoDialog
          dailyMetrics={dailyMetrics}
          dailyGols={dailyGols}
          campaigns={campaigns}
          metaGolsAssinados={metaGolsAss}
          metaGolsGanhos={metaGolsGan}
          isSupervisor={isSupervisorUser}
          onClose={() => setShowExtrato(false)}
        />
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
          {userColab ? (
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
                            <YAxis
                              domain={[0, 10000]}
                              ticks={[0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]}
                              tickFormatter={v => hideValues ? "***" : formatCurrency(v)}
                              tick={{ fontSize: 11, fill: "#64748b" }}
                            />
                            <Tooltip content={<CustomTooltip hideValues={hideValues} />} />
                            <Legend wrapperStyle={{ fontSize: 12 }} />
                            <Bar dataKey="comissaoAssinados" fill="#2F6FED" name="Comissão Assinados" radius={[4, 4, 0, 0]} />
                            {!commissionData[0]?.isSpecial && !isSupervisorUser && (
                              <Bar dataKey="comissaoGols" fill="#16A34A" name="Comissão Gols" radius={[4, 4, 0, 0]} />
                            )}
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      {commissionData.map((item) => {
                        const colab = item.originalColab;
                        const productType = getFaixaProductType(colab);
                        const faixas = tabelaComissoes
                          .filter(f => f.tipo === productType)
                          .sort((a, b) => a.faixa_min - b.faixa_min);
                        const goalGap = calculator.calculateGoalGap(item.totalCycles, tabelaComissoes);

                        let productGapInfo: { gap: number; nextValue: number } | null = null;
                        if (faixas.length > 0) {
                          const proximaFaixa = faixas.find(f => f.faixa_min > item.assinados);
                          if (proximaFaixa) {
                            productGapInfo = { gap: proximaFaixa.faixa_min - item.assinados, nextValue: proximaFaixa.faixa_min };
                          } else if (item.assinados < faixas[0].faixa_min) {
                            productGapInfo = { gap: faixas[0].faixa_min - item.assinados, nextValue: faixas[0].faixa_min };
                          }
                        }

                        let supervisorGapInfo: { gap: number; nextValue: number } | null = null;
                        if (isSupervisorUser) {
                          const equipeColabs = storeColabs.filter(c => c.equipeNome === colab.equipeNome && c.id !== colab.id);
                          const totalAssEquipe = equipeColabs.reduce((s, c) => s + (c.assinados || 0), 0);
                          const isSR = calculator.isSupervisorSR(colab.email);
                          supervisorGapInfo = calculator.calculateSupervisorGap(totalAssEquipe, isSR, tabelaComissoes);
                        }

                        return (
                          <div key={item.id} className="mt-4 p-3 bg-[#f8fafc] rounded-lg text-xs space-y-2">
                            {isSupervisorUser ? (
                              <>
                                <p><span className="font-semibold text-[#2F6FED]">Assinados da equipe:</span> {formatInt(item.assinados)}</p>
                                {supervisorGapInfo ? (
                                  <p>
                                    <span className="font-semibold text-[#8B5CF6]">Próxima faixa:</span>{' '}
                                    faltam <span className="font-bold">{formatInt(supervisorGapInfo.gap)}</span> assinados para a faixa mínima de {formatInt(supervisorGapInfo.nextValue)}.
                                  </p>
                                ) : (
                                  <p className="text-[#94a3b8]">Você já está na faixa máxima de supervisor.</p>
                                )}
                              </>
                            ) : (
                              <>
                                {goalGap ? (
                                  <p><span className="font-semibold text-[#8B5CF6]">Gols:</span> faltam <span className="font-bold">{formatInt(goalGap.gap)}</span> gols para a próxima faixa (mín. {formatInt(goalGap.nextValue)}).</p>
                                ) : (
                                  <p className="text-[#94a3b8]">Você já está na faixa máxima de gols.</p>
                                )}

                                {productGapInfo ? (
                                  <p><span className="font-semibold text-[#2F6FED]">Assinados:</span> faltam <span className="font-bold">{formatInt(productGapInfo.gap)}</span> assinados para a próxima faixa (mín. {formatInt(productGapInfo.nextValue)}).</p>
                                ) : (
                                  <p className="text-[#94a3b8]">
                                    {faixas.length === 0 ? `Nenhuma faixa de assinados configurada para ${productType}.` : "Você já está na faixa máxima de assinados."}
                                  </p>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}

                  <button
                    onClick={() => {
                      if (dailyMetrics.length === 0) {
                        toast.error('Nenhum dado diário disponível para exibir extrato.');
                        return;
                      }
                      setShowExtrato(true);
                    }}
                    className="mt-4 w-full py-2 px-4 inline-flex items-center justify-center gap-2 text-xs font-semibold rounded-lg border border-[#2F6FED] text-[#2F6FED] hover:bg-[#eff6ff] transition-colors"
                  >
                    <CalendarDays className="w-4 h-4" />
                    Ver Extrato de Gols e Campanhas
                  </button>
                </div>

                {!isSupervisorUser && (
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
                )}

                {isSupervisorUser && (
                  <div className="card p-5">
                    <h3 className="text-sm font-bold mb-4">Equipe (Assinados)</h3>
                    <div className="space-y-2 max-h-[420px] overflow-y-auto pr-2 custom-scrollbar">
                      {teamMembers.length > 0 ? (
                        teamMembers.map(member => (
                          <div key={member.id} className="flex items-center justify-between text-xs p-2 bg-[#f8fafc] rounded-lg">
                            <div className="flex items-center gap-2">
                              <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center font-bold text-[10px]">
                                {member.avatar || member.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="font-medium text-[#0f172a]">{member.name}</span>
                            </div>
                            <div className="flex items-center gap-4">
                              <span>Ass: <b>{formatInt(member.assinados)}</b></span>
                              <span>Ganhos: <b>{formatInt(member.ganhos)}</b></span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center text-[#94a3b8] py-4 text-xs">Nenhum membro na equipe.</div>
                      )}
                    </div>
                  </div>
                )}
              </div>

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

              {!isSupervisorUser && !isSpecialUser && (
                <div className="card p-5 mb-6">
                  <h3 className="text-sm font-bold mb-4">Evolução Diária</h3>
                  {evolucaoDiariaData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={evolucaoDiariaData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
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
              )}

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

              <div className="card p-5 mb-6">
                <h3 className="text-sm font-bold mb-3">Como a comissão é calculada</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-[#64748b]">
                  <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">1. Três períodos de apuração:</span> Diário, semanal e mensal.</div>
                  <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">2. Gols por período:</span> mínimo entre assinados e ganhos.</div>
                  <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">3. Comissão total:</span> soma das faixas de assinados + gols.</div>
                  <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">4. Campanhas aprovadas:</span> multiplicam gols (tipo GOLS) ou adicionam 1 gol por assinado (tipo ASSINADOS).</div>
                </div>
              </div>
            </>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
              Selecione um colaborador no filtro acima para visualizar as comissões.
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
}