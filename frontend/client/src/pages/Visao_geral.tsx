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
import { fetchLeadsRecebidos, fetchLigacoesProdutivas } from "@/lib/api";

// ========== CONSTANTES DE EXCLUSÃO ==========
const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing',
   'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda',
  'Equipe Reciclagem','','Equipe','Equipe Camila','Sales Ops', 'Departamento Comercial',
  'Equipe Gabriela Toledo','Equipe Treinamento', 'Equipe lucilene'
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

// Função para identificar supervisores pelo cargo
const isSupervisor = (c: Collaborator) => {
  const cargo = normalize(c.cargo);
  return cargo === 'supervisor' || cargo === 'supervisora' || cargo.includes('supervisor');
};

// ============================================================
//  META GLOBAL E HELPERS POR PERÍODO
// ============================================================
const GLOBAL_META = {
  diario: { ganhos: 65 },
  semanal: { ganhos: 325 },
  mensal: { ganhos: 1300 },
};

type PeriodKey = 'diario' | 'semanal' | 'mensal';

/**
 * Lê a meta de ganhos do colaborador no PERÍODO informado.
 * Prefere os campos históricos do banco (`peso*Ganhos`) e cai para
 * `meta*Ganhos`. NÃO usa fallback fictício: se o campo não existir,
 * retorna 0 — assim a soma bate com o SQL.
 */
function getMetaGanhosPeriodo(colab: any, periodKey: PeriodKey): number {
  const pesoKey =
    periodKey === 'diario' ? 'pesoDiarioGanhos'
    : periodKey === 'semanal' ? 'pesoSemanalGanhos'
    : 'pesoMensalGanhos';
  const metaKey =
    periodKey === 'diario' ? 'metaDiarioGanhos'
    : periodKey === 'semanal' ? 'metaSemanalGanhos'
    : 'metaMensalGanhos';

  const peso = Number(colab?.[pesoKey]);
  if (Number.isFinite(peso) && peso > 0) return peso;
  const meta = Number(colab?.[metaKey]);
  if (Number.isFinite(meta) && meta > 0) return meta;

  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(`[VisaoGeral] Meta ${periodKey} ausente para`, colab?.name, colab);
  }
  return 0;
}

// Dedup por id (fallback name) — evita somar o mesmo colaborador N vezes
// caso o backend traga linhas repetidas.
function dedupeCollaborators(list: Collaborator[]): Collaborator[] {
  const seen = new Map<string, Collaborator>();
  for (const c of list) {
    const key = String((c as any).id ?? c.name);
    if (!seen.has(key)) seen.set(key, c);
  }
  return Array.from(seen.values());
}

// Leitura robusta da classificação operacional (aceita camelCase e snake_case).
function getClassificacao(c: Collaborator): string {
  const raw = (c as any).classificacaoOperacional ?? (c as any).classificacao_operacional ?? '';
  return String(raw).trim().toLowerCase();
}

// Localiza o colaborador selecionado no filtro (id ou nome).
function findSelectedCollaborator(
  collaborators: Collaborator[],
  filters: { colaboradorId?: string | number; colaborador?: string }
): Collaborator | null {
  if (filters.colaboradorId != null) {
    const byId = collaborators.find(c => String(c.id) === String(filters.colaboradorId));
    if (byId) return byId;
  }
  if (filters.colaborador && filters.colaborador !== "todos") {
    return collaborators.find(c => c.name === filters.colaborador) ?? null;
  }
  return null;
}

// ========== RADAR DE CONVERSÃO (colaboradores individuais) ==========
function RadarConversaoLigacoes({ colaboradores }: { colaboradores: Collaborator[] }) {
  const dados = colaboradores.map((colab) => ({
    name: colab.name,
    value: Math.max(0, Math.min(100, (colab.ganhos || 0) * 10)),
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
  ganhos: number;
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
          <Tooltip formatter={(v) => [formatNumero(Number(v)), 'Ganhos']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          <Bar dataKey="ganhos" radius={[4, 4, 0, 0]} barSize={32}>
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
  const [totalLigacoesProdutivas, setTotalLigacoesProdutivas] = useState(0);

  const lastFetchLeads = useRef<number>(0);
  const LEADS_CACHE_TTL = 60000;
  const isFetching = useRef(false);

  // ============================================================
  //  DETECÇÃO DE SUPERVISOR SELECIONADO
  // ============================================================
  const selectedCollaborator = useMemo(
    () => findSelectedCollaborator(rawCollaborators, filters),
    [rawCollaborators, filters.colaborador, filters.colaboradorId]
  );
  const isSupervisorSelected = !!selectedCollaborator && isSupervisor(selectedCollaborator);
  const supervisorSelectedTeam = isSupervisorSelected ? (selectedCollaborator?.equipeNome || '') : '';

  // Monta os parâmetros de API aplicando a regra do supervisor
  const getEffectiveFilterParams = useCallback(() => {
    let equipeApi = filters.equipe === "todas" ? undefined : filters.equipe;
    let colaboradorApi = filters.colaborador === "todos" ? undefined : filters.colaborador;
    let colaboradorIdApi = filters.colaboradorId;

    if (isSupervisorSelected && selectedCollaborator) {
      equipeApi = selectedCollaborator.equipeNome || equipeApi;
      colaboradorApi = undefined;
      colaboradorIdApi = undefined;
    }

    const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;
    return { equipeApi, colaboradorApi, colaboradorIdApi, produtoApi };
  }, [filters, isSupervisorSelected, selectedCollaborator]);

  // -----------------------------------------------------------
  //  RESETAR cache de leads sempre que período ou filtros mudarem
  // -----------------------------------------------------------
  useEffect(() => {
    setTotalLeads(0);
    setTotalLigacoesProdutivas(0);
    lastFetchLeads.current = 0;
  }, [currentStartDate, currentEndDate, filters]);

  // Busca leads totais do período
  const fetchLeadsData = useCallback(async () => {
    if (!currentStartDate || !currentEndDate) return;
    const now = Date.now();
    if (lastFetchLeads.current > 0 && (now - lastFetchLeads.current) < LEADS_CACHE_TTL) return;

    try {
      const { equipeApi, colaboradorApi, produtoApi } = getEffectiveFilterParams();
      const params = {
        start: currentStartDate,
        end: currentEndDate,
        equipe: equipeApi,
        colaborador: colaboradorApi,
        produto: produtoApi,
      };
      const [leadsData, ligacoesProdutivas] = await Promise.all([
        fetchLeadsRecebidos(params),
        fetchLigacoesProdutivas(params),
      ]);
      const total = leadsData.reduce((sum: number, item: any) => sum + (Number(item.total) || 0), 0);
      setTotalLeads(total);
      setTotalLigacoesProdutivas(ligacoesProdutivas);
      lastFetchLeads.current = Date.now();
    } catch (err) {
      console.error("Erro ao buscar leads:", err);
    }
  }, [currentStartDate, currentEndDate, getEffectiveFilterParams]);

  // Função principal de carregamento
  const fetchData = useCallback(async (showRefreshing = false) => {
    if (!currentStartDate || !currentEndDate) return;
    if (showRefreshing) setRefreshing(true);
    try {
      const { equipeApi, colaboradorApi, colaboradorIdApi, produtoApi } = getEffectiveFilterParams();

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
  }, [getEffectiveFilterParams, currentStartDate, currentEndDate, rawCollaborators.length, loadCollaborators, loadMetricsForPeriod, loadRawMetrics, fetchLeadsData]);

  const handleRefresh = useCallback(async () => {
    await fetchData(true);
  }, [fetchData]);

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

  // ============================================================
  //  BASE ÚNICA (SEM DUPLICATAS)
  // ============================================================
  const uniqueCollaborators = useMemo(
    () => dedupeCollaborators(rawCollaborators),
    [rawCollaborators]
  );

  // ============================================================
  //  FILTRO DE COLABORADORES
  //  - Supervisor selecionado → equipe dele.
  //  - Produto = "Auxilio Acidente" → classificacao_operacional = 'Discador'
  //    (alinhado ao SQL).
  // ============================================================
  const collaborators = useMemo(() => {
    let list = uniqueCollaborators.filter(c => !isDesativado(c));

    if (isSupervisorSelected && supervisorSelectedTeam) {
      return list.filter(c => normalize(c.equipeNome) === normalize(supervisorSelectedTeam));
    }

    // Se uma equipe específica for selecionada, NÃO aplica exclusões globais
    if (filters.equipe === "todas") {
      list = list.filter(
        c => !isExcludedTeam(c.equipeNome) && !isExcludedCargo(c.cargo)
      );
    }

    if (filters.equipe !== "todas") {
      const equipeNormalizada = normalize(filters.equipe);
      list = list.filter(c => normalize(c.equipeNome) === equipeNormalizada);
    }

    if (filters.colaborador !== "todos") {
      const colaboradorNormalizado = normalize(filters.colaborador);
      list = list.filter(c => normalize(c.name) === colaboradorNormalizado);
    }

    // Filtro de produto alinhado ao SQL (classificacao_operacional)
    if (filters.produto !== "Todos") {
      if (filters.produto === "Auxilio Acidente") {
        list = list.filter(c => getClassificacao(c) === 'discador');
      } else if (filters.produto === "Quinquenio") {
        list = list.filter(c => c.cargo === "Quinquenio");
      } else if (filters.produto === "Concomitante") {
        list = list.filter(c => c.cargo === "Concomitante");
      }
    }

    return list;
  }, [uniqueCollaborators, filters, isSupervisorSelected, supervisorSelectedTeam]);

  // Segmentação estrita por classificação (bate com o SQL)
  const collaboratorsDiscador = useMemo(
    () => collaborators.filter(c => getClassificacao(c) === 'discador'),
    [collaborators]
  );
  const collaboratorsJudit = useMemo(
    () => collaborators.filter(c => getClassificacao(c) === 'judit'),
    [collaborators]
  );

  // Totais Discador — ganhos
  const totalGanhosDiscador = useMemo(
    () => collaboratorsDiscador.reduce((sum, c) => sum + (c.ganhos || 0), 0),
    [collaboratorsDiscador]
  );

  // Totais Judit — ganhos
  const totalGanhosJudit = useMemo(
    () => collaboratorsJudit.reduce((sum, c) => sum + (c.ganhos || 0), 0),
    [collaboratorsJudit]
  );

  // Totais gerais
  const totalAssinados = rawMetrics.assinados;
  const totalProtocolados = rawMetrics.protocolados;
  const totalGanhos = rawMetrics.ganhos;
  const totalEmitidos = rawMetrics.emitidos;
  const totalPerdidos = rawMetrics.perdidos;

  // Conversão geral: Assinados / (ligações produtivas + recebidos)
  const totalContatosConversao = totalLigacoesProdutivas + totalLeads;
  const conversaoGeral = totalContatosConversao > 0 ? (totalAssinados / totalContatosConversao) * 100 : 0;

  const periodoSelecionado = { inicio: currentStartDate, fim: currentEndDate };
  const diasUteisPeriodoSelecionado = useMemo(() => contarDiasUteis(periodoSelecionado), [periodoSelecionado]);
  const mesPeriodo = useMemo(() => getPeriodoMesDoCalendario(currentStartDate), [currentStartDate]);
  const diasUteisTotaisMes = useMemo(() => contarDiasUteis(mesPeriodo), [mesPeriodo]);
  const hoje = new Date().toISOString().slice(0, 10);
  const diasUteisDecorridos = useMemo(() => contarDiasUteis({ inicio: mesPeriodo.inicio, fim: hoje }), [mesPeriodo, hoje]);

  // ============================================================
  //  PERÍODO, VISÃO GLOBAL E METAS
  // ============================================================
  const periodKey: PeriodKey =
    period === 'Hoje' ? 'diario' : period === 'Semana' ? 'semanal' : 'mensal';

  const isGlobalView =
    filters.equipe === "todas" &&
    filters.colaborador === "todos" &&
    filters.produto === "Todos" &&
    !isSupervisorSelected;

  // Metas por canal — period-aware, sem fallback fictício
  const metaGanhosDiscador = useMemo(
    () => collaboratorsDiscador.reduce((sum, c) => sum + getMetaGanhosPeriodo(c, periodKey), 0),
    [collaboratorsDiscador, periodKey]
  );
  const metaGanhosJudit = useMemo(
    () => collaboratorsJudit.reduce((sum, c) => sum + getMetaGanhosPeriodo(c, periodKey), 0),
    [collaboratorsJudit, periodKey]
  );

  // Meta EFETIVA — GLOBAL_META quando sem filtro, senão soma filtrada
  const metaGanhosEfetiva = useMemo(() => {
    if (isGlobalView) return GLOBAL_META[periodKey].ganhos;
    return metaGanhosDiscador + metaGanhosJudit;
  }, [isGlobalView, periodKey, metaGanhosDiscador, metaGanhosJudit]);

  // ← DIAGNÓSTICO (só em dev): bate o front com o SQL.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const somaPesoMensalDiscador = collaboratorsDiscador.reduce(
      (s, c) => s + (Number((c as any).pesoMensalGanhos) || 0), 0
    );
    const somaPesoMensalJudit = collaboratorsJudit.reduce(
      (s, c) => s + (Number((c as any).pesoMensalGanhos) || 0), 0
    );
    // eslint-disable-next-line no-console
    console.table({
      period, periodKey, isGlobalView,
      "Discador.count": collaboratorsDiscador.length,
      "Judit.count": collaboratorsJudit.length,
      "metaGanhosDiscador (card)": metaGanhosDiscador,
      "soma pesoMensalGanhos Discador": somaPesoMensalDiscador,
      "metaGanhosJudit (card)": metaGanhosJudit,
      "soma pesoMensalGanhos Judit": somaPesoMensalJudit,
      metaGanhosEfetiva,
    });
  }, [period, periodKey, isGlobalView, collaboratorsDiscador, collaboratorsJudit, metaGanhosDiscador, metaGanhosJudit, metaGanhosEfetiva]);

  // Pace agora calculado sobre GANHOS e meta por canal
  const paceDiscador = calcularPaceProjecao(totalGanhosDiscador, metaGanhosDiscador, diasUteisDecorridos, diasUteisTotaisMes);
  const paceJudit = calcularPaceProjecao(totalGanhosJudit, metaGanhosJudit, diasUteisDecorridos, diasUteisTotaisMes);

  // Produtividade agora sobre GANHOS
  const produtividadeMedia = useMemo(() => {
    const ativos = collaborators.filter(c => !ehSupervisor(c.name) && c.status === 'ativo');
    if (ativos.length === 0 || diasUteisPeriodoSelecionado === 0) return 0;
    return totalGanhos / ativos.length / diasUteisPeriodoSelecionado;
  }, [collaborators, totalGanhos, diasUteisPeriodoSelecionado]);

  // Melhor / precisa atenção
  const melhor = useMemo(() => {
    let best: Collaborator | null = null;
    let maxGanhos = -1;
    for (const c of collaborators) {
      if ((c.ganhos || 0) > maxGanhos) { maxGanhos = c.ganhos || 0; best = c; }
    }
    return best;
  }, [collaborators]);

  const precisaAtencao = useMemo(() => {
    let pior: Collaborator | null = null;
    let minGanhos = Infinity;
    for (const c of collaborators) {
      if ((c.ganhos || 0) < minGanhos) { minGanhos = c.ganhos || 0; pior = c; }
    }
    return pior;
  }, [collaborators]);

  // Dados para o gráfico de equipes
  const times = useMemo(() => Array.from(new Set(collaborators.map(c => c.equipeNome))), [collaborators]);
  const porTime = useMemo(() =>
    times.map(time => {
      const membros = collaborators.filter(c => c.equipeNome === time);
      const gan = membros.reduce((s, c) => s + (c.ganhos || 0), 0);
      const prot = membros.reduce((s, c) => s + c.protocolados, 0);
      return { time, pessoas: membros.length, ganhos: gan, protocolados: prot, taxa: gan ? (prot / gan) * 100 : 0 };
    }).sort((a, b) => b.ganhos - a.ganhos), [times, collaborators]);

  const dadosEquipes = useMemo(
    () => porTime.map(t => ({ nome: t.time.replace('Equipe ', ''), ganhos: t.ganhos })),
    [porTime]
  );

  const equipeSelecionada = filters.equipe !== "todas";
  const isIndividualFilter = filters.colaborador !== "todos" && !isSupervisorSelected;

  // Atingimento usa a meta efetiva (global ou somada) sobre os ganhos totais
  const atingimentoMetaPeriodo = metaGanhosEfetiva > 0
    ? (totalGanhos / metaGanhosEfetiva) * 100
    : 0;

  // Funil
  const funnelStages = useMemo(() => [
    { stage: "Leads", count: totalLeads, color: "#3b82f6", icon: Users },
    { stage: "Emitidos", count: rawMetrics.emitidos, color: "#09175b", icon: FileText },
    { stage: "Assinados", count: rawMetrics.assinados, color: "#34a853", icon: CheckCircle },
    { stage: "Ganhos", count: rawMetrics.ganhos, color: "#f59e0b", icon: DollarSign },
    { stage: "Protocolados", count: rawMetrics.protocolados, color: "#045b5b", icon: Archive },
    { stage: "Perdidos", count: rawMetrics.perdidos, color: "#ef4444", icon: XCircle },
  ], [rawMetrics, totalLeads]);

  const hasActiveFilters =
    filters.equipe !== "todas" ||
    filters.colaborador !== "todos" ||
    filters.produto !== "Todos";

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
          {hasActiveFilters && (
            <div className="mb-4 px-4 py-2 bg-blue-50 rounded-lg text-xs text-blue-700 flex items-center gap-2 flex-wrap">
              <span>📊</span>
              <span>
                Mostrando dados para:
                {filters.equipe !== "todas" && ` Equipe ${filters.equipe}`}
                {filters.colaborador !== "todos" && !isSupervisorSelected && ` - ${filters.colaborador}`}
                {isSupervisorSelected && supervisorSelectedTeam && (
                  <> - Equipe <b>{supervisorSelectedTeam}</b> (agregado)</>
                )}
                {filters.produto !== "Todos" && ` • Produto: ${filters.produto}`}
              </span>
            </div>
          )}

          {/* Cards de resumo: Discador e Judit — metas period-aware */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <ResumoMesCard
              titulo="Discador · Ganhos"
              icon={FileSignature}
              atual={totalGanhosDiscador}
              meta={metaGanhosDiscador}
              pace={paceDiscador}
              onClick={() => setModalAberto('discador')}
            />
            {collaboratorsJudit.length > 0 && (
              <ResumoMesCard
                titulo="Judit · Ganhos"
                icon={FileSignature}
                atual={totalGanhosJudit}
                meta={metaGanhosJudit}
                pace={paceJudit}
                onClick={() => setModalAberto('judit')}
              />
            )}
          </div>

          {/* Modais */}
          {modalAberto === 'discador' && (
            <DetalheAssinadosModal
              titulo="Discador · Ganhos"
              colaboradores={collaboratorsDiscador}
              atual={totalGanhosDiscador}
              onFechar={() => setModalAberto(null)}
            />
          )}
          {modalAberto === 'judit' && (
            <DetalheAssinadosModal
              titulo="Judit · Ganhos"
              colaboradores={collaboratorsJudit}
              atual={totalGanhosJudit}
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

          {/* Resumo textual + meta efetiva */}
          <Card className="mb-6 p-4">
            <p className="text-sm font-semibold text-slate-900">
              {isSupervisorSelected && supervisorSelectedTeam
                ? `No período, a equipe ${supervisorSelectedTeam} ganhou ${formatNumero(totalGanhos)} e protocolou ${formatNumero(totalProtocolados)}.`
                : isIndividualFilter
                ? `O colaborador selecionado ganhou ${formatNumero(totalGanhos)} e protocolou ${formatNumero(totalProtocolados)} no período.`
                : `No período, a operação ganhou ${formatNumero(totalGanhos)} e protocolou ${formatNumero(totalProtocolados)}.`}
            </p>
            <p className="mt-1 text-[13px] text-slate-600">
              Isso representa {formatPct(atingimentoMetaPeriodo, 1)} da meta {periodKey === 'diario' ? 'diária' : periodKey === 'semanal' ? 'semanal' : 'mensal'} de ganhos
              {isGlobalView
                ? ` (meta global: ${formatNumero(metaGanhosEfetiva)}).`
                : ` (meta somada: ${formatNumero(metaGanhosEfetiva)}).`}
            </p>
          </Card>

          {/* Desempenho: radar individual ou gráfico de equipes */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
            <Card className="xl:col-span-2">
              <h3 className="text-sm font-semibold text-slate-700 mb-3">
                {equipeSelecionada || isIndividualFilter || isSupervisorSelected
                  ? `Desempenho · ${isSupervisorSelected ? supervisorSelectedTeam : filters.colaborador !== "todos" ? filters.colaborador : filters.equipe}`
                  : "Desempenho das Equipes"}
              </h3>
              {(equipeSelecionada || isIndividualFilter || isSupervisorSelected) ? (
                <RadarConversaoLigacoes
                  colaboradores={collaborators.filter(c => !isSupervisor(c) && c.status !== 'inativo')}
                />
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
                <p className="text-[11px] text-slate-500">Melhor colaborador (ganhos)</p>
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
                <p className="text-sm font-semibold text-slate-900">{produtividadeMedia.toFixed(1)} ganhos/dia por colaborador</p>
              </div>
            </Card>
          </div>

          {/* Comparativo por time */}
          {!isIndividualFilter && (
            <div className="mt-6">
              <Card className="xl:col-span-2">
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Comparativo por time</h3>
                <div className="space-y-2">
                  {porTime.map(t => (
                    <Link key={t.time} to={`/equipe/${encodeURIComponent(t.time)}`} className="flex items-center justify-between rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 hover:bg-slate-100 transition-colors">
                      <span className="text-[13px] font-medium text-slate-700">{t.time} <span className="text-slate-400 font-normal">· {t.pessoas} pessoas</span></span>
                      <span className="text-[13px] text-slate-400 text-center">{formatNumero(t.ganhos)} ganhos</span>
                      <span className="text-[13px] font-semibold text-slate-900">{formatPct(t.taxa)}</span>
                    </Link>
                  ))}
                  {porTime.length === 0 && <p className="text-sm text-slate-500">Nenhum time encontrado com os filtros atuais.</p>}
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
}