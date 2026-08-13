// src/pages/Visao_geral.tsx
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useAppStore, Collaborator } from "@/lib/dataStore";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import {
  FileText,
  CheckCircle,
  DollarSign,
  Archive,
  XCircle,
  Award,
  Inbox,
  Percent,
  FileCheck2,
  FileSignature,
  Trophy,
  UserX,
  Gauge,
  Loader2,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { KpiCard } from "@/components/kpi/KpiCard";
import { ResumoMesCard } from "@/components/kpi/ResumoMesCard";
import { Card } from "@/components/ui/card";
import { FunilChart } from "@/components/charts/FunilChart";
import { DetalheAssinadosModal } from "@/components/dashboard/DetalheAssinadosModal";
import { PlanoAcaoColaboradores } from "@/components/dashboard/PlanoAcaoColaboradores";
import { calcularPaceProjecao } from "@/lib/diagnostico";
import { contarDiasUteis, getPeriodoMesDoCalendario } from "@/lib/period";
import { formatNumero, formatPct } from "@/lib/format";
import { ehSupervisor } from "@/lib/colaboradoresAtivos";
import { Link } from "wouter";
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
import { fetchLeadsRecebidos } from "@/lib/api";

// ========== CONSTANTES DE EXCLUSÃO ==========
const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro', 'Equipe Reciclagem',''
];
const EXCLUDED_CARGOS = [
  "desativado", "assistente", "analista juridico", "gestor de projetos", "analista",
  "analista de discadora", "supervisor", "coordenador", "salesops", "ceo",
  "analista de crm", "desenvolvedor", "diretora", "analista de dados", "desenvolvedor make",
];
const normalize = (str: string): string =>
  (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const isExcludedTeam = (teamName: string) => EXCLUDED_TEAMS.includes(teamName);
const isExcludedCargo = (cargo: string) =>
  EXCLUDED_CARGOS.some(g => normalize(g) === normalize(cargo));
const isDesativado = (c: Collaborator) =>
  normalize(c.cargo) === 'desativado' || normalize(c.equipeNome).includes('desativado');

// ========== RADAR DE CONVERSÃO (colaboradores individuais) ==========
function RadarConversaoLigacoes({ colaboradores }: { colaboradores: Collaborator[] }) {
  const dados = colaboradores.map((colab) => ({
    name: colab.name,
    value: Math.max(0, Math.min(100, (colab.assinados || 0) * 10)),
  }));

  return (
    <div className="h-72">
      <div className="space-y-2">
        {dados.length === 0 ? (
          <p className="text-sm text-slate-500">Nenhum colaborador disponível.</p>
        ) : (
          dados.slice(0, 8).map((item) => (
            <div key={item.name} className="space-y-1">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>{item.name}</span>
                <span>{item.value.toFixed(0)}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-100">
                <div className="h-2 rounded-full bg-[#09175b]" style={{ width: `${Math.min(100, item.value)}%` }} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ========== GRÁFICO DE BARRAS (equipes) ==========
const CORES_TIME = ['#2563eb', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];

interface DadoDesempenho {
  nome: string;
  assinados: number;
}

function DesempenhoEquipes({ dados }: { dados: DadoDesempenho[] }) {
  if (dados.length === 0) {
    return <p className="text-sm text-slate-500">Nenhum dado disponível.</p>;
  }

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={dados} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="nome" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
          <Tooltip formatter={(v) => [formatNumero(Number(v)), 'Assinados']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          <Bar dataKey="assinados" radius={[4, 4, 0, 0]} barSize={32}>
            {dados.map((_, indice) => (
              <Cell key={indice} fill={CORES_TIME[indice % CORES_TIME.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ========== PÁGINA PRINCIPAL ==========
export default function VisaoGeral() {
  const {
    collaborators: rawCollaborators,
    currentStartDate,
    currentEndDate,
    period,
    rawMetrics,
    loadMetricsForPeriod,
    loadRawMetrics,
    loadCollaborators,
  } = useAppStore();

  const [filters, setFilters] = useState<{
    equipe: string;
    colaborador: string;
    colaboradorId?: string | number;
    produto: string;
  }>({
    equipe: "todas",
    colaborador: "todos",
    produto: "Todos",
  });

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalAberto, setModalAberto] = useState<"discador" | "judit" | null>(null);
  const [totalLeads, setTotalLeads] = useState(0);

  const lastFetchLeads = useRef<number>(0);
  const LEADS_CACHE_TTL = 60000;
  const isFetching = useRef(false);

  // -----------------------------------------------------------
  //  RESETAR cache de leads sempre que período ou filtros mudarem
  // -----------------------------------------------------------
  useEffect(() => {
    setTotalLeads(0);
    lastFetchLeads.current = 0;
  }, [currentStartDate, currentEndDate, filters]);

  // Busca leads totais do período
  const fetchLeadsData = useCallback(async () => {
    if (!currentStartDate || !currentEndDate) return;
    const now = Date.now();
    if (totalLeads > 0 && (now - lastFetchLeads.current) < LEADS_CACHE_TTL) return;

    try {
      const equipeApi = filters.equipe === "todas" ? undefined : filters.equipe;
      const colaboradorApi = filters.colaborador === "todos" ? undefined : filters.colaborador;
      const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;
      const params = {
        start: currentStartDate,
        end: currentEndDate,
        equipe: equipeApi,
        colaborador: colaboradorApi,
        produto: produtoApi,
      };
      const leadsData = await fetchLeadsRecebidos(params);
      const total = leadsData.reduce((sum: number, item: any) => sum + (Number(item.total) || 0), 0);
      setTotalLeads(total);
      lastFetchLeads.current = Date.now();
    } catch (err) {
      console.error("Erro ao buscar leads:", err);
    }
  }, [currentStartDate, currentEndDate, filters, totalLeads]);

  // Função principal de carregamento
  const fetchData = useCallback(async (showRefreshing = false) => {
    if (!currentStartDate || !currentEndDate) return;
    if (showRefreshing) setRefreshing(true);
    try {
      const equipeApi = filters.equipe === "todas" ? undefined : filters.equipe;
      const colaboradorApi = filters.colaborador === "todos" ? undefined : filters.colaborador;
      const colaboradorIdApi = filters.colaboradorId;
      const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;

      if (rawCollaborators.length === 0) await loadCollaborators();
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

      await fetchLeadsData();
    } catch (err) {
      console.error("Erro ao carregar dados da Visão Geral:", err);
    } finally {
      if (showRefreshing) setRefreshing(false);
      setLoading(false);
    }
  }, [filters, currentStartDate, currentEndDate, rawCollaborators.length, loadCollaborators, loadMetricsForPeriod, loadRawMetrics, fetchLeadsData]);

  // -----------------------------------------------------------
  //  HANDLE REFRESH (para o botão no FilterBar)
  // -----------------------------------------------------------
  const handleRefresh = useCallback(async () => {
    await fetchData(true);
  }, [fetchData]);

  // -----------------------------------------------------------
  //  EFEITO PRINCIPAL (com dependências completas e proteção contra loops)
  // -----------------------------------------------------------
  useEffect(() => {
    if (!currentStartDate || !currentEndDate) return;
    if (isFetching.current) return;
    isFetching.current = true;
    setLoading(true);
    fetchData().finally(() => {
      isFetching.current = false;
    });
  }, [currentStartDate, currentEndDate, filters, fetchData]);

  const handleFilterChange = (newFilters: typeof filters) => {
    setFilters(newFilters);
  };

  // Colaboradores ativos após exclusões
  const collaborators = useMemo(() => {
    let list = rawCollaborators.filter(
      c => !isDesativado(c) && !isExcludedTeam(c.equipeNome) && !isExcludedCargo(c.cargo)
    );
    if (filters.equipe !== "todas") list = list.filter(c => c.equipeNome === filters.equipe);
    if (filters.colaborador !== "todos") list = list.filter(c => c.name === filters.colaborador);
    if (filters.produto !== "Todos") {
      const groupMap: Record<string, string> = {
        "Auxilio Acidente": "Elite",
        "Quinquenio": "Quinquenio",
        "Concomitante": "Concomitante",
      };
      const group = groupMap[filters.produto];
      if (group) list = list.filter(c => c.cargo === group);
    }
    return list;
  }, [rawCollaborators, filters]);

  // Segmentação por canal
  const collaboratorsDiscador = useMemo(
    () => collaborators.filter(c => c.classificacaoOperacional?.toLowerCase() !== 'judit'),
    [collaborators]
  );
  const collaboratorsJudit = useMemo(
    () => collaborators.filter(c => c.classificacaoOperacional?.toLowerCase() === 'judit'),
    [collaborators]
  );

  // Totais Discador
  const totalAssinadosDiscador = useMemo(
    () => collaboratorsDiscador.reduce((sum, c) => sum + (c.assinados || 0), 0),
    [collaboratorsDiscador]
  );
  const metaMensalDiscador = useMemo(
    () => collaboratorsDiscador.reduce((sum, c) => sum + (c.metaMensalAssinados || 0), 0),
    [collaboratorsDiscador]
  );

  // Totais Judit
  const totalAssinadosJudit = useMemo(
    () => collaboratorsJudit.reduce((sum, c) => sum + (c.assinados || 0), 0),
    [collaboratorsJudit]
  );
  const metaMensalJudit = useMemo(
    () => collaboratorsJudit.reduce((sum, c) => sum + (c.metaMensalAssinados || 0), 0),
    [collaboratorsJudit]
  );

  // Totais gerais
  const totalAssinados = rawMetrics.assinados;
  const totalProtocolados = rawMetrics.protocolados;
  const totalGanhos = rawMetrics.ganhos;
  const totalEmitidos = rawMetrics.emitidos;
  const totalPerdidos = rawMetrics.perdidos;

  // Conversão geral: Assinados / Leads
  const conversaoGeral = totalLeads > 0 ? (totalAssinados / totalLeads) * 100 : 0;

  const periodoSelecionado = { inicio: currentStartDate, fim: currentEndDate };
  const diasUteisPeriodoSelecionado = useMemo(() => contarDiasUteis(periodoSelecionado), [periodoSelecionado]);
  const mesPeriodo = useMemo(() => getPeriodoMesDoCalendario(currentStartDate), [currentStartDate]);
  const diasUteisTotaisMes = useMemo(() => contarDiasUteis(mesPeriodo), [mesPeriodo]);
  const hoje = new Date().toISOString().slice(0, 10);
  const diasUteisDecorridos = useMemo(() => contarDiasUteis({ inicio: mesPeriodo.inicio, fim: hoje }), [mesPeriodo, hoje]);

  // Pace (sem classificação de status)
  const paceDiscador = calcularPaceProjecao(totalAssinadosDiscador, metaMensalDiscador, diasUteisDecorridos, diasUteisTotaisMes);
  const paceJudit = calcularPaceProjecao(totalAssinadosJudit, metaMensalJudit, diasUteisDecorridos, diasUteisTotaisMes);

  const produtividadeMedia = useMemo(() => {
    const ativos = collaborators.filter(c => !ehSupervisor(c.name) && c.status === 'ativo');
    if (ativos.length === 0 || diasUteisPeriodoSelecionado === 0) return 0;
    return totalAssinados / ativos.length / diasUteisPeriodoSelecionado;
  }, [collaborators, totalAssinados, diasUteisPeriodoSelecionado]);

  const melhor = useMemo(() => {
    let best: Collaborator | null = null;
    let maxAss = -1;
    for (const c of collaborators) {
      if (c.assinados > maxAss) { maxAss = c.assinados; best = c; }
    }
    return best;
  }, [collaborators]);

  const precisaAtencao = useMemo(() => {
    let pior: Collaborator | null = null;
    let minAss = Infinity;
    for (const c of collaborators) {
      if (c.assinados < minAss) { minAss = c.assinados; pior = c; }
    }
    return pior;
  }, [collaborators]);

  // Dados para o gráfico de equipes
  const times = useMemo(() => Array.from(new Set(collaborators.map(c => c.equipeNome))), [collaborators]);
  const porTime = useMemo(() =>
    times.map(time => {
      const membros = collaborators.filter(c => c.equipeNome === time);
      const ass = membros.reduce((s, c) => s + c.assinados, 0);
      const prot = membros.reduce((s, c) => s + c.protocolados, 0);
      return { time, pessoas: membros.length, assinados: ass, protocolados: prot, taxa: ass ? (prot / ass) * 100 : 0 };
    }).sort((a, b) => b.assinados - a.assinados), [times, collaborators]);

  const dadosEquipes = useMemo(
    () => porTime.map(t => ({ nome: t.time.replace('Equipe ', ''), assinados: t.assinados })),
    [porTime]
  );

  const equipeSelecionada = filters.equipe !== "todas";

  const atingimentoMetaPeriodo = metaMensalDiscador > 0 ? (totalAssinadosDiscador / metaMensalDiscador) * 100 : 0;

  // Funil com Leads e ordem correta
  const funnelStages = useMemo(() => [
    { stage: "Leads", count: totalLeads, color: "#3b82f6", icon: Users },
    { stage: "Emitidos", count: rawMetrics.emitidos, color: "#09175b", icon: FileText },
    { stage: "Assinados", count: rawMetrics.assinados, color: "#34a853", icon: CheckCircle },
    { stage: "Ganhos", count: rawMetrics.ganhos, color: "#f59e0b", icon: DollarSign },
    { stage: "Protocolados", count: rawMetrics.protocolados, color: "#045b5b", icon: Archive },
    { stage: "Perdidos", count: rawMetrics.perdidos, color: "#ef4444", icon: XCircle },
  ], [rawMetrics, totalLeads]);

  return (
    <DashboardLayout title="Visão Geral" subtitle={`Panorama executivo da operação comercial — Período ${period}`}>
      <FilterBar
        onFilterChange={handleFilterChange}
        showColaboradorFilter
        className="mb-6"
        onRefresh={handleRefresh}
      />

      {loading && (
        <div className="flex justify-center items-center py-4">
          <Loader2 className="w-5 h-5 animate-spin text-[#09175b]" />
          <span className="ml-2 text-sm text-gray-500">Carregando dados...</span>
        </div>
      )}

      {!loading && rawCollaborators.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-center text-amber-800 text-sm">
          Nenhum colaborador disponível no momento.
        </div>
      )}

      {!loading && rawCollaborators.length > 0 && (
        <>
          {/* Cards de resumo: Discador e Judit (sem statusPace) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <ResumoMesCard
              titulo="Discador · Assinados"
              icon={FileSignature}
              atual={totalAssinadosDiscador}
              meta={metaMensalDiscador}
              pace={paceDiscador}
              onClick={() => setModalAberto('discador')}
            />
            {collaboratorsJudit.length > 0 && (
              <ResumoMesCard
                titulo="Judit · Assinados"
                icon={FileSignature}
                atual={totalAssinadosJudit}
                meta={metaMensalJudit}
                pace={paceJudit}
                onClick={() => setModalAberto('judit')}
              />
            )}
          </div>

          {/* Modais */}
          {modalAberto === 'discador' && (
            <DetalheAssinadosModal
              titulo="Discador · Assinados"
              colaboradores={collaboratorsDiscador}
              atual={totalAssinadosDiscador}
              onFechar={() => setModalAberto(null)}
            />
          )}
          {modalAberto === 'judit' && (
            <DetalheAssinadosModal
              titulo="Judit · Assinados"
              colaboradores={collaboratorsJudit}
              atual={totalAssinadosJudit}
              onFechar={() => setModalAberto(null)}
            />
          )}

          {/* KPIs principais */}
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4 mb-6">
            <KpiCard titulo="Leads" valor={formatNumero(totalLeads)} icon={Users} accent="info" />
            <KpiCard titulo="Venda Ganha" valor={formatNumero(totalGanhos)} icon={Award} accent="brand" />
            <KpiCard titulo="Protocolados" valor={formatNumero(totalProtocolados)} icon={FileCheck2} accent="success" />
            <KpiCard titulo="Conversão Geral" valor={formatPct(conversaoGeral)} icon={Percent} accent="brand" />
            <KpiCard titulo="Perdidos" valor={formatNumero(totalPerdidos)} icon={XCircle} accent="danger" />
          </div>

          {/* Resumo textual (Discador) */}
          <Card className="mb-6 p-4">
            <p className="text-sm font-semibold text-slate-900">
              No período, a equipe Discador assinou {formatNumero(totalAssinadosDiscador)} e protocolou {formatNumero(totalProtocolados)}
            </p>
            <p className="mt-1 text-[13px] text-slate-600">
              Isso representa {formatPct(atingimentoMetaPeriodo, 1)} da meta mensal de assinados.
            </p>
          </Card>

          {/* Desempenho (gráfico de equipes ou radar) */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
            <Card className="xl:col-span-2">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">
                {equipeSelecionada ? `Desempenho · ${filters.equipe}` : "Desempenho das Equipes"}
              </h3>
              {equipeSelecionada ? (
                <RadarConversaoLigacoes colaboradores={collaborators.filter(c => !ehSupervisor(c.name) && c.status === 'ativo')} />
              ) : (
                <DesempenhoEquipes dados={dadosEquipes} />
              )}
            </Card>
            <Card>
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Funil Comercial</h3>
              <FunilChart etapas={funnelStages.map(s => ({ ...s, count: s.count }))} />
            </Card>
          </div>

          {/* Melhor, pior, produtividade */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
            <Card className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400"><Trophy size={18} /></div>
              <div className="min-w-0">
                <p className="text-[11px] text-slate-500">Melhor colaborador</p>
                {melhor ? <Link to={`/colaboradores/${melhor.id}`} className="text-sm font-semibold text-slate-900 hover:underline truncate block">{melhor.name}</Link> : <p className="text-sm text-slate-500">—</p>}
              </div>
            </Card>
            <Card className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/10 text-red-400"><UserX size={18} /></div>
              <div className="min-w-0">
                <p className="text-[11px] text-slate-500">Precisa de atenção</p>
                {precisaAtencao ? <Link to={`/colaboradores/${precisaAtencao.id}`} className="text-sm font-semibold text-slate-900 hover:underline truncate block">{precisaAtencao.name}</Link> : <p className="text-sm text-slate-500">—</p>}
              </div>
            </Card>
            <Card className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600"><Gauge size={18} /></div>
              <div className="min-w-0">
                <p className="text-[11px] text-slate-500">Produtividade média</p>
                <p className="text-sm font-semibold text-slate-900">{produtividadeMedia.toFixed(1)} assinados/dia por colaborador</p>
              </div>
            </Card>
          </div>

          {/* Comparativo por time */}
          <div className="mt-6">
            <Card className="xl:col-span-2">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Comparativo por time</h3>
              <div className="space-y-2">
                {porTime.map(t => (
                  <Link key={t.time} to={`/equipe/${encodeURIComponent(t.time)}`} className="flex items-center justify-between rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 hover:bg-slate-100 transition-colors">
                    <span className="text-[13px] font-medium text-slate-700">{t.time} <span className="text-slate-400 font-normal">· {t.pessoas} pessoas</span></span>
                    <span className="text-[13px] text-slate-400 text-center">{formatNumero(t.assinados)} assinados</span>
                    <span className="text-[13px] font-semibold text-slate-900">{formatPct(t.taxa)}</span>
                  </Link>
                ))}
                {porTime.length === 0 && <p className="text-sm text-slate-500">Nenhum time encontrado com os filtros atuais.</p>}
              </div>
            </Card>
          </div>

          {/* Plano de Ação 
          <div className="mt-6">
            <PlanoAcaoColaboradores
              colaboradores={collaborators}
              diasUteisPeriodo={diasUteisPeriodoSelecionado}
            />
          </div>*/}
        </>
      )}
    </DashboardLayout>
  );
}