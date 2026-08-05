// src/pages/Vgeral.tsx
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
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Award,
  Inbox,
  Percent,
  FileCheck2,
  FileSignature,
  Trophy,
  UserX,
  Gauge,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { KpiCard } from "@/components/kpi/KpiCard";
import { ResumoMesCard } from "@/components/kpi/ResumoMesCard";
import { Card } from "@/components/ui/Card";
import { FunilChart } from "@/components/charts/FunilChart";
import { DetalheAssinadosModal } from "@/components/dashboard/DetalheAssinadosModal";
import { calcularPaceProjecao, classificarPace } from "@/lib/diagnostico";
import { contarDiasUteis, getPeriodoMesDoCalendario } from "@/lib/period";
import { formatNumero, formatPct } from "@/lib/format";
import { ehSupervisor } from "@/lib/colaboradoresAtivos";
import { Link } from "wouter";

// ========== CONSTANTES DE EXCLUSÃO (idênticas ao Funil) ==========
const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro', 'Equipe de Reciclagem'
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

function AlertCard({ alerta }: { alerta: { id: number; prioridade: string; mensagem: string; titulo: string } }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-red-600">{alerta.titulo}</p>
      <p className="mt-1 text-sm text-slate-700">{alerta.mensagem}</p>
    </div>
  );
}

function PlanoAcaoColaboradores({ colaboradores, diasUteisPeriodo }: { colaboradores: Collaborator[]; diasUteisPeriodo: number }) {
  const lista = colaboradores
    .filter((colab) => (colab.assinados || 0) < 2)
    .slice(0, 5);

  return (
    <Card>
      <h3 className="text-sm font-semibold text-slate-700 mb-3">Plano de ação</h3>
      <p className="text-sm text-slate-500 mb-3">Dias úteis no período: {diasUteisPeriodo}</p>
      <div className="space-y-2">
        {lista.length === 0 ? (
          <p className="text-sm text-slate-500">Nenhum ajuste necessário no momento.</p>
        ) : (
          lista.map((colab) => (
            <div key={colab.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
              <div>
                <p className="text-sm font-medium text-slate-900">{colab.name}</p>
                <p className="text-xs text-slate-500">{colab.equipeNome}</p>
              </div>
              <div className="text-sm font-semibold text-amber-600">Acompanhar rotina</div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

export default function Vgeral() {
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

  // ========== CORREÇÃO DE TIPOS ==========
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
  const [modalAberto, setModalAberto] = useState<"geral" | null>(null);
  const initialLoadDone = useRef(false);

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
    } catch (err) {
      console.error("Erro ao carregar dados da Visão Geral:", err);
    } finally {
      if (showRefreshing) setRefreshing(false);
      setLoading(false);
    }
  }, [filters, currentStartDate, currentEndDate, rawCollaborators.length, loadCollaborators, loadMetricsForPeriod, loadRawMetrics]);

  useEffect(() => {
    if (initialLoadDone.current) return;

    initialLoadDone.current = true;
    setLoading(true);
    void fetchData();
  }, [fetchData]);

  // ========== handleFilterChange tipado corretamente ==========
  const handleFilterChange = (newFilters: typeof filters) => {
    setFilters(newFilters);
  };

  // Colaboradores ativos após exclusões (idêntico ao Funil)
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

  // Totais do funil (derivados de rawMetrics)
  const funnelStages = useMemo(() => [
    { stage: "Emitidos", count: rawMetrics.emitidos, color: "#09175b", icon: FileText },
    { stage: "Assinados", count: rawMetrics.assinados, color: "#34a853", icon: CheckCircle },
    { stage: "Protocolados", count: rawMetrics.protocolados, color: "#045b5b", icon: Archive },
    { stage: "Ganhos", count: rawMetrics.ganhos, color: "#f59e0b", icon: DollarSign },
    { stage: "Perdidos", count: rawMetrics.perdidos, color: "#ef4444", icon: XCircle },
  ], [rawMetrics]);

  const totalAssinados = rawMetrics.assinados;
  const totalProtocolados = rawMetrics.protocolados;
  const totalGanhos = rawMetrics.ganhos;
  const totalRecebidos = rawMetrics.emitidos;
  const conversaoGeral = totalRecebidos > 0 ? (totalAssinados / totalRecebidos) * 100 : 0;

  const metaMensalTotal = useMemo(
    () => collaborators.reduce((sum, c) => sum + (c.metaMensalAssinados || 0), 0),
    [collaborators]
  );

  const periodoSelecionado = { inicio: currentStartDate, fim: currentEndDate };
  const diasUteisPeriodoSelecionado = useMemo(() => contarDiasUteis(periodoSelecionado), [periodoSelecionado]);
  const mesPeriodo = useMemo(() => getPeriodoMesDoCalendario(currentStartDate), [currentStartDate]);
  const diasUteisTotaisMes = useMemo(() => contarDiasUteis(mesPeriodo), [mesPeriodo]);
  const hoje = new Date().toISOString().slice(0, 10);
  const diasUteisDecorridos = useMemo(() => contarDiasUteis({ inicio: mesPeriodo.inicio, fim: hoje }), [mesPeriodo, hoje]);

  const paceEquipe = calcularPaceProjecao(totalAssinados, metaMensalTotal, diasUteisDecorridos, diasUteisTotaisMes);
  const statusPace = classificarPace(paceEquipe, metaMensalTotal);

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

  const times = useMemo(() => Array.from(new Set(collaborators.map(c => c.equipeNome))), [collaborators]);
  const porTime = useMemo(() =>
    times.map(time => {
      const membros = collaborators.filter(c => c.equipeNome === time);
      const ass = membros.reduce((s, c) => s + c.assinados, 0);
      const prot = membros.reduce((s, c) => s + c.protocolados, 0);
      return { time, pessoas: membros.length, assinados: ass, protocolados: prot, taxa: ass ? (prot / ass) * 100 : 0 };
    }), [times, collaborators]);

  const alertas = useMemo(() => {
    const lista: { id: number; prioridade: string; mensagem: string; titulo: string }[] = [];
    if (conversaoGeral < 50 && totalRecebidos > 0) {
      lista.push({ id: 1, prioridade: 'critico', mensagem: `Conversão geral de ${formatPct(conversaoGeral, 1)} está abaixo do esperado.`, titulo: 'Baixa conversão' });
    }
    if (totalAssinados === 0 && totalRecebidos > 0) {
      lista.push({ id: 2, prioridade: 'critico', mensagem: 'Nenhum assinado no período, apesar de haver leads recebidos.', titulo: 'Sem conversão' });
    }
    return lista;
  }, [conversaoGeral, totalAssinados, totalRecebidos]);

  const alertasCriticos = alertas.filter(a => a.prioridade === 'critico').slice(0, 2);
  const atingimentoMetaPeriodo = metaMensalTotal > 0 ? (totalAssinados / metaMensalTotal) * 100 : 0;
  const metaComprometida = atingimentoMetaPeriodo < 90;

  return (
    <DashboardLayout title="Visão Geral" subtitle={`Panorama executivo da operação comercial — Período ${period}`}>
      <FilterBar onFilterChange={handleFilterChange} showColaboradorFilter className="mb-6" />

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

      {!loading && rawCollaborators.length > 0 && (
        <>
          <div className="flex items-center justify-end gap-2 mb-2">
            {refreshing && (
              <div className="flex items-center gap-1.5 text-xs text-gray-500 animate-pulse">
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Atualizando dados...</span>
              </div>
            )}
            <span className="text-[10px] text-gray-400">Atualizado {new Date().toLocaleTimeString()}</span>
            <button onClick={() => fetchData(true)} disabled={refreshing} className="ml-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#09175b] text-white hover:bg-[#09175b]/90 disabled:opacity-50 transition-colors">
              <RefreshCw className={cn("w-3.5 h-3.5 inline mr-1", refreshing && "animate-spin")} />
              Atualizar
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <ResumoMesCard titulo="Geral · Assinados" icon={FileSignature} atual={totalAssinados} meta={metaMensalTotal} pace={paceEquipe} statusPace={statusPace} onClick={() => setModalAberto('geral')} />
          </div>

          {modalAberto === 'geral' && (
            <DetalheAssinadosModal titulo="Geral · Assinados" colaboradores={collaborators} atual={totalAssinados} onFechar={() => setModalAberto(null)} />
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-4 mb-6">
            <KpiCard titulo="Venda Ganha" valor={formatNumero(totalGanhos)} icon={Award} accent="brand" />
            <KpiCard titulo="Recebidos" valor={formatNumero(totalRecebidos)} icon={Inbox} accent="info" />
            <KpiCard titulo="Protocolados" valor={formatNumero(totalProtocolados)} icon={FileCheck2} accent="success" />
            <KpiCard titulo="Conversão Geral" valor={formatPct(conversaoGeral)} icon={Percent} accent="brand" />
            <KpiCard titulo="Perdidos" valor={formatNumero(rawMetrics.perdidos)} icon={XCircle} accent="danger" />
          </div>

          <Card className="mb-6 flex items-start gap-3" style={{ borderLeft: `3px solid ${metaComprometida ? '#ef4444' : '#22c55e'}` }}>
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: metaComprometida ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', color: metaComprometida ? '#ef4444' : '#22c55e' }}>
              {metaComprometida ? <AlertTriangle size={17} /> : <TrendingUp size={17} />}
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900">No período, a equipe assinou {formatNumero(totalAssinados)} e protocolou {formatNumero(totalProtocolados)}</p>
              <p className="mt-1 text-[13px] text-slate-600">
                {metaComprometida
                  ? `Isso representa apenas ${formatPct(atingimentoMetaPeriodo, 1)} da meta mensal de assinados — abaixo do esperado.`
                  : `Isso representa ${formatPct(atingimentoMetaPeriodo, 1)} da meta mensal de assinados — dentro do esperado.`}
              </p>
            </div>
          </Card>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
            <Card className="xl:col-span-2">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Desempenho da Equipe</h3>
              <RadarConversaoLigacoes colaboradores={collaborators.filter(c => !ehSupervisor(c.name) && c.status === 'ativo')} />
            </Card>
            <Card>
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Funil Comercial</h3>
              <FunilChart etapas={funnelStages.map(s => ({ ...s, count: s.count }))} />
            </Card>
          </div>

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

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <Card className="xl:col-span-2">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">Comparativo por time</h3>
              <div className="space-y-2">
                {porTime.map(t => (
                  <Link key={t.time} to={`/equipe/${encodeURIComponent(t.time)}`} className="flex items-center justify-between rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 hover:bg-slate-100 transition-colors">
                    <span className="text-[13px] font-medium text-slate-700">{t.time} <span className="text-slate-400 font-normal">· {t.pessoas} pessoas</span></span>
                    <span className="text-[13px] text-slate-600">{formatNumero(t.protocolados)} protocolados</span>
                    <span className="text-[13px] font-semibold text-slate-900">{formatPct(t.taxa)}</span>
                  </Link>
                ))}
                {porTime.length === 0 && <p className="text-sm text-slate-500">Nenhum time encontrado com os filtros atuais.</p>}
              </div>
            </Card>
            <Card>
              <div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold text-slate-700">Alertas críticos</h3></div>
              {alertasCriticos.length > 0 ? (
                <div className="space-y-3">{alertasCriticos.map(a => <AlertCard key={a.id} alerta={a} />)}</div>
              ) : (
                <p className="text-sm text-slate-500">Nenhum alerta crítico no período. Equipe operando dentro do esperado.</p>
              )}
            </Card>
          </div>

          <div className="mt-6">
            <PlanoAcaoColaboradores colaboradores={collaborators} diasUteisPeriodo={diasUteisPeriodoSelecionado} />
          </div>
        </>
      )}
    </DashboardLayout>
  );
}