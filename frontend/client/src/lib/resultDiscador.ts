// src/lib/resultDiscador.ts

import { API_BASE } from './api';

/**
 * Linha do resultado "discador × assinaturas".
 * Equivale ao SELECT final da consulta SQL de referência
 * (ver bloco de comentário ao final deste arquivo).
 */
export interface DiscadorRow {
  agent_name: string;
  campaign_name: string;
  /** Colaborador do cadastro vinculado ao agente (null = agente do discador sem cadastro). */
  colaborador_id?: number | string | null;
  /** Unidade do colaborador vinculado — usada no filtro por unidade. */
  unidade_id?: number | null;
  /** Equipes válidas do colaborador; mais de uma vem como "Equipe A / Equipe B". */
  nome_equipe: string | null;
  total_discagens: number;
  cpc_sem_negocio: number;
  cpc_a: number;
  mudo: number;
  queda_ligacao: number;
  cpc_total: number;
  tma_total: number;
  assinados: number;
  conversao_ass_cpc_a: number;
  periodo_inicio?: string;
  periodo_fim?: string;
}

export interface ResultDiscadorParams {
  start: string;                 // YYYY-MM-DD
  end: string;                   // YYYY-MM-DD
}

/**
 * Busca o resultado discador × assinaturas do período.
 * Endpoint esperado: GET /discador/resultado?start=...&end=...
 */
export async function fetchResultadoDiscador(
  params: ResultDiscadorParams,
): Promise<DiscadorRow[]> {
  // O backend devolve o período inteiro (cache por período) e ignora
  // equipe/colaborador/unidade. Esses filtros são aplicados na tela,
  // em src/lib/discadorFilters.ts.
  const search = new URLSearchParams();
  search.set('start', params.start);
  search.set('end', params.end);

  const res = await fetch(`${API_BASE}/discador/resultado?${search.toString()}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Erro ${res.status} ao carregar resultado do discador.`);
  }
  return (await res.json()) as DiscadorRow[];
}

// ============================================================
// AGREGAÇÕES
// ============================================================
export interface DiscadorTotals {
  d: number;   // acionamentos
  sn: number;  // CPC sem negócio
  ca: number;  // CPC-A
  mu: number;  // mudo
  qd: number;  // queda de ligação
  tma: number; // TMA total (segundos)
  as: number;  // assinados
  cp: number;  // CPC total = sn + ca
}

export const emptyTotals = (): DiscadorTotals => ({
  d: 0, sn: 0, ca: 0, mu: 0, qd: 0, tma: 0, as: 0, cp: 0,
});

export function sumRows(rows: DiscadorRow[]): DiscadorTotals {
  const t = emptyTotals();
  for (const r of rows) {
    t.d += r.total_discagens || 0;
    t.sn += r.cpc_sem_negocio || 0;
    t.ca += r.cpc_a || 0;
    t.mu += r.mudo || 0;
    t.qd += r.queda_ligacao || 0;
    t.tma += r.tma_total || 0;
    t.as += r.assinados || 0;
    t.cp += r.cpc_total || 0;
  }
  return t;
}

export interface GroupResult {
  k: string;
  rows: DiscadorRow[];
  t: DiscadorTotals;
  cnt: number;
}

export function groupBy(
  rows: DiscadorRow[],
  key: 'agent_name' | 'campaign_name' | 'nome_equipe',
): GroupResult[] {
  const map = new Map<string, DiscadorRow[]>();
  for (const r of rows) {
    const k = (r[key] ?? '').toString().trim() || 'Sem valor';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return Array.from(map.entries()).map(([k, v]) => ({
    k,
    rows: v,
    t: sumRows(v),
    cnt: v.length,
  }));
}

// ============================================================
// MÉTRICAS CONFIGURÁVEIS (para os gráficos de barra)
// ============================================================
export type MetricKey = 'as' | 'cv' | 'ca' | 'd' | 'qr';

export interface MetricDef {
  label: string;
  get: (t: DiscadorTotals) => number;
  format: (v: number) => string;
}

const pctFmt = (v: number) => `${(v * 100).toFixed(1).replace('.', ',')}%`;
const intFmt = (v: number) => Math.round(v || 0).toLocaleString('pt-BR');

export const METRICS: Record<MetricKey, MetricDef> = {
  as: { label: 'Assinados', get: (t) => t.as, format: intFmt },
  cv: { label: 'Conversão', get: (t) => (t.ca > 0 ? t.as / t.ca : 0), format: pctFmt },
  ca: { label: 'CPC-A', get: (t) => t.ca, format: intFmt },
  d: { label: 'Acionamentos', get: (t) => t.d, format: intFmt },
  qr: { label: 'Queda', get: (t) => (t.d > 0 ? t.qd / t.d : 0), format: pctFmt },
};

/* ============================================================
 * CONSULTA SQL DE REFERÊNCIA (executada no backend)
 * ------------------------------------------------------------
 * A query abaixo roda no endpoint /discador/resultado.
 * Mantida aqui apenas como documentação — ver "Pasted text.txt".
 *
 * Destaques:
 *  - Período: 1º dia do mês corrente → hoje (fuso America/Sao_Paulo).
 *  - CTE equipes_excluidas: filtra equipes fora do escopo.
 *  - CTE classificacao: mapeia qualification_name para
 *      cpc_sem_negocio / cpc_a / mudo / queda_ligacao.
 *  - CTE assinaturas_*: cruza discador × assinaturas por telefone.
 *  - FULL OUTER JOIN garante que agentes só com assinatura também
 *    apareçam (assinados sem discagem).
 *  - Filtro final remove colaboradores cujas equipes são todas
 *    excluídas.
 * ============================================================ */