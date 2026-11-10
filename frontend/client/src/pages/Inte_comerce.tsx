// src/pages/Inte_comerce.tsx
import { useState, useMemo, useCallback, useEffect } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, type Collaborator } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import { getAccessLevel, LEVELS } from "@/lib/accessControl";
import {
  Download, AlertTriangle, Loader2,
  Send, Clock, Trash2, Megaphone, Info, AlertCircle,
  ChevronDown,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from "recharts";
import {
  getActiveRecommendationsFor,
  subscribeRecommendations,
  addRecommendation,
  removeRecommendation,
  getRemainingTimeLabel,
  type TemporaryRecommendation,
  type RecommendationPriority,
} from "@/lib/recommendations";
import {
  fetchInteComerceAll,
  fetchInteComerceCollaborators,
  fetchInteComerceTeams,
  type InteComerceOverview,
  type InteComerceStrategic,
  type InteComerceFunnel,
  type InteComerceReason,
  type InteComerceDaily,
  type InteComerceCollaborator,
  type InteComerceTeam,
} from "@/lib/inteComerce";

// ───────────────────────────────────────────────────────────
const formatInt = (n: number) => (n || 0).toLocaleString("pt-BR");
const formatPct = (num: number, den: number) => {
  if (!den) return "—";
  return `${((num / den) * 100).toFixed(1).replace(".", ",")}%`;
};
const dateBr = (iso: string) => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
};
const dateTimeBr = (iso: string) => new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
}).format(new Date(iso));
function getInteComerceDateLimits(now = new Date(), lookbackMonths = 24) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(now);
  const [year, month, day] = today.split("-").map(Number);
  const minimumMonth = new Date(Date.UTC(year, month - 1 - lookbackMonths, 1));
  const daysInMinimumMonth = new Date(
    Date.UTC(minimumMonth.getUTCFullYear(), minimumMonth.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const minimumDay = lookbackMonths >= 22 ? 1 : Math.min(day, daysInMinimumMonth);
  const minimum = new Date(Date.UTC(
    minimumMonth.getUTCFullYear(),
    minimumMonth.getUTCMonth(),
    minimumDay,
  )).toISOString().slice(0, 10);
  const maximumExclusive = new Date(Date.UTC(
    year,
    month - 1,
    day + 1,
  ))
    .toISOString()
    .slice(0, 10);
  return { minimum, maximumExclusive, today };
}
function countWeekdays(start: string, end: string): number {
  if (!start || !end) return 0;
  const s = new Date(start + "T12:00:00Z");
  const e = new Date(end + "T12:00:00Z");
  let count = 0;
  for (const d = new Date(s); d < e; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) count++;
  }
  return count;
}
const normalizeKey = (s: string | undefined | null) =>
  String(s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function getMonthPeriod(month: string, today: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${month}-01`;
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { start, end: nextMonth < tomorrow ? nextMonth : tomorrow };
}

// ───────────────────────────────────────────────────────────
type StatKey =
  | "received" | "worked" | "contact" | "signed"
  | "gained" | "protocolados" | "disq";

type FiltersState = {
  equipe: string;
  colaborador: string;
  colaboradorId?: string | number;
  produto: string;
  unidadeId?: number;
};

const STAT_CARDS: {
  key: StatKey;
  label: string;
  sub: string;
  highlight?: "signed" | "disq";
}[] = [
  { key: "received",     label: "Negócios criados", sub: "Dentro do período de criação da coorte" },
  { key: "worked",       label: "Trabalhados",     sub: "Movimentação no CRM" },
  { key: "contact",      label: "Em contato",      sub: "Etapa Em contato" },
  { key: "signed",       label: "Assinados",       sub: "ORIGINAL · dentro do período medido", highlight: "signed" },
  { key: "gained",       label: "Ganhos",          sub: "Ganho registrado no Deal" },
  { key: "protocolados", label: "Protocolados",    sub: "Protocolo registrado" },
  { key: "disq",         label: "Desqualificados", sub: "Saída do Closer", highlight: "disq" },
];

const FUNNEL_STAGES: { key: keyof InteComerceFunnel; label: string; gradient: string }[] = [
  { key: "recebidos",     label: "Recebidos",     gradient: "from-[#3972e0] to-[#83adfa]" },
  { key: "trabalhados",   label: "Trabalhados",   gradient: "from-[#3685e8] to-[#61aee8]" },
  { key: "em_contato",    label: "Em contato",    gradient: "from-[#269cc1] to-[#6ac4d5]" },
  { key: "coleta",        label: "Coleta",        gradient: "from-[#2c9aa8] to-[#5dbec4]" },
  { key: "contrato",      label: "Contrato",      gradient: "from-[#2c9aa8] to-[#5dbec4]" },
  { key: "emitidos",      label: "Emitidos",      gradient: "from-[#2c9aa8] to-[#5dbec4]" },
  { key: "assinados",     label: "Assinados",     gradient: "from-[#299875] to-[#6ac9a2]" },
  { key: "ganhos",        label: "Ganhos",        gradient: "from-[#299875] to-[#6ac9a2]" },
  { key: "protocolados",  label: "Protocolados",  gradient: "from-[#299875] to-[#6ac9a2]" },
];

const EMPTY_OVERVIEW: InteComerceOverview = {
  recebidos: 0, trabalhados_proxy: 0, em_contato_crm: 0,
  assinados: 0, ganhos: 0, protocolados: 0, desqualificados: 0,
};
const EMPTY_STRATEGIC: InteComerceStrategic = {
  recebidos: 0, em_contato: 0, assinados: 0, assinados_que_ganharam: 0,
  pct_recebidos_ate_assinados: 0, pct_recebidos_ate_em_contato: 0,
  pct_assinados_ate_ganhos: 0, variacao_safra_sem_maturidade_equivalente: null,
};
const EMPTY_FUNNEL: InteComerceFunnel = {
  recebidos: 0, trabalhados: 0, em_contato: 0, coleta: 0, contrato: 0,
  emitidos: 0, assinados: 0, ganhos: 0, protocolados: 0,
  desqualificados_saida: 0, coleta_sem_contato_observado: 0,
};
type Row = {
  key: string;
  name: string;
  team: string;
  received: number;
  worked: number;
  contact: number;
  collection: number;
  signed: number;
  gained: number;
  protocolados: number;
};

type ComparisonSlice = Pick<
  InteComerceOverview,
  "recebidos" | "assinados" | "ganhos" | "protocolados"
>;
type ComparisonBlock = { day: ComparisonSlice | null; month: ComparisonSlice };
type AllResult = Awaited<ReturnType<typeof fetchInteComerceAll>>;

// ───────────────────────────────────────────────────────────
//  ESTILOS DE PRIORIDADE
// ───────────────────────────────────────────────────────────
const REC_PRIORITY_STYLES: Record<
  RecommendationPriority,
  { border: string; bg: string; text: string; label: string; Icon: LucideIcon }
> = {
  info:    { border: "border-sky-200",   bg: "bg-sky-50",   text: "text-sky-700",   label: "Informativa", Icon: Info },
  warning: { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-700", label: "Atenção",     Icon: AlertCircle },
  danger:  { border: "border-red-200",   bg: "bg-red-50",   text: "text-red-700",   label: "Urgente",     Icon: AlertTriangle },
};

// ───────────────────────────────────────────────────────────
//  CARD DE RECOMENDAÇÕES TEMPORÁRIAS (24h) — compacto
// ───────────────────────────────────────────────────────────
function RecomendacoesCard({
  filters,
  colaboradores,
}: {
  filters: FiltersState;
  colaboradores: Collaborator[];
}) {
  const { currentUser } = useAccessControl();
  const userLevel = getAccessLevel(currentUser?.cargo, currentUser?.status);
  const canAuthorRecommendations = userLevel >= LEVELS.SUPERVISAO;
  const canDeleteAny = userLevel >= LEVELS.COORDENADOR;

  const targetColaboradores = useMemo<Collaborator[]>(() => {
    const isIndividual =
      filters.colaboradorId != null ||
      (filters.colaborador && filters.colaborador !== "todos");

    if (isIndividual) {
      return colaboradores.filter(
        (c) =>
          (filters.colaboradorId != null &&
            String(c.id) === String(filters.colaboradorId)) ||
          (filters.colaborador &&
            filters.colaborador !== "todos" &&
            c.name === filters.colaborador),
      );
    }

    if (filters.equipe && filters.equipe !== "todas") {
      const eq = normalizeKey(filters.equipe);
      return colaboradores.filter(
        (c) => normalizeKey(c.equipeNome) === eq,
      );
    }

    return [];
  }, [filters, colaboradores]);

  const targetLabel = useMemo(() => {
    if (targetColaboradores.length === 0) return "—";
    if (targetColaboradores.length === 1) return targetColaboradores[0].name;
    return `${targetColaboradores.length} colaboradores da equipe ${filters.equipe}`;
  }, [targetColaboradores, filters.equipe]);

  const [tempRecs, setTempRecs] = useState<TemporaryRecommendation[]>([]);
  const [newRecText, setNewRecText] = useState("");
  const [newRecPriority, setNewRecPriority] =
    useState<RecommendationPriority>("info");
  const [sendingRec, setSendingRec] = useState(false);

  const targetIdsKey = targetColaboradores.map((c) => c.id).join(",");

  useEffect(() => {
    if (targetColaboradores.length === 0) {
      setTempRecs([]);
      return;
    }
    const refresh = () => {
      const all: TemporaryRecommendation[] = [];
      for (const c of targetColaboradores) {
        all.push(...getActiveRecommendationsFor(c.id));
      }
      setTempRecs(all);
    };
    refresh();
    const unsub = subscribeRecommendations(refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIdsKey]);

  const grouped = useMemo(() => {
    const map = new Map<
      string,
      { key: string; rec: TemporaryRecommendation; ids: string[]; targetNames: string[] }
    >();
    const nameById = new Map(targetColaboradores.map((c) => [String(c.id), c.name]));
    for (const r of tempRecs) {
      const key = `${r.text}|${r.authorId}|${r.expiresAt}`;
      if (!map.has(key)) map.set(key, { key, rec: r, ids: [], targetNames: [] });
      const entry = map.get(key)!;
      entry.ids.push(r.id);
      const name = nameById.get(String((r as any).targetId)) || (r as any).targetName || "—";
      if (!entry.targetNames.includes(name)) entry.targetNames.push(name);
    }
    return Array.from(map.values());
  }, [tempRecs, targetColaboradores]);

  const handleAddRec = () => {
    if (!currentUser || targetColaboradores.length === 0) return;
    const txt = newRecText.trim();
    if (!txt) return;
    setSendingRec(true);
    try {
      for (const c of targetColaboradores) {
        addRecommendation({
          targetId: c.id,
          targetName: c.name,
          targetEmail: c.email,
          authorId: currentUser.id,
          authorName: currentUser.nome ?? currentUser.email ?? "Usuário",
          authorCargo: currentUser.cargo ?? "Não informado",
          text: txt,
          priority: newRecPriority,
        });
      }
      setNewRecText("");
      setNewRecPriority("info");
    } finally {
      setSendingRec(false);
    }
  };

  const handleRemoveRec = (ids: string[]) => {
    for (const id of ids) removeRecommendation(id);
  };

  if (!canAuthorRecommendations) return null;

  const hasTarget = targetColaboradores.length > 0;

  return (
    <details className="card mb-4 group">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-[13px] font-semibold text-slate-700 [&::-webkit-details-marker]:hidden">
        <Megaphone size={15} className="text-amber-600" />
        <span>Recomendações temporárias</span>
        <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-medium">
          Ativas por 24h
        </span>
        <span className="text-[11px] font-normal text-slate-500 ml-auto">
          Alvo atual: <b>{targetLabel}</b>
        </span>
        <ChevronDown size={15} className="shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-slate-100 p-3">
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="text-[11px] text-slate-500">
            Orientações direcionadas ao filtro selecionado.
          </span>
        </div>

        {!hasTarget ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3">
            <p className="text-[12px] text-slate-500">
              Selecione uma <b>equipe</b> ou um <b>colaborador</b> no filtro acima
              para publicar ou visualizar recomendações temporárias.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-2.5 mb-3">
              <p className="text-[11px] font-semibold text-slate-700 mb-1.5">
                Nova recomendação para{" "}
                {targetColaboradores.length === 1
                  ? targetColaboradores[0].name
                  : `${targetColaboradores.length} colaboradores da equipe ${filters.equipe}`}
              </p>
              <textarea
                value={newRecText}
                onChange={(e) => setNewRecText(e.target.value)}
                placeholder="Escreva uma orientação temporária (válida por 24h)..."
                rows={2}
                maxLength={500}
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
              />
              <div className="flex flex-wrap items-center gap-2 mt-1.5 justify-between">
                <div className="flex items-center gap-1.5">
                  {(["info", "warning", "danger"] as RecommendationPriority[]).map((p) => {
                    const style = REC_PRIORITY_STYLES[p];
                    const PIcon = style.Icon;
                    const active = newRecPriority === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setNewRecPriority(p)}
                        className={cn(
                          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium border transition-colors",
                          active
                            ? `${style.bg} ${style.text} ${style.border}`
                            : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50",
                        )}
                      >
                        <PIcon size={10} />
                        {style.label}
                      </button>
                    );
                  })}
                  <span className="text-[10px] text-slate-400 ml-1">
                    {newRecText.length}/500
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleAddRec}
                  disabled={!newRecText.trim() || sendingRec}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {sendingRec ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                  Publicar (24h)
                </button>
              </div>
            </div>

            {grouped.length > 0 ? (
              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">
                  Orientações ativas
                </p>
                <ul className="space-y-2">
                  {grouped.map((entry) => {
                    const style = REC_PRIORITY_STYLES[entry.rec.priority];
                    const canDelete = canDeleteAny || entry.rec.authorId === currentUser?.id;
                    const targetsLabel =
                      entry.targetNames.length === 1
                        ? entry.targetNames[0]
                        : `${entry.targetNames.length} colaboradores`;
                    return (
                      <li
                        key={entry.key}
                        className={cn("flex gap-2 items-start p-2 rounded-lg border", style.border, style.bg)}
                      >
                        <style.Icon size={13} className={cn("mt-0.5 shrink-0", style.text)} />
                        <div className="flex-1 min-w-0">
                          <p className={cn("text-[12px] whitespace-pre-wrap break-words", style.text)}>
                            {entry.rec.text}
                          </p>
                          <p className="text-[10px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-2">
                            <span>{entry.rec.authorName} · {entry.rec.authorCargo}</span>
                            <span className="inline-flex items-center gap-1">
                              <Clock size={9} /> expira em {getRemainingTimeLabel(entry.rec.expiresAt)}
                            </span>
                            <span className="text-slate-400">· para {targetsLabel}</span>
                          </p>
                        </div>
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => handleRemoveRec(entry.ids)}
                            className="shrink-0 p-1 rounded text-slate-400 hover:text-red-600 hover:bg-white"
                            title="Remover recomendação"
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="text-[12px] text-slate-400 italic">
                Nenhuma orientação temporária ativa para {targetLabel}.
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

// ───────────────────────────────────────────────────────────
export default function Inte_comerce() {
  const { collaborators } = useAppStore();
  const [today] = useState(() => new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date()));
  const [viewMode, setViewMode] = useState<"safra" | "producao">("safra");
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7));
  // ⬇️ opcionais; sem preenchimento não há comparativo
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [comparisonMonth, setComparisonMonth] = useState<string | null>(null);

  const reportPeriod = useMemo(() => {
    const limits = getInteComerceDateLimits(new Date(`${today}T12:00:00`), 24);
    const [year, month] = selectedMonth.split("-").map(Number);
    const start = `${selectedMonth}-01`;
    const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const end = nextMonth < limits.maximumExclusive ? nextMonth : limits.maximumExclusive;
    return {
      start, end, clipped: false,
      unavailable:
        selectedMonth > today.slice(0, 7) ||
        start < limits.minimum ||
        end <= start,
      limits,
    };
  }, [selectedMonth, today]);

  const comparisonPeriod = useMemo(
    () => (comparisonMonth ? getMonthPeriod(comparisonMonth, today) : null),
    [comparisonMonth, today],
  );

  const [filters, setFilters] = useState<FiltersState>({
    equipe: "todas",
    colaborador: "todos",
    produto: "Todos",
    unidadeId: undefined,
  });
  const { equipe, colaborador, colaboradorId, produto } = filters;

  const [grouping, setGrouping] = useState<"person" | "team">("person");
  const [search, setSearch] = useState<string>("");
  const [sortKey, setSortKey] = useState<string>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  const [showAllReasons, setShowAllReasons] = useState(false);
  const [dataAsOf, setDataAsOf] = useState<string | null>(null);
  const [safraComparison, setSafraComparison] = useState<ComparisonBlock | null>(null);
  const [productionComparison, setProductionComparison] = useState<ComparisonBlock | null>(null);
  const [comparisonResult, setComparisonResult] = useState<AllResult | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [overview, setOverview] = useState<InteComerceOverview>(EMPTY_OVERVIEW);
  const [strategic, setStrategic] = useState<InteComerceStrategic>(EMPTY_STRATEGIC);
  const [funnel, setFunnel] = useState<InteComerceFunnel>(EMPTY_FUNNEL);
  const [reasons, setReasons] = useState<InteComerceReason[]>([]);
  const [daily, setDaily] = useState<InteComerceDaily[]>([]);
  const [collabTable, setCollabTable] = useState<InteComerceCollaborator[]>([]);
  const [teamTable, setTeamTable] = useState<InteComerceTeam[]>([]);

  // ── Carregamento
  const reloadData = useCallback(async () => {
    if (!reportPeriod.start || !reportPeriod.end) return;
    if (reportPeriod.unavailable) {
      setLoading(false);
      setOverview(EMPTY_OVERVIEW);
      setStrategic(EMPTY_STRATEGIC);
      setFunnel(EMPTY_FUNNEL);
      setReasons([]);
      setDaily([]);
      setDataAsOf(null);
      setCollabTable([]);
      setTeamTable([]);
      setTableError(null);
      setSafraComparison(null);
      setProductionComparison(null);
      setComparisonResult(null);
      setError(
        `O período selecionado não contém datas disponíveis. Esta visão permite consultar de ${dateBr(reportPeriod.limits?.minimum || "")} até hoje.`,
      );
      return;
    }
    setLoading(true);
    setError(null);
    setTableError(null);

    const dayParam =
      (viewMode === "safra" || viewMode === "producao") && selectedDay
        ? selectedDay
        : undefined;

    const params = {
      start: reportPeriod.start,
      end: reportPeriod.end,
      equipe: equipe !== "todas" ? equipe : undefined,
      colaboradorId,
      produto,
      unidadeId: filters.unidadeId,
      mode: viewMode,
      selectedDay: dayParam,
    };

    const comparisonParams =
      comparisonPeriod
        ? {
            ...params,
            start: comparisonPeriod.start,
            end: comparisonPeriod.end,
            mode: viewMode,
            selectedDay: undefined,
          }
        : null;

    try {
      const [allResult, tableResult, monthCompareResult] = await Promise.allSettled([
        fetchInteComerceAll(params),
        grouping === "team"
          ? fetchInteComerceTeams(params).then((data) => ({ kind: "team" as const, data }))
          : fetchInteComerceCollaborators(params).then((data) => ({ kind: "person" as const, data })),
        comparisonParams ? fetchInteComerceAll(comparisonParams) : Promise.resolve(null),
      ]);

      if (allResult.status === "fulfilled") {
        setDataAsOf(allResult.value.dataAsOf || null);
        setOverview(allResult.value.overview || EMPTY_OVERVIEW);
        setStrategic(allResult.value.strategic || EMPTY_STRATEGIC);
        setFunnel(allResult.value.funnel || EMPTY_FUNNEL);
        setReasons(allResult.value.reasons || []);
        setDaily(allResult.value.daily || []);
        setSafraComparison((allResult.value.safraComparison as any) || null);
        setProductionComparison((allResult.value.productionComparison as any) || null);
      } else {
        console.error("Erro ao carregar indicadores de Inte_comerce:", allResult.reason);
        setError(
          allResult.reason instanceof Error
            ? allResult.reason.message
            : "Falha ao carregar os indicadores.",
        );
      }

      if (comparisonParams) {
        if (monthCompareResult.status === "fulfilled" && monthCompareResult.value) {
          setComparisonResult(monthCompareResult.value as AllResult);
          setComparisonError(null);
        } else {
          setComparisonResult(null);
          setComparisonError(
            monthCompareResult.status === "rejected"
              ? (monthCompareResult.reason instanceof Error
                  ? monthCompareResult.reason.message
                  : "Falha ao carregar o mês de comparação.")
              : null,
          );
        }
      } else {
        setComparisonResult(null);
        setComparisonError(null);
      }

      if (tableResult.status === "fulfilled") {
        setTableError(null);
        if (tableResult.value.kind === "team") setTeamTable(tableResult.value.data || []);
        else setCollabTable(tableResult.value.data || []);
      } else {
        console.warn("Tabela de Inte_comerce indisponível:", tableResult.reason);
        setTableError(
          tableResult.reason instanceof Error
            ? tableResult.reason.message
            : "Falha ao carregar a tabela.",
        );
        if (grouping === "team") setTeamTable([]);
        else setCollabTable([]);
      }
    } finally {
      setLoading(false);
    }
  }, [
    reportPeriod, equipe, colaboradorId, produto, filters.unidadeId,
    grouping, viewMode, selectedDay, comparisonPeriod,
  ]);

  useEffect(() => { void reloadData(); }, [reloadData]);

  const handleFilterChange = useCallback((rawFilters: FiltersState) => {
    setFilters((prev) => {
      if (
        prev.equipe === rawFilters.equipe &&
        prev.colaborador === rawFilters.colaborador &&
        String(prev.colaboradorId ?? "") === String(rawFilters.colaboradorId ?? "") &&
        prev.produto === rawFilters.produto &&
        prev.unidadeId === rawFilters.unidadeId
      ) return prev;
      return rawFilters;
    });
  }, []);

  const handleRefresh = useCallback(async () => { await reloadData(); }, [reloadData]);

  // ── Derivados
  const aggregates = useMemo(
    () => ({
      received: overview.recebidos,
      worked: overview.trabalhados_proxy,
      contact: overview.em_contato_crm,
      signed: overview.assinados,
      gained: overview.ganhos,
      protocolados: overview.protocolados,
      disq: overview.desqualificados,
    }),
    [overview],
  );

  const comparisonOverview = comparisonResult?.overview ?? null;
  const comparisonFunnel = comparisonResult?.funnel ?? null;
  const comparisonStrategic = comparisonResult?.strategic ?? null;
  const comparisonReasons = comparisonResult?.reasons ?? [];
  const comparisonDaily = comparisonResult?.daily ?? [];
  const hasComparison = !!comparisonResult;

  // Evolução diária com sobreposição (por dia do mês)
  const seriesData = useMemo(() => {
    const compByDom = new Map<string, InteComerceDaily>();
    for (const d of comparisonDaily) compByDom.set(d.dia.slice(-2), d);
    return daily.map((d) => {
      const dom = d.dia.slice(-2);
      const comp = compByDom.get(dom);
      return {
        dayOfMonth: dom,
        date: d.dia,
        received: d.recebidos,
        signed: d.assinados_ate_corte,
        receivedComp: comp?.recebidos ?? null,
        signedComp: comp?.assinados_ate_corte ?? null,
      };
    });
  }, [daily, comparisonDaily]);

  const tableRows = useMemo<Row[]>(() => {
    if (grouping === "team") {
      return teamTable.map((t) => ({
        key: t.equipe, name: t.equipe, team: t.equipe,
        received: t.recebimentos_assessor_deal_dia,
        worked: t.trabalhados, contact: t.em_contato,
        collection: t.coleta, signed: t.assinados,
        gained: t.ganhos, protocolados: t.protocolados,
      }));
    }
    return collabTable.map((c) => ({
      key: c.colaborador_id || c.colaborador,
      name: c.colaborador, team: c.equipe_atual || "—",
      received: c.recebimentos_deal_dia,
      worked: c.trabalhados, contact: c.em_contato,
      collection: c.coleta, signed: c.assinados,
      gained: c.ganhos, protocolados: c.protocolados,
    }));
  }, [grouping, collabTable, teamTable]);

  const filteredTable = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("pt-BR");
    let arr = tableRows;
    if (q) arr = arr.filter((r) =>
      `${r.name} ${r.team}`.toLocaleLowerCase("pt-BR").includes(q),
    );
    return [...arr].sort((a, b) => {
      const va: any = (a as any)[sortKey];
      const vb: any = (b as any)[sortKey];
      if (typeof va === "string" || typeof vb === "string") {
        return String(va || "").localeCompare(String(vb || ""), "pt-BR") * sortDir;
      }
      return ((va || 0) - (vb || 0)) * sortDir;
    });
  }, [tableRows, search, sortKey, sortDir]);

  const pctOfPrevious = (index: number) => {
    if (index === 0) return "100%";
    const prev = FUNNEL_STAGES[index - 1].key;
    const curr = FUNNEL_STAGES[index].key;
    return formatPct(funnel[curr] as number, funnel[prev] as number);
  };

  const weekdays = countWeekdays(reportPeriod.start, reportPeriod.end);
  const avgSignedPerDay = weekdays ? aggregates.signed / weekdays : 0;
  const comparisonWeekdays = comparisonPeriod
    ? countWeekdays(comparisonPeriod.start, comparisonPeriod.end)
    : 0;
  const comparisonAvgSignedPerDay =
    comparisonWeekdays && comparisonStrategic
      ? comparisonStrategic.assinados / comparisonWeekdays
      : 0;

  const hasActiveFilters =
    equipe !== "todas" || colaborador !== "todos" || produto !== "Todos";

  const maxDisqReasons = reasons.reduce(
    (m, r) => Math.max(m, r.deals_desqualificados), 0,
  );

  // Motivos com sobreposição do mês comparativo
  const mergedReasons = useMemo(() => {
    const map = new Map<string, { motivo: string; current: number; comp: number }>();
    for (const r of reasons) {
      map.set(r.motivo, { motivo: r.motivo, current: r.deals_desqualificados, comp: 0 });
    }
    for (const r of comparisonReasons) {
      const e = map.get(r.motivo) || { motivo: r.motivo, current: 0, comp: 0 };
      e.comp = r.deals_desqualificados;
      map.set(r.motivo, e);
    }
    return Array.from(map.values())
      .sort((a, b) => Math.max(b.current, b.comp) - Math.max(a.current, a.comp))
      .slice(0, showAllReasons ? undefined : 10);
  }, [reasons, comparisonReasons, showAllReasons]);

  const maxMergedReason = mergedReasons.reduce(
    (m, r) => Math.max(m, r.current, r.comp), 0,
  );

  // Tabela comparativa (adaptativa)
  const comparisonTableRows = useMemo(() => {
    const data = viewMode === "safra" ? safraComparison : productionComparison;
    const hasDay = !!selectedDay;
    const hasComp = hasComparison;
    const metrics = [
      ["recebidos", viewMode === "producao" ? "Leads recebidos" : "Negócios criados"],
      ["assinados", "Assinados"],
      ["ganhos", "Ganhos"],
      ["protocolados", "Protocolados"],
    ] as const;
    return metrics.map(([key, label]) => {
      const dayValue = hasDay
        ? ((data as any)?.day?.[key] as number | null | undefined)
        : undefined;
      const monthValue = (data as any)?.month?.[key] as number | undefined;
      const comparedValue = hasComp
        ? ((comparisonOverview as any)?.[key] as number | undefined)
        : undefined;
      const variation =
        hasComp && comparedValue
          ? (((monthValue || 0) - comparedValue) / comparedValue) * 100
          : null;
      return { key, label, dayValue, monthValue, comparedValue, variation };
    });
  }, [
    viewMode, safraComparison, productionComparison,
    selectedDay, hasComparison, comparisonOverview,
  ]);

  const handleExportCsv = () => {
    if (filteredTable.length === 0) return;
    const header = [
      grouping === "person" ? "Colaborador" : "Equipe",
      "Equipe", "Recebidos", "Trabalhados", "Em contato",
      "Coleta", "Assinados", "Ganhos", "Protocolados",
    ];
    const rows = filteredTable.map((r) => [
      r.name, r.team, r.received, r.worked, r.contact,
      r.collection, r.signed, r.gained, r.protocolados,
    ]);
    const csv = "\uFEFF" + [header, ...rows]
      .map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";"))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `producao_comercial_${reportPeriod.start || "inicio"}_${reportPeriod.end || "fim"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportComparison = () => {
    if (comparisonTableRows.length === 0) return;
    const hasDay = !!selectedDay;
    const hasComp = hasComparison;
    const header = ["Indicador"];
    if (hasDay) header.push("Dia");
    header.push("Total mês");
    if (hasDay) header.push("Dia / mês");
    if (hasComp) header.push("Total comparação", "Variação");
    const rows = comparisonTableRows.map((r) => {
      const row: (string | number)[] = [r.label];
      if (hasDay) row.push(r.dayValue == null ? "" : r.dayValue);
      row.push(r.monthValue == null ? "" : r.monthValue);
      if (hasDay) row.push(formatPct(r.dayValue || 0, r.monthValue || 0));
      if (hasComp) {
        row.push(r.comparedValue == null ? "" : r.comparedValue);
        row.push(
          r.variation == null
            ? ""
            : `${r.variation > 0 ? "+" : ""}${r.variation.toFixed(1).replace(".", ",")}%`,
        );
      }
      return row;
    });
    const csv = "\uFEFF" + [header, ...rows]
      .map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";"))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `comparativo_${viewMode}_${selectedMonth}${selectedDay ? `_${selectedDay}` : ""}${comparisonMonth ? `_vs_${comparisonMonth}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleMonthChange = (value: string) => {
    if (!/^\d{4}-\d{2}$/.test(value)) return;
    setSelectedMonth(value);
    if (selectedDay) {
      const [year, month] = value.split("-").map(Number);
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const preferredDay = Number(selectedDay.slice(-2)) || 1;
      const todayDay = Number(today.slice(-2));
      const maxDay = value === today.slice(0, 7) ? todayDay : daysInMonth;
      const day = Math.min(preferredDay, daysInMonth, maxDay);
      setSelectedDay(`${value}-${String(day).padStart(2, "0")}`);
    }
    if (comparisonMonth === value) setComparisonMonth(null);
  };

  const selectedMonthDays = (() => {
    const [year, month] = selectedMonth.split("-").map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return selectedMonth === today.slice(0, 7)
      ? Math.min(daysInMonth, Number(today.slice(-2)))
      : daysInMonth;
  })();

  const modeLabel = viewMode === "safra" ? "Safra" : "Produção";

  const modeDescription = viewMode === "safra"
    ? (selectedDay
        ? `Negócios criados em ${selectedMonth}; resultados realizados em ${dateBr(selectedDay)}.`
        : `Negócios criados em ${selectedMonth}; resultados realizados no mês selecionado.`)
    : (selectedDay
        ? `Produção realizada em ${dateBr(selectedDay)} comparada ao total do mês ${selectedMonth}, sem restringir a data de criação dos negócios.`
        : `Produção realizada no mês ${selectedMonth}, sem restringir a data de criação dos negócios.`);

  const comparisonSectionTitle = viewMode === "safra"
    ? "Comparativo da safra"
    : "Comparativo da produção";
  const comparisonSectionDescription = viewMode === "safra"
    ? (selectedDay
        ? `Dia ${dateBr(selectedDay)} × total de ${selectedMonth} × mês ${comparisonMonth}.`
        : `Total de ${selectedMonth} × mês ${comparisonMonth}.`)
    : (selectedDay
        ? `Produção do dia ${dateBr(selectedDay)}, do mês ${selectedMonth} e do mês ${comparisonMonth}.`
        : `Total de ${selectedMonth} × mês ${comparisonMonth}.`);

  // ═══════════════════════════════════════════════════════════
  return (
    <DashboardLayout
      title="Inteligência Comercial"
      subtitle="Visão consolidada da operação, da distribuição à assinatura e ao resultado jurídico, em uma única página."
      showPeriodFilter={false}
    >
      <FilterBar
        onFilterChange={handleFilterChange}
        showColaboradorFilter={true}
        className="mb-3"
        onRefresh={handleRefresh}
      />
      <RecomendacoesCard filters={filters} colaboradores={collaborators} />

      <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Modo do relatório">
        {([
          ["safra", "Safra"],
          ["producao", "Produção"],
        ] as const).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            aria-pressed={viewMode === mode}
            onClick={() => setViewMode(mode)}
            className={cn(
              "rounded-lg border px-3 py-2 text-xs font-semibold transition-colors",
              viewMode === mode
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Mês
          <input
            type="month"
            min={reportPeriod.limits?.minimum.slice(0, 7)}
            max={today.slice(0, 7)}
            value={selectedMonth}
            onChange={(event) => handleMonthChange(event.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-800"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Dia para comparar
          <select
            value={selectedDay ? selectedDay.slice(-2) : ""}
            onChange={(event) => {
              const v = event.target.value;
              setSelectedDay(v ? `${selectedMonth}-${v}` : null);
            }}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-800"
          >
            <option value="">Selecione um dia</option>
            {Array.from({ length: selectedMonthDays }, (_, index) => {
              const day = String(index + 1).padStart(2, "0");
              return <option key={day} value={day}>{day}</option>;
            })}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-slate-600">
          Comparar mês com
          <div className="flex items-center gap-1">
            <input
              type="month"
              min={reportPeriod.limits?.minimum.slice(0, 7)}
              max={today.slice(0, 7)}
              value={comparisonMonth ?? ""}
              onChange={(event) => setComparisonMonth(event.target.value || null)}
              placeholder="Selecione"
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal text-slate-800"
            />
            {comparisonMonth && (
              <button
                type="button"
                onClick={() => setComparisonMonth(null)}
                className="rounded-md px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100"
                title="Limpar comparação"
              >
                Limpar
              </button>
            )}
          </div>
        </label>
      </div>
      <p className="mb-4 text-xs text-slate-500">{modeDescription}</p>

      {/* ── Comparativo: só aparece com mês de comparação; recolhido por padrão ── */}
      {hasComparison && (
        <details className="card mb-4 group">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold text-slate-800">
                {comparisonSectionTitle}
              </h2>
              <p className="mt-0.5 text-[11px] text-slate-500 truncate">
                {comparisonSectionDescription}
              </p>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleExportComparison();
              }}
              disabled={comparisonTableRows.length === 0}
              className="inline-flex items-center gap-1 px-2 py-1 border border-[#e2e8f0] rounded-md text-[11px] font-semibold text-[#475569] bg-white hover:bg-[#f1f5f9] disabled:opacity-50 disabled:cursor-not-allowed"
              title="Exportar comparativo em CSV"
            >
              <Download className="w-3 h-3" />
              CSV
            </button>
            <ChevronDown
              size={15}
              className="shrink-0 text-slate-400 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="overflow-x-auto border-t border-slate-100 [&_th]:py-1.5 [&_th]:text-[11px] [&_td]:py-1.5 [&_td]:text-[11px]">
            <table className="simple-table w-full">
              <thead>
                <tr>
                  <th>Indicador</th>
                  {selectedDay && <th className="text-right">{dateBr(selectedDay)}</th>}
                  <th className="text-right">
                    Total {selectedMonth}{selectedMonth === today.slice(0, 7) ? " · até hoje" : ""}
                  </th>
                  {selectedDay && <th className="text-right">Dia / mês</th>}
                  <th className="text-right">Total {comparisonMonth}</th>
                  <th className="text-right">Variação entre períodos</th>
                </tr>
              </thead>
              <tbody>
                {comparisonTableRows.map((r) => (
                  <tr key={r.key}>
                    <td className="font-semibold">{r.label}</td>
                    {selectedDay && (
                      <td className="text-right tabular-nums">
                        {r.dayValue == null ? "—" : formatInt(r.dayValue)}
                      </td>
                    )}
                    <td className="text-right tabular-nums">
                      {r.monthValue == null ? "—" : formatInt(r.monthValue)}
                    </td>
                    {selectedDay && (
                      <td className="text-right tabular-nums">
                        {formatPct(r.dayValue || 0, r.monthValue || 0)}
                      </td>
                    )}
                    <td className="text-right tabular-nums">
                      {r.comparedValue == null ? "—" : formatInt(r.comparedValue)}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.variation == null
                        ? "—"
                        : `${r.variation > 0 ? "+" : ""}${r.variation.toFixed(1).replace(".", ",")}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {comparisonError && (
            <p className="border-t border-red-100 bg-red-50 px-4 py-1.5 text-[11px] text-red-700">
              Não foi possível carregar o mês de comparação: {comparisonError}
            </p>
          )}
        </details>
      )}

      {dataAsOf && (
        <div className="mb-4 text-xs text-slate-500" role="status">
          Dados consultados até {dateTimeBr(dataAsOf)}.
        </div>
      )}

      {hasActiveFilters && (
        <div className="mb-4 px-4 py-2 bg-[#eff6ff] rounded-lg text-xs text-[#2F6FED] flex items-center gap-2 flex-wrap">
          <span>📊</span>
          <span>
            Mostrando dados de:
            {equipe !== "todas" && ` ${equipe}`}
            {colaborador !== "todos" && ` - ${colaborador}`}
            {produto !== "Todos" && ` - Produto: ${produto}`}
          </span>
        </div>
      )}

      {loading && (
        <div className="mb-4 flex items-center gap-2 text-xs text-[#64748b]">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando dados de Inte_comerce…
        </div>
      )}

      {error && (
        <div className="mb-4 bg-red-50 text-red-700 p-3 rounded-lg text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-semibold">Não foi possível carregar os dados.</p>
            <p className="mt-0.5">{error}</p>
            <button
              type="button"
              onClick={() => void reloadData()}
              className="mt-2 px-3 py-1 bg-red-600 text-white rounded text-[11px] font-semibold hover:bg-red-700"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )}

      {/* 1) VISÃO GERAL — sempre mês de referência */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-[#0f172a]">Visão geral do funil</h2>
            <p className="text-xs text-[#64748b]">
              Indicadores do mês de referência ({modeLabel}).
            </p>
          </div>
          <span className="badge info">{modeLabel} · K01A</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {STAT_CARDS.map((card) => (
            <div key={card.key} className="card p-4">
              <div className="text-[11px] text-[#64748b] font-medium">
                {viewMode === "producao" && card.key === "received"
                  ? "Leads recebidos"
                  : card.label}
              </div>
              <div
                className={cn(
                  "text-2xl font-extrabold mt-2 tabular-nums",
                  card.highlight === "signed" && "text-[#2F6FED]",
                  card.highlight === "disq" && "text-[#DC2626]",
                  !card.highlight && "text-[#0f172a]",
                )}
              >
                {formatInt(aggregates[card.key])}
              </div>
              <div className="text-[10px] text-[#94a3b8] mt-1 leading-snug min-h-[32px]">
                {viewMode === "producao" && card.key === "received"
                  ? "Recebidos no período, sem restrição de criação"
                  : card.sub}
              </div>
              <div
                className={cn(
                  "mt-3 h-1 w-6 rounded-full",
                  card.highlight === "disq" ? "bg-[#DC2626]" : "bg-[#2F6FED]",
                )}
              />
            </div>
          ))}
        </div>
      </div>

      {/* 2) PERFORMANCE COMERCIAL — mostra ambos os meses */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-[#0f172a]">Performance Comercial</h2>
            <p className="text-xs text-[#64748b]">
              Métricas estratégicas do mês de referência{hasComparison ? " e do mês de comparação" : ""}.
            </p>
          </div>
          <span className="badge info">{modeLabel} · K02A</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          {/* Card 1 — Média de assinados / dia */}
          <div className="card p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#407de5]" />
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-[#50627a]">Média de assinados / dia</h3>
              <span className="badge success">{modeLabel}</span>
            </div>
            <div className="text-4xl font-black tracking-tight mt-3 tabular-nums text-[#0f172a]">
              {avgSignedPerDay.toFixed(1).replace(".", ",")}
            </div>
            <p className="text-[11px] text-[#8c9bae] mt-3 min-h-[36px]">
              {formatInt(aggregates.signed)} assinados · {formatInt(weekdays)} dias de semana
            </p>
            {hasComparison && (
              <p className="text-[11px] text-slate-500 mt-1">
                Comparação ({comparisonMonth}): <b>{comparisonAvgSignedPerDay.toFixed(1).replace(".", ",")}</b>
              </p>
            )}
            <div className="border-t border-[#eaf0f6] pt-3 mt-3 text-[11px] text-[#61768f]">
              Assinados ORIGINAL no período medido ÷ dias úteis do período.
            </div>
          </div>

          {/* Card 2 — Conversão geral */}
          <div className="card p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#1a9ac5]" />
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-[#50627a]">Conversão geral operacional</h3>
              <span className="badge info">{modeLabel}</span>
            </div>
            <div className="text-4xl font-black tracking-tight mt-3 tabular-nums text-[#0f172a]">
              {strategic.pct_recebidos_ate_assinados != null
                ? `${strategic.pct_recebidos_ate_assinados.toFixed(1).replace(".", ",")}%`
                : "—"}
            </div>
            <p className="text-[11px] text-[#8c9bae] mt-3 min-h-[36px]">
              {formatInt(strategic.assinados)} assinados ÷ {formatInt(strategic.recebidos)} recebidos
            </p>
            {hasComparison && (
              <p className="text-[11px] text-slate-500 mt-1">
                Comparação ({comparisonMonth}):{" "}
                <b>
                  {comparisonStrategic?.pct_recebidos_ate_assinados != null
                    ? `${comparisonStrategic.pct_recebidos_ate_assinados.toFixed(1).replace(".", ",")}%`
                    : "—"}
                </b>
              </p>
            )}
            <div className="border-t border-[#eaf0f6] pt-3 mt-3 text-[11px] text-[#61768f]">
              {viewMode === "producao"
                ? "Assinados no período ÷ recebidos no período. Não é conversão por coorte: os eventos podem pertencer a negócios criados em outros períodos."
                : "Recebidos → assinados na mesma safra (K02A)."}
            </div>
          </div>

          {/* Card 3 — Conversão assinados → ganhos */}
          <div className="card p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#189e79]" />
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-[#50627a]">Conversão assinados → ganhos</h3>
              <span className="badge success">{modeLabel}</span>
            </div>
            <div className="text-4xl font-black tracking-tight mt-3 tabular-nums text-[#0f172a]">
              {strategic.pct_assinados_ate_ganhos != null
                ? `${strategic.pct_assinados_ate_ganhos.toFixed(1).replace(".", ",")}%`
                : "—"}
            </div>
            <p className="text-[11px] text-[#8c9bae] mt-3 min-h-[36px]">
              {formatInt(strategic.assinados_que_ganharam)} ganhos de {formatInt(strategic.assinados)} assinados
            </p>
            {hasComparison && (
              <p className="text-[11px] text-slate-500 mt-1">
                Comparação ({comparisonMonth}):{" "}
                <b>
                  {comparisonStrategic?.pct_assinados_ate_ganhos != null
                    ? `${comparisonStrategic.pct_assinados_ate_ganhos.toFixed(1).replace(".", ",")}%`
                    : "—"}
                </b>
              </p>
            )}
            <div className="border-t border-[#eaf0f6] pt-3 mt-3 text-[11px] text-[#61768f]">
              {viewMode === "producao"
                ? "Dos negócios assinados no período, quantos já possuem data de ganho registrada."
                : "Ganho registrado após a assinatura da mesma safra (K02A)."}
            </div>
          </div>
        </div>
      </div>

      {/* 3) FUNIL + DESQUALIFICAÇÃO — sobreposição comparativa */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-[#0f172a]">
              Progressão do funil comercial e desqualificação
            </h2>
            <p className="text-xs text-[#64748b]">
              Marcos da jornada por Deal e motivos de saída do Closer.
            </p>
          </div>
          <span className="badge info">{modeLabel} · K03A / K04A</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="card p-5 lg:col-span-2">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <h3 className="text-sm font-bold text-[#0f172a]">Progressão do funil comercial</h3>
              {comparisonFunnel && (
                <div className="flex items-center gap-3 text-[10px] text-slate-500">
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-1.5 rounded-full bg-slate-400/50" /> Comparação
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="inline-block w-3 h-2.5 rounded-full bg-gradient-to-r from-[#3972e0] to-[#83adfa]" /> Referência
                  </span>
                </div>
              )}
            </div>
            <div className="space-y-2.5">
              {FUNNEL_STAGES.map((stage, i) => {
                const value = (funnel[stage.key] as number) || 0;
                const base = funnel.recebidos;
                const width = base ? Math.max(2, (value / base) * 100) : 2;
                const compValue = comparisonFunnel
                  ? ((comparisonFunnel[stage.key] as number) || 0)
                  : null;
                const compBase = comparisonFunnel?.recebidos;
                const compWidth = comparisonFunnel && compBase
                  ? Math.max(2, (compValue! / compBase) * 100)
                  : 0;
                const grid = comparisonFunnel
                  ? "grid-cols-[110px_1fr_56px_56px_56px]"
                  : "grid-cols-[110px_1fr_70px_70px]";
                return (
                  <div key={stage.key} className={cn("w-full grid items-center gap-3 text-xs py-1 px-1", grid)}>
                    <span className="font-medium text-[#0f172a] text-left">{stage.label}</span>
                    <div className="flex flex-col gap-0.5">
                      {comparisonFunnel && (
                        <div className="h-1.5 rounded-full bg-[#edf2f8] overflow-hidden">
                          <div
                            className="h-full rounded-full bg-slate-400/50"
                            style={{ width: `${compWidth}%` }}
                          />
                        </div>
                      )}
                      <div className="h-2.5 rounded-full bg-[#edf2f8] overflow-hidden">
                        <div
                          className={cn("h-full rounded-full bg-gradient-to-r", stage.gradient)}
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </div>
                    <span className="font-bold text-right text-[#0f172a] tabular-nums">
                      {formatInt(value)}
                    </span>
                    {comparisonFunnel && (
                      <span className="text-right text-slate-400 tabular-nums">
                        {formatInt(compValue || 0)}
                      </span>
                    )}
                    <span className="text-right text-[#94a3b8] tabular-nums">
                      {pctOfPrevious(i)}
                    </span>
                  </div>
                );
              })}

              <div
                className={cn(
                  "w-full grid items-center gap-3 text-xs border-t border-dashed border-[#e2e8f0] pt-3 mt-2 py-1 px-1",
                  comparisonFunnel
                    ? "grid-cols-[110px_1fr_56px_56px_56px]"
                    : "grid-cols-[110px_1fr_70px_70px]",
                )}
              >
                <span className="font-medium text-[#DC2626] text-left">↳ Desqualificados</span>
                <div className="flex flex-col gap-0.5">
                  {comparisonFunnel && (
                    <div className="h-1.5 rounded-full bg-[#fef2f2] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#df8d93]/60"
                        style={{
                          width: `${
                            comparisonFunnel.recebidos
                              ? Math.max(2, (comparisonFunnel.desqualificados_saida / comparisonFunnel.recebidos) * 100)
                              : 2
                          }%`,
                        }}
                      />
                    </div>
                  )}
                  <div className="h-2.5 rounded-full bg-[#fef2f2] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#df8d93]"
                      style={{
                        width: `${
                          funnel.recebidos
                            ? Math.max(2, (funnel.desqualificados_saida / funnel.recebidos) * 100)
                            : 2
                        }%`,
                      }}
                    />
                  </div>
                </div>
                <span className="font-bold text-right text-[#0f172a] tabular-nums">
                  {formatInt(funnel.desqualificados_saida)}
                </span>
                {comparisonFunnel && (
                  <span className="text-right text-slate-400 tabular-nums">
                    {formatInt(comparisonFunnel.desqualificados_saida)}
                  </span>
                )}
                <span className="text-right text-[#94a3b8] tabular-nums">
                  {formatPct(funnel.desqualificados_saida, funnel.recebidos)}
                </span>
              </div>
            </div>
            <div className="mt-4 rounded-lg bg-[#f4f8ff] border-l-2 border-[#82a9e7] px-3 py-2 text-[11px] text-[#627a98]">
              <strong className="text-[#2357a3]">Desqualificados</strong> é saída paralela, não uma etapa posterior a Protocolados. Fonte:{" "}
              <code className="text-[10px]">
                ops.v_bi_v6_coortes.primeira_desqualificacao_em
              </code>.
            </div>
          </div>

          <div className="card p-5">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
              <h3 className="text-sm font-bold text-[#0f172a]">
                Principais motivos de desqualificação
              </h3>
              <span className="badge">Closer · motivo_perda</span>
            </div>
            <div className="space-y-3">
              {mergedReasons.length === 0 && (
                <p className="text-xs text-[#94a3b8]">
                  {loading ? "Carregando motivos…" : "Nenhum motivo registrado no período."}
                </p>
              )}
              {mergedReasons.map((reason) => {
                const width = maxMergedReason
                  ? Math.max(2, (reason.current / maxMergedReason) * 100)
                  : 2;
                const compWidth = maxMergedReason && hasComparison
                  ? Math.max(2, (reason.comp / maxMergedReason) * 100)
                  : 0;
                return (
                  <div
                    key={reason.motivo}
                    className="grid grid-cols-[1fr_1.6fr_56px] items-center gap-3 text-xs"
                  >
                    <span
                      className="text-[#0f172a] font-medium truncate"
                      title={reason.motivo}
                    >
                      {reason.motivo}
                    </span>
                    <div className="flex flex-col gap-0.5">
                      {hasComparison && (
                        <div className="h-1.5 rounded-full bg-[#edf1f7] overflow-hidden">
                          <div
                            className="h-full rounded-full bg-slate-400/50"
                            style={{ width: `${compWidth}%` }}
                          />
                        </div>
                      )}
                      <div className="h-2 rounded-full bg-[#edf1f7] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#d99362]"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-right">
                      <strong className="text-[#0f172a] tabular-nums">
                        {formatInt(reason.current)}
                      </strong>
                      {hasComparison && (
                        <div className="text-[10px] text-slate-400 tabular-nums">
                          {formatInt(reason.comp)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {reasons.length > 10 && (
              <button
                type="button"
                aria-expanded={showAllReasons}
                aria-label={showAllReasons ? "Mostrar menos motivos" : "Mostrar todos os motivos"}
                title={showAllReasons ? "Mostrar menos" : "Mostrar todos os motivos"}
                onClick={() => setShowAllReasons((expanded) => !expanded)}
                className="mt-5 rounded px-2 py-1 text-sm font-bold text-[#2F6FED] hover:bg-[#eff6ff] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2F6FED]"
              >
                {showAllReasons ? "Mostrar menos" : "..."}
              </button>
            )}
            <div className="mt-4 text-[11px] text-[#94a3b8]">
              Fonte: <strong>K04A</strong> — motivo atual do Deal no momento da desqualificação.
            </div>
          </div>
        </div>
      </div>

      {/* 4) TABELA DE PRODUÇÃO */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-[#0f172a]">
              Tabela de Produção comercial
            </h2>
            <p className="text-xs text-[#64748b]">
              Visão por colaborador ou equipe; safra de recebimento no período.
            </p>
          </div>
          <span className="badge info">
            {formatInt(filteredTable.length)}{" "}
            {grouping === "person" ? "colaboradores" : "equipes"}
          </span>
        </div>

        {tableError && (
          <div className="mb-3 bg-amber-50 text-amber-800 p-3 rounded-lg text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold">Não foi possível carregar a tabela.</p>
              <p className="mt-0.5">{tableError}</p>
            </div>
          </div>
        )}

        <div className="card">
          <div className="p-5 border-b border-[#e2e8f0]">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-sm font-bold text-[#0f172a]">
                  Produção comercial
                </h3>
                <p className="text-xs text-[#64748b] mt-0.5">
                  {grouping === "person" ? "Colaboradores" : "Equipes"} · {modeLabel} por
                  recebimento
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg border border-[#e2e8f0] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setGrouping("person")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold transition-colors",
                      grouping === "person"
                        ? "bg-[#eff6ff] text-[#2F6FED]"
                        : "bg-white text-[#64748b] hover:bg-[#f8fafc]",
                    )}
                  >
                    Por colaborador
                  </button>
                  <button
                    type="button"
                    onClick={() => setGrouping("team")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold border-l border-[#e2e8f0] transition-colors",
                      grouping === "team"
                        ? "bg-[#eff6ff] text-[#2F6FED]"
                        : "bg-white text-[#64748b] hover:bg-[#f8fafc]",
                    )}
                  >
                    Por equipe
                  </button>
                </div>
                <input
                  type="search"
                  placeholder="Buscar colaborador / equipe"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="px-3 py-2 border border-[#e2e8f0] rounded-lg text-sm bg-white min-w-[220px]"
                />
                <button
                  type="button"
                  onClick={handleExportCsv}
                  disabled={filteredTable.length === 0}
                  className="inline-flex items-center gap-1.5 px-3 py-2 border border-[#e2e8f0] rounded-lg text-sm font-semibold text-[#475569] bg-white hover:bg-[#f1f5f9] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Download className="w-3.5 h-3.5" />
                  Exportar CSV
                </button>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
            <table className="simple-table w-full">
              <thead className="sticky top-0 bg-white z-10">
                <tr>
                  {[
                    {
                      key: "name",
                      label: grouping === "person" ? "Colaborador" : "Equipe",
                    },
                    { key: "received", label: "Recebidos" },
                    { key: "worked", label: "Trabalhados" },
                    { key: "contact", label: "Em contato" },
                    { key: "collection", label: "Coleta" },
                    { key: "signed", label: "Assinados" },
                    { key: "gained", label: "Ganhos" },
                    { key: "protocolados", label: "Protocolados" },
                  ].map((col) => (
                    <th
                      key={col.key}
                      onClick={() => {
                        if (sortKey === col.key)
                          setSortDir((d) => (d === 1 ? -1 : 1));
                        else {
                          setSortKey(col.key);
                          setSortDir(-1);
                        }
                      }}
                      className="cursor-pointer hover:text-[#2F6FED]"
                    >
                      {col.label}
                      {sortKey === col.key && (sortDir === 1 ? " ↑" : " ↓")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredTable.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8 text-[#64748b]">
                      Nenhum{" "}
                      {grouping === "person" ? "colaborador" : "equipe"}{" "}
                      encontrado para os filtros selecionados.
                    </td>
                  </tr>
                ) : (
                  filteredTable.map((row) => (
                    <tr key={row.key}>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-[#e8effb] text-[#3c72bf] flex items-center justify-center text-[10px] font-bold flex-shrink-0">
                            {(row.name || "?")
                              .split(" ")
                              .map((s: string) => s[0])
                              .slice(0, 2)
                              .join("")
                              .toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-[#0f172a] truncate">
                              {row.name}
                            </div>
                            <div className="text-[11px] text-[#94a3b8] truncate">
                              {row.team}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="text-right tabular-nums">
                        {formatInt(row.received)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatInt(row.worked)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatInt(row.contact)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatInt(row.collection)}
                      </td>
                      <td className="text-right tabular-nums font-bold text-[#0f172a]">
                        {formatInt(row.signed)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatInt(row.gained)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatInt(row.protocolados)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="px-5 py-3 border-t border-[#e2e8f0] text-[11px] text-[#94a3b8]">
            Fontes: <strong className="text-[#64748b]">K05A</strong> (por
            colaborador) e <strong className="text-[#64748b]">K06A</strong> (por
            equipe). Os percentuais de <strong className="text-[#64748b]">Discadora</strong>,{" "}
            <strong className="text-[#64748b]">HubSpot</strong> e{" "}
            <strong className="text-[#64748b]">desqualificados por colaborador</strong>{" "}
            serão habilitados após a homologação da telefonia e origem (K11).
          </div>
        </div>
      </div>

      {/* 5) EVOLUÇÃO DIÁRIA — sobreposição comparativa */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-[#0f172a]">
              Evolução de recebimentos e assinaturas
            </h2>
            <p className="text-xs text-[#64748b]">
              Barras por dia; medida de comparação em tom translúcido e mês de referência em cor viva.
            </p>
          </div>
          <span className="badge">{modeLabel} · K07A</span>
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
            <h3 className="text-sm font-bold text-[#0f172a]">
              {viewMode === "producao"
                ? "Leads recebidos × Assinados"
                : "Recebidos × Assinados (safra)"}
            </h3>
            {comparisonResult && (
              <div className="flex items-center gap-3 text-[10px] text-slate-500">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-2 rounded-sm bg-[#9bc1fb]/50" /> Recebidos (comp.)
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-2 rounded-sm bg-[#9bc1fb]" /> Recebidos (ref.)
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-2 rounded-sm bg-[#2866dd]/50" /> Assinados (comp.)
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-2 rounded-sm bg-[#2866dd]" /> Assinados (ref.)
                </span>
              </div>
            )}
          </div>
          {seriesData.length === 0 ? (
            <div className="flex items-center justify-center h-[260px] text-[#94a3b8] text-sm">
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Aguardando período…
                </>
              ) : (
                "Nenhum dado diário disponível no período."
              )}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={seriesData} barGap={comparisonResult ? 1 : 2}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#e2e8f0"
                  vertical={false}
                />
                <XAxis
                  dataKey={comparisonResult ? "dayOfMonth" : "date"}
                  tickFormatter={(v) =>
                    comparisonResult ? String(v) : dateBr(String(v)).slice(0, 5)
                  }
                  tick={{ fontSize: 10, fill: "#64748b" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#64748b" }}
                  axisLine={false}
                  tickLine={false}
                  width={30}
                />
                <Tooltip
                  labelFormatter={(v) =>
                    comparisonResult ? `Dia ${v}` : dateBr(String(v))
                  }
                  formatter={(value: any, name: any) => {
                    const labels: Record<string, string> = {
                      received: viewMode === "producao" ? "Leads recebidos" : "Recebidos",
                      signed: "Assinados",
                      receivedComp:
                        viewMode === "producao"
                          ? "Leads recebidos (comparação)"
                          : "Recebidos (comparação)",
                      signedComp: "Assinados (comparação)",
                    };
                    return [formatInt(Number(value)), labels[name] || name];
                  }}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11 }}
                  formatter={(value) => {
                    const labels: Record<string, string> = {
                      received: viewMode === "producao" ? "Leads recebidos" : "Recebidos",
                      signed: "Assinados",
                      receivedComp: "Recebidos (comparação)",
                      signedComp: "Assinados (comparação)",
                    };
                    return labels[value] || value;
                  }}
                />
                {comparisonResult && (
                  <Bar
                    dataKey="receivedComp"
                    name="receivedComp"
                    fill="#9bc1fb"
                    fillOpacity={0.35}
                    radius={[4, 4, 0, 0]}
                  />
                )}
                {comparisonResult && (
                  <Bar
                    dataKey="signedComp"
                    name="signedComp"
                    fill="#2866dd"
                    fillOpacity={0.35}
                    radius={[4, 4, 0, 0]}
                  />
                )}
                <Bar
                  dataKey="received"
                  name="received"
                  fill="#9bc1fb"
                  radius={[4, 4, 0, 0]}
                />
                <Bar
                  dataKey="signed"
                  name="signed"
                  fill="#2866dd"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}