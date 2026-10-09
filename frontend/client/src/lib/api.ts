// src/lib/api.ts
export const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function handleResponse(response: Response, defaultErrorMessage: string) {
  const contentLength = response.headers.get('content-length');
  if (contentLength === '0' || response.status === 204) {
    if (response.status === 403) {
      throw new Error('Token CSRF inválido. Recarregue a página e tente novamente.');
    }
    return {};  
  } 

  let text;
  try {
    text = await response.text();
  } catch (err) {
    console.error('❌ Erro ao ler corpo da resposta:', err);
    throw new Error(defaultErrorMessage || 'Erro desconhecido ao processar a resposta');
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
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

function csrfHeaders(extraHeaders: Record<string, string> = {}) {
  const token = localStorage.getItem('csrfToken');
  return {
    'Content-Type': 'application/json',
    ...(token ? { 'x-csrf-token': token } : {}),
    ...extraHeaders,
  };
}

// ============ COLABORADORES E EQUIPES ============

export async function fetchCollaborators(queryString = "") {
  const url = `${API_BASE}/collaborators${queryString}`;
  console.log('🌐 [fetchCollaborators] URL:', url);
  const response = await fetch(url, { credentials: 'include' });
  console.log('📡 [fetchCollaborators] Status:', response.status);
  const data = await handleResponse(response, 'Erro ao carregar colaboradores');
  console.log('📦 [fetchCollaborators] Itens recebidos:', data.data?.length);
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

// ============================================================
// GANHOS — suporta filtro de "demanda"
// ------------------------------------------------------------
// demanda = 'todos' (default) — comportamento antigo, retorna todos os ganhos.
// demanda = 'atual'            — considera apenas ganhos cuja ASSINATURA
//                                ocorreu no mês do `start` da consulta.
//                                Exclui, portanto, ganhos originados de
//                                "demanda reprimida" (assinaturas de meses
//                                anteriores que só viraram ganho agora).
//
// Usado pela página de Comissões para que o cálculo da campanha
// CAMPGANHOS_2026 contabilize somente a demanda do mês corrente.
// ============================================================
export type GanhosDemandaFilter = 'todos' | 'atual';

export interface GanhosParams extends MetricParams {
  demanda?: GanhosDemandaFilter;
}

export async function fetchGanhos(
  params: GanhosParams
): Promise<{ colaborador: string; equipe: string; total: number; periodo?: string }[]> {
  const url = new URL(buildMetricUrl(`${API_BASE}/metrics/ganhos`, params), window.location.origin);
  if (params.demanda) url.searchParams.append('demanda', params.demanda);
  const res = await fetch(url.toString(), { credentials: 'include', signal: params.signal });
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

export async function fetchLigacoesProdutivas(params: MetricParams): Promise<number> {
  const url = buildMetricUrl(`${API_BASE}/metrics/ligacoes-produtivas`, params);
  const res = await fetch(url, { credentials: 'include', signal: params.signal });
  const data = await handleResponse(res, 'Erro ao carregar ligações produtivas');
  return Number(data.total) || 0;
}

export interface CallMetrics {
  periodo?: string;
  colaborador: string;
  equipe: string;
  campanha: string;
  total_ligacoes: number;
  leads_distintos: number;
  produtivas: number;
  agendamentos: number;
  ocorrencias: number;
  insucessos: number;
  tma_medio: number | null;
}

export type CallTabulationCategory = 'productive' | 'appointments' | 'occurrences' | 'failures';

export interface CallTabulation {
  tabulacao: string;
  total: number;
}

export async function fetchLigacoes(params: MetricParams): Promise<CallMetrics[]> {
  const url = buildMetricUrl(`${API_BASE}/metrics/ligacoes`, params);
  const res = await fetch(url, { credentials: 'include', signal: params.signal });
  const data = await handleResponse(res, 'Erro ao carregar métricas de ligações');
  return data.data || [];
}

export async function fetchLigacoesTabulacoes(
  params: MetricParams & { categoria: CallTabulationCategory },
): Promise<CallTabulation[]> {
  const url = new URL(buildMetricUrl(`${API_BASE}/metrics/ligacoes/tabulacoes`, params), window.location.origin);
  url.searchParams.append('categoria', params.categoria);
  const res = await fetch(url.toString(), { credentials: 'include', signal: params.signal });
  const data = await handleResponse(res, 'Erro ao carregar tabulações das ligações');
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
// DEMANDA ATUAL / REPRIMIDA
// ------------------------------------------------------------
// Tipos definidos localmente para evitar import circular com
// dataStore.ts (que importa estas funções). São estruturalmente
// compatíveis com DemandaItem / DemandaResumo de lá.
// ============================================================
export interface DemandaApiParams {
  equipe?: string;
  colaborador?: string;
  colaboradorId?: string | number;
  produto?: string;
}

export interface DemandaApiItem {
  colaborador: string;
  equipe: string;
  lead_id: string | number | null;
  deal_id: string | number | null;
  data_emissao: string | null;
  data_assinatura: string | null;
  data_ganho: string | null;
  pipeline: string | null;
  etapa: string | null;
}

export interface DemandaApiResumoLinha {
  colaborador: string;
  equipe: string;
  total: number;
}

export interface DemandaApiResumo {
  atual: DemandaApiResumoLinha[];
  reprimida: DemandaApiResumoLinha[];
  totalAtual: number;
  totalReprimida: number;
}

function buildDemandaQuery(p?: DemandaApiParams): string {
  const qs = new URLSearchParams();
  if (p?.equipe && p.equipe !== 'todas') qs.append('equipe', p.equipe);
  if (p?.colaborador) qs.append('colaborador', p.colaborador);
  if (p?.colaboradorId !== undefined && p?.colaboradorId !== null) {
    qs.append('colaboradorId', String(p.colaboradorId));
  }
  if (p?.produto && p.produto !== 'Todos') qs.append('produto', p.produto);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export async function fetchDemandaAtual(p?: DemandaApiParams): Promise<DemandaApiItem[]> {
  const res = await fetch(`${API_BASE}/metrics/demanda-atual${buildDemandaQuery(p)}`, {
    credentials: 'include',
  });
  const data = await handleResponse(res, 'Erro ao carregar demanda atual');
  return (data?.data ?? []) as DemandaApiItem[];
}

export async function fetchDemandaReprimida(p?: DemandaApiParams): Promise<DemandaApiItem[]> {
  const res = await fetch(`${API_BASE}/metrics/demanda-reprimida${buildDemandaQuery(p)}`, {
    credentials: 'include',
  });
  const data = await handleResponse(res, 'Erro ao carregar demanda reprimida');
  return (data?.data ?? []) as DemandaApiItem[];
}

export async function fetchDemandaResumo(p?: DemandaApiParams): Promise<DemandaApiResumo> {
  const res = await fetch(`${API_BASE}/metrics/demanda-resumo${buildDemandaQuery(p)}`, {
    credentials: 'include',
  });
  const data = await handleResponse(res, 'Erro ao carregar resumo de demanda');
  return (data?.data ?? {
    atual: [],
    reprimida: [],
    totalAtual: 0,
    totalReprimida: 0,
  }) as DemandaApiResumo;
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
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}