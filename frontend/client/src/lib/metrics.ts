// src/lib/metrics.ts
import { Period } from '@/contexts/period';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3007/api';

// ============================================================
// MÉTRICAS DE DESEMPENHO (EMITIDOS, ASSINADOS, ETC.)
// ============================================================

export async function fetchEmitidos(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/emitidos`);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar emitidos');
  return data.data;
}

export async function fetchAssinados(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/assinados`);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar assinados');
  return data.data;
}

export async function fetchProtocolados(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/protocolados`);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar protocolados');
  return data.data;
}

export async function fetchGanhos(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/ganhos`);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar ganhos');
  return data.data;
}

export async function fetchPerdidos(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string }
): Promise<{ colaborador: string; equipe: string; total: number }[]> {
  const url = new URL(`${API_BASE}/metrics/perdidos`);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar perdidos');
  return data.data;
}

export async function fetchLeadsRecebidos(
  params: { periodo?: Period; start?: string; end?: string; colaborador?: string; equipe?: string; produto?: string }
): Promise<{ data: string; total: number; colaborador: string }[]> {
  const url = new URL(`${API_BASE}/metrics/leads-recebidos`);
  if (params.periodo) url.searchParams.append('periodo', params.periodo);
  if (params.start) url.searchParams.append('start', params.start);
  if (params.end) url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar leads');
  return data.data;
}

export async function fetchWeeklyPerformance(
  params: { start: string; end: string }
): Promise<{ semana: string; vendas: number; meta: number }[]> {
  const url = new URL(`${API_BASE}/metrics/weekly-performance`);
  url.searchParams.append('start', params.start);
  url.searchParams.append('end', params.end);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar desempenho semanal');
  return data.data;
}

// ============================================================
// RECALCULAR PESOS HIERÁRQUICOS (usado em Configuration)
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