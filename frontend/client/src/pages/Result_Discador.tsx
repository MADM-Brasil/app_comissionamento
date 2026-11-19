// src/pages/Result_Discador.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore } from "@/lib/dataStore";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  Loader2, RefreshCw, AlertTriangle, Download, Search,
  ChevronDown, ArrowDown, ArrowUp,
} from "lucide-react";
import {
  fetchResultadoDiscador,
  sumRows,
  groupBy,
  METRICS,
  type DiscadorRow,
  type DiscadorTotals,
  type MetricKey,
} from "@/lib/resultDiscador";
import {
  applyScope,
  buildCollabIndex,
  collabId,
  isHiddenRow,
  normKey,
} from "@/lib/discadorFilters";

// ============================================================
// HELPERS
// ============================================================

// ─── Blacklist de equipes (espelha Inte_commerce + SQL) ──────────────────────
const EXCLUDED_TEAMS: string[] = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria',
  'Departamento Marketing', 'Departamento Comercial',
  'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael', 'Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo', 'Equipe Jennifer',
  'Equipe Natalia', 'Equipe Maria Eduarda', 'Equipe Reciclagem',
  '', 'Equipe', 'Equipe Camila', 'Sales Ops',
  'Equipe Elizandra', 'Equipe Bruno Abreu', 'Equipe Lucas Magno',
  'Equipe SP1', 'Equipe Marcia', 'Equipe Lucilene', 'backoffice',
  'Equipe Debora', 'Equipe Curitiba', 'Equipe Gabriela Toledo',
  'Equipe SP01', 'Equipe Adriele', 'Equipe Toledo',
  'Equipe Priscila', 'Equipe Maiana', 'Equipe Marcio',
];
const EXCLUDED_TEAMS_UPPER = new Set(
  EXCLUDED_TEAMS.map((t) => String(t).trim().toUpperCase()).filter(Boolean),
);
function isExcludedTeam(team: string | null | undefined): boolean {
  if (!team) return false;
  return EXCLUDED_TEAMS_UPPER.has(String(team).trim().toUpperCase());
}

// ─── Blacklist de cargos ─────────────────────────────────────────────────────
const EXCLUDED_CARGOS_FOR_DISPLAY = [
  "desativado", "assistente", "analista juridico", "gestor de projetos", "analista",
  "analista de discadora", "supervisor", "coordenador", "salesops", "ceo",
  "analista de crm", "desenvolvedor", "diretora", "analista de dados", "desenvolvedor make",
];

const normalizeKey = (s: string | undefined | null) =>
  String(s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const EXCLUDED_CARGOS_SET = new Set(EXCLUDED_CARGOS_FOR_DISPLAY.map(normalizeKey));

const DEACTIVATED_VALUES = new Set(
  [
    "desativado", "desativada", "desativados", "desativadas",
    "inativo", "inativa", "inativos", "inativas",
    "desligado", "desligada", "desligados", "desligadas",
    "inactive", "disabled", "off", "suspenso", "suspensa",
    "bloqueado", "bloqueada",
    "inabilitado", "inabilitada", "afastado", "afastada",
    "desativado(a)", "inativo(a)",
  ].map(normalizeKey),
);

const STATUS_LIKE_KEYS = [
  "status", "status_colaborador", "statusColaborador",
  "situacao", "situação", "situacao_colaborador", "situacaoColaborador",
  "estado", "state",
  "classificacao", "classificacaoOperacional", "classificacao_operacional",
  "grupo", "canal", "tipo",
  "situacao_operacional", "status_operacional",
];

function hasDeactivatedValue(c: any): boolean {
  if (!c) return false;
  for (const key of STATUS_LIKE_KEYS) {
    const n = normalizeKey((c as any)[key]);
    if (n && DEACTIVATED_VALUES.has(n)) return true;
  }
  for (const key of Object.keys(c)) {
    const kl = key.toLowerCase();
    if (
      !kl.includes("status") && !kl.includes("situacao") && !kl.includes("situação") &&
      !kl.includes("classificacao") && !kl.includes("classificação") &&
      !kl.includes("canal") && !kl.includes("grupo") &&
      !kl.includes("tipo") && !kl.includes("estado")
    ) continue;
    const v = (c as any)[key];
    if (typeof v !== "string") continue;
    const n = normalizeKey(v);
    if (n && DEACTIVATED_VALUES.has(n)) return true;
  }
  return false;
}

function pickCargo(c: any): string {
  if (!c) return "";
  return normalizeKey(
    c.cargo ?? c.cargoNome ?? c.cargo_nome ??
    c.role ?? c.funcao ?? c.função ?? c.cargoAtual,
  );
}

function isHiddenCollaborator(c: any): boolean {
  if (!c) return false;
  if (hasDeactivatedValue(c)) return true;
  const cargo = pickCargo(c);
  if (!cargo) return false;
  if (DEACTIVATED_VALUES.has(cargo)) return true;
  if (EXCLUDED_CARGOS_SET.has(cargo)) return true;
  return false;
}

const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")}%`;
const fmtInt = (n: number) => (n || 0).toLocaleString("pt-BR");
const mm = (s: number) => {
  const v = Math.round(s || 0);
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};
const cvOf = (as: number, ca: number) => (ca > 0 ? as / ca : 0);
const txOf = (cp: number, d: number) => (d > 0 ? cp / d : 0);
const qrOf = (qd: number, d: number) => (d > 0 ? qd / d : 0);

type View = "gerencial" | "operacional";
type SubView = "equipes" | "agentes" | "campanhas";
type SortKey = "n" | "t" | "c" | "d" | "tx" | "ca" | "as" | "cv" | "qr" | "tm";

// ============================================================
// TOOLTIPS (hover) — termos técnicos
// ============================================================
const TERM_TIPS: Record<string, { title: string; text: string }> = {
  acionamentos: { title: "Acionamento",  text: "Alô / atendida. Toda tentativa de contato efetivamente atendida." },
  cpc:          { title: "CPC",          text: "Contato com a pessoa certa (decisor / responsável pelo negócio)." },
  "cpc-a":      { title: "CPC-A",        text: "CPC com intenção de prosseguir — é tudo aquilo que foi prospectado." },
  assinados:    { title: "Assinados",    text: "Contratos assinados atribuídos à discadora no período." },
  conversao:    { title: "Conversão",    text: "Assinados ÷ CPC-A. Mede a eficiência sobre o que realmente foi prospectado." },
  tma:          { title: "TMA por CPC",  text: "Tempo médio de atendimento (em minutos:segundos) por CPC." },
  queda:        { title: "Queda",        text: "Percentual de acionamentos encerrados por queda de ligação." },
};

function Tip({ term, children }: { term: keyof typeof TERM_TIPS; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);
  const data = TERM_TIPS[term];

  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: r.left + r.width / 2, y: r.top });
    setOpen(true);
  };

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        tabIndex={0}
        className={cn(
          "border-b border-dotted border-[#94a3b8] cursor-help outline-none transition-colors",
          "hover:border-[#2F6FED] hover:text-[#2F6FED]",
          "focus-visible:border-[#2F6FED] focus-visible:text-[#2F6FED]",
        )}
      >
        {children}
      </span>
      {open && data && (
        <div
          role="tooltip"
          className={cn(
            "fixed z-50 max-w-[260px] px-3 py-2 rounded-lg pointer-events-none",
            "bg-white text-[#334155] text-[12px] leading-snug font-medium",
            "border border-[#e2e8f0] shadow-md",
          )}
          style={{
            left: Math.max(8, Math.min(pos.x - 130, window.innerWidth - 268)),
            top: Math.max(8, pos.y - 68),
          }}
        >
          <b className="block text-[10px] uppercase tracking-wider text-[#2F6FED] mb-1">
            {data.title}
          </b>
          {data.text}
        </div>
      )}
    </>
  );
}

// ============================================================
// COMPONENTES DE APOIO
// ============================================================
function KpiCard({
  label, value, sub, accent, tip,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "danger" | "warning" | "brand" | "success";
  tip?: keyof typeof TERM_TIPS;
}) {
  const colorClass =
    accent === "danger" ? "text-red-600"
      : accent === "warning" ? "text-amber-600"
      : accent === "success" ? "text-emerald-600"
      : accent === "brand" ? "text-[#2F6FED]"
      : "text-[#0f172a]";
  return (
    <Card className="p-4">
      <div className="text-[11px] text-[#64748b] font-medium">
        {tip ? <Tip term={tip}>{label}</Tip> : label}
      </div>
      <div className={cn("text-2xl font-black mt-1 tabular-nums", colorClass)}>{value}</div>
      {sub && <div className="text-[10px] text-[#94a3b8] mt-1 leading-snug">{sub}</div>}
    </Card>
  );
}

function Bar({
  label, value, max, right, color = "#2F6FED",
}: {
  label: string;
  value: number;
  max: number;
  right: string;
  color?: string;
}) {
  const width = Math.max(2, (value / (max || 1)) * 100);
  return (
    <div className="grid grid-cols-[minmax(110px,180px)_1fr_auto] gap-3 items-center py-1">
      <div className="text-xs font-medium text-[#0f172a] truncate" title={label}>
        {label}
      </div>
      <div className="relative h-2.5 bg-[#eef0f4] rounded-full">
        <div className="h-full rounded-full" style={{ width: `${width}%`, background: color }} />
      </div>
      <div className="text-xs text-[#64748b] tabular-nums text-right min-w-[92px]">{right}</div>
    </div>
  );
}

function FunnelRow({ label, value, hint, max }: {
  label: string; value: number; hint: string; max: number;
}) {
  const width = Math.max(2, (value / (max || 1)) * 100);
  return (
    <div className="grid grid-cols-[90px_1fr_60px] gap-3 items-center py-1.5 text-xs">
      <div>
        <p className="font-medium text-[#0f172a]">{label}</p>
        <p className="text-[10px] text-[#94a3b8]">{hint}</p>
      </div>
      <div className="h-2.5 bg-[#eef0f4] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#2F6FED] to-[#5b8cff]"
          style={{ width: `${width}%` }}
        />
      </div>
      <div className="text-right font-bold text-[#0f172a] tabular-nums">{fmtInt(value)}</div>
    </div>
  );
}

// ============================================================
// PÁGINA
// ============================================================
export default function ResultDiscador() {
  const { currentStartDate, currentEndDate, collaborators } = useAppStore();

  const [filters, setFilters] = useState<{ equipe: string; colaborador: string; unidadeId?: number }>({
    equipe: "todas",
    colaborador: "todos",
  });

  const [view, setView] = useState<View>("gerencial");
  const [subView, setSubView] = useState<SubView>("equipes");
  const [rows, setRows] = useState<DiscadorRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtros locais (aba Operacional)
  const [campaignFilter, setCampaignFilter] = useState<string>("");
  const [minCpcA, setMinCpcA] = useState<number>(0);
  const [agentSearch, setAgentSearch] = useState<string>("");
  const [showAllAgents, setShowAllAgents] = useState(false);

  // Métrica / ordenação
  const [teamMetric, setTeamMetric] = useState<MetricKey>("as");
  const [sortKey, setSortKey] = useState<SortKey>("as");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  // ── Carregamento
  const reload = useCallback(async () => {
    if (!currentStartDate || !currentEndDate) return;
    setLoading(true);
    setError(null);
    try {
      const inclusiveEnd = new Date(`${currentEndDate}T00:00:00.000Z`);
      inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);
      // Busca o período inteiro; equipe / unidade / colaborador são
      // filtrados abaixo (filteredRows), sem precisar recarregar.
      const data = await fetchResultadoDiscador({
        start: currentStartDate,
        end: inclusiveEnd.toISOString().slice(0, 10),
      });
      setRows(data);
    } catch (err: unknown) {
      console.error("Erro ao carregar resultado do discador:", err);
      setError(err instanceof Error ? err.message : "Falha ao carregar dados.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate]);

  useEffect(() => { void reload(); }, [reload]);

  const handleFilterChange = useCallback(
    (raw: { equipe: string; colaborador: string; produto: string; unidadeId?: number }) => {
      setFilters((prev) => {
        if (prev.equipe === raw.equipe && prev.colaborador === raw.colaborador && prev.unidadeId === raw.unidadeId) {
          return prev;
        }
        return { equipe: raw.equipe, colaborador: raw.colaborador, unidadeId: raw.unidadeId };
      });
    },
    [],
  );

  const collabIndex = useMemo(() => buildCollabIndex(collaborators as any[]), [collaborators]);

  // Agentes ocultos (cargo/status na blacklist): só correspondência EXATA por
  // id ou nome normalizado. Antes bastavam 2 nomes em comum ("Ana Paula Rocha"
  // × "Ana Paula Souza") para esconder alguém — e as assinaturas dele sumiam.
  const hiddenCollabKeys = useMemo(() => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const c of collaborators) {
      if (!isHiddenCollaborator(c)) continue;
      const id = collabId(c as any);
      if (id) ids.add(id);
      const n = normKey((c as any).name);
      if (n) names.add(n);
    }
    return { ids, names };
  }, [collaborators]);

  // ── Derivados
  // Linhas no escopo de equipe / unidade / colaborador (FilterBar).
  const scopedRows = useMemo(
    () =>
      applyScope(
        rows.filter((r) => !isExcludedTeam(r.nome_equipe)),
        { equipe: filters.equipe, colaborador: filters.colaborador, unidadeId: filters.unidadeId },
        collabIndex,
      ),
    [rows, filters.equipe, filters.colaborador, filters.unidadeId, collabIndex],
  );

  // Agentes do discador sem cadastro vinculado: não têm unidade/equipe,
  // então ficam de fora quando há filtro de unidade ou equipe.
  const unlinked = useMemo(() => {
    const list = rows.filter((r) => r.colaborador_id == null && r.unidade_id == null && !r.nome_equipe);
    return {
      agents: new Set(list.map((r) => r.agent_name)).size,
      dials: list.reduce((s, r) => s + (r.total_discagens || 0), 0),
      signed: list.reduce((s, r) => s + (r.assinados || 0), 0),
    };
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = agentSearch.trim().toLowerCase();
    return scopedRows.filter((r) => {
      if (isHiddenRow(r, hiddenCollabKeys)) return false;
      if (campaignFilter && r.campaign_name !== campaignFilter) return false;
      if (minCpcA > 0 && r.cpc_a < minCpcA) return false;
      if (q) {
        const hay = `${r.agent_name} ${r.campaign_name} ${r.nome_equipe ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [scopedRows, campaignFilter, minCpcA, agentSearch, hiddenCollabKeys]);

  const T = useMemo(() => sumRows(filteredRows), [filteredRows]);
  const teamGroups = useMemo(() => groupBy(filteredRows, "nome_equipe"), [filteredRows]);
  const campaignGroups = useMemo(() => groupBy(filteredRows, "campaign_name"), [filteredRows]);
  const agentGroups = useMemo(() => groupBy(filteredRows, "agent_name"), [filteredRows]);

  const campaigns = useMemo(
    () => Array.from(new Set(scopedRows.map((r) => r.campaign_name))).sort(),
    [scopedRows],
  );

  const hasData = filteredRows.length > 0;
  const isEmpty = !loading && !hasData && !error;
  const hasActiveFilters =
    filters.equipe !== "todas" ||
    filters.colaborador !== "todos" ||
    filters.unidadeId != null ||
    !!campaignFilter ||
    minCpcA > 0 ||
    !!agentSearch;

  // ── Insights
  const insights = useMemo(() => {
    if (T.d === 0 && T.as === 0) return [];
    const out: string[] = [];
    if (T.d > 0) {
      out.push(
        `A cada 100 acionamentos, ${(txOf(T.cp, T.d) * 100).toFixed(0)} viram contato e ` +
        `${((T.ca / T.d) * 100).toFixed(1).replace(".", ",")} viram CPC-A.`,
      );
      out.push(
        `Queda e mudo consomem ${pct((T.qd + T.mu) / T.d)} dos acionamentos — ` +
        `principal ponto de recuperação.`,
      );
    }
    const eligible = teamGroups.filter((g) => g.t.ca >= 100);
    if (eligible.length > 1) {
      const best = [...eligible].sort((a, b) => cvOf(b.t.as, b.t.ca) - cvOf(a.t.as, a.t.ca))[0];
      out.push(
        `Melhor conversão entre equipes com 100+ CPC-A: **${best.k}** (${pct(cvOf(best.t.as, best.t.ca))}).`,
      );
    }
    const topAgent = [...agentGroups].sort((a, b) => b.t.as - a.t.as)[0];
    if (topAgent?.t.as) {
      out.push(`Maior número de assinados: **${topAgent.k}**, com ${fmtInt(topAgent.t.as)}.`);
    }
    return out;
  }, [T, teamGroups, agentGroups]);

  // ── Export CSV
  const handleExport = () => {
    let header: string[];
    let data: (string | number)[][];

    if (subView === "agentes") {
      header = ["Agente", "Equipe", "Campanha", "Acionamentos", "%CPC", "CPC-A", "Assinados", "Conversão", "%Queda", "TMA"];
      data = agentGroups.map((g) => [
        g.k,
        g.rows[0]?.nome_equipe ?? "",
        g.rows[0]?.campaign_name ?? "",
        g.t.d,
        pct(txOf(g.t.cp, g.t.d)),
        g.t.ca,
        g.t.as,
        pct(cvOf(g.t.as, g.t.ca)),
        pct(qrOf(g.t.qd, g.t.d)),
        g.t.cp ? mm(g.t.tma / g.t.cp) : "–",
      ]);
    } else if (subView === "campanhas") {
      header = ["Campanha", "Acionamentos", "%CPC", "CPC-A", "Assinados", "Conversão", "%Queda"];
      data = campaignGroups.map((g) => [
        g.k, g.t.d, pct(txOf(g.t.cp, g.t.d)), g.t.ca, g.t.as,
        pct(cvOf(g.t.as, g.t.ca)), pct(qrOf(g.t.qd, g.t.d)),
      ]);
    } else {
      header = ["Equipe", "Acionamentos", "%CPC", "CPC-A", "Assinados", "Conversão", "%Queda"];
      data = teamGroups.map((g) => [
        g.k, g.t.d, pct(txOf(g.t.cp, g.t.d)), g.t.ca, g.t.as,
        pct(cvOf(g.t.as, g.t.ca)), pct(qrOf(g.t.qd, g.t.d)),
      ]);
    }

    const csv =
      "\uFEFF" +
      [header, ...data]
        .map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";"))
        .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `resultado_discador_${subView}_${currentStartDate ?? "inicio"}_${currentEndDate ?? "fim"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Sort dos agentes
  const sortedAgents = useMemo(() => {
    const list = [...agentGroups];
    list.sort((a, b) => {
      const get = (g: typeof a): number | string => {
        switch (sortKey) {
          case "n": return g.k.toLowerCase();
          case "t": return (g.rows[0]?.nome_equipe ?? "").toLowerCase();
          case "c": return (g.rows[0]?.campaign_name ?? "").toLowerCase();
          case "d": return g.t.d;
          case "tx": return txOf(g.t.cp, g.t.d);
          case "ca": return g.t.ca;
          case "as": return g.t.as;
          case "cv": return cvOf(g.t.as, g.t.ca);
          case "qr": return qrOf(g.t.qd, g.t.d);
          case "tm": return g.t.cp ? g.t.tma / g.t.cp : 0;
          default: return 0;
        }
      };
      const av = get(a);
      const bv = get(b);
      if (typeof av === "string" && typeof bv === "string") {
        return av.localeCompare(bv) * sortDir;
      }
      return ((av as number) - (bv as number)) * sortDir;
    });
    return showAllAgents ? list : list.slice(0, 15);
  }, [agentGroups, sortKey, sortDir, showAllAgents]);

  const toggleSort = (key: SortKey) => {
    setSortKey((prev) => {
      setSortDir((d) => (prev === key ? (d === 1 ? -1 : 1) : key === "n" || key === "t" || key === "c" ? 1 : -1));
      return key;
    });
  };

  // ═══════════════════════════════════════════════════════════
  return (
    <DashboardLayout
      title="Discador × Assinaturas"
      subtitle="Performance de acionamentos, CPC-A e conversão de assinaturas."
    >
      <FilterBar
        onFilterChange={handleFilterChange}
        showColaboradorFilter
        showProdutoFilter={false}
        className="mb-6"
      />

      {loading && (
        <div className="mb-4 flex items-center gap-2 text-xs text-[#64748b]">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando resultado do discador…
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
              onClick={() => void reload()}
              className="mt-2 px-3 py-1 bg-red-600 text-white rounded text-[11px] font-semibold hover:bg-red-700"
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )}

      {isEmpty && !error && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800 text-center">
          Nenhum registro de discagem ou assinatura no período selecionado.
        </div>
      )}

      {hasData && (
        <>
          {/* Tabs Gerencial / Operacional */}
          <div className="mb-4 flex items-center gap-2 flex-wrap">
            <div className="flex rounded-lg border border-[#e2e8f0] overflow-hidden">
              <button
                type="button"
                onClick={() => setView("gerencial")}
                className={cn(
                  "px-3 py-1.5 text-xs font-semibold transition-colors",
                  view === "gerencial"
                    ? "bg-[#eff6ff] text-[#2F6FED]"
                    : "bg-white text-[#64748b] hover:bg-[#f8fafc]",
                )}
              >
                Gerencial
              </button>
              <button
                type="button"
                onClick={() => setView("operacional")}
                className={cn(
                  "px-3 py-1.5 text-xs font-semibold border-l border-[#e2e8f0] transition-colors",
                  view === "operacional"
                    ? "bg-[#eff6ff] text-[#2F6FED]"
                    : "bg-white text-[#64748b] hover:bg-[#f8fafc]",
                )}
              >
                Operacional
              </button>
            </div>
            {view === "operacional" && (
              <>
                <div className="ml-auto flex rounded-lg border border-[#e2e8f0] overflow-hidden">
                  {(["equipes", "agentes", "campanhas"] as SubView[]).map((sv) => (
                    <button
                      key={sv}
                      type="button"
                      onClick={() => setSubView(sv)}
                      className={cn(
                        "px-3 py-1.5 text-xs font-semibold border-l first:border-l-0 border-[#e2e8f0] transition-colors",
                        subView === sv
                          ? "bg-[#eff6ff] text-[#2F6FED]"
                          : "bg-white text-[#64748b] hover:bg-[#f8fafc]",
                      )}
                    >
                      {sv[0].toUpperCase() + sv.slice(1)}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleExport}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#e2e8f0] rounded-lg text-xs font-semibold text-[#475569] bg-white hover:bg-[#f1f5f9]"
                >
                  <Download size={12} /> Exportar CSV
                </button>
              </>
            )}
          </div>

          {view === "gerencial" ? (
            <GerencialView
              T={T}
              teamGroups={teamGroups}
              insights={insights}
              teamMetric={teamMetric}
              setTeamMetric={setTeamMetric}
            />
          ) : (
            <OperacionalView
              subView={subView}
              T={T}
              teamGroups={teamGroups}
              agentGroups={sortedAgents}
              campaignGroups={campaignGroups}
              campaigns={campaigns}
              campaignFilter={campaignFilter}
              setCampaignFilter={setCampaignFilter}
              minCpcA={minCpcA}
              setMinCpcA={setMinCpcA}
              agentSearch={agentSearch}
              setAgentSearch={setAgentSearch}
              showAllAgents={showAllAgents}
              setShowAllAgents={setShowAllAgents}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
          )}
        </>
      )}
    </DashboardLayout>
  );
}

// ============================================================
// VIEW GERENCIAL
// ============================================================
function GerencialView({
  T, teamGroups, insights, teamMetric, setTeamMetric,
}: {
  T: DiscadorTotals;
  teamGroups: ReturnType<typeof groupBy>;
  insights: string[];
  teamMetric: MetricKey;
  setTeamMetric: (m: MetricKey) => void;
}) {
  const noDial = 0; // reservado (assinaturas sem discagem aparecem como agente próprio)
  const conv = cvOf(T.as, T.ca);
  const tmaCpc = T.cp > 0 ? T.tma / T.cp : 0;

  // Donut
  const segments = [
    { label: "Queda de ligação", value: T.qd, color: "#DC2626" },
    { label: "Mudo", value: T.mu, color: "#D97706" },
    { label: "CPC sem negócio", value: T.sn, color: "#2F6FED" },
    { label: "CPC-A", value: T.ca, color: "#16A34A" },
    { label: "Outros", value: Math.max(0, T.d - T.qd - T.mu - T.cp), color: "#94a3b8" },
  ];
  let cum = 0;
  const stops = segments.map((seg) => {
    const w = T.d > 0 ? (seg.value / T.d) * 100 : 0;
    const start = cum;
    cum += w;
    return `${seg.color} ${start}% ${cum}%`;
  }).join(", ");
  const donutStyle = T.d > 0 ? { background: `conic-gradient(${stops})` } : { background: "#eef0f4" };

  // Time bars
  const teamSorted = [...teamGroups]
    .sort((a, b) => METRICS[teamMetric].get(b.t) - METRICS[teamMetric].get(a.t))
    .slice(0, 10);
  const teamMax = Math.max(...teamSorted.map((g) => METRICS[teamMetric].get(g.t)), 1e-9);

  // Render simples de `**bold**`
  const renderMd = (raw: string) => {
    const parts = raw.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) =>
      p.startsWith("**") && p.endsWith("**")
        ? <b key={i} className="font-semibold text-[#2F6FED]">{p.slice(2, -2)}</b>
        : <span key={i}>{p}</span>,
    );
  };

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard
          label="Acionamentos"
          value={fmtInt(T.d)}
          sub={`${pct(txOf(T.cp, T.d))} viraram contato`}
          tip="acionamentos"
        />
        <KpiCard
          label="CPC"
          value={fmtInt(T.cp)}
          sub="contatos com a pessoa certa"
          accent="brand"
          tip="cpc"
        />
        <KpiCard
          label="CPC-A"
          value={fmtInt(T.ca)}
          sub={`${pct(T.cp > 0 ? T.ca / T.cp : 0)} dos CPC`}
          accent="brand"
          tip="cpc-a"
        />
        <KpiCard
          label="Assinados Discadora"
          value={fmtInt(T.as)}
          sub={`${fmtInt(noDial)} sem acionamento`}
          accent="success"
          tip="assinados"
        />
        <KpiCard
          label="Conversão"
          value={pct(conv)}
          sub="assinados ÷ CPC-A"
          accent="success"
          tip="conversao"
        />
        <KpiCard
          label="TMA por CPC"
          value={T.cp ? mm(tmaCpc) : "–"}
          sub="minutos:segundos"
          tip="tma"
        />
      </div>

      {/* Donut + Funil */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="p-5">
          <h3 className="text-sm font-bold text-[#0f172a] mb-1">Destino dos acionamentos
            <p className="text-xs text-[#64748b]/75 mt-0.5">Como cada chamada terminou</p>
          </h3>
          <div className="flex items-center gap-6 flex-wrap">
            <div className="relative w-[180px] aspect-square rounded-full shrink-0" style={donutStyle}>
              <div className="absolute inset-6 rounded-full bg-white grid place-content-center text-center">
                <b className="text-2xl font-black text-[#0f172a] tabular-nums">{fmtInt(T.d)}</b>
                <small className="text-[10px] text-[#94a3b8]">acionamentos</small>
              </div>
            </div>
            <div className="grid gap-2 text-xs flex-1 min-w-[180px]">
              {segments.map((s) => (
                <div key={s.label} className="flex items-center gap-2 text-[#475569]">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }} />
                  <span className="flex-1">{s.label}</span>
                  <span className="font-bold tabular-nums">{pct(T.d > 0 ? s.value / T.d : 0)}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-bold text-[#0f172a] mb-1">Funil de conversão
            <p className="text-xs text-[#64748b]/75 mt-0.5">Do acionamento ao contrato assinado</p>
          </h3>
          <div className="text-[#64748b]/75 space-y-1.5">
            <FunnelRow label="Acionamentos" value={T.d} hint="alô / atendida" max={T.d} />
            <FunnelRow label="CPC" value={T.cp} hint={pct(txOf(T.cp, T.d))} max={T.d} />
            <FunnelRow label="CPC-A" value={T.ca} hint={pct(txOf(T.ca, T.cp))} max={T.d} />
            <FunnelRow label="Assinados Discadora" value={T.as} hint={pct(cvOf(T.as, T.ca))} max={T.d} />
          </div>
        </Card>
      </div>

      {/* Time bars + Insights */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h3 className="text-sm font-bold text-[#0f172a]">Desempenho por equipe</h3>
              <p className="text-xs text-[#64748b] mt-0.5">Top 10 · alternar métrica</p>
            </div>
            <div className="flex flex-wrap gap-1">
              {(Object.keys(METRICS) as MetricKey[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTeamMetric(k)}
                  className={cn(
                    "px-2 py-1 rounded-md text-[11px] font-semibold transition",
                    teamMetric === k
                      ? "bg-[#2F6FED] text-white"
                      : "bg-[#f1f5f9] text-[#64748b] hover:bg-[#e2e8f0]",
                  )}
                >
                  {METRICS[k].label}
                </button>
              ))}
            </div>
          </div>
          {teamSorted.length === 0 ? (
            <p className="text-xs text-[#94a3b8]">Sem equipes no recorte.</p>
          ) : (
            teamSorted.map((g) => (
              <Bar
                key={g.k}
                label={g.k}
                value={METRICS[teamMetric].get(g.t)}
                max={teamMax}
                right={METRICS[teamMetric].format(METRICS[teamMetric].get(g.t))}
                color={teamMetric === "qr" ? "#DC2626" : "#16A34A"}
              />
            ))
          )}
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-bold text-[#0f172a] mb-3">Leituras para decisão</h3>
          {insights.length === 0 ? (
            <p className="text-xs text-[#94a3b8]">Sem dados suficientes para gerar leituras.</p>
          ) : (
            <ul className="space-y-2">
              {insights.map((raw, i) => (
                <li
                  key={i}
                  className="bg-[#f8fafc] border border-[#e2e8f0] rounded-lg p-3 text-[13px] text-[#334155]"
                >
                  <span className="text-[#2F6FED] mr-2">•</span>
                  {renderMd(raw)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ============================================================
// VIEW OPERACIONAL
// ============================================================
function OperacionalView({
  subView, T, teamGroups, agentGroups, campaignGroups, campaigns,
  campaignFilter, setCampaignFilter, minCpcA, setMinCpcA,
  agentSearch, setAgentSearch, showAllAgents, setShowAllAgents,
  sortKey, sortDir, onSort,
}: {
  subView: SubView;
  T: DiscadorTotals;
  teamGroups: ReturnType<typeof groupBy>;
  agentGroups: ReturnType<typeof groupBy>;
  campaignGroups: ReturnType<typeof groupBy>;
  campaigns: string[];
  campaignFilter: string;
  setCampaignFilter: (v: string) => void;
  minCpcA: number;
  setMinCpcA: (v: number) => void;
  agentSearch: string;
  setAgentSearch: (v: string) => void;
  showAllAgents: boolean;
  setShowAllAgents: (v: boolean) => void;
  sortKey: SortKey;
  sortDir: 1 | -1;
  onSort: (k: SortKey) => void;
}) {
  const [campaignOpen, setCampaignOpen] = useState(false);

  const totalFiltered = subView === "agentes"
    ? agentGroups.reduce((s, g) => s + g.t.d, 0)
    : subView === "campanhas"
    ? campaignGroups.reduce((s, g) => s + g.t.d, 0)
    : teamGroups.reduce((s, g) => s + g.t.d, 0);

  const SortHead = ({ k, label, left }: { k: SortKey; label: string; left?: boolean }) => (
    <th
      className={cn("py-2 px-3 font-medium cursor-pointer select-none hover:text-[#0f172a]", left ? "text-left" : "text-right")}
      onClick={() => onSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === k && (sortDir === 1 ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </span>
    </th>
  );

  return (
    <div className="space-y-3">
      {/* Filtros locais */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <button
            type="button"
            onClick={() => setCampaignOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-[#e2e8f0] rounded-lg text-xs font-semibold text-[#475569] bg-white hover:bg-[#f1f5f9] min-w-[180px] justify-between"
          >
            <span className="truncate">{campaignFilter || "Todas as campanhas"}</span>
            <ChevronDown size={12} className={cn("transition-transform", campaignOpen && "rotate-180")} />
          </button>
          {campaignOpen && (
            <div className="absolute z-20 mt-1 w-[260px] max-h-[260px] overflow-auto bg-white border border-[#e2e8f0] rounded-lg shadow-lg p-1">
              <button
                type="button"
                onClick={() => { setCampaignFilter(""); setCampaignOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-xs hover:bg-[#f1f5f9] rounded"
              >
                Todas as campanhas
              </button>
              {campaigns.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { setCampaignFilter(c); setCampaignOpen(false); }}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-xs hover:bg-[#f1f5f9] rounded truncate",
                    campaignFilter === c && "bg-[#eff6ff] text-[#2F6FED] font-semibold",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

        <select
          value={minCpcA}
          onChange={(e) => setMinCpcA(Number(e.target.value))}
          className="px-3 py-2 border border-[#e2e8f0] rounded-lg text-xs bg-white"
        >
          <option value={0}>Sem mínimo de CPC-A</option>
          <option value={30}>CPC-A ≥ 30</option>
          <option value={100}>CPC-A ≥ 100</option>
          <option value={200}>CPC-A ≥ 200</option>
        </select>

        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#94a3b8]" />
          <input
            type="search"
            value={agentSearch}
            onChange={(e) => setAgentSearch(e.target.value)}
            placeholder="Buscar agente, equipe ou campanha"
            className="pl-8 pr-3 py-2 border border-[#e2e8f0] rounded-lg text-xs bg-white min-w-[240px]"
          />
        </div>

        <span className="text-[11px] text-[#94a3b8] ml-auto">
          {fmtInt(totalFiltered)} acionamentos · {fmtInt(T.as)} assinados
        </span>
      </div>

      {/* Tabelas */}
      {subView === "equipes" && (
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white z-10">
                <tr className="text-[#64748b] border-b border-[#e2e8f0]">
                  <th className="text-left py-2 px-3 font-medium w-10">#</th>
                  <SortHead k="t" label="Equipe" left />
                  <SortHead k="d" label="Acionamentos" />
                  <SortHead k="tx" label="%CPC" />
                  <SortHead k="ca" label="CPC-A" />
                  <SortHead k="as" label="Assinados Discadora" />
                  <SortHead k="cv" label="Conversão" />
                  <SortHead k="qr" label="%Queda" />
                </tr>
              </thead>
              <tbody>
                {teamGroups.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-8 text-[#64748b]">Nenhuma equipe no recorte.</td></tr>
                ) : (
                  [...teamGroups].sort((a, b) => b.t.as - a.t.as).map((g, i) => (
                    <tr key={g.k} className="border-b border-[#f1f5f9] hover:bg-[#f8fafc]">
                      <td className="py-2 px-3 text-[#94a3b8]">{i + 1}</td>
                      <td className="py-2 px-3 font-semibold text-[#0f172a]">{g.k}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{fmtInt(g.t.d)}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{pct(txOf(g.t.cp, g.t.d))}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{fmtInt(g.t.ca)}</td>
                      <td className="py-2 px-3 text-right font-bold tabular-nums">{fmtInt(g.t.as)}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{pct(cvOf(g.t.as, g.t.ca))}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{pct(qrOf(g.t.qd, g.t.d))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {subView === "agentes" && (
        <>
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white z-10">
                  <tr className="text-[#64748b] border-b border-[#e2e8f0]">
                    <th className="text-left py-2 px-3 font-medium w-10">#</th>
                    <SortHead k="n" label="Agente" left />
                    <SortHead k="t" label="Equipe" left />
                    <SortHead k="c" label="Campanha" left />
                    <SortHead k="d" label="Acionamentos" />
                    <SortHead k="tx" label="%CPC" />
                    <SortHead k="ca" label="CPC-A" />
                    <SortHead k="as" label="Assinados Discadora" />
                    <SortHead k="cv" label="Conversão" />
                    <SortHead k="qr" label="%Queda" />
                    <SortHead k="tm" label="TMA" />
                  </tr>
                </thead>
                <tbody>
                  {agentGroups.length === 0 ? (
                    <tr><td colSpan={11} className="text-center py-8 text-[#64748b]">Nenhum agente no recorte.</td></tr>
                  ) : (
                    agentGroups.map((g, i) => (
                      <tr key={g.k} className="border-b border-[#f1f5f9] hover:bg-[#f8fafc]">
                        <td className="py-2 px-3 text-[#94a3b8]">{i + 1}</td>
                        <td className="py-2 px-3">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-[#e8effb] text-[#3c72bf] flex items-center justify-center text-[10px] font-bold shrink-0">
                              {(g.k || "?").split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase()}
                            </div>
                            <span className="text-[#0f172a] truncate">{g.k}</span>
                          </div>
                        </td>
                        <td className="py-2 px-3 text-[#475569] truncate">{g.rows[0]?.nome_equipe ?? "–"}</td>
                        <td className="py-2 px-3 text-[#475569] truncate">{g.rows[0]?.campaign_name ?? "–"}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{fmtInt(g.t.d)}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{pct(txOf(g.t.cp, g.t.d))}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{fmtInt(g.t.ca)}</td>
                        <td className="py-2 px-3 text-right font-bold tabular-nums">{fmtInt(g.t.as)}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{pct(cvOf(g.t.as, g.t.ca))}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{pct(qrOf(g.t.qd, g.t.d))}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{g.t.cp ? mm(g.t.tma / g.t.cp) : "–"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
          {agentGroups.length > 15 && (
            <button
              type="button"
              onClick={() => setShowAllAgents(!showAllAgents)}
              className="text-xs text-[#2F6FED] font-semibold hover:underline"
            >
              {showAllAgents ? "Mostrar só os 15 primeiros" : `Ver todos (${agentGroups.length})`}
            </button>
          )}
        </>
      )}

      {subView === "campanhas" && (
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-white z-10">
                <tr className="text-[#64748b] border-b border-[#e2e8f0]">
                  <SortHead k="c" label="Campanha" left />
                  <SortHead k="d" label="Acionamentos" />
                  <SortHead k="tx" label="%CPC" />
                  <SortHead k="ca" label="CPC-A" />
                  <SortHead k="as" label="Assinados Discadora" />
                  <SortHead k="cv" label="Conversão" />
                  <SortHead k="qr" label="%Queda" />
                </tr>
              </thead>
              <tbody>
                {campaignGroups.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-8 text-[#64748b]">Nenhuma campanha no recorte.</td></tr>
                ) : (
                  [...campaignGroups].sort((a, b) => b.t.d - a.t.d).map((g) => (
                    <tr key={g.k} className="border-b border-[#f1f5f9] hover:bg-[#f8fafc]">
                      <td className="py-2 px-3 font-semibold text-[#0f172a]">{g.k}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{fmtInt(g.t.d)}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{pct(txOf(g.t.cp, g.t.d))}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{fmtInt(g.t.ca)}</td>
                      <td className="py-2 px-3 text-right font-bold tabular-nums">{fmtInt(g.t.as)}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{pct(cvOf(g.t.as, g.t.ca))}</td>
                      <td className="py-2 px-3 text-right tabular-nums">{pct(qrOf(g.t.qd, g.t.d))}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="text-[11px] text-[#94a3b8]">
        <b>CPC</b> = contato com a pessoa certa · <b>CPC-A</b> = CPC com intenção de prosseguir ·{" "}
        <b>Conversão</b> = assinados ÷ CPC-A · <b>TMA</b> = tempo médio de atendimento por CPC.
      </p>
    </div>
  );
}