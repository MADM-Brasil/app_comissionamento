// src/lib/metrics.ts
import { Period } from '@/contexts/period';
import { API_BASE } from '@/lib/api';

// ============================================================
// MÉTRICAS DE DESEMPENHO (EMITIDOS, ASSINADOS, ETC.)
// ============================================================

export async function fetchEmitidos(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string; granularity?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/emitidos`, window.location.origin);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  if (params.granularity) url.searchParams.append('granularity', params.granularity);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar emitidos');
  return data.data;
}

export async function fetchAssinados(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string; granularity?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/assinados`, window.location.origin);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  if (params.granularity) url.searchParams.append('granularity', params.granularity);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar assinados');
  return data.data;
}

export async function fetchProtocolados(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string; granularity?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/protocolados`, window.location.origin);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  if (params.granularity) url.searchParams.append('granularity', params.granularity);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar protocolados');
  return data.data;
}

export async function fetchGanhos(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string; granularity?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/ganhos`, window.location.origin);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  if (params.granularity) url.searchParams.append('granularity', params.granularity);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar ganhos');
  return data.data;
}

export async function fetchPerdidos(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string; granularity?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/perdidos`, window.location.origin);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  if (params.granularity) url.searchParams.append('granularity', params.granularity);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar perdidos');
  return data.data;
}

export async function fetchLeadsRecebidos(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string; granularity?: string }
): Promise<{ data: string; total: number; colaborador: string }[]> {
  const url = new URL(`${API_BASE}/metrics/leads-recebidos`, window.location.origin);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  if (params.granularity) url.searchParams.append('granularity', params.granularity);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar leads');
  return data.data;
}

export async function fetchWeeklyPerformance(
  params: { start: string; end: string }
): Promise<{ semana: string; vendas: number; meta: number }[]> {
  const url = new URL(`${API_BASE}/metrics/weekly-performance`, window.location.origin);
  url.searchParams.append('start', params.start);
  url.searchParams.append('end', params.end);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar desempenho semanal');
  return data.data;
}

// ============================================================
// DADOS DIÁRIOS
// ============================================================

export interface DailyMetric {
  date: string;
  emitidos: number;
  assinados: number;
  ganhos: number;
  perdidos: number;
  protocolados: number;
}

export interface DailyGols extends DailyMetric {
  gols: number;
}

export async function fetchDailyMetrics(
  params: { start: string; end: string; colaborador?: string; equipe?: string; produto?: string }
): Promise<DailyMetric[]> {
  const baseParams = {
    start: params.start,
    end: params.end,
    colaborador: params.colaborador,
    equipe: params.equipe,
    produto: params.produto && params.produto !== 'Todos' ? params.produto : undefined,
    granularity: 'daily' as const,
  };

  const [emitidos, assinados, ganhos, perdidos, protocolados] = await Promise.all([
    fetchEmitidos(baseParams),
    fetchAssinados(baseParams),
    fetchGanhos(baseParams),
    fetchPerdidos(baseParams),
    fetchProtocolados(baseParams),
  ]);

  const dailyMap = new Map<string, DailyMetric>();

  const addToMap = (items: any[], metricKey: keyof Omit<DailyMetric, 'date'>) => {
    for (const item of items) {
      const date = item.periodo || item.data;
      if (!date) continue;

      if (!dailyMap.has(date)) {
        dailyMap.set(date, {
          date,
          emitidos: 0,
          assinados: 0,
          ganhos: 0,
          perdidos: 0,
          protocolados: 0,
        });
      }
      const entry = dailyMap.get(date)!;
      entry[metricKey] = (entry[metricKey] || 0) + (Number(item.total) || 0);
    }
  };

  addToMap(emitidos, 'emitidos');
  addToMap(assinados, 'assinados');
  addToMap(ganhos, 'ganhos');
  addToMap(perdidos, 'perdidos');
  addToMap(protocolados, 'protocolados');

  return Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ============================================================
// RECALCULAR PESOS HIERÁRQUICOS
// ============================================================
export async function recalculateHierarchyWeights(): Promise<{ message: string }> {
  const token = localStorage.getItem('csrfToken');
  const headers: HeadersInit = { 'Content-Type': 'application/json' };
  if (token) headers['x-csrf-token'] = token;

  const res = await fetch(`${API_BASE}/commission/recalculate-hierarchy`, {
    method: 'POST',
    headers,
    credentials: 'include',
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('Erro ao recalcular hierarquia:', data);
    throw new Error(data.error || 'Erro ao recalcular pesos hierárquicos');
  }
  return data;
}

// ============================================================
// REGRA DE GOLS POR ASSINADOS
//
//   3  assinados = 1 gol
//   5  assinados = 2 gols
//   7  assinados = 3 gols
//   9  assinados = 4 gols
//   11 assinados = 5 gols
//
// Fórmula: Math.floor((assinados - 1) / 2)
// ============================================================

export const TABELA_GOLS_ASSINADOS: ReadonlyArray<{ assinados: number; gols: number }> = [
  { assinados: 3,  gols: 1 },
  { assinados: 5,  gols: 2 },
  { assinados: 7,  gols: 3 },
  { assinados: 9,  gols: 4 },
  { assinados: 11, gols: 5 },
];

export const MAX_GOLS_TABELA = 5;

export function calcularGolsPorAssinados(assinados: number): number {
  const n = Number(assinados);
  if (!Number.isFinite(n) || n < 3) return 0;
  return Math.floor((n - 1) / 2);
}

export function calcularGolsDaTabela(assinados: number): number {
  const n = Number(assinados);
  if (!Number.isFinite(n)) return 0;
  const linha = TABELA_GOLS_ASSINADOS.find(l => l.assinados === n);
  return linha?.gols ?? 0;
}

export function calcularGolsPorAssinadosComCap(assinados: number): number {
  return Math.min(calcularGolsPorAssinados(assinados), MAX_GOLS_TABELA);
}

export function calcularGolsDiarios(dailyMetrics: DailyMetric[]): DailyGols[] {
  return dailyMetrics.map(day => ({
    ...day,
    gols: calcularGolsPorAssinados(day.assinados),
  }));
}

export function calcularTotalGols(dailyMetrics: DailyMetric[]): number {
  return dailyMetrics.reduce((sum, day) => sum + calcularGolsPorAssinados(day.assinados), 0);
}

// ============================================================
// CAMPANHAS APLICADAS SOBRE A REGRA DE GOLS
//
// Compatível com o backend /api/campanhas/aplicar:
//   1. Base: regra fixa 3→1, 5→2, 7→3, 9→4, 11→5 ...
//   2. GOLS: multiplica os gols do dia pelo maior multiplicador.
//   3. ASSINADOS: adiciona floor(assinados / quantidadePorGol).
//   4. PROGRESSIVA:
//        - Se atingiu a meta: substitui tudo por `assinados`.
//        - Se NÃO atingiu: mantém os gols já acumulados (base + outras campanhas).
// ============================================================

/** Tipo estrutural para não criar dependência circular com o dataStore. */
export interface CampaignLike {
  tipo?: string;
  multiplicador?: number | string;
  data_publicacao?: string;
  validacao_financeiro?: boolean;
  produto?: string;
  descricao?: string;
  [key: string]: any;
}

/**
 * Retorna as campanhas válidas (validadas financeiramente) que se aplicam
 * a um determinado dia (data_publicacao == dateKey).
 */
function getCampanhasDoDia(campaigns: CampaignLike[], dateKey: string): CampaignLike[] {
  return (campaigns || []).filter(c => {
    if (!c || !c.validacao_financeiro) return false;
    const d = String(c.data_publicacao || '').split('T')[0];
    return d === dateKey;
  });
}

/**
 * Calcula os gols de um único dia aplicando campanhas ativas sobre a
 * regra base de assinados.
 *
 * Regra de precedência (na ordem):
 *   1. Base: regra fixa 3→1, 5→2, 7→3, 9→4, 11→5 (contínua: floor((n-1)/2))
 *   2. GOLS: multiplica os gols do dia pelo maior multiplicador
 *   3. ASSINADOS: +floor(assinados / quantidadePorGol) por campanha
 *   4. PROGRESSIVA:
 *        - Se `assinados >= meta`: substitui TUDO por `assinados` (gols = assinados).
 *        - Se `assinados < meta`: MANTÉM os gols já acumulados (base + campanhas anteriores).
 *          Ou seja, o colaborador não fica "zerado" — ele leva o que a regra base
 *          (e outras campanhas) já davam naquele dia.
 *
 * Exemplo (meta progressiva = 4, base 3→1):
 *   3 assinados → 1 gol (base)
 *   4 assinados → 4 gols (progressiva atingida)
 *   5 assinados → 5 gols
 */
export function calcularGolsComCampanhas(
  assinados: number,
  dateKey: string,
  campaigns: CampaignLike[],
): number {
  const n = Number(assinados) || 0;

  // 1) Base: regra fixa por assinados
  let gols = calcularGolsPorAssinados(n);

  const dayCamps = getCampanhasDoDia(campaigns, dateKey);
  if (dayCamps.length === 0) return gols;

  // 2) GOLS: multiplicador (maior valor vence — igual ao backend)
  const multiplicadores = dayCamps
    .filter(c => (c.tipo || '').toUpperCase() === 'GOLS')
    .map(c => Number(c.multiplicador) || 1)
    .filter(m => m > 1);
  if (multiplicadores.length > 0) {
    gols = gols * Math.max(...multiplicadores);
  }

  // 3) ASSINADOS: + floor(assinados / quantidadePorGol)
  const campanhasAssinados = dayCamps.filter(c => (c.tipo || '').toUpperCase() === 'ASSINADOS');
  for (const camp of campanhasAssinados) {
    const quantidadePorGol = Number(camp.multiplicador) || 3;
    if (quantidadePorGol > 0) {
      gols += Math.floor(n / quantidadePorGol);
    }
  }

  // 4) PROGRESSIVA:
  //    - Atingiu a meta → gols = assinados (substitui tudo)
  //    - NÃO atingiu  → mantém os gols já acumulados (base + GOLS + ASSINADOS)
  const campanhasProgressivas = dayCamps.filter(c => (c.tipo || '').toUpperCase() === 'PROGRESSIVA');
  if (campanhasProgressivas.length > 0) {
    const metas = campanhasProgressivas
      .map(c => Number(c.multiplicador) || 0)
      .filter(m => m > 0);
    if (metas.length > 0) {
      const metaProgressiva = Math.min(...metas);
      if (n >= metaProgressiva) {
        gols = n; // ← campanha progressiva atingida: substitui
      }
      // else: mantém `gols` como está (base + outras campanhas)
    }
  }

  return gols;
}

/** Série diária com gols considerando campanhas. */
export function calcularGolsDiariosComCampanhas(
  dailyMetrics: DailyMetric[],
  campaigns: CampaignLike[],
): DailyGols[] {
  return dailyMetrics.map(day => ({
    ...day,
    gols: calcularGolsComCampanhas(
      Number(day.assinados) || 0,
      String(day.date || '').slice(0, 10),
      campaigns,
    ),
  }));
}

/** Total de gols do período considerando campanhas. */
export function calcularTotalGolsComCampanhas(
  dailyMetrics: DailyMetric[],
  campaigns: CampaignLike[],
): number {
  return dailyMetrics.reduce(
    (sum, day) =>
      sum +
      calcularGolsComCampanhas(
        Number(day.assinados) || 0,
        String(day.date || '').slice(0, 10),
        campaigns,
      ),
    0
  );
}