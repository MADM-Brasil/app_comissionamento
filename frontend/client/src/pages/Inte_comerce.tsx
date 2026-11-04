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
  fetchInteComerceOverview,
  fetchInteComerceStrategic,
  fetchInteComerceFunnel,
  fetchInteComerceDisqualify,
  fetchInteComerceDaily,
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

// ───────────────────────────────────────────────────────────
type StatKey =
  | "received" | "worked" | "contact" | "signed"
  | "gained" | "protocolados" | "disq";

type FiltersState = {
  equipe: string;
  colaborador: string;
  colaboradorId?: string | number;
  produto: string;
};

const STAT_CARDS: {
  key: StatKey;
  label: string;
  sub: string;
  highlight?: "signed" | "disq";
}[] = [
  { key: "received",     label: "Leads recebidos", sub: "Atribuições novas no período" },
  { key: "worked",       label: "Trabalhados",     sub: "Movimentação no CRM" },
  { key: "contact",      label: "Em contato",      sub: "Etapa Em contato" },
  { key: "signed",       label: "Assinados",       sub: "ORIGINAL · safra do período", highlight: "signed" },
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

// ───────────────────────────────────────────────────────────
//  ESTILOS DE PRIORIDADE (mesma nomenclatura de Equipe.tsx)
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
//  CARD DE RECOMENDAÇÕES TEMPORÁRIAS (24h)
//  Adaptado de Equipe.tsx; o "alvo" é determinado pelos filtros.
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

  // Alvo = lista de colaboradores deduzida do filtro
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

  // Agrupa por (texto + autor + expiração) para que uma publicação em
  // equipe inteira apareça como UMA linha, não N.
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        rec: TemporaryRecommendation;
        ids: string[];
        targetNames: string[];
      }
    >();
    const nameById = new Map(
      targetColaboradores.map((c) => [String(c.id), c.name]),
    );
    for (const r of tempRecs) {
      const key = `${r.text}|${r.authorId}|${r.expiresAt}`;
      if (!map.has(key)) {
        map.set(key, { key, rec: r, ids: [], targetNames: [] });
      }
      const entry = map.get(key)!;
      entry.ids.push(r.id);
      const name =
        nameById.get(String((r as any).targetId)) ||
        (r as any).targetName ||
        "—";
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
    <div className="card p-5 mb-6">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Megaphone size={17} className="text-amber-600" />
        <h3 className="text-sm font-semibold text-slate-700">
          Recomendações temporárias
        </h3>
        <span className="text-[10px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded font-medium">
          Ativas por 24h
        </span>
        <span className="text-[11px] text-slate-500 ml-auto">
          Alvo atual: <b>{targetLabel}</b>
        </span>
      </div>

      {!hasTarget ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4">
          <p className="text-[12px] text-slate-500">
            Selecione uma <b>equipe</b> ou um <b>colaborador</b> no filtro acima
            para publicar ou visualizar recomendações temporárias.
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 mb-4">
            <p className="text-[11px] font-semibold text-slate-700 mb-2">
              Nova recomendação para{" "}
              {targetColaboradores.length === 1
                ? targetColaboradores[0].name
                : `${targetColaboradores.length} colaboradores da equipe ${filters.equipe}`}
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
                {(
                  ["info", "warning", "danger"] as RecommendationPriority[]
                ).map((p) => {
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
                        active
                          ? `${style.bg} ${style.text} ${style.border}`
                          : "bg-white text-slate-500 border-slate-200 hover:bg-slate-50",
                      )}
                    >
                      <PIcon size={11} />
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
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sendingRec ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} />
                )}
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
                  const canDelete =
                    canDeleteAny || entry.rec.authorId === currentUser?.id;
                  const targetsLabel =
                    entry.targetNames.length === 1
                      ? entry.targetNames[0]
                      : `${entry.targetNames.length} colaboradores`;
                  return (
                    <li
                      key={entry.key}
                      className={cn(
                        "flex gap-3 items-start p-3 rounded-lg border",
                        style.border,
                        style.bg,
                      )}
                    >
                      <style.Icon
                        size={15}
                        className={cn("mt-0.5 shrink-0", style.text)}
                      />
                      <div className="flex-1 min-w-0">
                        <p
                          className={cn(
                            "text-[13px] whitespace-pre-wrap break-words",
                            style.text,
                          )}
                        >
                          {entry.rec.text}
                        </p>
                        <p className="text-[10px] text-slate-500 mt-1 flex flex-wrap items-center gap-2">
                          <span>
                            {entry.rec.authorName} · {entry.rec.authorCargo}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock size={10} /> expira em{" "}
                            {getRemainingTimeLabel(entry.rec.expiresAt)}
                          </span>
                          <span className="text-slate-400">
                            · para {targetsLabel}
                          </span>
                        </p>
                      </div>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => handleRemoveRec(entry.ids)}
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
            <p className="text-[12px] text-slate-400 italic">
              Nenhuma orientação temporária ativa para {targetLabel}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────
export default function Inte_comerce() {
  const { collaborators, currentStartDate, currentEndDate } = useAppStore();

  const [filters, setFilters] = useState<FiltersState>({
    equipe: "todas",
    colaborador: "todos",
    produto: "Todos",
  });
  const { equipe, colaborador, colaboradorId, produto } = filters;

  const [grouping, setGrouping] = useState<"person" | "team">("person");
  const [search, setSearch] = useState<string>("");
  const [sortKey, setSortKey] = useState<string>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overview, setOverview] = useState<InteComerceOverview>(EMPTY_OVERVIEW);
  const [strategic, setStrategic] = useState<InteComerceStrategic>(EMPTY_STRATEGIC);
  const [funnel, setFunnel] = useState<InteComerceFunnel>(EMPTY_FUNNEL);
  const [reasons, setReasons] = useState<InteComerceReason[]>([]);
  const [daily, setDaily] = useState<InteComerceDaily[]>([]);
  const [collabTable, setCollabTable] = useState<InteComerceCollaborator[]>([]);
  const [teamTable, setTeamTable] = useState<InteComerceTeam[]>([]);

  // ── Carregamento dos indicadores e da tabela selecionada
  const reloadData = useCallback(async () => {
    if (!currentStartDate || !currentEndDate) return;
    setLoading(true);
    setError(null);
    const params = {
      start: currentStartDate,
      end: currentEndDate,
      equipe: equipe !== "todas" ? equipe : undefined,
      colaboradorId,
      produto,
    };
    try {
      const o = await fetchInteComerceOverview(params);
      setOverview(o || EMPTY_OVERVIEW);

      const s = await fetchInteComerceStrategic(params);
      setStrategic(s || EMPTY_STRATEGIC);

      const f = await fetchInteComerceFunnel(params);
      setFunnel(f || EMPTY_FUNNEL);

      const r = await fetchInteComerceDisqualify(params);
      setReasons(r || []);

      const d = await fetchInteComerceDaily(params);
      setDaily(d || []);

      if (grouping === "team") {
        setTeamTable((await fetchInteComerceTeams(params)) || []);
      } else {
        setCollabTable((await fetchInteComerceCollaborators(params)) || []);
      }
    } catch (err: any) {
      console.error("Erro ao carregar Inte_comerce:", err);
      setError(err.message || "Falha ao carregar dados.");
    } finally {
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate, equipe, colaboradorId, produto, grouping]);

  useEffect(() => {
    void reloadData();
  }, [reloadData]);

  const handleFilterChange = useCallback((rawFilters: FiltersState) => {
    setFilters((prev) => {
      if (
        prev.equipe === rawFilters.equipe &&
        prev.colaborador === rawFilters.colaborador &&
        String(prev.colaboradorId ?? "") === String(rawFilters.colaboradorId ?? "") &&
        prev.produto === rawFilters.produto
      )
        return prev;
      return rawFilters;
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    await reloadData();
  }, [reloadData]);

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

  const seriesData = useMemo(
    () =>
      daily.map((d) => ({
        date: d.dia,
        received: d.recebidos,
        signed: d.assinados_ate_corte,
      })),
    [daily],
  );

  const tableRows = useMemo<Row[]>(() => {
    if (grouping === "team") {
      return teamTable.map((t) => ({
        key: t.equipe,
        name: t.equipe,
        team: t.equipe,
        received: t.recebimentos_assessor_deal_dia,
        worked: t.trabalhados,
        contact: t.em_contato,
        collection: t.coleta,
        signed: t.assinados,
        gained: t.ganhos,
        protocolados: t.protocolados,
      }));
    }
    return collabTable.map((c) => ({
      key: c.colaborador_id || c.colaborador,
      name: c.colaborador,
      team: c.equipe_atual || "—",
      received: c.recebimentos_deal_dia,
      worked: c.trabalhados,
      contact: c.em_contato,
      collection: c.coleta,
      signed: c.assinados,
      gained: c.ganhos,
      protocolados: c.protocolados,
    }));
  }, [grouping, collabTable, teamTable]);

  const filteredTable = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("pt-BR");
    let arr = tableRows;
    if (q) {
      arr = arr.filter((r) =>
        `${r.name} ${r.team}`.toLocaleLowerCase("pt-BR").includes(q),
      );
    }
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

  const weekdays = countWeekdays(currentStartDate || "", currentEndDate || "");
  const avgSignedPerDay = weekdays ? aggregates.signed / weekdays : 0;
  const hasActiveFilters =
    equipe !== "todas" || colaborador !== "todos" || produto !== "Todos";

  const maxDisqReasons = reasons.reduce(
    (m, r) => Math.max(m, r.deals_desqualificados),
    0,
  );

  const handleExportCsv = () => {
    if (filteredTable.length === 0) return;
    const header = [
      grouping === "person" ? "Colaborador" : "Equipe",
      "Equipe",
      "Recebidos",
      "Trabalhados",
      "Em contato",
      "Coleta",
      "Assinados",
      "Ganhos",
      "Protocolados",
    ];
    const rows = filteredTable.map((r) => [
      r.name, r.team, r.received, r.worked, r.contact,
      r.collection, r.signed, r.gained, r.protocolados,
    ]);
    const csv =
      "\uFEFF" +
      [header, ...rows]
        .map((row) =>
          row
            .map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`)
            .join(";"),
        )
        .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `producao_comercial_${currentStartDate ?? "inicio"}_${currentEndDate ?? "fim"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ═══════════════════════════════════════════════════════════
  return (
    <DashboardLayout
      title="Inteligência Comercial"
      subtitle="Visão consolidada da operação, da distribuição à assinatura e ao resultado jurídico, em uma única página."
    >
      <FilterBar
        onFilterChange={handleFilterChange}
        showColaboradorFilter={true}
        className="mb-6"
        onRefresh={handleRefresh}
      />

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

      {/* ═══════════════════════════════════════════════════════
          RECOMENDAÇÕES TEMPORÁRIAS (24h) — supervisor+
          Alvo definido pelo filtro acima (colaborador OU equipe).
          ═══════════════════════════════════════════════════════ */}
      <RecomendacoesCard filters={filters} colaboradores={collaborators} />

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

      {/* ═══════════════════════════════════════════════════════
          1) VISÃO GERAL DO FUNIL  (K01A)
          ═══════════════════════════════════════════════════════ */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-[#0f172a]">Visão geral do funil</h2>
            <p className="text-xs text-[#64748b]">
              Sete indicadores principais do período selecionado.
            </p>
          </div>
          <span className="badge info">SAFRA · K01A</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {STAT_CARDS.map((card) => (
            <div key={card.key} className="card p-4">
              <div className="text-[11px] text-[#64748b] font-medium">{card.label}</div>
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
                {card.sub}
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

      {/* ═══════════════════════════════════════════════════════
          2) PERFORMANCE COMERCIAL  (K02A)
          ═══════════════════════════════════════════════════════ */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-[#0f172a]">Performance Comercial</h2>
            <p className="text-xs text-[#64748b]">
              Métricas estratégicas em um bloco unificado.
            </p>
          </div>
          <span className="badge info">SAFRA · K02A</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="card p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#407de5]" />
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-[#50627a]">
                Média de assinados / dia
              </h3>
              <span className="badge success">SAFRA</span>
            </div>
            <div className="text-4xl font-black tracking-tight mt-3 tabular-nums text-[#0f172a]">
              {avgSignedPerDay.toFixed(1).replace(".", ",")}
            </div>
            <p className="text-[11px] text-[#8c9bae] mt-3 min-h-[36px]">
              {formatInt(aggregates.signed)} assinados · {formatInt(weekdays)} dias de semana
            </p>
            <div className="border-t border-[#eaf0f6] pt-3 mt-3 text-[11px] text-[#61768f]">
              Assinados ORIGINAL da safra ÷ dias úteis do período.
            </div>
          </div>

          <div className="card p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#1a9ac5]" />
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-[#50627a]">
                Conversão geral operacional
              </h3>
              <span className="badge info">SAFRA</span>
            </div>
            <div className="text-4xl font-black tracking-tight mt-3 tabular-nums text-[#0f172a]">
              {strategic.pct_recebidos_ate_assinados
                ? `${strategic.pct_recebidos_ate_assinados.toFixed(1).replace(".", ",")}%`
                : "—"}
            </div>
            <p className="text-[11px] text-[#8c9bae] mt-3 min-h-[36px]">
              {formatInt(strategic.assinados)} assinados ÷ {formatInt(strategic.recebidos)} recebidos
            </p>
            <div className="border-t border-[#eaf0f6] pt-3 mt-3 text-[11px] text-[#61768f]">
              Recebidos → assinados na mesma safra (K02A).
            </div>
          </div>

          <div className="card p-5 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-[#189e79]" />
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-[#50627a]">
                Conversão assinados → ganhos
              </h3>
              <span className="badge success">SAFRA</span>
            </div>
            <div className="text-4xl font-black tracking-tight mt-3 tabular-nums text-[#0f172a]">
              {strategic.pct_assinados_ate_ganhos
                ? `${strategic.pct_assinados_ate_ganhos.toFixed(1).replace(".", ",")}%`
                : "—"}
            </div>
            <p className="text-[11px] text-[#8c9bae] mt-3 min-h-[36px]">
              {formatInt(strategic.assinados_que_ganharam)} ganhos de {formatInt(strategic.assinados)} assinados
            </p>
            <div className="border-t border-[#eaf0f6] pt-3 mt-3 text-[11px] text-[#61768f]">
              Ganho registrado após a assinatura da mesma safra (K02A).
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════
          3) PROGRESSÃO DO FUNIL E DESQUALIFICAÇÃO (K03A / K04A)
          ═══════════════════════════════════════════════════════ */}
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
          <span className="badge info">SAFRA · K03A / K04A</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="card p-5 lg:col-span-2">
            <h3 className="text-sm font-bold text-[#0f172a] mb-4">
              Progressão do funil comercial
            </h3>
            <div className="space-y-2.5">
              {FUNNEL_STAGES.map((stage, i) => {
                const value = (funnel[stage.key] as number) || 0;
                const base = funnel.recebidos;
                const width = base ? Math.max(2, (value / base) * 100) : 2;
                return (
                  <div
                    key={stage.key}
                    className="w-full grid grid-cols-[110px_1fr_70px_70px] items-center gap-3 text-xs py-1 px-1"
                  >
                    <span className="font-medium text-[#0f172a] text-left">
                      {stage.label}
                    </span>
                    <div className="h-2.5 rounded-full bg-[#edf2f8] overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full bg-gradient-to-r",
                          stage.gradient,
                        )}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <span className="font-bold text-right text-[#0f172a] tabular-nums">
                      {formatInt(value)}
                    </span>
                    <span className="text-right text-[#94a3b8] tabular-nums">
                      {pctOfPrevious(i)}
                    </span>
                  </div>
                );
              })}

              <div className="w-full grid grid-cols-[110px_1fr_70px_70px] items-center gap-3 text-xs border-t border-dashed border-[#e2e8f0] pt-3 mt-2 py-1 px-1">
                <span className="font-medium text-[#DC2626] text-left">
                  ↳ Desqualificados
                </span>
                <div className="h-2.5 rounded-full bg-[#fef2f2] overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[#df8d93]"
                    style={{
                      width: `${
                        funnel.recebidos
                          ? Math.max(
                              2,
                              (funnel.desqualificados_saida / funnel.recebidos) *
                                100,
                            )
                          : 2
                      }%`,
                    }}
                  />
                </div>
                <span className="font-bold text-right text-[#0f172a] tabular-nums">
                  {formatInt(funnel.desqualificados_saida)}
                </span>
                <span className="text-right text-[#94a3b8] tabular-nums">
                  {formatPct(funnel.desqualificados_saida, funnel.recebidos)}
                </span>
              </div>
            </div>
            <div className="mt-4 rounded-lg bg-[#f4f8ff] border-l-2 border-[#82a9e7] px-3 py-2 text-[11px] text-[#627a98]">
              <strong className="text-[#2357a3]">Desqualificados</strong> é saída
              paralela, não uma etapa posterior a Protocolados. Fonte:{" "}
              <code className="text-[10px]">
                ops.v_bi_v6_coortes.primeira_desqualificacao_em
              </code>
              .
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
              {reasons.length === 0 && (
                <p className="text-xs text-[#94a3b8]">
                  {loading
                    ? "Carregando motivos…"
                    : "Nenhum motivo registrado no período."}
                </p>
              )}
              {reasons.map((reason) => {
                const width = maxDisqReasons
                  ? Math.max(
                      2,
                      (reason.deals_desqualificados / maxDisqReasons) * 100,
                    )
                  : 2;
                return (
                  <div
                    key={reason.motivo}
                    className="grid grid-cols-[1fr_1.6fr_50px] items-center gap-3 text-xs"
                  >
                    <span
                      className="text-[#0f172a] font-medium truncate"
                      title={reason.motivo}
                    >
                      {reason.motivo}
                    </span>
                    <div className="h-2 rounded-full bg-[#edf1f7] overflow-hidden">
                      <div
                        className="h-full rounded-full bg-[#d99362]"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <strong className="text-right text-[#0f172a] tabular-nums">
                      {formatInt(reason.deals_desqualificados)}
                    </strong>
                  </div>
                );
              })}
            </div>
            <div className="mt-4 text-[11px] text-[#94a3b8]">
              Fonte: <strong>K04A</strong> — motivo atual do Deal no momento da
              desqualificação.
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════
          4) TABELA DE PRODUÇÃO (K05A / K06A)
          ═══════════════════════════════════════════════════════ */}
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

        <div className="card">
          <div className="p-5 border-b border-[#e2e8f0]">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-sm font-bold text-[#0f172a]">
                  Produção comercial
                </h3>
                <p className="text-xs text-[#64748b] mt-0.5">
                  {grouping === "person" ? "Colaboradores" : "Equipes"} · SAFRA por
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

      {/* ═══════════════════════════════════════════════════════
          5) EVOLUÇÃO DIÁRIA (K07A)
          ═══════════════════════════════════════════════════════ */}
      <div className="mb-6">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <div>
            <h2 className="text-lg font-bold text-[#0f172a]">
              Evolução de recebimentos e assinaturas
            </h2>
            <p className="text-xs text-[#64748b]">
              Duas barras lado a lado por dia, sem filtro próprio. Segue o
              período, equipe e colaborador do topo.
            </p>
          </div>
          <span className="badge">SAFRA · K07A</span>
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
            <h3 className="text-sm font-bold text-[#0f172a]">
              Recebidos × Assinados (safra)
            </h3>
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
              <BarChart data={seriesData} barGap={2}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#e2e8f0"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => dateBr(v).slice(0, 5)}
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
                  labelFormatter={(v) => dateBr(String(v))}
                  formatter={(value: any, name: any) => [
                    formatInt(Number(value)),
                    name === "received" ? "Recebidos" : "Assinados (safra)",
                  ]}
                  contentStyle={{ fontSize: 12, borderRadius: 8 }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 11 }}
                  formatter={(value) =>
                    value === "received" ? "Recebidos" : "Assinados"
                  }
                />
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