// src/pages/Tabulacoes.tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore } from "@/lib/dataStore";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  Loader2, RefreshCw, AlertTriangle, Download,
  ChevronDown, Search, User, Users,
} from "lucide-react";
import {
  fetchNaoTabuladas,
  type NaoTabuladaRow,
} from "@/lib/tabulacoes";

// ============================================================
//  CONSTANTES ANALÍTICAS (mesmas do HTML original)
// ============================================================
const MEAN_CRIT = 2;
const MEAN_ATT = 1.1;

const pct = (x: number) => `${(x * 100).toFixed(1).replace(".", ",")}%`;
const dec = (x: number) => x.toFixed(1).replace(".", ",");
const fmtInt = (n: number) => (n || 0).toLocaleString("pt-BR");

type Status = "CRÍTICO" | "ATENÇÃO" | "OK";
type Diag = "Operador exclusivo" | "Equipe" | "Misto";
type View = "gerencial" | "operacional";

interface EnrichedSup {
  n: string;
  q: number;
  a: number;
  ag: NaoTabuladaRow[];
  avg: number;
  of: number;
  oc: number;
  t1: number;
  diag: Diag;
  ratio: number;
  share: number;
  cum: number;
  cls: "A" | "B" | "C";
  st: Status;
}

interface Calculated {
  rows: NaoTabuladaRow[];
  total: number;
  mean: number;
  sups: EnrichedSup[];
}

// ============================================================
//  CÁLCULO (idêntico à função `calc` do HTML)
// ============================================================
function calcular(rowsIn: NaoTabuladaRow[]): Calculated {
  const rows = rowsIn
    .filter((r) => r.total_nao_tabuladas > 0)
    .sort((a, b) => b.total_nao_tabuladas - a.total_nao_tabuladas);

  const total = rows.reduce((t, r) => t + r.total_nao_tabuladas, 0);
  const mean = total / (rows.length || 1);

  const map = new Map<string, { n: string; q: number; a: number; ag: NaoTabuladaRow[] }>();
  for (const r of rows) {
    if (!map.has(r.supervisor)) {
      map.set(r.supervisor, { n: r.supervisor, q: 0, a: 0, ag: [] });
    }
    const s = map.get(r.supervisor)!;
    s.q += r.total_nao_tabuladas;
    s.a += 1;
    s.ag.push(r);
  }

  const supsBase = Array.from(map.values()).sort((a, b) => b.q - a.q);
  let cum = 0;
  const sups: EnrichedSup[] = supsBase.map((s) => {
    const avg = s.q / s.a;
    const of = s.ag.filter((x) => x.total_nao_tabuladas >= mean).length;
    const oc = s.ag.filter((x) => x.total_nao_tabuladas >= mean * MEAN_CRIT).length;
    const t1 = s.ag[0].total_nao_tabuladas / s.q;
    const diag: Diag =
      t1 >= 0.5 ? "Operador exclusivo" : of / s.a >= 0.5 ? "Equipe" : "Misto";
    const ratio = avg / mean;
    const share = s.q / total;
    const before = cum;
    cum += share;
    const cls: "A" | "B" | "C" = before < 0.8 ? "A" : before < 0.95 ? "B" : "C";
    const st: Status =
      ratio >= MEAN_CRIT ? "CRÍTICO" : ratio >= MEAN_ATT ? "ATENÇÃO" : "OK";
    return { ...s, avg, of, oc, t1, diag, ratio, share, cum, cls, st };
  });

  return { rows, total, mean, sups };
}

// ============================================================
//  COMPONENTES DE APOIO
// ============================================================
function KpiCard({
  label, value, sub, accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: "danger" | "warning" | "brand";
}) {
  const colorClass =
    accent === "danger" ? "text-red-600"
      : accent === "warning" ? "text-amber-600"
      : "text-[#0f172a]";
  return (
    <Card className="p-4">
      <div className="text-[11px] text-[#64748b] font-medium">{label}</div>
      <div className={cn("text-2xl font-black mt-1 tabular-nums", colorClass)}>{value}</div>
      {sub && <div className="text-[10px] text-[#94a3b8] mt-1 leading-snug">{sub}</div>}
    </Card>
  );
}

const statusBarColor: Record<string, string> = {
  CRÍTICO: "#DC2626",
  "Crítico": "#DC2626",
  ATENÇÃO: "#D97706",
  "Atenção": "#D97706",
  OK: "#16A34A",
  "Normal": "#16A34A",
};

function Bar({
  label, value, max, status, right, reference,
}: {
  label: string;
  value: number;
  max: number;
  status: string;
  right: string;
  reference?: number;
}) {
  const width = Math.max(2, (value / max) * 100);
  const bg = statusBarColor[status] || "#94a3b8";
  return (
    <div className="grid grid-cols-[minmax(110px,180px)_1fr_auto] gap-3 items-center py-1">
      <div className="text-xs font-medium text-[#0f172a] truncate" title={label}>
        {label}
      </div>
      <div className="relative h-2.5 bg-[#eef0f4] rounded-full">
        <div className="h-full rounded-full" style={{ width: `${width}%`, background: bg }} />
        {reference != null && (
          <div
            className="absolute -top-1 -bottom-1 w-0.5 bg-[#0f172a]/70"
            style={{ left: `${Math.min(100, Math.max(0, (reference / max) * 100))}%` }}
          />
        )}
      </div>
      <div className="text-xs text-[#64748b] tabular-nums text-right min-w-[92px]">{right}</div>
    </div>
  );
}

function StatusTag({ status }: { status: string }) {
  const cls =
    status === "CRÍTICO" || status === "Crítico"
      ? "bg-red-600"
      : status === "ATENÇÃO" || status === "Atenção"
      ? "bg-amber-600"
      : "bg-emerald-600";
  return (
    <span className={cn("inline-block text-white text-[10.5px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide", cls)}>
      {status}
    </span>
  );
}

// ============================================================
//  PÁGINA PRINCIPAL
// ============================================================
export default function Tabulacoes() {
  const { currentStartDate, currentEndDate, collaborators } = useAppStore();

  const [filters, setFilters] = useState<{ equipe: string; colaborador: string; unidadeId?: number }>({ equipe: "todas", colaborador: "todos" });

  const [view, setView] = useState<View>("gerencial");
  const [rows, setRows] = useState<NaoTabuladaRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Operacional
  const [supFilter, setSupFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [onlyHigh, setOnlyHigh] = useState<boolean>(false);
  const [copied, setCopied] = useState(false);

  // ── Carregamento (sempre que o período, equipe ou colaborador muda)
  const reload = useCallback(async () => {
    if (!currentStartDate || !currentEndDate) return;
    setLoading(true);
    setError(null);
    try {
      const inclusiveEnd = new Date(`${currentEndDate}T00:00:00.000Z`);
      inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);
      const data = await fetchNaoTabuladas({
        start: currentStartDate,
        end: inclusiveEnd.toISOString().slice(0, 10),
        equipe: filters.equipe !== "todas" ? filters.equipe : undefined,
        colaborador: filters.colaborador !== "todos" ? filters.colaborador : undefined,
      });
      if (filters.unidadeId == null) {
        setRows(data);
      } else {
        const allowedNames = new Set(
          collaborators
            .filter((collaborator) => Number(collaborator.unidadeId) === filters.unidadeId)
            .map((collaborator) => collaborator.name.trim().toLocaleLowerCase()),
        );
        setRows(data.filter((row) => allowedNames.has(row.agente.trim().toLocaleLowerCase())));
      }
    } catch (err: unknown) {
      console.error("Erro ao carregar tabulações:", err);
      setError(err instanceof Error ? err.message : "Falha ao carregar dados.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate, filters.equipe, filters.colaborador, filters.unidadeId, collaborators]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleFilterChange = useCallback(
    (raw: { equipe: string; colaborador: string; produto: string; unidadeId?: number }) => {
      setFilters((prev) => {
        if (prev.equipe === raw.equipe && prev.colaborador === raw.colaborador && prev.unidadeId === raw.unidadeId) return prev;
        return { equipe: raw.equipe, colaborador: raw.colaborador, unidadeId: raw.unidadeId };
      });
    },
    [],
  );

  const handleRefresh = useCallback(async () => {
    await reload();
  }, [reload]);

  // ── Derivados
  const D = useMemo(() => calcular(rows), [rows]);

  const hasActiveFilters = filters.equipe !== "todas" || filters.colaborador !== "todos" || filters.unidadeId != null;

  // ── Insights (paridade total com o HTML)
  const insights = useMemo(() => {
    if (D.rows.length === 0) return [];
    const top3 = D.sups.slice(0, 3).reduce((t, s) => t + s.q, 0);
    const crit = D.sups.filter((s) => s.st === "CRÍTICO");
    const clsA = D.sups.filter((s) => s.cls === "A").length;
    const t5 = D.rows.slice(0, 5).reduce((t, r) => t + r.total_nao_tabuladas, 0);
    const ag = D.rows[0];
    return [
      `<b>${ag.supervisor}</b> concentra ${D.sups[0].q} ocorrências (${pct(D.sups[0].share)} do total).`.replace(
        /<b>(.*?)<\/b>/,
        "[[B]]$1[[/B]]",
      ),
      `Os 3 maiores supervisores somam ${pct(top3 / D.total)}; ${clsA} supervisor(es) formam a Classe A (até 80% do volume).`,
      crit.length
        ? `Supervisor(es) em status crítico (média por agente ≥ ${MEAN_CRIT}x a média geral): [[B]]${crit
            .map((s) => `${s.n} (${dec(s.avg)}/agente)`)
            .join(", ")}[[/B]].`
        : "Nenhum supervisor em status crítico.",
      `Maior ofensor individual: [[B]]${ag.agente}[[/B]] (${ag.supervisor}) com ${ag.total_nao_tabuladas}; os 5 maiores agentes somam ${pct(t5 / D.total)}.`,
      `[[ACT]]Ação sugerida:[[/ACT]] feedback diário com ${
        crit.length ? crit[0].n : D.sups[0].n
      } e com os ${Math.min(5, D.rows.length)} maiores ofensores. Ver fila completa na visão Operacional.`,
    ];
  }, [D]);

  // ── Operacional (filtros)
  const operacionalRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return D.rows.filter((r) => {
      if (supFilter && r.supervisor !== supFilter) return false;
      if (q && !`${r.agente} ${r.supervisor}`.toLowerCase().includes(q)) return false;
      if (onlyHigh && r.total_nao_tabuladas < D.mean) return false;
      return true;
    });
  }, [D, supFilter, search, onlyHigh]);

  const operacionalTotal = operacionalRows.reduce((s, r) => s + r.total_nao_tabuladas, 0);

  // ── CSV
  const handleExport = () => {
    if (operacionalRows.length === 0) return;
    const header = ["Agente", "Supervisor", "Qtde", "% do total", "Prioridade"];
    const csv = "\uFEFF" + [header, ...operacionalRows.map((r) => {
      const pri = r.total_nao_tabuladas >= D.mean * MEAN_CRIT ? "Crítico"
        : r.total_nao_tabuladas >= D.mean ? "Atenção" : "Normal";
      return [r.agente, r.supervisor, r.total_nao_tabuladas, pct(r.total_nao_tabuladas / D.total), pri];
    })]
      .map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";"))
      .join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nao_tabuladas_${currentStartDate ?? "inicio"}_${currentEndDate ?? "fim"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    if (operacionalRows.length === 0) return;
    const txt = "agente\tsupervisor\tqtde\n" +
      operacionalRows.map((r) => `${r.agente}\t${r.supervisor}\t${r.total_nao_tabuladas}`).join("\n");
    try {
      await navigator.clipboard.writeText(txt);
      setError(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Erro ao copiar tabulações:", err);
      setError("Não foi possível copiar os dados para a área de transferência.");
    }
  };

  // ── Estados de tela
  const hasData = D.rows.length > 0;
  const isEmpty = !loading && !hasData;

  // ═══════════════════════════════════════════════════════════
  return (
    <DashboardLayout
      title="Não Tabuladas · Tempo Excedido"
      subtitle="Painel analítico de ocorrências de tabulação por tempo excedido, por agente e supervisor."
    >
      <FilterBar
        onFilterChange={handleFilterChange}
        showColaboradorFilter
        showProdutoFilter={false}
        className="mb-6"
      />

      {hasActiveFilters && (
        <div className="mb-4 px-4 py-2 bg-[#eff6ff] rounded-lg text-xs text-[#2F6FED] flex items-center gap-2 flex-wrap">
          <span>📊</span>
          <span>
            Mostrando dados de:
            {filters.equipe !== "todas" && ` ${filters.equipe}`}
            {filters.colaborador !== "todos" && ` · ${filters.colaborador}`}
          </span>
        </div>
      )}

      {loading && (
        <div className="mb-4 flex items-center gap-2 text-xs text-[#64748b]">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando tabulações…
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
          Nenhuma ocorrência de tabulação por tempo excedido no período selecionado.
        </div>
      )}

      {hasData && (
        <>
          {/* Tabs Gerencial / Operacional */}
          <div className="mb-4 flex items-center gap-2">
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
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-[#e2e8f0] rounded-lg text-xs font-semibold text-[#475569] bg-white hover:bg-[#f1f5f9] disabled:opacity-50"
            >
              {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Atualizar
            </button>
          </div>

          {view === "gerencial" ? (
            <GerencialView D={D} insights={insights} />
          ) : (
            <OperacionalView
              D={D}
              supFilter={supFilter}
              setSupFilter={setSupFilter}
              search={search}
              setSearch={setSearch}
              onlyHigh={onlyHigh}
              setOnlyHigh={setOnlyHigh}
              filtered={operacionalRows}
              filteredTotal={operacionalTotal}
              onExport={handleExport}
              onCopy={handleCopy}
              copied={copied}
            />
          )}
        </>
      )}
    </DashboardLayout>
  );
}

// ============================================================
//  VIEW GERENCIAL
// ============================================================
function GerencialView({ D, insights }: { D: Calculated; insights: string[] }) {
  const top3 = D.sups.slice(0, 3).reduce((t, s) => t + s.q, 0);
  const crit = D.sups.filter((s) => s.st === "CRÍTICO");
  const hiAg = D.rows.filter((r) => r.total_nao_tabuladas >= D.mean * MEAN_CRIT).length;
  const ag = D.rows[0];
  const mxSup = D.sups[0]?.q || 1;
  const mxAvg = Math.max(...D.sups.map((s) => s.avg), D.mean);
  const mxAg = D.rows[0]?.total_nao_tabuladas || 1;

  // Helper para renderizar marcação [[B]]...[[/B]] e [[ACT]]...[[/ACT]]
  const renderInsight = (raw: string) => {
    const parts = raw.split(/(\[\[B\]\]|\[\[\/B\]\]|\[\[ACT\]\]|\[\[\/ACT\]\])/g);
    let bold = false, act = false;
    return parts.map((p, i) => {
      if (p === "[[B]]") { bold = true; return null; }
      if (p === "[[/B]]") { bold = false; return null; }
      if (p === "[[ACT]]") { act = true; return null; }
      if (p === "[[/ACT]]") { act = false; return null; }
      if (!p) return null;
      return (
        <span key={i} className={cn(bold && "font-semibold", act && "text-[#2F6FED]")}>
          {p}
        </span>
      );
    });
  };

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard label="Total não tabuladas" value={fmtInt(D.total)} sub="D-1" />
        <KpiCard label="Agentes com ocorrência" value={fmtInt(D.rows.length)} sub={`${hiAg} acima de ${MEAN_CRIT}x a média`} />
        <KpiCard
          label="Supervisores"
          value={fmtInt(D.sups.length)}
          sub={`${crit.length} crítico(s) · ${D.sups.filter((s) => s.st === "ATENÇÃO").length} atenção`}
          accent={crit.length ? "danger" : undefined}
        />
        <KpiCard label="Média por agente" value={dec(D.mean)} sub="referência de status" />
        <KpiCard label="Top 3 supervisores" value={pct(top3 / D.total)} sub="do volume total" />
        <KpiCard
          label="Maior ofensor"
          value={fmtInt(ag?.total_nao_tabuladas ?? 0)}
          sub={ag?.agente.split(" ").slice(0, 2).join(" ") ?? "Sem dados"}
          accent="danger"
        />
      </div>

      {/* Insights */}
      <Card className="p-5">
        <h3 className="text-sm font-bold text-[#0f172a] mb-3">Insights do dia</h3>
        <ul className="space-y-2">
          {insights.map((raw, i) => (
            <li
              key={i}
              className={cn(
                "flex gap-2 text-[13px] text-[#334155] rounded-lg p-3",
                i === insights.length - 1
                  ? "bg-[#eff6ff] border border-[#82a9e7]/40 font-medium"
                  : "bg-[#f8fafc] border border-[#e2e8f0]",
              )}
            >
              <span className="text-[#2F6FED] shrink-0">•</span>
              <span className="whitespace-pre-line">{renderInsight(raw)}</span>
            </li>
          ))}
        </ul>
      </Card>

      {/* Diagnóstico por supervisor */}
      <Card className="p-5">
        <h3 className="text-sm font-bold text-[#0f172a] mb-3">
          Equipe ou operador? Ofensores por supervisor
        </h3>
        <div className="space-y-2">
          {D.sups.map((s) => {
            const totalTeam = s.q || 1;
            return (
              <div
                key={s.n}
                className="grid grid-cols-1 md:grid-cols-[minmax(180px,240px)_1fr_180px] gap-3 items-center py-2 border-b border-[#e2e8f0] last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-[#0f172a] truncate">{s.n}</p>
                  <p className="text-[11px] text-[#64748b]">
                    {s.of} de {s.a} agentes ofensores{s.oc ? ` · ${s.oc} crítico(s)` : ""}
                  </p>
                </div>
                <div className="flex gap-0.5 h-3.5">
                  {s.ag.map((x, i) => (
                    <i
                      key={i}
                      className="rounded-sm"
                      style={{
                        flex: x.total_nao_tabuladas,
                        background: i === 0 ? "#DC2626" : "#3b82f6",
                        minWidth: 2,
                      }}
                      title={`${x.agente}: ${x.total_nao_tabuladas}`}
                    />
                  ))}
                </div>
                <div className="text-xs text-right">
                  <p className="text-[#334155]">
                    1º agente = <b>{pct(s.t1)}</b>
                  </p>
                  <StatusTag status={s.diag === "Equipe" ? "CRÍTICO" : s.diag === "Misto" ? "ATENÇÃO" : "OK"} />
                  <span className="ml-1 text-[10px] text-[#64748b]">{s.diag}</span>
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-[11px] text-[#64748b] leading-relaxed">
          Ofensor = agente com volume ≥ média geral ({dec(D.mean)}). Barra = fatia de cada
          agente no total da equipe (vermelho = maior).{" "}
          <b>Operador exclusivo</b>: o 1º agente responde por ≥ 50% da equipe. <b>Equipe</b>:
          ≥ 50% dos agentes são ofensores. <b>Misto</b>: demais casos.
        </p>
      </Card>

      {/* Pareto + Justiça */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card className="p-5">
          <h3 className="text-sm font-bold text-[#0f172a] mb-3">
            Concentração por supervisor (Pareto)
          </h3>
          {D.sups.map((s) => (
            <Bar
              key={s.n}
              label={s.n}
              value={s.q}
              max={mxSup}
              status={s.st}
              right={`${s.q} · ${pct(s.share)} · ${s.cls}`}
            />
          ))}
          <p className="mt-3 text-[11px] text-[#64748b]">
            Cor = status pela média por agente. Letra = classe ABC (A até 80% acumulado).
          </p>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-bold text-[#0f172a] mb-3">
            Justiça entre equipes: média por agente
          </h3>
          {[...D.sups]
            .sort((a, b) => b.avg - a.avg)
            .map((s) => (
              <Bar
                key={s.n}
                label={s.n}
                value={s.avg}
                max={mxAvg * 1.05}
                status={s.st}
                right={`${dec(s.avg)} · ${dec(s.ratio)}x`}
                reference={D.mean}
              />
            ))}
          <p className="mt-3 text-[11px] text-[#64748b]">
            Linha preta = média geral ({dec(D.mean)}). Isola equipes grandes de equipes
            realmente piores.
          </p>
        </Card>
      </div>

      {/* Top 10 */}
      <Card className="p-5">
        <h3 className="text-sm font-bold text-[#0f172a] mb-3">Top 10 ofensores individuais</h3>
        {D.rows.slice(0, 10).map((r) => {
          const status: Status = r.total_nao_tabuladas >= D.mean * MEAN_CRIT
            ? "CRÍTICO"
            : r.total_nao_tabuladas >= D.mean ? "ATENÇÃO" : "OK";
          return (
            <Bar
              key={`${r.agente}::${r.supervisor}`}
              label={r.agente}
              value={r.total_nao_tabuladas}
              max={mxAg}
              status={status}
              right={`${r.total_nao_tabuladas} · ${r.supervisor.split(" ").slice(0, 2).join(" ")}`}
            />
          );
        })}
      </Card>
    </div>
  );
}

// ============================================================
//  VIEW OPERACIONAL
// ============================================================
function OperacionalView({
  D, supFilter, setSupFilter, search, setSearch, onlyHigh, setOnlyHigh,
  filtered, filteredTotal, onExport, onCopy, copied,
}: {
  D: Calculated;
  supFilter: string;
  setSupFilter: (v: string) => void;
  search: string;
  setSearch: (v: string) => void;
  onlyHigh: boolean;
  setOnlyHigh: (v: boolean) => void;
  filtered: NaoTabuladaRow[];
  filteredTotal: number;
  onExport: () => void;
  onCopy: () => void;
  copied: boolean;
}) {
  const mx = D.rows[0]?.total_nao_tabuladas || 1;

  const priOf = (r: NaoTabuladaRow) =>
    r.total_nao_tabuladas >= D.mean * MEAN_CRIT
      ? "Crítico"
      : r.total_nao_tabuladas >= D.mean ? "Atenção" : "Normal";

  return (
    <div className="space-y-4">
      {/* Chips de supervisor */}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setSupFilter("")}
          className={cn(
            "px-2.5 py-1 rounded-full border text-xs",
            !supFilter
              ? "bg-[#eff6ff] text-[#2F6FED] border-[#2F6FED] font-semibold"
              : "bg-white text-[#475569] border-[#e2e8f0] hover:bg-[#f8fafc]",
          )}
        >
          Todos
        </button>
        {D.sups.map((s) => (
          <button
            key={s.n}
            type="button"
            onClick={() => setSupFilter(s.n)}
            className={cn(
              "px-2.5 py-1 rounded-full border text-xs",
              supFilter === s.n
                ? "bg-[#eff6ff] text-[#2F6FED] border-[#2F6FED] font-semibold"
                : "bg-white text-[#475569] border-[#e2e8f0] hover:bg-[#f8fafc]",
            )}
          >
            {s.n} · {s.q} · {s.of} ofens.
          </button>
        ))}
      </div>

      {/* Filtros + ações */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#94a3b8]" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar agente ou supervisor"
            className="pl-8 pr-3 py-2 border border-[#e2e8f0] rounded-lg text-xs bg-white min-w-[260px]"
          />
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs text-[#475569]">
          <input
            type="checkbox"
            checked={onlyHigh}
            onChange={(e) => setOnlyHigh(e.target.checked)}
          />
          só acima da média ({dec(D.mean)})
        </label>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-[#e2e8f0] rounded-lg text-xs font-semibold text-[#475569] bg-white hover:bg-[#f1f5f9]"
        >
          <Users size={12} />
          {copied ? "Copiado!" : "Copiar lista"}
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={filtered.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-[#e2e8f0] rounded-lg text-xs font-semibold text-[#475569] bg-white hover:bg-[#f1f5f9] disabled:opacity-50"
        >
          <Download size={12} />
          Exportar CSV
        </button>
        <span className="text-[11px] text-[#94a3b8] ml-auto">
          {filtered.length} agente(s) · {fmtInt(filteredTotal)} ocorrências
        </span>
      </div>

      {/* Tabela */}
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-white z-10">
              <tr className="text-[#64748b] border-b border-[#e2e8f0]">
                <th className="text-left py-2 px-3 font-medium w-10">#</th>
                <th className="text-left py-2 px-3 font-medium">Agente</th>
                <th className="text-left py-2 px-3 font-medium">Supervisor</th>
                <th className="text-right py-2 px-3 font-medium">Qtde</th>
                <th className="text-right py-2 px-3 font-medium">% total</th>
                <th className="py-2 px-3 font-medium w-[22%]"></th>
                <th className="text-left py-2 px-3 font-medium">Prioridade</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-[#64748b]">
                    Nenhum agente corresponde aos filtros atuais.
                  </td>
                </tr>
              ) : (
                filtered.map((r, i) => {
                  const pri = priOf(r);
                  return (
                    <tr key={`${r.agente}::${r.supervisor}`} className="border-b border-[#f1f5f9] hover:bg-[#f8fafc]">
                      <td className="py-2 px-3 text-[#94a3b8]">{i + 1}</td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-[#e8effb] text-[#3c72bf] flex items-center justify-center text-[10px] font-bold">
                            {(r.agente || "?").split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase()}
                          </div>
                          <span className="text-[#0f172a] truncate">{r.agente}</span>
                        </div>
                      </td>
                      <td className="py-2 px-3 text-[#475569] truncate">{r.supervisor}</td>
                      <td className="py-2 px-3 text-right font-bold text-[#0f172a] tabular-nums">
                        {r.total_nao_tabuladas}
                      </td>
                      <td className="py-2 px-3 text-right text-[#475569] tabular-nums">
                        {pct(r.total_nao_tabuladas / D.total)}
                      </td>
                      <td className="py-2 px-3">
                        <div className="h-2 bg-[#eef0f4] rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${(r.total_nao_tabuladas / mx) * 100}%`,
                              background: statusBarColor[pri] || "#94a3b8",
                            }}
                          />
                        </div>
                      </td>
                      <td className="py-2 px-3">
                        <StatusTag status={pri} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <p className="text-[11px] text-[#94a3b8]">
        Crítico ≥ {MEAN_CRIT}x a média por agente ({dec(D.mean * MEAN_CRIT)}); Atenção ≥ a
        média ({dec(D.mean)}).
      </p>
    </div>
  );
}