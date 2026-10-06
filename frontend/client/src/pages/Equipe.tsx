// src/pages/Equipe.tsx
import { useEffect, useMemo, useState, useCallback } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft, ArrowRight, LayoutGrid, Search, Table as TableIcon,
  UserCheck, Users, RefreshCw, Loader2, TrendingUp, Target,
  ShieldCheck, FileStack, FilePenLine, FileCheck2, Award, AlertTriangle,
  Medal, Star, Trophy, type LucideIcon,
  Send, Clock, Trash2, Megaphone, Info, AlertCircle,
} from "lucide-react";
import {
  CartesianGrid, Legend, Line, LineChart, PolarAngleAxis, PolarGrid,
  Radar, RadarChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useAppStore, Collaborator } from "@/lib/dataStore";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import DashboardLayout from "@/components/DashboardLayout";
import { useAccessControl } from "@/hooks/useAccessControl";
import { getAccessLevel, LEVELS } from "@/lib/accessControl";
import { fetchAssinadosDiarioColaborador } from "@/lib/assinados_diario_colaborador";
import {
  fetchLigacoes,
  fetchLigacoesTabulacoes,
  type CallMetrics,
  type CallTabulation,
  type CallTabulationCategory,
} from "@/lib/api";
import {
  getActiveRecommendationsFor,
  subscribeRecommendations,
  addRecommendation,
  removeRecommendation,
  getRemainingTimeLabel,
  type TemporaryRecommendation,
  type RecommendationPriority,
} from "@/lib/recommendations";

// ============================================================
//  FORMATAÇÃO
// ============================================================
function formatNumero(valor: number): string {
  return new Intl.NumberFormat("pt-BR").format(Math.round(valor));
}
function formatPct(valor: number, casasDecimais = 1): string {
  return `${valor.toFixed(casasDecimais)}%`;
}
function formatMoeda(valor: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(valor);
}

// ← CORRIGIDO: alias para manter compatibilidade com o nome usado em Comissoes.tsx
// (evita o erro TS2304 "Cannot find name 'formatInt'")
const formatInt = formatNumero;

// ============================================================
//  META DE GANHOS DO PERÍODO (banca em peso_meta_ganho_*)
// ============================================================
function getMetaGanhosPeriodo(colab: any, period: string, diasUteisPeriodo = 0): number {
  const pesoDiario = pickNumber(colab?.pesoDiarioGanhos, colab?.metaDiarioGanhos, 3);
  const pesoSemanal = pickNumber(colab?.pesoSemanalGanhos, colab?.metaSemanalGanhos, 15);
  const pesoMensal = pickNumber(colab?.pesoMensalGanhos, colab?.metaMensalGanhos, 60);
  if (period === "Hoje") return pesoDiario;
  if (period === "Semana") return pesoSemanal;
  if (period === "Mês") return pesoMensal;
  return pesoDiario * Math.max(1, diasUteisPeriodo);
}
function pickNumber(...values: Array<unknown>): number {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const fb = Number(values[values.length - 1]);
  return Number.isFinite(fb) ? fb : 0;
}

// ============================================================
//  MEDALHAS (pódio)
// ============================================================
type Medalha = "ouro" | "prata" | "bronze" | "destaque";
const MEDALHA_ICON: Record<Medalha, LucideIcon> = {
  ouro: Trophy, prata: Medal, bronze: Medal, destaque: Star,
};
const MEDALHA_COR: Record<Medalha, string> = {
  ouro: "#f59e0b", prata: "#94a3b8", bronze: "#c2703d", destaque: "#2563eb",
};

// ============================================================
//  KpiCard LOCAL
// ============================================================
interface KpiCardProps {
  titulo: string;
  valor: string;
  icon: React.ElementType;
  accent?: "brand" | "success" | "warning" | "danger" | "info";
  subtitulo?: string;
  variacao?: number;
}
const ACCENT_STYLES: Record<NonNullable<KpiCardProps["accent"]>, string> = {
  brand: "text-blue-600 bg-blue-500/10",
  success: "text-emerald-400 bg-emerald-500/10",
  warning: "text-amber-400 bg-amber-500/10",
  danger: "text-red-400 bg-red-500/10",
  info: "text-sky-400 bg-sky-500/10",
};
function KpiCard({ titulo, valor, icon: Icon, accent = "brand", subtitulo, variacao }: KpiCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] text-slate-500 leading-snug">{titulo}</p>
        <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", ACCENT_STYLES[accent])}>
          <Icon size={16} />
        </span>
      </div>
      <p className="text-2xl font-semibold text-slate-900 tracking-tight">{valor}</p>
      {subtitulo && <p className="text-[11px] text-slate-400">{subtitulo}</p>}
      {variacao !== undefined && (
        <p className={cn("text-xs font-medium", variacao >= 0 ? "text-emerald-600" : "text-red-500")}>
          {variacao >= 0 ? "+" : ""}{variacao.toFixed(1)}% vs. período anterior
        </p>
      )}
    </Card>
  );
}

// ============================================================
//  CONSTANTES DE EXCLUSÃO
// ============================================================
const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing', 'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda',
  'Equipe Reciclagem','','Equipe','Equipe Camila','Sales Ops', 'Departamento Comercial',
  'Equipe Gabriela Toledo','Equipe Treinamento', 'Equipe lucilene', 'Equipe Elizandra'
];
const normalize = (str: string | undefined | null): string =>
  (str || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const isExcludedTeam = (teamName: string) =>
  EXCLUDED_TEAMS.some((t) => normalize(t) === normalize(teamName));
const normalizarNome = (nome: string) => normalize(nome);
// Alias adicionado para manter consistência com o restante do sistema
// (evita TS2304 em helpers portados de outros arquivos).
const normalizeName = (text: string | undefined | null) => normalize(text);
function isAggregatedRole(cargo: string | undefined): boolean {
  const c = normalize(cargo);
  if (c.includes("supervisor")) return true;
  if (c === "coordenador" || c === "administrativo") return true;
  return false;
}

// ============================================================
//  AUXILIARES VISUAIS
// ============================================================
function Avatar({ nome, size = 40 }: { nome: string; size?: number }) {
  const inicial = (nome || "?")[0].toUpperCase();
  return (
    <div className="flex items-center justify-center rounded-full bg-blue-500 text-white font-bold"
      style={{ width: size, height: size, fontSize: size * 0.4 }}>
      {inicial}
    </div>
  );
}

// ============================================================
//  API DIÁRIA
// ============================================================
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3007/api";
interface AssinadosDiarioLinha { time?: string; nome?: string; dia: string; total: number; }
async function fetchAssinadosDiarioPorTime(inicio: string, fim: string): Promise<AssinadosDiarioLinha[]> {
  const url = `${API_BASE}/metrics/assinados-diario-por-equipe?inicio=${inicio}&fim=${fim}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) return [];
  const response = await res.json();
  const rows = Array.isArray(response) ? response : response.data || [];
  return rows.map((item: any) => ({
    time: item.equipe || item.time, dia: item.dia, total: Number(item.total) || 0,
  }));
}

// ============================================================
//  HELPERS DE DATA / PACE
// ============================================================
function isDiaUtil(data: Date): boolean {
  const dia = data.getDay();
  return dia !== 0 && dia !== 6;
}
function contarDiasUteis(inicio: Date, fim: Date): number {
  let count = 0; const cursor = new Date(inicio);
  while (cursor <= fim) { if (isDiaUtil(cursor)) count++; cursor.setDate(cursor.getDate() + 1); }
  return count;
}
function gerarDiasEntre(inicio: string, fim: string): string[] {
  const dias: string[] = [];
  const cursor = new Date(inicio); const end = new Date(fim);
  while (cursor <= end) {
    const pad = (n: number) => String(n).padStart(2, "0");
    dias.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dias;
}
function mesmoPeriodoAnterior(inicio: string, fim: string): { inicio: string; fim: string } {
  const start = new Date(inicio); const end = new Date(fim);
  const duracao = end.getTime() - start.getTime();
  const novoFim = new Date(start.getTime() - 1);
  const novoInicio = new Date(novoFim.getTime() - duracao);
  return { inicio: novoInicio.toISOString().slice(0, 10), fim: novoFim.toISOString().slice(0, 10) };
}
interface PaceData { paceAtual: number; paceEsperado: number; projecao: number; gap: number; }
function calcularPaceProjecao(realizado: number, metaPeriodo: number, diasUteisDecorridos: number, diasUteisTotaisPeriodo: number): PaceData | null {
  if (metaPeriodo <= 0 || diasUteisTotaisPeriodo === 0) return null;
  const paceAtual = diasUteisDecorridos > 0 ? realizado / diasUteisDecorridos : 0;
  const paceEsperado = metaPeriodo / diasUteisTotaisPeriodo;
  const projecao = paceAtual * diasUteisTotaisPeriodo;
  return { paceAtual, paceEsperado, projecao: Math.round(projecao), gap: Math.round(projecao - metaPeriodo) };
}

// ============================================================
//  AUXILIARES DE RECOMENDAÇÃO
// ============================================================
const PRIORITY_STYLES: Record<RecommendationPriority, { border: string; bg: string; text: string; label: string; Icon: LucideIcon }> = {
  info: { border: "border-sky-200", bg: "bg-sky-50", text: "text-sky-700", label: "Informativa", Icon: Info },
  warning: { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-700", label: "Atenção", Icon: AlertCircle },
  danger: { border: "border-red-200", bg: "bg-red-50", text: "text-red-700", label: "Urgente", Icon: AlertTriangle },
};

// ============================================================
//  CONSTANTES VISUAIS
// ============================================================
const CORES_TIME = ["#2563eb", "#10b981", "#8b5cf6", "#f59e0b", "#ec4899", "#06b6d4"];
const PODIO_ESTILO = {
  1: { altura: "h-28", cor: "#f59e0b", gradiente: "linear-gradient(180deg, #fef3c7 0%, #fbbf24 100%)", ordem: "order-2" },
  2: { altura: "h-20", cor: "#94a3b8", gradiente: "linear-gradient(180deg, #f1f5f9 0%, #cbd5e1 100%)", ordem: "order-1" },
  3: { altura: "h-20", cor: "#c2703d", gradiente: "linear-gradient(180deg, #fed7aa 0%, #ea9a5f 100%)", ordem: "order-3" },
} as const;
const MEDALHA_POR_POSICAO = ["ouro", "prata", "bronze"] as const;
function CardPodioTime({ item, posicao }: { item: any; posicao: 1 | 2 | 3 }) {
  const estilo = PODIO_ESTILO[posicao];
  const medalha = MEDALHA_POR_POSICAO[posicao - 1];
  const IconeMedalha = MEDALHA_ICON[medalha as Medalha];
  return (
    <div className={cn("flex flex-col items-center", estilo.ordem)}>
      <Link to={`/equipe/${encodeURIComponent(item.nomeTime)}`} className="flex flex-col items-center group w-28 md:w-36">
        <div className="flex items-center justify-center rounded-full bg-blue-500/15 text-blue-600" style={{ width: posicao === 1 ? 52 : 42, height: posicao === 1 ? 52 : 42 }}>
          <Users size={posicao === 1 ? 22 : 18} />
        </div>
        <span className="mt-2 text-[13px] font-semibold text-slate-800 text-center group-hover:underline truncate max-w-full">{item.nomeTime}</span>
        <span className="text-[11px] text-slate-500 mt-0.5">{item.pessoas} colaborador(es)</span>
        <span className="text-sm font-bold mt-1" style={{ color: estilo.cor }}>{formatNumero(item.pontuacao)} score</span>
        <span className="text-[11px] text-slate-500 mt-0.5">{formatNumero(item.ganhos)} ganhos · {formatMoeda(item.vendaGanha)}</span>
      </Link>
      <div className={cn("w-24 md:w-28 mt-3 rounded-t-lg flex flex-col items-center justify-start pt-3 gap-1.5 shadow-lg", estilo.altura)} style={{ borderTop: `3px solid ${estilo.cor}`, background: estilo.gradiente, boxShadow: `0 8px 20px -6px ${estilo.cor}66` }}>
        <span className="text-2xl font-bold leading-none" style={{ color: estilo.cor }}>{posicao}º</span>
        <IconeMedalha size={22} style={{ color: MEDALHA_COR[medalha as Medalha] }} />
      </div>
    </div>
  );
}

// ============================================================
//  PÁGINA PRINCIPAL
// ============================================================
export default function Equipe() {
  const [location] = useLocation();
  const {
    collaborators: rawCollaborators, currentStartDate, currentEndDate, period,
    loadCollaborators, loadMetricsForPeriod, loadRawMetrics, updateCurrentDates,
  } = useAppStore();
  const { currentUser } = useAccessControl();
  const userLevel = getAccessLevel(currentUser?.cargo, currentUser?.status);
  const isAssessor = userLevel === LEVELS.ASSESSOR;
  const isSupervisor = userLevel === LEVELS.SUPERVISAO;
  const canSeeAll = userLevel >= LEVELS.COORDENADOR;

  const [busca, setBusca] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<string | null>(null);

  useEffect(() => {
    updateCurrentDates();
    const load = async () => {
      try {
        if (rawCollaborators.length === 0) await loadCollaborators();
        await loadMetricsForPeriod();
        await loadRawMetrics();
      } catch (err) {
        console.error("Erro ao carregar dados:", err);
        setLoadingError("Falha ao carregar dados. Tente novamente.");
      } finally {
        setInitialLoading(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
    if (initialLoading) return;
    loadMetricsForPeriod();
    loadRawMetrics();
  }, [currentStartDate, currentEndDate]);

  const userTeam = useMemo(() => {
    if (!currentUser) return '';
    const direct = (currentUser.equipe || (currentUser as any).equipeNome || (currentUser as any).nome_equipe || '').trim();
    if (direct) return direct;
    if (rawCollaborators.length > 0) {
      const colab = rawCollaborators.find(c => c.email === currentUser.email || c.id === currentUser.id);
      if (colab && colab.equipeNome) return colab.equipeNome.trim();
    }
    return '';
  }, [currentUser, rawCollaborators]);

  const supervisor = useMemo(() => {
    const pathMatch = location.match(/^\/equipe\/(.+)$/);
    if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);
    const queryParams = new URLSearchParams(location.split("?")[1] ?? "");
    return queryParams.get("supervisor") ?? undefined;
  }, [location]);

  const colaboradorId = useMemo(() => {
    const pathMatch = location.match(/^\/colaboradores\/(.+)$/);
    if (pathMatch?.[1]) return decodeURIComponent(pathMatch[1]);
    return undefined;
  }, [location]);

  useEffect(() => {
    if (!currentUser) return;
    if (isSupervisor) {
      if (!userTeam) return;
      if (supervisor && normalize(supervisor) !== normalize(userTeam)) {
        window.location.href = `/equipe/${encodeURIComponent(userTeam)}`;
        return;
      }
      if (!supervisor) window.location.href = `/equipe/${encodeURIComponent(userTeam)}`;
    }
    if (isAssessor && supervisor) {
      const col = rawCollaborators.find(c => c.email === currentUser.email);
      if (col) window.location.href = `/colaboradores/${col.id}`;
    }
  }, [currentUser, isSupervisor, isAssessor, supervisor, rawCollaborators, userTeam]);

  const colaboradores = useMemo(() => {
    let filtered = rawCollaborators.filter((c) => !isExcludedTeam(c.equipeNome));
    if (isAssessor) {
      filtered = filtered.filter(c => c.email === currentUser?.email);
    } else if (isSupervisor) {
      filtered = userTeam ? filtered.filter(c => normalize(c.equipeNome) === normalize(userTeam)) : [];
    }
    return filtered;
  }, [rawCollaborators, currentUser, isAssessor, isSupervisor, userTeam]);

  const labelPeriodo = useMemo(
    () => (period === "Custom" ? `${currentStartDate} a ${currentEndDate}` : period),
    [period, currentStartDate, currentEndDate]
  );

  const titulo = supervisor ? `Equipe ${supervisor}` : isAssessor ? "Meus Dados" : "Equipes";
  const subtitulo = supervisor
    ? `Performance individual de cada consultor. Ganhos de ${labelPeriodo}.`
    : isAssessor ? "Seus indicadores de desempenho."
    : `Visão geral das equipes. Ganhos de ${labelPeriodo}.`;

  if (initialLoading) {
    return (
      <DashboardLayout title={titulo} subtitle="Carregando...">
        <div className="flex justify-center items-center h-64">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          <span className="ml-2 text-sm text-slate-500">Carregando dados...</span>
        </div>
      </DashboardLayout>
    );
  }
  if (loadingError) {
    return (
      <DashboardLayout title={titulo} subtitle={subtitulo}>
        <div className="flex flex-col items-center justify-center h-64">
          <AlertTriangle className="w-8 h-8 text-red-500 mb-2" />
          <p className="text-slate-600 mb-4">{loadingError}</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">Recarregar página</button>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout title={titulo} subtitle={subtitulo}>
      {!supervisor && !colaboradorId && canSeeAll ? (
        <ListaEquipes colaboradores={colaboradores} busca={busca} setBusca={setBusca}
          currentStartDate={currentStartDate} currentEndDate={currentEndDate} period={period} />
      ) : supervisor ? (
        <ColaboradoresDaEquipe equipe={supervisor} colaboradores={colaboradores} period={period}
          currentStartDate={currentStartDate} currentEndDate={currentEndDate} />
      ) : colaboradorId ? (
        <DetalhesColaborador colaboradorId={colaboradorId} colaboradores={colaboradores} period={period} />
      ) : isAssessor ? (
        <DetalhesColaborador colaboradorId={colaboradores[0]?.id} colaboradores={colaboradores} period={period} />
      ) : isSupervisor ? (
        <ColaboradoresDaEquipe equipe={userTeam} colaboradores={colaboradores} period={period}
          currentStartDate={currentStartDate} currentEndDate={currentEndDate} />
      ) : (
        <ListaEquipes colaboradores={colaboradores} busca={busca} setBusca={setBusca}
          currentStartDate={currentStartDate} currentEndDate={currentEndDate} period={period} />
      )}
    </DashboardLayout>
  );
}

// ============================================================
//  LISTA DE EQUIPES
// ============================================================
function BuscaColaborador({ busca, setBusca }: { busca: string; setBusca: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 w-full sm:w-64">
      <Search size={15} className="text-slate-500 shrink-0" />
      <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar colaborador..."
        className="bg-transparent text-[13px] text-slate-700 placeholder:text-slate-400 outline-none w-full" />
    </div>
  );
}

type OrdenarPor = "desempenho" | "recebidos" | "assinados" | "protocolados" | "comissao";

function ListaEquipes({
  colaboradores, busca, setBusca, currentStartDate, currentEndDate, period,
}: {
  colaboradores: Collaborator[]; busca: string; setBusca: (v: string) => void;
  currentStartDate: string; currentEndDate: string; period: string;
}) {
  const [visualizacao, setVisualizacao] = useState<"cards" | "tabela">("cards");
  const [ordenarPor, setOrdenarPor] = useState<OrdenarPor>("desempenho");
  const [diario, setDiario] = useState<AssinadosDiarioLinha[]>([]);
  const [loadingDiario, setLoadingDiario] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { loadCollaborators, loadMetricsForPeriod } = useAppStore();

  const { inicio: inicioPeriodo, fim: fimPeriodo } = useMemo(() => {
    if (currentStartDate && currentEndDate) return { inicio: currentStartDate, fim: currentEndDate };
    const hoje = new Date().toISOString().slice(0, 10);
    return { inicio: hoje, fim: hoje };
  }, [currentStartDate, currentEndDate]);

  const diasPeriodo = useMemo(() => gerarDiasEntre(inicioPeriodo, fimPeriodo), [inicioPeriodo, fimPeriodo]);
  const diasUteisPeriodo = useMemo(
    () => diasPeriodo.filter((d) => isDiaUtil(new Date(d + "T00:00:00"))).length,
    [diasPeriodo]
  );

  const labelPeriodoGrafico = useMemo(() => {
    if (period === "Custom") return `${inicioPeriodo} → ${fimPeriodo}`;
    if (period === "Hoje") return "hoje";
    if (period === "Semana") return "semana atual";
    if (period === "Mês") return "mês atual";
    return "período selecionado";
  }, [period, inicioPeriodo, fimPeriodo]);

  const carregarDiario = useCallback(async () => {
    if (!inicioPeriodo || !fimPeriodo) return;
    setLoadingDiario(true);
    try { setDiario(await fetchAssinadosDiarioPorTime(inicioPeriodo, fimPeriodo)); }
    catch { setDiario([]); }
    finally { setLoadingDiario(false); }
  }, [inicioPeriodo, fimPeriodo]);

  useEffect(() => { void carregarDiario(); }, [carregarDiario]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try { await Promise.allSettled([loadCollaborators(), loadMetricsForPeriod(), carregarDiario()]); }
    finally { setRefreshing(false); }
  };

  const times = Array.from(new Set(colaboradores.map((c) => c.equipeNome))).sort();

  const diarioPorTime = useMemo(() => {
    const mapa = new Map<string, Map<string, number>>();
    for (const linha of diario) {
      if (!linha.time) continue;
      if (!mapa.has(linha.time)) mapa.set(linha.time, new Map());
      mapa.get(linha.time)!.set(linha.dia, linha.total);
    }
    return mapa;
  }, [diario]);

  const dadosPorTime = times.map((nome, indice) => {
    const membros = colaboradores.filter((c) => c.equipeNome === nome);
    const membrosFolha = membros.filter((c) => !isAggregatedRole(c.cargo));
    const recebidos = membrosFolha.reduce((s, c) => s + (c.emitidos || 0), 0);
    const assinados = membrosFolha.reduce((s, c) => s + (c.assinados || 0), 0);
    const protocolados = membrosFolha.reduce((s, c) => s + (c.protocolados || 0), 0);
    const ganhos = membrosFolha.reduce((s, c) => s + (c.ganhos || 0), 0);
    const metaGanhos = membrosFolha.reduce((s, c) => s + getMetaGanhosPeriodo(c, period, diasUteisPeriodo), 0);
    const taxaConversao = recebidos > 0 ? (ganhos / recebidos) * 100 : 0;
    const serieDiaria = diasPeriodo.map((dia) => diarioPorTime.get(nome)?.get(dia) ?? 0);
    return { nome, pessoas: membros.length, recebidos, assinados, protocolados, ganhos, metaGanhos, taxaConversao, serieDiaria, cor: CORES_TIME[indice % CORES_TIME.length] };
  });

  const ordenados = [...dadosPorTime].sort((a, b) => {
    if (ordenarPor === "desempenho") return b.taxaConversao - a.taxaConversao;
    if (ordenarPor === "recebidos") return b.recebidos - a.recebidos;
    if (ordenarPor === "assinados") return b.assinados - a.assinados;
    if (ordenarPor === "comissao") return b.ganhos - a.ganhos;
    return b.protocolados - a.protocolados;
  });

  const dadosEvolucao = diasPeriodo.map((dia) => {
    const ponto: Record<string, string | number> = { dia: dia.slice(5) };
    for (const nome of times) ponto[nome] = diarioPorTime.get(nome)?.get(dia) ?? 0;
    return ponto;
  });
  const dadosRadar = dadosPorTime.map((t) => ({ time: t.nome.replace("Equipe ", ""), taxa: t.taxaConversao }));

  const buscaNormalizada = normalizarNome(busca.trim());
  const resultadosBusca = buscaNormalizada
    ? colaboradores.filter((c) => normalizarNome(c.name).includes(buscaNormalizada))
    : null;

  if (colaboradores.length === 0 && !loadingDiario && times.length === 0) {
    return (
      <div className="text-center py-12">
        <Users className="w-12 h-12 text-slate-300 mx-auto mb-3" />
        <h3 className="text-lg font-semibold text-slate-700 mb-1">Nenhuma equipe encontrada</h3>
        <p className="text-sm text-slate-500 mb-4">Não há colaboradores para exibir no momento.</p>
        <button onClick={handleRefresh} disabled={refreshing}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          {refreshing ? "Atualizando..." : "Tentar novamente"}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-800">Visão geral das equipes</p>
          <p className="text-sm text-slate-500">Atualize os dados e acompanhe a performance consolidada.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <BuscaColaborador busca={busca} setBusca={setBusca} />
          <button type="button" onClick={handleRefresh} disabled={refreshing}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60">
            {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            {refreshing ? "Atualizando..." : "Atualizar"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-6">
        <KpiCard titulo="Colaboradores" valor={`${colaboradores.length}`} icon={UserCheck} accent="brand" />
      </div>

      {resultadosBusca ? (
        resultadosBusca.length === 0 ? (
          <p className="text-slate-500">Nenhum colaborador encontrado para "{busca}".</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {resultadosBusca.map((c) => (
              <ColaboradorCard key={c.id} c={c} period={period} diasUteisPeriodo={diasUteisPeriodo}
                teamMembersCount={colaboradores.filter((x) => x.equipeNome === c.equipeNome).length} />
            ))}
          </div>
        )
      ) : (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
            <h3 className="text-sm font-semibold text-slate-700">Desempenho por Equipe</h3>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                <button onClick={() => setVisualizacao("cards")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium ${visualizacao === "cards" ? "bg-blue-500/15 text-blue-700" : "text-slate-500 hover:bg-slate-50"}`}>
                  <LayoutGrid size={13} /> Cards
                </button>
                <button onClick={() => setVisualizacao("tabela")}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium border-l border-slate-200 ${visualizacao === "tabela" ? "bg-blue-500/15 text-blue-700" : "text-slate-500 hover:bg-slate-50"}`}>
                  <TableIcon size={13} /> Tabela
                </button>
              </div>
              <select value={ordenarPor} onChange={(e) => setOrdenarPor(e.target.value as OrdenarPor)}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-600 outline-none">
                <option value="desempenho">Desempenho</option>
                <option value="recebidos">Recebidos</option>
                <option value="assinados">Assinados</option>
                <option value="protocolados">Protocolados</option>
                <option value="comissao">Comissão</option>
              </select>
            </div>
          </div>

          {visualizacao === "cards" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
              {ordenados.map((t) => (
                <Link key={t.nome} to={`/equipe/${encodeURIComponent(t.nome)}`}>
                  <Card className="h-full transition-all duration-200 hover:border-blue-500/40 hover:-translate-y-0.5 hover:shadow-[0_0_24px_rgba(37,99,235,0.35)] group">
                    <div className="flex flex-col items-center text-center pt-1 mb-4">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-500/15 text-blue-600 shrink-0">
                        <Users size={16} />
                      </div>
                      <p className="text-sm font-semibold text-slate-900 mt-2">{t.nome}</p>
                      <p className="text-[11px] text-slate-500 mt-0.5">{t.pessoas} colaborador(es)</p>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div><p className="text-[11px] text-slate-500">Ganhos</p><p className="text-sm font-semibold text-slate-700 text-center">{formatNumero(t.ganhos)}</p></div>
                      <div><p className="text-[11px] text-slate-500 text-center">Meta</p><p className="text-sm font-semibold text-slate-700 text-center">{formatNumero(t.metaGanhos)}</p></div>
                      <div><p className="text-[11px] text-slate-500">Protocolados</p><p className="text-sm font-semibold text-slate-700 text-center">{formatNumero(t.protocolados)}</p></div>
                    </div>
                    <div className="mb-3">
                      <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                        <span>Tx. Ganhos/Recebidos</span>
                        <span className="font-semibold text-slate-700">{formatPct(t.taxaConversao, 1)}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${Math.min(100, t.taxaConversao)}%`, backgroundColor: t.cor }} />
                      </div>
                    </div>
                    <div className="h-10 -mx-1 mb-2">
                      {loadingDiario ? (
                        <div className="flex items-center justify-center h-full"><Loader2 size={14} className="animate-spin text-slate-300" /></div>
                      ) : diario.length === 0 ? (
                        <p className="text-[10px] text-slate-400 text-center leading-10">Sem dados no período</p>
                      ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={t.serieDiaria.map((v, i) => ({ i, v }))}>
                            <Line type="monotone" dataKey="v" stroke={t.cor} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                          </LineChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                    <span className="text-[12px] font-medium text-blue-600 group-hover:underline inline-flex items-center gap-1">
                      Ver equipe <ArrowRight size={12} />
                    </span>
                  </Card>
                </Link>
              ))}
            </div>
          ) : (
            <Card className="mb-6">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-200">
                      <th className="py-2 pr-4 font-medium w-10">#</th>
                      <th className="py-2 pr-4 font-medium">Equipe</th>
                      <th className="py-2 pr-4 font-medium">Ganhos</th>
                      <th className="py-2 pr-4 font-medium">Meta</th>
                      <th className="py-2 pr-4 font-medium">Comissão</th>
                      <th className="py-2 pr-4 font-medium">Tx. Ganhos/Recebidos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordenados.map((t, indice) => (
                      <tr key={t.nome} className="border-b border-slate-200/60 hover:bg-slate-50">
                        <td className="py-2.5 pr-4 text-slate-500 font-semibold">{indice + 1}º</td>
                        <td className="py-2.5 pr-4">
                          <Link to={`/equipe/${encodeURIComponent(t.nome)}`} className="font-medium text-slate-800 hover:underline">{t.nome}</Link>
                        </td>
                        <td className="py-2.5 pr-4 text-slate-600">{formatNumero(t.ganhos)}</td>
                        <td className="py-2.5 pr-4 text-slate-600">{formatNumero(t.metaGanhos)}</td>
                        <td className="py-2.5 pr-4 text-slate-600">{formatMoeda(t.ganhos)}</td>
                        <td className="py-2.5 pr-4 text-slate-700 font-semibold">{formatPct(t.taxaConversao, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
            <Card>
              <h3 className="text-sm font-semibold text-slate-700 mb-3">
                Evolução das Equipes <span className="font-normal text-slate-400">· {labelPeriodoGrafico}</span>
              </h3>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={dadosEvolucao} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="dia" stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
                    interval={Math.max(0, Math.floor(dadosEvolucao.length / 8) - 1)} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={28} />
                  <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, fontSize: 12 }} />
                  {times.map((nome, indice) => (
                    <Line key={nome} type="monotone" dataKey={nome} name={nome}
                      stroke={CORES_TIME[indice % CORES_TIME.length]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </Card>
            <Card>
              <h3 className="text-sm font-semibold text-slate-700 mb-3">
                Distribuição dos Resultados <span className="font-normal text-slate-400">· taxa de conversão</span>
              </h3>
              <ResponsiveContainer width="100%" height={220}>
                <RadarChart data={dadosRadar} outerRadius={75}>
                  <PolarGrid stroke="#e2e8f0" />
                  <PolarAngleAxis dataKey="time" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                  <Radar name="Tx. Ganhos/Recebidos" dataKey="taxa" stroke="#6366f1" fill="#6366f1" fillOpacity={0.35} />
                  <Tooltip formatter={(v) => [formatPct(Number(v), 1), "Tx. Ganhos/Recebidos"]} />
                </RadarChart>
              </ResponsiveContainer>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

// ============================================================
//  COLABORADOR CARD
// ============================================================
function ColaboradorCard({
  c, period, diasUteisPeriodo, teamMembersCount,
}: {
  c: Collaborator; period: string; diasUteisPeriodo: number; teamMembersCount: number;
}) {
  const agregado = isAggregatedRole(c.cargo);
  const recebidos = c.emitidos || 0;
  const assinados = c.assinados || 0;
  const ganhos = c.ganhos || 0;
  const metaGanhos = getMetaGanhosPeriodo(c, period, diasUteisPeriodo);
  const taxa = recebidos > 0 ? (ganhos / recebidos) * 100 : 0;
  return (
    <Link to={`/colaboradores/${c.id}`}>
      <Card className="h-full transition-all duration-200 hover:border-blue-500/40 hover:-translate-y-0.5 hover:shadow-[0_0_24px_rgba(37,99,235,0.35)] group">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Avatar nome={c.name} size={40} />
            <div>
              <p className="text-sm font-semibold text-slate-900">{c.name}</p>
              <p className="text-[12px] text-slate-500">{c.cargo} · {c.equipeNome}</p>
              {agregado && (
                <p className="text-[10px] text-amber-600">
                  Totais da equipe ({teamMembersCount} pessoa{teamMembersCount === 1 ? "" : "s"})
                </p>
              )}
            </div>
          </div>
          <ArrowRight size={16} className="text-slate-400 group-hover:text-blue-600 transition-colors shrink-0" />
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 mb-4">
          <div><p className="text-[11px] text-slate-500">Recebidos</p><p className="text-sm font-semibold text-slate-700">{formatNumero(recebidos)}</p></div>
          <div><p className="text-[11px] text-slate-500">Assinados</p><p className="text-sm font-semibold text-slate-700">{formatNumero(assinados)}</p></div>
          <div><p className="text-[11px] text-slate-500">Meta do período</p><p className="text-sm font-semibold text-slate-700">{formatNumero(metaGanhos)}</p></div>
          <div><p className="text-[11px] text-slate-500">Ganhos</p><p className="text-sm font-semibold text-slate-700">{formatNumero(ganhos)}</p></div>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] text-slate-500">Tx. Ganhos/Recebidos</p>
            <p className="text-base font-semibold text-slate-900">{formatPct(taxa)}</p>
          </div>
        </div>
      </Card>
    </Link>
  );
}

// ============================================================
//  COLABORADORES DA EQUIPE
// ============================================================
function ColaboradoresDaEquipe({
  equipe, colaboradores, period, currentStartDate, currentEndDate,
}: {
  equipe: string; colaboradores: Collaborator[]; period: string;
  currentStartDate: string; currentEndDate: string;
}) {
  const membros = useMemo(() => {
    if (!equipe) return [];
    return colaboradores.filter(c => normalize(c.equipeNome) === normalize(equipe));
  }, [colaboradores, equipe]);

  const diasUteisPeriodo = useMemo(() => {
    if (!currentStartDate || !currentEndDate) return 0;
    return contarDiasUteis(new Date(currentStartDate), new Date(currentEndDate));
  }, [currentStartDate, currentEndDate]);

  return (
    <div>
      <Link to="/equipe" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4 w-fit">
        <ArrowLeft size={15} /> Voltar para equipes
      </Link>
      {membros.length === 0 ? (
        <div className="text-center py-12">
          <Users className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <h3 className="text-lg font-semibold text-slate-700">Nenhum colaborador encontrado</h3>
          <p className="text-sm text-slate-500">Não há membros na equipe {equipe}.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {membros.map((c) => (
            <ColaboradorCard key={c.id} c={c} period={period} diasUteisPeriodo={diasUteisPeriodo} teamMembersCount={membros.length} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
//  DETALHES DO COLABORADOR
// ============================================================
function DetalhesColaborador({
  colaboradorId, colaboradores, period,
}: {
  colaboradorId?: string; colaboradores: Collaborator[]; period: string;
}) {
  const colaborador = colaboradores.find((c) => c.id === colaboradorId);
  const { currentUser } = useAccessControl();
  const userLevel = getAccessLevel(currentUser?.cargo, currentUser?.status);
  const canAuthorRecommendations = userLevel >= LEVELS.SUPERVISAO;
  const canDeleteAny = userLevel >= LEVELS.COORDENADOR;

  const { currentStartDate, currentEndDate } = useAppStore();
  const [evolucaoMensal, setEvolucaoMensal] = useState<
    { dia: string; dataCompletaAtual: string; dataCompletaAnterior: string; atual: number; anterior: number }[]
  >([]);
  const [carregandoEvolucao, setCarregandoEvolucao] = useState(false);

  // ============================================================
  //  RECOMENDAÇÕES TEMPORÁRIAS
  // ============================================================
  const [tempRecs, setTempRecs] = useState<TemporaryRecommendation[]>([]);
  const [newRecText, setNewRecText] = useState("");
  const [newRecPriority, setNewRecPriority] = useState<RecommendationPriority>("info");
  const [sendingRec, setSendingRec] = useState(false);

  // ============================================================
  //  DADOS DE LIGAÇÕES E TABULAÇÕES PARA AS RECOMENDAÇÕES
  // ============================================================
  const [callMetrics, setCallMetrics] = useState<CallMetrics[]>([]);
  const [allTabulations, setAllTabulations] = useState<CallTabulation[]>([]);
  const [loadingCallData, setLoadingCallData] = useState(false);

  useEffect(() => {
    if (!colaborador || !currentStartDate || !currentEndDate) {
      setCallMetrics([]);
      setAllTabulations([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setLoadingCallData(true);
      try {
        const calls = await fetchLigacoes({
          start: currentStartDate,
          end: currentEndDate,
          colaborador: colaborador.name,
        }).catch(() => [] as CallMetrics[]);
        if (cancelled) return;
        setCallMetrics(calls);

        const categorias: CallTabulationCategory[] = ['productive', 'appointments', 'occurrences', 'failures'];
        const resultados = await Promise.all(
          categorias.map(cat =>
            fetchLigacoesTabulacoes({
              start: currentStartDate,
              end: currentEndDate,
              colaborador: colaborador.name,
              categoria: cat,
            }).catch(() => [] as CallTabulation[])
          )
        );
        if (cancelled) return;
        setAllTabulations(resultados.flat());
      } finally {
        if (!cancelled) setLoadingCallData(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [colaborador?.name, currentStartDate, currentEndDate]);

  useEffect(() => {
    if (!colaborador) return;
    const refresh = () => setTempRecs(getActiveRecommendationsFor(colaborador.id));
    refresh();
    const unsub = subscribeRecommendations(refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { unsub(); window.clearInterval(timer); };
  }, [colaborador?.id]);

  const handleAddRec = () => {
    if (!colaborador || !currentUser) return;
    const txt = newRecText.trim();
    if (!txt) return;
    setSendingRec(true);
    try {
      addRecommendation({
        targetId: colaborador.id,
        targetName: colaborador.name,
        targetEmail: colaborador.email,
        authorId: currentUser.id,
        authorName: currentUser.nome,
        authorCargo: currentUser.cargo,
        text: txt,
        priority: newRecPriority,
      });
      setNewRecText("");
      setNewRecPriority("info");
    } finally {
      setSendingRec(false);
    }
  };

  const handleRemoveRec = (id: string) => {
    removeRecommendation(id);
  };

  const periodoAnterior = useMemo(
    () => (currentStartDate && currentEndDate ? mesmoPeriodoAnterior(currentStartDate, currentEndDate) : { inicio: "", fim: "" }),
    [currentStartDate, currentEndDate]
  );

  const mesAnoDeData = (dataDDMMAAAA: string): string => {
    if (!dataDDMMAAAA || dataDDMMAAAA.length < 10) return "—";
    const partes = dataDDMMAAAA.split('/');
    if (partes.length !== 3) return "—";
    const mes = parseInt(partes[1], 10);
    const ano = partes[2];
    const nomesMeses = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
    return `${nomesMeses[mes - 1] || mes}/${ano}`;
  };

  useEffect(() => {
    if (!colaborador || !currentStartDate || !currentEndDate) return;
    let cancelado = false;
    setCarregandoEvolucao(true);
    const diasAtual = gerarDiasEntre(currentStartDate, currentEndDate);
    const diasAnterior = periodoAnterior.inicio && periodoAnterior.fim
      ? gerarDiasEntre(periodoAnterior.inicio, periodoAnterior.fim) : [];

    const gerarEstimativa = (dias: string[], totalAssinados: number) => {
      const diasUteis = dias.filter(d => isDiaUtil(new Date(d + 'T00:00:00'))).length || 1;
      const media = totalAssinados / diasUteis;
      return dias.map(d => ({ dia: d, total: isDiaUtil(new Date(d + 'T00:00:00')) ? media : 0 }));
    };

    const promessas = [fetchAssinadosDiarioColaborador(colaborador.name, currentStartDate, currentEndDate)];
    if (periodoAnterior.inicio && periodoAnterior.fim) {
      promessas.push(fetchAssinadosDiarioColaborador(colaborador.name, periodoAnterior.inicio, periodoAnterior.fim));
    } else promessas.push(Promise.resolve([]));

    Promise.allSettled(promessas).then(([resultAtual, resultAnterior]) => {
      if (cancelado) return;
      const linhasAtual = resultAtual.status === 'fulfilled' && resultAtual.value.length > 0
        ? resultAtual.value : gerarEstimativa(diasAtual, colaborador.assinados || 0);
      const linhasAnterior = (resultAnterior.status === 'fulfilled' ? resultAnterior.value : []) || [];
      const mapAtual = new Map(linhasAtual.map((l) => [l.dia, l.total]));
      const mapAnterior = new Map(linhasAnterior.map((l) => [l.dia, l.total]));
      const totalDias = Math.max(diasAtual.length, diasAnterior.length);
      const combinado = Array.from({ length: totalDias }, (_, i) => {
        const dataAtual = diasAtual[i] || null;
        const dataAnterior = diasAnterior[i] || null;
        const rotulo = `Dia ${i + 1}`;
        const dataCompletaAtual = dataAtual ? dataAtual.slice(8,10)+'/'+dataAtual.slice(5,7)+'/'+dataAtual.slice(0,4) : '';
        const dataCompletaAnterior = dataAnterior ? dataAnterior.slice(8,10)+'/'+dataAnterior.slice(5,7)+'/'+dataAnterior.slice(0,4) : '';
        return {
          dia: rotulo, dataCompletaAtual, dataCompletaAnterior,
          atual: dataAtual ? (mapAtual.get(dataAtual) ?? 0) : 0,
          anterior: dataAnterior ? (mapAnterior.get(dataAnterior) ?? 0) : 0,
        };
      });
      setEvolucaoMensal(combinado);
    }).finally(() => { if (!cancelado) setCarregandoEvolucao(false); });
    return () => { cancelado = true; };
  }, [colaborador?.name, currentStartDate, currentEndDate, periodoAnterior.inicio, periodoAnterior.fim]);

  const recebidos = colaborador?.emitidos || 0;
  const assinados = colaborador?.assinados || 0;
  const protocolados = colaborador?.protocolados || 0;
  const ganhos = colaborador?.ganhos || 0;

  const hoje = new Date();
  const inicioPeriodo = currentStartDate ? new Date(currentStartDate) : new Date();
  const fimPeriodo = currentEndDate ? new Date(currentEndDate) : new Date();
  const diasUteisTotaisPeriodo = contarDiasUteis(inicioPeriodo, fimPeriodo);
  const diasUteisDecorridos = contarDiasUteis(inicioPeriodo, hoje < fimPeriodo ? hoje : fimPeriodo);
  const metaGanhosPeriodo = colaborador ? getMetaGanhosPeriodo(colaborador, period, diasUteisTotaisPeriodo) : 0;
  const pace = period === "Mês" ? calcularPaceProjecao(ganhos, metaGanhosPeriodo, diasUteisDecorridos, diasUteisTotaisPeriodo) : null;

  const taxaConversaoGeral = recebidos > 0 ? (assinados / recebidos) * 100 : 0;
  const taxaConversaoProtocolados = assinados > 0 ? (protocolados / assinados) * 100 : 0;
  const taxaGanhos = recebidos > 0 ? (ganhos / recebidos) * 100 : 0;
  const corConversaoGeral = taxaConversaoGeral >= 60 ? "#22c55e" : taxaConversaoGeral >= 40 ? "#f59e0b" : "#ef4444";
  const corConversaoProtocolados = taxaConversaoProtocolados >= 60 ? "#22c55e" : taxaConversaoProtocolados >= 40 ? "#f59e0b" : "#ef4444";

  const equipe = colaboradores.filter((c) => c.equipeNome === colaborador?.equipeNome);
  const mediaEquipe = useMemo(() => {
    if (equipe.length === 0) return null;
    const total = equipe.length;
    return {
      recebidos: equipe.reduce((s, c) => s + (c.emitidos || 0), 0) / total,
      assinados: equipe.reduce((s, c) => s + (c.assinados || 0), 0) / total,
      protocolados: equipe.reduce((s, c) => s + (c.protocolados || 0), 0) / total,
      ganhos: equipe.reduce((s, c) => s + (c.ganhos || 0), 0) / total,
      taxaConversao: equipe.reduce((s, c) => s + ((c.assinados || 0) / Math.max(1, c.emitidos || 1)) * 100, 0) / total,
    };
  }, [equipe]);

  const radarData = useMemo(() => {
    if (!mediaEquipe) return [];
    return [
      { metrica: "Recebidos", colaborador: recebidos, equipe: mediaEquipe.recebidos, max: Math.max(recebidos, mediaEquipe.recebidos) * 1.2 },
      { metrica: "Assinados", colaborador: assinados, equipe: mediaEquipe.assinados, max: Math.max(assinados, mediaEquipe.assinados) * 1.2 },
      { metrica: "Protocolados", colaborador: protocolados, equipe: mediaEquipe.protocolados, max: Math.max(protocolados, mediaEquipe.protocolados) * 1.2 },
      { metrica: "Ganhos", colaborador: ganhos, equipe: mediaEquipe.ganhos, max: Math.max(ganhos, mediaEquipe.ganhos) * 1.2 },
      { metrica: "Tx Conversão", colaborador: taxaConversaoGeral, equipe: mediaEquipe.taxaConversao, max: 100 },
    ];
  }, [recebidos, assinados, protocolados, ganhos, taxaConversaoGeral, mediaEquipe]);

  // ============================================================
  // RECOMENDAÇÕES AUTOMÁTICAS
  // ============================================================
  const recomendacoes: string[] = [];

  // ---- 1) Comissão / metas ----
  if (metaGanhosPeriodo > 0 && ganhos < metaGanhosPeriodo * 0.7) {
    recomendacoes.push("Ganhos abaixo de 70% da meta do período. Redefinir plano de recuperação com acompanhamento semanal.");
  }
  if (pace && pace.gap < 0) {
    const gapRatio = pace.projecao / metaGanhosPeriodo;
    if (gapRatio < 0.75) recomendacoes.push(`Pace de ganhos muito abaixo do esperado (gap de ${formatNumero(pace.gap)} vs. meta) — no ritmo atual não fecha o mês.`);
    else if (gapRatio < 0.9) recomendacoes.push(`Pace de ganhos abaixo do esperado (gap de ${formatNumero(pace.gap)} vs. meta) — acompanhar de perto.`);
  }
  if (taxaConversaoProtocolados < 60) recomendacoes.push("Revisar imediatamente a carteira de assinados sem protocolo.");
  if (taxaConversaoGeral < 70) recomendacoes.push("Reforçar técnicas de fechamento comercial (etapa emissão → assinatura).");

  // ---- 2) Ligações e tabulações ----
  const callTotals = callMetrics.reduce((sum, row) => ({
    total: sum.total + (Number(row.total_ligacoes) || 0),
    productive: sum.productive + (Number(row.produtivas) || 0),
  }), { total: 0, productive: 0 });

  const totalLigacoes = callTotals.total;
  const ligacoesProdutivas = callTotals.productive;

  // Helper: soma tabulações por padrões de nome (normalizado, case-insensitive)
  const sumTabulationsByName = (patterns: string[]): number => {
    return allTabulations.reduce((sum, t) => {
      const nome = normalizeName(t.tabulacao);
      const matched = patterns.some(p => nome.includes(normalizeName(p)));
      return matched ? sum + (Number(t.total) || 0) : sum;
    }, 0);
  };

  if (totalLigacoes > 0) {
    const taxaProdutivas = (ligacoesProdutivas / totalLigacoes) * 100;

    if (taxaProdutivas > 50) {
      recomendacoes.push(
        `🎉 Parabéns! ${taxaProdutivas.toFixed(0)}% das suas ligações foram produtivas no período. Excelente trabalho — continue assim!`
      );
    } else if (taxaProdutivas < 40) {
      recomendacoes.push(
        `Apenas ${taxaProdutivas.toFixed(0)}% das suas ligações foram produtivas. Revise o script de abordagem e o horário dos contatos.`
      );
    }

    const totalAgendamentos = sumTabulationsByName(['trabalhando', 'retornar liga']);
    const taxaAgendamentos = (totalAgendamentos / totalLigacoes) * 100;
    if (taxaAgendamentos > 5) {
      recomendacoes.push(
        `Você registrou ${taxaAgendamentos.toFixed(1)}% de agendamentos. Ótimo ritmo! Melhores horários para uma nova tentativa de contato: 8:10, 10:12 e 12:14.`
      );
    }

    const totalNaoTabulada = sumTabulationsByName(['nao tabulada', 'não tabulada', 'tempo excedido']);
    if (totalNaoTabulada > 3) {
      recomendacoes.push(
        // ← CORRIGIDO: formatInt agora existe como alias de formatNumero
        `Foram registradas ${formatInt(totalNaoTabulada)} ocorrências de "Não Tabulada - Tempo Excedido" no período. Evite deixar atendimentos sem a devida tabulação.`
      );
    }

    const totalQueda = sumTabulationsByName(['queda']);
    const taxaQueda = (totalQueda / totalLigacoes) * 100;
    if (taxaQueda > 10) {
      recomendacoes.push(
        `Você tem ${taxaQueda.toFixed(1)}% de quedas de ligação. Recomendamos acompanhar a estabilidade da rede e a conexão com a internet.\n` +
        `OBS: a tabulação de "Queda" deve ser utilizada quando a ligação for encerrada antes da conclusão do atendimento.`
      );
    }

    const totalMuda = sumTabulationsByName(['muda', 'mudo']);
    const taxaMuda = (totalMuda / totalLigacoes) * 100;
    if (taxaMuda > 10) {
      recomendacoes.push(
        // ← CORRIGIDO: typos "tabulção" → "tabulação" e "Ligaçoes" → "Ligações"
        `${taxaMuda.toFixed(1)}% das ligações foram tabuladas como "Mudas". Recomendamos que verifique o funcionamento dos equipamentos e separe os casos para serem avaliados por nossa equipe.\n` +
        `OBS: A tabulação de Ligações mudas deve ser utilizada quando não houver comunicação/áudio do cliente.`
      );
    }
  }

  const acessoNegado = !!(colaborador && (
    (userLevel === LEVELS.SUPERVISAO && normalize(colaborador.equipeNome) !== normalize(currentUser?.equipe || "")) ||
    (userLevel === LEVELS.ASSESSOR && colaborador.email !== currentUser?.email)
  ));

  if (!colaborador) {
    return (
      <div>
        <Link to="/equipe" className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4 w-fit">
          <ArrowLeft size={15} /> Voltar para equipes
        </Link>
        <p className="text-slate-500">Colaborador não encontrado.</p>
      </div>
    );
  }
  if (acessoNegado) return <p className="text-slate-500">Acesso não autorizado.</p>;

  const labelPeriodoMeta =
    period === "Hoje" ? "meta diária"
    : period === "Semana" ? "meta semanal"
    : period === "Mês" ? "meta mensal" : "meta do período";

  return (
    <div>
      <Link to={`/equipe/${encodeURIComponent(colaborador.equipeNome)}`}
        className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4 w-fit">
        <ArrowLeft size={15} /> Voltar para a equipe
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <Avatar nome={colaborador.name} size={56} />
          <div>
            <h1 className="text-xl font-semibold text-slate-900">{colaborador.name}</h1>
            <p className="text-sm text-slate-500">{colaborador.cargo} · {colaborador.equipeNome}</p>
          </div>
        </div>
        <span className="text-sm text-slate-500">{colaborador.email}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4 mb-6">
        <KpiCard titulo="Recebidos" valor={formatNumero(recebidos)} icon={FileStack} accent="info" />
        <KpiCard titulo="Ganhos"
          valor={metaGanhosPeriodo > 0 ? `${formatNumero(ganhos)} / ${formatNumero(metaGanhosPeriodo)}` : formatNumero(ganhos)}
          icon={FilePenLine} accent="brand" subtitulo={`Meta ${labelPeriodoMeta}`} />
        <KpiCard titulo="Protocolados" valor={formatNumero(protocolados)} icon={FileCheck2} accent="success" />
        <KpiCard titulo="Assinados" valor={formatNumero(assinados)} icon={FilePenLine} accent="warning" />
        <KpiCard
          titulo={metaGanhosPeriodo > 0 ? "Atingimento da Meta (ganhos)" : "Tx. Ganhos/Recebidos"}
          valor={formatPct(metaGanhosPeriodo > 0 ? (ganhos / metaGanhosPeriodo) * 100 : taxaGanhos, 0)}
          icon={Target}
          accent={metaGanhosPeriodo === 0 ? "info" : (ganhos / metaGanhosPeriodo) * 100 >= 90 ? "success" : "warning"}
          subtitulo={metaGanhosPeriodo === 0 ? "Meta não cadastrada" : undefined} />
      </div>

      {period === "Mês" && metaGanhosPeriodo > 0 && pace && (
        <Card className="mb-6 border-l-4 border-l-blue-500">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-700">Pace do mês (ganhos)</h3>
            <span className="text-[11px] text-slate-500">
              {diasUteisDecorridos} de {diasUteisTotaisPeriodo} dias úteis decorridos · meta: {formatNumero(metaGanhosPeriodo)}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div><p className="text-[11px] text-slate-500">Pace atual</p><p className="text-base font-semibold text-slate-900">{pace.paceAtual.toFixed(2)}/dia</p></div>
            <div><p className="text-[11px] text-slate-500">Pace esperado</p><p className="text-base font-semibold text-slate-900">{pace.paceEsperado.toFixed(2)}/dia</p></div>
            <div><p className="text-[11px] text-slate-500">Projeção do mês</p><p className="text-base font-semibold text-slate-900">{formatNumero(pace.projecao)}</p></div>
            <div>
              <p className="text-[11px] text-slate-500">Gap vs. meta</p>
              <p className="text-base font-semibold flex items-center gap-1 text-slate-900">
                <TrendingUp size={14} className={pace.gap >= 0 ? "" : "rotate-180"} />
                {pace.gap >= 0 ? "+" : ""}{formatNumero(pace.gap)}
              </p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
        <Card className="xl:col-span-2">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">
            Evolução do período <span className="font-normal text-slate-400">· assinados por dia, atual vs. anterior</span>
          </h3>
          {carregandoEvolucao ? (
            <div className="flex items-center justify-center h-40">
              <Loader2 size={24} className="animate-spin text-slate-400" />
            </div>
          ) : evolucaoMensal.length === 0 ? (
            <p className="text-sm text-slate-500 py-10 text-center">Sem dados de evolução para o período selecionado.</p>
          ) : (
            <>
              {evolucaoMensal.every(p => p.anterior === 0) && (
                <p className="text-xs text-amber-600 mb-2">Dados do período anterior não disponíveis.</p>
              )}
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={evolucaoMensal} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="dia" stroke="#64748b" tick={{ fontSize: 10 }} tickLine={false} axisLine={false}
                    interval={Math.floor(evolucaoMensal.length / 8) || 1} />
                  <YAxis stroke="#64748b" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                  <Tooltip
                    formatter={(v, name) => [formatNumero(Number(v)), name === "atual" ? "Atual" : "Anterior"]}
                    labelFormatter={(label, payload: any[]) => {
                      const item = payload?.[0]?.payload;
                      if (!item) return label;
                      const mesAtual = mesAnoDeData(item.dataCompletaAtual);
                      const mesAnterior = item.dataCompletaAnterior ? mesAnoDeData(item.dataCompletaAnterior) : "—";
                      return (
                        <div>
                          <p className="font-semibold text-slate-800">{label}</p>
                          <p className="text-xs text-slate-500">Período atual: {mesAtual}</p>
                          <p className="text-xs text-slate-500">Período anterior: {mesAnterior}</p>
                        </div>
                      );
                    }}
                    contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="anterior" name="anterior" stroke="#f97316" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="atual" name="atual" stroke="#2563eb" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </>
          )}
        </Card>

        <Card className="flex flex-col items-center justify-center">
          <h3 className="text-sm font-semibold text-slate-700 self-start mb-2">Eficiência</h3>
          <div className="grid grid-cols-2 gap-4 w-full">
            <div className="flex flex-col items-center">
              <p className="text-[11px] text-slate-500 mb-1">Conversão Geral</p>
              <div className="relative w-28 h-28">
                <svg viewBox="0 0 36 36" className="w-full h-full">
                  <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#e2e8f0" strokeWidth="3" />
                  <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831" fill="none" stroke={corConversaoGeral} strokeWidth="3" strokeDasharray={`${taxaConversaoGeral}, 100`} strokeLinecap="round" />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold" style={{ color: corConversaoGeral }}>{formatPct(taxaConversaoGeral, 0)}</span>
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-1">Assinados / Emitidos</p>
            </div>
            <div className="flex flex-col items-center">
              <p className="text-[11px] text-slate-500 mb-1">Conv. Protocolados</p>
              <div className="relative w-28 h-28">
                <svg viewBox="0 0 36 36" className="w-full h-full">
                  <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#e2e8f0" strokeWidth="3" />
                  <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831" fill="none" stroke={corConversaoProtocolados} strokeWidth="3" strokeDasharray={`${taxaConversaoProtocolados}, 100`} strokeLinecap="round" />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-bold" style={{ color: corConversaoProtocolados }}>{formatPct(taxaConversaoProtocolados, 0)}</span>
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-1">Protocolados / Assinados</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Recomendações temporárias — visível somente para supervisor+ */}
      {canAuthorRecommendations && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
          <Card className="xl:col-span-1">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Comparação com a equipe</h3>
            {radarData.length > 0 ? (
              <ResponsiveContainer width="100%" height={250}>
                <RadarChart data={radarData}>
                  <PolarGrid stroke="#e2e8f0" />
                  <PolarAngleAxis dataKey="metrica" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                  <Radar name="Colaborador" dataKey="colaborador" stroke="#2563eb" fill="#2563eb" fillOpacity={0.2} />
                  <Radar name="Média da equipe" dataKey="equipe" stroke="#f97316" fill="#f97316" fillOpacity={0.2} />
                  <Tooltip formatter={(value: number) => value.toFixed(2)} />
                </RadarChart>
              </ResponsiveContainer>
            ) : <p className="text-sm text-slate-500">Dados insuficientes para comparação.</p>}
          </Card>

          <Card className="xl:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <Megaphone size={17} className="text-amber-600" />
              <h3 className="text-sm font-semibold text-slate-700">Recomendações</h3>
              <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-medium">
                Ativas por 24h
              </span>
            </div>

            {/* Form de criação */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 mb-4">
              <p className="text-[11px] font-semibold text-slate-700 mb-2">
                Nova recomendação para {colaborador.name}
              </p>
              <textarea
                value={newRecText}
                onChange={(e) => setNewRecText(e.target.value)}
                placeholder="Escreva uma orientação temporária (válida por 24h)..."
                rows={3}
                maxLength={500}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
              />
              <div className="flex flex-wrap items-center gap-2 mt-2 justify-between">
                <div className="flex items-center gap-1.5">
                  {(["info", "warning", "danger"] as RecommendationPriority[]).map((p) => {
                    const style = PRIORITY_STYLES[p];
                    const PIcon = style.Icon;
                    const active = newRecPriority === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setNewRecPriority(p)}
                        className={cn(
                          "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors",
                          active
                            ? `${style.bg} ${style.text} ${style.border}`
                            : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50"
                        )}
                      >
                        <PIcon size={11} />
                        {style.label}
                      </button>
                    );
                  })}
                  <span className="text-[10px] text-slate-400 ml-1">{newRecText.length}/500</span>
                </div>
                <button
                  type="button"
                  onClick={handleAddRec}
                  disabled={!newRecText.trim() || sendingRec}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {sendingRec ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  Publicar (24h)
                </button>
              </div>
            </div>

            {/* Lista de recomendações ativas criadas */}
            {tempRecs.length > 0 ? (
              <div className="space-y-2 mb-4">
                <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                  Orientações ativas
                </p>
                <ul className="space-y-2">
                  {tempRecs.map((r) => {
                    const style = PRIORITY_STYLES[r.priority];
                    const canDelete = canDeleteAny || r.authorId === currentUser?.id;
                    return (
                      <li key={r.id}
                        className={cn("flex gap-3 items-start p-3 rounded-lg border", style.border, style.bg)}>
                        <style.Icon size={15} className={cn("mt-0.5 shrink-0", style.text)} />
                        <div className="flex-1 min-w-0">
                          <p className={cn("text-[13px] whitespace-pre-wrap break-words", style.text)}>{r.text}</p>
                          <p className="text-[10px] text-slate-500 mt-1 flex flex-wrap items-center gap-2">
                            <span>{r.authorName} · {r.authorCargo}</span>
                            <span className="inline-flex items-center gap-1">
                              <Clock size={10} /> expira em {getRemainingTimeLabel(r.expiresAt)}
                            </span>
                          </p>
                        </div>
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => handleRemoveRec(r.id)}
                            className="shrink-0 p-1 rounded text-slate-400 hover:text-red-600 hover:bg-white"
                            title="Remover recomendação"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="text-[12px] text-slate-400 italic mb-4">
                Nenhuma orientação temporária ativa para {colaborador.name}.
              </p>
            )}

            {/* Recomendações automáticas */}
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                Recomendações
              </p>
              {loadingCallData && (
                <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
                  <Loader2 size={10} className="animate-spin" /> atualizando ligações...
                </span>
              )}
            </div>
            {recomendacoes.length > 0 ? (
              <ul className="space-y-2">
                {recomendacoes.map((r, i) => (
                  <li key={i} className="flex gap-2 text-[13px] text-slate-600 rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <span className="text-blue-600 shrink-0">→</span>
                    {/* ← CORRIGIDO: whitespace-pre-line faz o "\n" virar quebra de linha real
                        (necessário para o "OBS:" aparecer na linha de baixo) */}
                    <span className="whitespace-pre-line">{r}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="text-[12px] text-slate-500">
                  Nenhuma recomendação automática gerada. Os indicadores atuais não acionaram sugestões.
                </p>
              </div>
            )}
          </Card>
        </div>
      )}

      <p className="mt-4 text-xs text-slate-400">
        Período analisado: {currentStartDate} até {currentEndDate} · {labelPeriodoMeta}: {formatNumero(metaGanhosPeriodo)}
      </p>
    </div>
  );
}