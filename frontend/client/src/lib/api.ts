// src/lib/api.ts

// ============================================================
// BASE URL – usa VITE_API_URL em produção, /api em dev (proxy)
// ============================================================
export const API_BASE = import.meta.env.VITE_API_URL || '/api';

// ============================================================
// FUNÇÃO AUXILIAR PARA TRATAR RESPOSTAS (CORRIGIDA)
// ============================================================
async function handleResponse(response: Response, defaultErrorMessage: string) {
  // Verifica se a resposta está vazia (ex: 204 ou 403 sem corpo)
  const contentLength = response.headers.get('content-length');
  if (contentLength === '0' || response.status === 204) {
    if (response.status === 403) {
      throw new Error('Token CSRF inválido. Recarregue a página e tente novamente.');
    }
    // Resposta vazia não é erro; retornamos um objeto vazio
    return {};
  }

  // Lê o corpo como texto UMA ÚNICA VEZ
  let text;
  try {
    text = await response.text();
  } catch (err) {
    console.error('❌ Erro ao ler corpo da resposta:', err);
    throw new Error(defaultErrorMessage || 'Erro desconhecido ao processar a resposta');
  }

  // Tenta fazer parse como JSON
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    // Se não for JSON, usa o texto como mensagem de erro
    console.error('❌ Resposta não é JSON:', text?.substring(0, 200));
    throw new Error(text?.substring(0, 100) || 'Resposta inválida do servidor');
  }

  if (!response.ok) {
    throw new Error(data?.error || defaultErrorMessage || `Erro ${response.status}`);
  }

  if (data?.success === false) {
    throw new Error(data.error || defaultErrorMessage);
  }

  return data;
}

// ============================================================
// FUNÇÃO AUXILIAR CSRF
// ============================================================
function csrfHeaders(extraHeaders: Record<string, string> = {}) {
  const token = localStorage.getItem('csrfToken');
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'x-csrf-token': token } : {}),
    ...extraHeaders,
  };
}

// ============================================================
// COLABORADORES E EQUIPES
// ============================================================
export async function fetchCollaborators(queryString = "") {
  const url = `${API_BASE}/collaborators${queryString}`;
  const response = await fetch(url, { credentials: 'include' });
  const data = await handleResponse(response, 'Erro ao carregar colaboradores');
  return data.data || [];
}

export async function fetchEquipes() {
  const response = await fetch(`${API_BASE}/equipes`, { credentials: 'include' });
  const data = await handleResponse(response, 'Erro ao carregar equipes');
  return data.data || [];
}

// ============================================================
// MÉTRICAS GLOBAIS
// ============================================================
export async function fetchGlobalMetrics(): Promise<{
  peso_diario_assinados: number;
  peso_diario_ganhos: number;
  peso_semanal_assinados: number;
  peso_semanal_ganhos: number;
  peso_mensal_assinados: number;
  peso_mensal_ganhos: number;
  bonus: number;
}> {
  const res = await fetch(`${API_BASE}/admin/global-metrics`, { credentials: 'include' });
  const data = await handleResponse(res, 'Erro ao carregar métricas globais');
  return data.data;
}

export async function fetchEquipeMetrics(nomeEquipe: string) {
  const res = await fetch(`${API_BASE}/admin/equipe-metrics?nome=${encodeURIComponent(nomeEquipe)}`, {
    credentials: 'include',
  });
  const data = await handleResponse(res, 'Erro ao carregar métricas da equipe');
  return data.data;
}

// ============================================================
// ATUALIZAÇÕES ADMIN
// ============================================================
export async function updateAllAssessorsMetrics(payload: any) {
  const res = await fetch(`${API_BASE}/admin/update-all-assessors-metrics`, {
    method: 'POST',
    headers: csrfHeaders(),
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  return await handleResponse(res, 'Erro ao atualizar métricas globais');
}

export async function updateTeamMetrics(payload: any) {
  const res = await fetch(`${API_BASE}/admin/update-team-metrics`, {
    method: 'POST',
    headers: csrfHeaders(),
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  return await handleResponse(res, 'Erro ao atualizar métricas da equipe');
}

export async function updateAssessorMetrics(payload: any) {
  const res = await fetch(`${API_BASE}/admin/update-assessor-metrics`, {
    method: 'POST',
    headers: csrfHeaders(),
    body: JSON.stringify(payload),
    credentials: 'include',
  });
  return await handleResponse(res, 'Erro ao atualizar métricas do assessor');
}

// ============================================================
// MÉTRICAS COM PARÂMETROS
// ============================================================
export interface MetricParams {
  start: string;
  end: string;
  colaborador?: string;
  colaboradorId?: string | number;
  equipe?: string;
  produto?: string;
  granularity?: 'daily' | 'weekly' | 'monthly';
  signal?: AbortSignal;
}

function buildMetricUrl(base: string, params: MetricParams): string {
  const url = new URL(base, window.location.origin);
  url.searchParams.append('start', params.start);
  url.searchParams.append('end', params.end);
  if (params.colaborador) url.searchParams.append('colaborador', params.colaborador);
  if (params.colaboradorId != null) url.searchParams.append('colaboradorId', String(params.colaboradorId));
  if (params.equipe) url.searchParams.append('equipe', params.equipe);
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  if (params.granularity) url.searchParams.append('granularity', params.granularity);
  return url.toString();
}

export async function fetchEmitidos(params: MetricParams) {
  const url = buildMetricUrl(`${API_BASE}/metrics/emitidos`, params);
  const res = await fetch(url, { credentials: 'include', signal: params.signal });
  const data = await handleResponse(res, 'Erro ao carregar emitidos');
  return data.data || [];
}

export async function fetchAssinados(params: MetricParams): Promise<{ colaborador: string; equipe: string; total: number; periodo?: string }[]> {
  const url = buildMetricUrl(`${API_BASE}/metrics/assinados`, params);
  const res = await fetch(url, { credentials: 'include', signal: params.signal });
  const data = await handleResponse(res, 'Erro ao carregar assinados');
  return data.data || [];
}

export async function fetchProtocolados(params: MetricParams): Promise<{ colaborador: string; equipe: string; total: number; periodo?: string }[]> {
  const url = buildMetricUrl(`${API_BASE}/metrics/protocolados`, params);
  const res = await fetch(url, { credentials: 'include', signal: params.signal });
  const data = await handleResponse(res, 'Erro ao carregar protocolados');
  return data.data || [];
}

export async function fetchGanhos(params: MetricParams): Promise<{ colaborador: string; equipe: string; total: number; periodo?: string }[]> {
  const url = buildMetricUrl(`${API_BASE}/metrics/ganhos`, params);
  const res = await fetch(url, { credentials: 'include', signal: params.signal });
  const data = await handleResponse(res, 'Erro ao carregar ganhos');
  return data.data || [];
}

export async function fetchPerdidos(params: MetricParams): Promise<{ colaborador: string; equipe: string; total: number; periodo?: string }[]> {
  const url = buildMetricUrl(`${API_BASE}/metrics/perdidos`, params);
  const res = await fetch(url, { credentials: 'include', signal: params.signal });
  const data = await handleResponse(res, 'Erro ao carregar perdidos');
  return data.data || [];
}

export async function fetchLeadsRecebidos(params: MetricParams): Promise<{ data: string; total: number; colaborador: string }[]> {
  const url = buildMetricUrl(`${API_BASE}/metrics/leads-recebidos`, params);
  const res = await fetch(url, { credentials: 'include', signal: params.signal });
  const data = await handleResponse(res, 'Erro ao carregar leads recebidos');
  if (Array.isArray(data.data)) {
    data.data = data.data.map((item: any) => ({ ...item, total: Number(item.total) || 0 }));
  }
  return data.data || [];
}

// ============================================================
// PERFORMANCE SEMANAL
// ============================================================
export async function fetchWeeklyPerformance(params: { start: string; end: string }): Promise<{ semana: string; vendas: number; meta: number }[]> {
  const url = new URL(`${API_BASE}/metrics/weekly`, window.location.origin);
  url.searchParams.append('start', params.start);
  url.searchParams.append('end', params.end);
  const res = await fetch(url.toString(), { credentials: 'include' });
  const data = await handleResponse(res, 'Erro ao carregar performance semanal');
  return data.data || [];
}

// ============================================================
// UTILITÁRIO DE DATAS
// ============================================================
export function getDateRangeFromPeriod(periodo: string): { start: string; end: string } {
  const now = new Date();
  let start: Date, end: Date;
  if (periodo === 'Hoje') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else if (periodo === 'Semana') {
    const first = now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1);
    start = new Date(now.getFullYear(), now.getMonth(), first);
    end = new Date(now.getFullYear(), now.getMonth(), first + 7);
  } else { // Mês
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}