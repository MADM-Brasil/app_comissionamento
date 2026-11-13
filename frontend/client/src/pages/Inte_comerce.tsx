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
  ChevronDown, RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ResponsiveContainer, BarChart, Bar, AreaChart, Area, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend,
} from "recharts";
import {
  fetchLeadsRecebidos,
  fetchAssinados,
  fetchGanhos,
  fetchProtocolados,
  fetchPerdidos,
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
const EXCLUDED_TEAMS: string[] = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing','Departamento Comercial',
  'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda',
  'Equipe Reciclagem','','Equipe','Equipe Camila','Sales Ops','Equipe Elizandra','Equipe Bruno Abreu',
  'Equipe Lucas Magno','Equipe SP1','Equipe Marcia','Equipe Lucilene','backoffice','Equipe Debora','Equipe Curitiba',
  'Equipe Gabriela Toledo','Equipe SP01', 'Equipe Adriele','Equipe Elizandra', 'Equipe Debora', 'Equipe Toledo'
];
const EXCLUDED_TEAMS_UPPER = new Set(
  EXCLUDED_TEAMS.map((t) => String(t).trim().toUpperCase()).filter(Boolean),
);
function isExcludedTeam(team: string | null | undefined): boolean {
  if (!team) return false;
  return EXCLUDED_TEAMS_UPPER.has(String(team).trim().toUpperCase());
}

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
  dateStyle: "short", timeStyle: "short",
}).format(new Date(iso));
function getInteComerceDateLimits(now = new Date(), lookbackMonths = 24) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(now);
  const [year, month, day] = today.split("-").map(Number);
  const minimumMonth = new Date(Date.UTC(year, month - 1 - lookbackMonths, 1));
  const daysInMinimumMonth = new Date(
    Date.UTC(minimumMonth.getUTCFullYear(), minimumMonth.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const minimumDay = lookbackMonths >= 22 ? 1 : Math.min(day, daysInMinimumMonth);
  const minimum = new Date(Date.UTC(
    minimumMonth.getUTCFullYear(), minimumMonth.getUTCMonth(), minimumDay,
  )).toISOString().slice(0, 10);
  const maximumExclusive = new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString().slice(0, 10);
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

function formatMotivo(raw: string | undefined | null): string {
  const s = String(raw ?? "").trim();
  if (!s) return "(SEM MOTIVO)";
  const cleaned = s.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.replace(/(^|[\s/])(\p{Ll})/gu, (_, sep, ch) =>
    sep + ch.toLocaleUpperCase("pt-BR"),
  );
}

function getMonthPeriod(month: string, today: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = `${month}-01`;
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
    .toISOString().slice(0, 10);
  return { start, end: nextMonth < tomorrow ? nextMonth : tomorrow };
}

// ───────────────────────────────────────────────────────────
type DailyPoint = {
  date: string; fullDate: string; leads: number;
  assinados: number; ganhos: number; protocolados: number; perdidos: number;
};
type RawSeriesItem = { data?: string; periodo?: string; total?: number; leads_recebidos?: number };

function buildDailySeries(
  start: string, end: string,
  series: {
    leads: RawSeriesItem[]; assinados: RawSeriesItem[];
    ganhos: RawSeriesItem[]; protocolados: RawSeriesItem[]; perdidos: RawSeriesItem[];
  },
): DailyPoint[] {
  const dataMap = new Map<
    string,
    { leads: number; assinados: number; ganhos: number; protocolados: number; perdidos: number }
  >();
  const process = (
    items: RawSeriesItem[] | undefined,
    field: "leads" | "assinados" | "ganhos" | "protocolados" | "perdidos",
    fallbackKey?: "leads_recebidos",
  ) => {
    for (const item of items ?? []) {
      const rawDate = item?.data ?? item?.periodo;
      if (!rawDate) continue;
      const dateStr = String(rawDate).split("T")[0];
      if (!dateStr) continue;
      const existing = dataMap.get(dateStr) ?? {
        leads: 0, assinados: 0, ganhos: 0, protocolados: 0, perdidos: 0,
      };
      const raw = (item.total ?? (fallbackKey ? (item as any)[fallbackKey] : 0) ?? 0);
      existing[field] += Number(raw) || 0;
      dataMap.set(dateStr, existing);
    }
  };
  process(series.leads, "leads", "leads_recebidos");
  process(series.assinados, "assinados");
  process(series.ganhos, "ganhos");
  process(series.protocolados, "protocolados");
  process(series.perdidos, "perdidos");

  const allDates: string[] = [];
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const startDate = new Date(Date.UTC(sy, sm - 1, sd));
  const endDate = new Date(Date.UTC(ey, em - 1, ed));
  const cursor = new Date(startDate);
  while (cursor < endDate) {
    allDates.push(cursor.toISOString().split("T")[0]);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (allDates.length === 0 && start) allDates.push(start);

  return allDates.map((fullDate) => {
    const values = dataMap.get(fullDate) ?? {
      leads: 0, assinados: 0, ganhos: 0, protocolados: 0, perdidos: 0,
    };
    const [, m, d] = fullDate.split("-");
    return {
      date: `${d}/${m}`, fullDate,
      leads: values.leads, assinados: values.assinados,
      ganhos: values.ganhos, protocolados: values.protocolados, perdidos: values.perdidos,
    };
  });
}

// ───────────────────────────────────────────────────────────
type StatKey = "received" | "worked" | "contact" | "signed" | "gained" | "protocolados" | "disq";

type FiltersState = {
  equipe: string; colaborador: string; colaboradorId?: string | number;
  produto: string; unidadeId?: number;
};

const STAT_CARDS: { key: StatKey; label: string; sub: string; highlight?: "signed" | "disq" | "gained" }[] = [
  { key: "received",     label: "Negócios criados", sub: "" },
  { key: "worked",       label: "Trabalhados",      sub: "" },
  { key: "contact",      label: "Em contato",       sub: "" },
  { key: "signed",       label: "Assinados",        sub: "", highlight: "signed" },
  { key: "gained",       label: "Ganhos",           sub: "", highlight: "gained" },
  { key: "protocolados", label: "Protocolados",     sub: "", highlight: "gained" },
  { key: "disq",         label: "Desqualificados",  sub: "", highlight: "disq" },
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
  key: string; name: string; team: string;
  received: number; worked: number; contact: number; collection: number;
  signed: number; gained: number; protocolados: number;
  metaGanhosMensal: number;
};

type ComparisonSlice = Pick<InteComerceOverview, "recebidos" | "assinados" | "ganhos" | "protocolados">;
type ComparisonBlock = { day: ComparisonSlice | null; month: ComparisonSlice };
type AllResult = Awaited<ReturnType<typeof fetchInteComerceAll>>;

const REC_PRIORITY_STYLES: Record<
  RecommendationPriority,
  { border: string; bg: string; text: string; label: string; Icon: LucideIcon }
> = {
  info:    { border: "border-sky-200",   bg: "bg-sky-50",   text: "text-sky-700",   label: "Informativa", Icon: Info },
  warning: { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-700", label: "Atenção",     Icon: AlertCircle },
  danger:  { border: "border-red-200",   bg: "bg-red-50",   text: "text-red-700",   label: "Urgente",     Icon: AlertTriangle },
};

// ───────────────────────────────────────────────────────────
function RecomendacoesCard({ filters, colaboradores }: { filters: FiltersState; colaboradores: Collaborator[]; }) {
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
          (filters.colaboradorId != null && String(c.id) === String(filters.colaboradorId)) ||
          (filters.colaborador && filters.colaborador !== "todos" && c.name === filters.colaborador),
      );
    }
    if (filters.equipe && filters.equipe !== "todas") {
      const eq = normalizeKey(filters.equipe);
      return colaboradores.filter((c) => normalizeKey(c.equipeNome) === eq);
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
  const [newRecPriority, setNewRecPriority] = useState<RecommendationPriority>("info");
  const [sendingRec, setSendingRec] = useState(false);
  const targetIdsKey = targetColaboradores.map((c) => c.id).join(",");

  useEffect(() => {
    if (targetColaboradores.length === 0) { setTempRecs([]); return; }
    const refresh = () => {
      const all: TemporaryRecommendation[] = [];
      for (const c of targetColaboradores) all.push(...getActiveRecommendationsFor(c.id));
      setTempRecs(all);
    };
    refresh();
    const unsub = subscribeRecommendations(refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => { unsub(); window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIdsKey]);

  const grouped = useMemo(() => {
    const map = new Map<string, { key: string; rec: TemporaryRecommendation; ids: string[]; targetNames: string[] }>();
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
          targetId: c.id, targetName: c.name, targetEmail: c.email,
          authorId: currentUser.id,
          authorName: currentUser.nome ?? currentUser.email ?? "Usuário",
          authorCargo: currentUser.cargo ?? "Não informado",
          text: txt, priority: newRecPriority,
        });
      }
      setNewRecText(""); setNewRecPriority("info");
    } finally { setSendingRec(false); }
  };

  const handleRemoveRec = (ids: string[]) => { for (const id of ids) removeRecommendation(id); };
  if (!canAuthorRecommendations) return null;
  const hasTarget = targetColaboradores.length > 0;

  return (
    <details className="card mb-4 group">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-sm font-semibold text-slate-700 [&::-webkit-details-marker]:hidden">
        <Megaphone size={16} className="text-amber-600" />
        <span>Recomendações temporárias</span>
        <span className="text-[11px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-medium">Ativas por 24h</span>
        <span className="text-xs font-normal text-slate-500 ml-auto">Recomendação para: <b>{targetLabel}</b></span>
        <ChevronDown size={16} className="shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-slate-100 p-4">
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-xs text-slate-500">Orientações direcionadas ao filtro selecionado.</span>
        </div>

        {!hasTarget ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">
              Selecione uma <b>equipe</b> ou um <b>colaborador</b> no filtro acima
              para publicar ou visualizar recomendações temporárias.
            </p>
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 mb-3">
              <p className="text-xs font-semibold text-slate-700 mb-2">
                Nova recomendação para{" "}
                {targetColaboradores.length === 1
                  ? targetColaboradores[0].name
                  : `${targetColaboradores.length} colaboradores da equipe ${filters.equipe}`}
              </p>
              <textarea
                value={newRecText}
                onChange={(e) => setNewRecText(e.target.value)}
                placeholder="Escreva uma orientação temporária (válida por 24h)..."
                rows={2} maxLength={500}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:ring-2 focus:ring-blue-500/20 resize-none"
              />
              <div className="flex flex-wrap items-center gap-2 mt-2 justify-between">
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
                          "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors",
                          active ? `${style.bg} ${style.text} ${style.border}` : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50",
                        )}
                      >
                        <PIcon size={11} />{style.label}
                      </button>
                    );
                  })}
                  <span className="text-[11px] text-slate-400 ml-1">{newRecText.length}/500</span>
                </div>
                <button
                  type="button"
                  onClick={handleAddRec}
                  disabled={!newRecText.trim() || sendingRec}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {sendingRec ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  Publicar (24h)
                </button>
              </div>
            </div>

            {grouped.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Orientações ativas</p>
                <ul className="space-y-2">
                  {grouped.map((entry) => {
                    const style = REC_PRIORITY_STYLES[entry.rec.priority];
                    const canDelete = canDeleteAny || entry.rec.authorId === currentUser?.id;
                    const targetsLabel =
                      entry.targetNames.length === 1
                        ? entry.targetNames[0]
                        : `${entry.targetNames.length} colaboradores`;
                    return (
                      <li key={entry.key} className={cn("flex gap-2 items-start p-3 rounded-lg border", style.border, style.bg)}>
                        <style.Icon size={15} className={cn("mt-0.5 shrink-0", style.text)} />
                        <div className="flex-1 min-w-0">
                          <p className={cn("text-sm whitespace-pre-wrap break-words", style.text)}>{entry.rec.text}</p>
                          <p className="text-[11px] text-slate-500 mt-1 flex flex-wrap items-center gap-2">
                            <span>{entry.rec.authorName} · {entry.rec.authorCargo}</span>
                            <span className="inline-flex items-center gap-1">
                              <Clock size={10} /> expira em {getRemainingTimeLabel(entry.rec.expiresAt)}
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
                            <Trash2 size={15} />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-slate-400 italic">Nenhuma orientação temporária ativa para {targetLabel}.</p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

const EvolucaoTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-[#e2e8f0] rounded-lg p-3 shadow-lg text-xs max-h-60 overflow-y-auto">
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

// ───────────────────────────────────────────────────────────
export default function Inte_comerce() {
  const { collaborators } = useAppStore();
  const [today] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()));
  const [viewMode, setViewMode] = useState<"safra" | "producao">("safra");
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7));
  const [comparisonMonth, setComparisonMonth] = useState<string | null>(null);

  const reportPeriod = useMemo(() => {
    const limits = getInteComerceDateLimits(new Date(`${today}T12:00:00`), 24);
    const [year, month] = selectedMonth.split("-").map(Number);
    const start = `${selectedMonth}-01`;
    const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const end = nextMonth < limits.maximumExclusive ? nextMonth : limits.maximumExclusive;
    return {
      start, end, clipped: false,
      unavailable: selectedMonth > today.slice(0, 7) || start < limits.minimum || end <= start,
      limits,
    };
  }, [selectedMonth, today]);

  const comparisonPeriod = useMemo(
    () => (comparisonMonth ? getMonthPeriod(comparisonMonth, today) : null),
    [comparisonMonth, today],
  );

  const [filters, setFilters] = useState<FiltersState>({
    equipe: "todas", colaborador: "todos", produto: "Todos", unidadeId: undefined,
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
  const [dailySeries, setDailySeries] = useState<DailyPoint[]>([]);
  const [dailySeriesError, setDailySeriesError] = useState<string | null>(null);
  const [collabTable, setCollabTable] = useState<InteComerceCollaborator[]>([]);
  const [teamTable, setTeamTable] = useState<InteComerceTeam[]>([]);

  const reloadData = useCallback(async () => {
    if (!reportPeriod.start || !reportPeriod.end) return;
    if (reportPeriod.unavailable) {
      setLoading(false);
      setOverview(EMPTY_OVERVIEW);
      setStrategic(EMPTY_STRATEGIC);
      setFunnel(EMPTY_FUNNEL);
      setReasons([]);
      setDaily([]);
      setDailySeries([]);
      setDailySeriesError(null);
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

    const params = {
      start: reportPeriod.start, end: reportPeriod.end,
      equipe: equipe !== "todas" ? equipe : undefined,
      colaboradorId, produto, unidadeId: filters.unidadeId,
      mode: viewMode,
    };

    const dailySeriesParams = {
      start: reportPeriod.start, end: reportPeriod.end,
      equipe: equipe !== "todas" ? equipe : undefined,
      colaborador: colaborador !== "todos" ? colaborador : undefined,
      colaboradorId,
      produto: produto !== "Todos" ? produto : undefined,
      granularity: "daily" as const,
    };

    const comparisonParams = comparisonPeriod
      ? { ...params, start: comparisonPeriod.start, end: comparisonPeriod.end, mode: viewMode }
      : null;

    try {
      const [allResult, tableResult, monthCompareResult, dailySeriesResult] = await Promise.allSettled([
        fetchInteComerceAll(params),
        grouping === "team"
          ? fetchInteComerceTeams(params).then((data) => ({ kind: "team" as const, data }))
          : fetchInteComerceCollaborators(params).then((data) => ({ kind: "person" as const, data })),
        comparisonParams ? fetchInteComerceAll(comparisonParams) : Promise.resolve(null),
        Promise.all([
          fetchLeadsRecebidos(dailySeriesParams),
          fetchAssinados(dailySeriesParams),
          fetchGanhos(dailySeriesParams),
          fetchProtocolados(dailySeriesParams),
          fetchPerdidos(dailySeriesParams),
        ]),
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
          allResult.reason instanceof Error ? allResult.reason.message : "Falha ao carregar os indicadores.",
        );
      }

      if (dailySeriesResult.status === "fulfilled") {
        const [leadsR, assinadosR, ganhosR, protocoladosR, perdidosR] = dailySeriesResult.value;
        setDailySeries(
          buildDailySeries(reportPeriod.start, reportPeriod.end, {
            leads: leadsR as unknown as RawSeriesItem[],
            assinados: assinadosR as unknown as RawSeriesItem[],
            ganhos: ganhosR as unknown as RawSeriesItem[],
            protocolados: protocoladosR as unknown as RawSeriesItem[],
            perdidos: perdidosR as unknown as RawSeriesItem[],
          }),
        );
        setDailySeriesError(null);
      } else {
        console.warn("[Inte_comerce] série diária (Analytics) indisponível:", dailySeriesResult.reason);
        setDailySeries([]);
        setDailySeriesError(
          dailySeriesResult.reason instanceof Error
            ? dailySeriesResult.reason.message
            : "Falha ao carregar a série diária.",
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
          tableResult.reason instanceof Error ? tableResult.reason.message : "Falha ao carregar a tabela.",
        );
        if (grouping === "team") setTeamTable([]);
        else setCollabTable([]);
      }
    } finally {
      setLoading(false);
    }
  }, [
    reportPeriod, equipe, colaborador, colaboradorId, produto, filters.unidadeId,
    grouping, viewMode, comparisonPeriod,
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

  const aggregates = useMemo(
    () => ({
      received: overview.recebidos, worked: overview.trabalhados_proxy,
      contact: overview.em_contato_crm, signed: overview.assinados,
      gained: overview.ganhos, protocolados: overview.protocolados,
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

  const seriesData = useMemo(() => {
    const compByDom = new Map<string, InteComerceDaily>();
    for (const d of comparisonDaily) compByDom.set(d.dia.slice(-2), d);
    return daily.map((d) => {
      const dom = d.dia.slice(-2);
      const comp = compByDom.get(dom);
      return {
        dayOfMonth: dom, date: d.dia,
        received: d.recebidos, signed: d.assinados_ate_corte,
        receivedComp: comp?.recebidos ?? null,
        signedComp: comp?.assinados_ate_corte ?? null,
      };
    });
  }, [daily, comparisonDaily]);

  const dailyChartData = useMemo(() => {
    return dailySeries.map((d) => ({
      date: d.date, fullDate: d.fullDate,
      leads: d.leads, assinados: d.assinados,
      ganhos: d.ganhos, protocolados: d.protocolados, perdidos: d.perdidos,
    }));
  }, [dailySeries]);

  // ─────────────────────────────────────────────────────────
  //  Lookup de metas (colaborador × equipe).
  //  Usa `collaborators` do useAppStore como fonte da verdade,
  //  buscando por `id` e caindo para `name` quando necessário.
  // ─────────────────────────────────────────────────────────
  const collabMetaByKey = useMemo(() => {
    const map = new Map<string, { metaMensalGanhos: number; metaMensalAssinados: number }>();
    for (const c of collaborators) {
      const metaMensalGanhos = Number((c as any).metaMensalGanhos ?? 0);
      const metaMensalAssinados = Number((c as any).metaMensalAssinados ?? 0);
      if (c.id != null) map.set(`id:${String(c.id)}`, { metaMensalGanhos, metaMensalAssinados });
      if (c.name) map.set(`name:${c.name}`, { metaMensalGanhos, metaMensalAssinados });
    }
    return map;
  }, [collaborators]);

  const teamMetaByKey = useMemo(() => {
    const map = new Map<string, { metaMensalGanhos: number; metaMensalAssinados: number }>();
    for (const c of collaborators) {
      const key = normalizeKey(c.equipeNome);
      if (!key) continue;
      const existing = map.get(key) || { metaMensalGanhos: 0, metaMensalAssinados: 0 };
      existing.metaMensalGanhos += Number((c as any).metaMensalGanhos ?? 0);
      existing.metaMensalAssinados += Number((c as any).metaMensalAssinados ?? 0);
      map.set(key, existing);
    }
    return map;
  }, [collaborators]);

  const tableRows = useMemo<Row[]>(() => {
    if (grouping === "team") {
      return teamTable
        .filter((t) => !isExcludedTeam(t.equipe))
        .map((t) => {
          const meta = teamMetaByKey.get(normalizeKey(t.equipe));
          return {
            key: t.equipe, name: t.equipe, team: t.equipe,
            received: t.recebimentos_assessor_deal_dia,
            worked: t.trabalhados, contact: t.em_contato,
            collection: t.coleta, signed: t.assinados,
            gained: t.ganhos, protocolados: t.protocolados,
            metaGanhosMensal: meta?.metaMensalGanhos ?? 0,
          };
        });
    }
    return collabTable
      .filter((c) => !isExcludedTeam(c.equipe_atual))
      .map((c) => {
        const byId = c.colaborador_id != null ? collabMetaByKey.get(`id:${String(c.colaborador_id)}`) : undefined;
        const byName = collabMetaByKey.get(`name:${c.colaborador}`);
        const meta = byId ?? byName;
        return {
          key: c.colaborador_id || c.colaborador,
          name: c.colaborador, team: c.equipe_atual || "—",
          received: c.recebimentos_deal_dia,
          worked: c.trabalhados, contact: c.em_contato,
          collection: c.coleta, signed: c.assinados,
          gained: c.ganhos, protocolados: c.protocolados,
          metaGanhosMensal: meta?.metaMensalGanhos ?? 0,
        };
      });
  }, [grouping, collabTable, teamTable, collabMetaByKey, teamMetaByKey]);

  const filteredTable = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("pt-BR");
    let arr = tableRows;
    if (q) arr = arr.filter((r) =>
      `${r.name} ${r.team}`.toLocaleLowerCase("pt-BR").includes(q),
    );
    return [...arr].sort((a, b) => {
      // Ordenação especial: "Meta × Realizado" ordena por % atingida
      if (sortKey === "metaGanhosMensal") {
        const pA = a.metaGanhosMensal ? a.gained / a.metaGanhosMensal : 0;
        const pB = b.metaGanhosMensal ? b.gained / b.metaGanhosMensal : 0;
        return (pA - pB) * sortDir;
      }
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

  const comparisonTableRows = useMemo(() => {
    const data = viewMode === "safra" ? safraComparison : productionComparison;
    const hasComp = hasComparison;
    const metrics = [
      ["recebidos", viewMode === "producao" ? "Leads recebidos" : "Negócios criados"],
      ["assinados", "Assinados"],
      ["ganhos", "Ganhos"],
      ["protocolados", "Protocolados"],
    ] as const;
    return metrics.map(([key, label]) => {
      const monthValue = (data as any)?.month?.[key] as number | undefined;
      const comparedValue = hasComp
        ? ((comparisonOverview as any)?.[key] as number | undefined)
        : undefined;
      const variation =
        hasComp && comparedValue
          ? (((monthValue || 0) - comparedValue) / comparedValue) * 100
          : null;
      return { key, label, monthValue, comparedValue, variation };
    });
  }, [viewMode, safraComparison, productionComparison, hasComparison, comparisonOverview]);

  const handleExportCsv = () => {
    if (filteredTable.length === 0) return;
    const header = [
      grouping === "person" ? "Colaborador" : "Equipe",
      "Equipe", "Recebidos", "Trabalhados", "Em contato",
      "Coleta", "Assinados", "Ganhos", "Protocolados",
      "Meta mensal (Ganhos)", "% da meta",
    ];
    const rows = filteredTable.map((r) => [
      r.name, r.team, r.received, r.worked, r.contact,
      r.collection, r.signed, r.gained, r.protocolados,
      r.metaGanhosMensal > 0 ? r.metaGanhosMensal : "",
      r.metaGanhosMensal > 0
        ? `${((r.gained / r.metaGanhosMensal) * 100).toFixed(1).replace(".", ",")}%`
        : "",
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
    const hasComp = hasComparison;
    const header = ["Indicador", "Total mês"];
    if (hasComp) header.push("Total comparação", "Variação");
    const rows = comparisonTableRows.map((r) => {
      const row: (string | number)[] = [r.label];
      row.push(r.monthValue == null ? "" : r.monthValue);
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
    a.download = `comparativo_${viewMode}_${selectedMonth}${comparisonMonth ? `_vs_${comparisonMonth}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleMonthChange = (value: string) => {
    if (!/^\d{4}-\d{2}$/.test(value)) return;
    setSelectedMonth(value);
    if (comparisonMonth === value) setComparisonMonth(null);
  };

  const modeLabel = viewMode === "safra" ? "Safra" : "Produção";
  const modeDescription = viewMode === "safra"
  const comparisonSectionTitle = viewMode === "safra" ? "Comparativo de Safra" : "Comparativo de Produção";
  const comparisonSectionDescription = `Total de ${selectedMonth} × mês ${comparisonMonth}.`;

  const headerControls = (
    <div className="flex flex-wrap items-center gap-2">
      <div
        className="flex items-center rounded-lg border border-slate-200 bg-white overflow-hidden"
        role="group"
        aria-label="Modo do relatório"
      >
        {([["safra", "Safra"], ["producao", "Produção"]] as const).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            aria-pressed={viewMode === mode}
            onClick={() => setViewMode(mode)}
            className={cn(
              "px-2.5 py-1.5 text-[11px] font-semibold transition-colors",
              viewMode === mode ? "bg-blue-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <input
          type="month"
          min={reportPeriod.limits?.minimum.slice(0, 7)}
          max={today.slice(0, 7)}
          value={selectedMonth}
          onChange={(event) => handleMonthChange(event.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-normal text-slate-700"
          title="Mês de referência"
          aria-label="Mês de referência"
        />
        <span className="text-[10px] font-semibold text-slate-400 px-0.5">vs</span>
        <input
          type="month"
          min={reportPeriod.limits?.minimum.slice(0, 7)}
          max={today.slice(0, 7)}
          value={comparisonMonth ?? ""}
          onChange={(event) => setComparisonMonth(event.target.value || null)}
          className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-normal text-slate-700"
          title="Mês de comparação (opcional)"
          aria-label="Mês de comparação (opcional)"
          placeholder="Comparar"
        />
        {comparisonMonth && (
          <button
            type="button"
            onClick={() => setComparisonMonth(null)}
            className="rounded-md px-1.5 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-100"
            title="Limpar comparação"
            aria-label="Limpar comparação"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════
  return (
    <DashboardLayout
      title="Inteligência Comercial"
      subtitle="Visão consolidada da operação, da distribuição à assinatura e ao resultado jurídico, em uma única página."
      showPeriodFilter={false}
      headerActions={headerControls}
    >
      <FilterBar
        onFilterChange={handleFilterChange}
        showColaboradorFilter={true}
        className="mb-4"
      />
      <button
        type="button"
        onClick={() => void handleRefresh()}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
        title="Atualizar dados"
        aria-label="Atualizar dados"
      >
        <RefreshCw size={13} className={cn(loading && "animate-spin")} />
        <span className="hidden sm:inline">Atualizar</span>
      </button>

      <p className="mb-4 text-xs text-slate-500">{modeDescription}</p>

      {hasComparison && (
        <details className="card mb-4 group">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-bold text-slate-800">{comparisonSectionTitle}</h2>
              <p className="mt-0.5 text-[11px] text-slate-500 truncate">{comparisonSectionDescription}</p>
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
            <ChevronDown size={15} className="shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
          </summary>
          <div className="overflow-x-auto border-t border-slate-100 [&_th]:py-1.5 [&_th]:text-[11px] [&_td]:py-1.5 [&_td]:text-[11px]">
            <table className="simple-table w-full">
              <thead>
                <tr>
                  <th>Indicador</th>
                  <th className="text-right">
                    Total {selectedMonth}{selectedMonth === today.slice(0, 7) ? " · até hoje" : ""}
                  </th>
                  <th className="text-right">Total {comparisonMonth}</th>
                  <th className="text-right">Variação entre períodos</th>
                </tr>
              </thead>
              <tbody>
                {comparisonTableRows.map((r) => (
                  <tr key={r.key}>
                    <td className="font-semibold">{r.label}</td>
                    <td className="text-right tabular-nums">{r.monthValue == null ? "—" : formatInt(r.monthValue)}</td>
                    <td className="text-right tabular-nums">{r.comparedValue == null ? "—" : formatInt(r.comparedValue)}</td>
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

      {/* 1) VISÃO GERAL */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div><h2 className="text-lg font-bold text-[#0f172a]">Visão geral do funil</h2></div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          {STAT_CARDS.map((card) => (
            <div key={card.key} className="card p-3">
              <div className="text-xs text-[#64748b] font-medium leading-tight min-h-[28px]">
                {viewMode === "producao" && card.key === "received" ? "Leads recebidos" : card.label}
              </div>
              <div
                className={cn(
                  "text-2xl font-extrabold mt-1.5 tabular-nums leading-none",
                  card.highlight === "signed" && "text-[#2F6FED]",
                  card.highlight === "gained" && "text-[#16A34A]",
                  card.highlight === "disq" && "text-[#DC2626]",
                  !card.highlight && "text-[#0f172a]",
                )}
              >
                {formatInt(aggregates[card.key])}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 2) PERFORMANCE COMERCIAL */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div><h2 className="text-lg font-bold text-[#0f172a]">Performance Comercial</h2></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="card p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#407de5]" />
            <h3 className="text-sm font-bold text-[#50627a]">Média de assinados / dia</h3>
            <div className="text-4xl font-black tracking-tight mt-3 tabular-nums text-[#0f172a]">
              {avgSignedPerDay.toFixed(1).replace(".", ",")}
            </div>
          </div>
          <div className="card p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#1a9ac5]" />
            <h3 className="text-sm font-bold text-[#50627a]">Conversão geral operacional</h3>
            <div className="text-4xl font-black tracking-tight mt-3 tabular-nums text-[#0f172a]">
              {strategic.pct_recebidos_ate_assinados != null
                ? `${strategic.pct_recebidos_ate_assinados.toFixed(1).replace(".", ",")}%`
                : "—"}
            </div>
          </div>
          <div className="card p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#189e79]" />
            <h3 className="text-sm font-bold text-[#50627a]">Conversão assinados → ganhos</h3>
            <div className="text-4xl font-black tracking-tight mt-3 tabular-nums text-[#0f172a]">
              {strategic.pct_assinados_ate_ganhos != null
                ? `${strategic.pct_assinados_ate_ganhos.toFixed(1).replace(".", ",")}%`
                : "—"}
            </div>
          </div>
        </div>
      </div>

      <RecomendacoesCard filters={filters} colaboradores={collaborators} />

      {/* 3) FUNIL + DESQUALIFICAÇÃO */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-[#0f172a]">
              Progressão do funil comercial e desqualificação
            </h2>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
          <div className="card p-5 lg:col-span-2 h-full flex flex-col">
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
            <div className="flex-1 flex flex-col justify-between gap-2">
              {FUNNEL_STAGES.map((stage, i) => {
                const value = (funnel[stage.key] as number) || 0;
                const base = funnel.recebidos;
                const width = base ? Math.max(2, (value / base) * 100) : 2;
                const compValue = comparisonFunnel ? ((comparisonFunnel[stage.key] as number) || 0) : null;
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
                          <div className="h-full rounded-full bg-slate-400/50" style={{ width: `${compWidth}%` }} />
                        </div>
                      )}
                      <div className="h-2.5 rounded-full bg-[#edf2f8] overflow-hidden">
                        <div className={cn("h-full rounded-full bg-gradient-to-r", stage.gradient)} style={{ width: `${width}%` }} />
                      </div>
                    </div>
                    <span className="font-bold text-right text-[#0f172a] tabular-nums">{formatInt(value)}</span>
                    {comparisonFunnel && (
                      <span className="text-right text-slate-400 tabular-nums">{formatInt(compValue || 0)}</span>
                    )}
                    <span className="text-right text-[#94a3b8] tabular-nums">{pctOfPrevious(i)}</span>
                  </div>
                );
              })}
              <div
                className={cn(
                  "w-full grid items-center gap-3 text-xs border-t border-dashed border-[#e2e8f0] pt-3 mt-1 py-1 px-1",
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
          </div>

          <div className="card p-5 h-full flex flex-col">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
              <h3 className="text-sm font-bold text-[#0f172a]">Principais motivos de desqualificação</h3>
            </div>
            <div className="space-y-3 flex-1">
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
                const displayMotivo = formatMotivo(reason.motivo);
                return (
                  <div key={reason.motivo} className="grid grid-cols-[1fr_1.6fr_56px] items-center gap-3 text-xs">
                    <span className="text-[#0f172a] font-medium leading-tight break-words min-w-0" title={displayMotivo}>
                      {displayMotivo}
                    </span>
                    <div className="flex flex-col gap-0.5">
                      {hasComparison && (
                        <div className="h-1.5 rounded-full bg-[#edf1f7] overflow-hidden">
                          <div className="h-full rounded-full bg-slate-400/50" style={{ width: `${compWidth}%` }} />
                        </div>
                      )}
                      <div className="h-2 rounded-full bg-[#edf1f7] overflow-hidden">
                        <div className="h-full rounded-full bg-[#d99362]" style={{ width: `${width}%` }} />
                      </div>
                    </div>
                    <div className="text-right">
                      {hasComparison && (
                        <strong className="text-[10px] text-slate-400 tabular-nums">{formatInt(reason.comp)}</strong>
                      )}<br/>
                      <strong className="text-[#0f172a] tabular-nums">{formatInt(reason.current)}</strong>
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
          </div>
        </div>
      </div>

      {/* 4) TABELA DE PRODUÇÃO — com coluna Meta × Realizado */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div><h2 className="text-lg font-bold text-[#0f172a]">Tabela de Produção comercial</h2></div>
          <span className="badge info">
            {formatInt(filteredTable.length)} {grouping === "person" ? "colaboradores" : "equipes"}
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
              <div><h3 className="text-sm font-bold text-[#0f172a]">Produção comercial</h3></div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg border border-[#e2e8f0] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setGrouping("person")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold transition-colors",
                      grouping === "person" ? "bg-[#eff6ff] text-[#2F6FED]" : "bg-white text-[#64748b] hover:bg-[#f8fafc]",
                    )}
                  >
                    Por colaborador
                  </button>
                  <button
                    type="button"
                    onClick={() => setGrouping("team")}
                    className={cn(
                      "px-3 py-1.5 text-xs font-semibold border-l border-[#e2e8f0] transition-colors",
                      grouping === "team" ? "bg-[#eff6ff] text-[#2F6FED]" : "bg-white text-[#64748b] hover:bg-[#f8fafc]",
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
                    { key: "name", label: grouping === "person" ? "Colaborador" : "Equipe" },
                    { key: "received", label: "Recebidos" },
                    { key: "worked", label: "Trabalhados" },
                    { key: "contact", label: "Em contato" },
                    { key: "collection", label: "Coleta" },
                    { key: "signed", label: "Assinados" },
                    { key: "gained", label: "Ganhos" },
                    { key: "protocolados", label: "Protocolados" },
                    { key: "metaGanhosMensal", label: "Meta × Realizado" },
                  ].map((col) => (
                    <th
                      key={col.key}
                      onClick={() => {
                        if (sortKey === col.key) setSortDir((d) => (d === 1 ? -1 : 1));
                        else { setSortKey(col.key); setSortDir(-1); }
                      }}
                      className={cn(
                        "cursor-pointer hover:text-[#2F6FED]",
                        col.key !== "name" && "text-right",
                      )}
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
                    <td colSpan={9} className="text-center py-8 text-[#64748b]">
                      Nenhum {grouping === "person" ? "colaborador" : "equipe"} encontrado para os filtros selecionados.
                    </td>
                  </tr>
                ) : (
                  filteredTable.map((row) => {
                    const metaPct = row.metaGanhosMensal > 0
                      ? Math.min(100, (row.gained / row.metaGanhosMensal) * 100)
                      : 0;
                    const metaColor =
                      row.metaGanhosMensal === 0
                        ? "#cbd5e1"
                        : row.gained >= row.metaGanhosMensal
                          ? "#16A34A"
                          : row.gained >= row.metaGanhosMensal * 0.7
                            ? "#2F6FED"
                            : "#EA8C1D";
                    return (
                      <tr key={row.key}>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-[#e8effb] text-[#3c72bf] flex items-center justify-center text-[10px] font-bold flex-shrink-0">
                              {(row.name || "?").split(" ").map((s: string) => s[0]).slice(0, 2).join("").toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-[#0f172a] truncate">{row.name}</div>
                              <div className="text-[11px] text-[#94a3b8] truncate">{row.team}</div>
                            </div>
                          </div>
                        </td>
                        <td className="text-right tabular-nums">{formatInt(row.received)}</td>
                        <td className="text-right tabular-nums">{formatInt(row.worked)}</td>
                        <td className="text-right tabular-nums">{formatInt(row.contact)}</td>
                        <td className="text-right tabular-nums">{formatInt(row.collection)}</td>
                        <td className="text-right tabular-nums font-bold text-[#0f172a]">{formatInt(row.signed)}</td>
                        <td className="text-right tabular-nums">{formatInt(row.gained)}</td>
                        <td className="text-right tabular-nums">{formatInt(row.protocolados)}</td>
                        <td className="text-right">
                          {row.metaGanhosMensal > 0 ? (
                            <div className="inline-flex flex-col items-end gap-0.5 min-w-[90px]">
                              <div className="text-[11px] tabular-nums text-[#0f172a]">
                                <span className="font-bold">{formatInt(row.gained)}</span>
                                <span className="text-slate-400"> / </span>
                                <span>{formatInt(row.metaGanhosMensal)}</span>
                              </div>
                              <div className="w-24 h-1.5 rounded-full bg-[#edf1f7] overflow-hidden">
                                <div
                                  className="h-full rounded-full transition-all"
                                  style={{ width: `${metaPct}%`, background: metaColor }}
                                />
                              </div>
                              <span className="text-[10px] tabular-nums" style={{ color: metaColor }}>
                                {metaPct.toFixed(0)}%
                                {row.gained >= row.metaGanhosMensal ? " · Atingido" : ""}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 5) EVOLUÇÃO DIÁRIA (BarChart) */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div><h2 className="text-lg font-bold text-[#0f172a]">Recebidos × Assinados por dia</h2></div>
        </div>
        <div className="card p-5">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
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
              {loading ? (<><Loader2 className="w-4 h-4 animate-spin mr-2" />Aguardando período…</>) : "Nenhum dado diário disponível no período."}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={seriesData} barGap={comparisonResult ? 1 : 2}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="dayOfMonth" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} width={30} />
                <Tooltip
                  labelFormatter={(v) => `Dia ${v}`}
                  formatter={(value: any, name: any) => {
                    const labels: Record<string, string> = {
                      received: viewMode === "producao" ? "Leads recebidos" : "Recebidos",
                      signed: "Assinados",
                      gained: "Ganhos",
                      receivedComp: viewMode === "producao" ? "Leads recebidos (comparação)" : "Recebidos (comparação)",
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
                      gained: "Ganhos",
                      receivedComp: "Recebidos (comparação)",
                      signedComp: "Assinados (comparação)",
                    };
                    return labels[value] || value;
                  }}
                />
                {comparisonResult && (
                  <Bar dataKey="receivedComp" name="receivedComp" fill="#9bc1fb" fillOpacity={0.35} radius={[4, 4, 0, 0]} />
                )}
                {comparisonResult && (
                  <Bar dataKey="signedComp" name="signedComp" fill="#2866dd" fillOpacity={0.35} radius={[4, 4, 0, 0]} />
                )}
                <Bar dataKey="received" name="received" fill="#9bc1fb" radius={[4, 4, 0, 0]} />
                <Bar dataKey="signed" name="signed" fill="#2866dd" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* 6) EVOLUÇÃO DIÁRIA (AreaChart) */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div><h2 className="text-lg font-bold text-[#0f172a]">Evolução Diária</h2></div>
        </div>
        <div className="card p-5">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-4"></div>
          {dailySeriesError && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700">
              Não foi possível carregar a série diária: {dailySeriesError}
            </div>
          )}
          {dailyChartData.length === 0 ? (
            <div className="flex items-center justify-center h-[320px] text-[#94a3b8] text-sm">
              {loading ? (<><Loader2 className="w-4 h-4 animate-spin mr-2" />Aguardando período…</>) : "Nenhum dado diário disponível no período."}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={dailyChartData}>
                <defs>
                  <linearGradient id="colorLeadsInte" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#16A34A" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#16A34A" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorAssinadosInte" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2F6FED" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#2F6FED" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorGanhosInte" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#EA8C1D" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#EA8C1D" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorProtocoladosInte" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorPerdidosInte" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#DC2626" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#DC2626" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} width={30} />
                <Tooltip content={<EvolucaoTooltip />} />
                <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="leads" stroke="#16A34A" strokeWidth={2} fill="url(#colorLeadsInte)" name="Leads" />
                <Area type="monotone" dataKey="assinados" stroke="#2F6FED" strokeWidth={2} fill="url(#colorAssinadosInte)" name="Assinados" />
                <Area type="monotone" dataKey="ganhos" stroke="#EA8C1D" strokeWidth={2} fill="url(#colorGanhosInte)" name="Ganhos" />
                <Area type="monotone" dataKey="protocolados" stroke="#8B5CF6" strokeWidth={2} fill="url(#colorProtocoladosInte)" name="Protocolados" />
                <Area type="monotone" dataKey="perdidos" stroke="#DC2626" strokeWidth={2} fill="url(#colorPerdidosInte)" name="Perdidos" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}