// src/lib/inteComerce.ts
import { API_BASE } from '@/lib/api';

export interface InteComerceParams {
  start: string;
  end: string;
  equipe?: string;
  colaboradorId?: string | number;
  produto?: string;
  unidadeId?: number;
}

export interface InteComerceOverview {
  recebidos: number;
  trabalhados_proxy: number;
  em_contato_crm: number;
  assinados: number;
  ganhos: number;
  protocolados: number;
  desqualificados: number;
}

export interface InteComerceStrategic {
  recebidos: number;
  em_contato: number;
  assinados: number;
  assinados_que_ganharam: number;
  pct_recebidos_ate_assinados: number;
  pct_recebidos_ate_em_contato: number;
  pct_assinados_ate_ganhos: number;
  variacao_safra_sem_maturidade_equivalente: number | null;
}

export interface InteComerceFunnel {
  recebidos: number;
  trabalhados: number;
  em_contato: number;
  coleta: number;
  contrato: number;
  emitidos: number;
  assinados: number;
  ganhos: number;
  protocolados: number;
  desqualificados_saida: number;
  coleta_sem_contato_observado: number;
}

export interface InteComerceReason {
  motivo: string;
  deals_desqualificados: number;
}

export interface InteComerceCollaborator {
  colaborador_id: string;
  colaborador: string;
  equipe_atual: string;
  recebimentos_deal_dia: number;
  trabalhados: number;
  em_contato: number;
  coleta: number;
  assinados: number;
  ganhos: number;
  protocolados: number;
  pct_olos_pendente: number | null;
  pct_hubspot_pendente: number | null;
}

export interface InteComerceTeam {
  equipe: string;
  recebimentos_assessor_deal_dia: number;
  deals_unicos_da_equipe: number;
  trabalhados: number;
  em_contato: number;
  coleta: number;
  assinados: number;
  ganhos: number;
  protocolados: number;
}

export interface InteComerceDaily {
  dia: string;
  recebidos: number;
  assinados_ate_corte: number;
  taxa_safra_pct: number | null;
}

function buildUrl(path: string, params: InteComerceParams): string {
  const url = new URL(`${API_BASE}/metrics/inte-comerce${path}`, window.location.origin);
  url.searchParams.append('start', params.start);
  url.searchParams.append('end', params.end);
  if (params.equipe && params.equipe !== 'todas') url.searchParams.append('equipe', params.equipe);
  if (params.colaboradorId != null && String(params.colaboradorId).trim() !== '') {
    url.searchParams.append('colaboradorId', String(params.colaboradorId));
  }
  if (params.produto && params.produto !== 'Todos') url.searchParams.append('produto', params.produto);
  if (params.unidadeId != null) url.searchParams.append('unidadeId', String(params.unidadeId));
  return url.toString();
}

async function call<T>(path: string, params: InteComerceParams): Promise<T> {
  const res = await fetch(buildUrl(path, params), { credentials: 'include' });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(json.error || 'Erro ao carregar dados.');
  return json.data as T;
}

export const fetchInteComerceOverview        = (p: InteComerceParams) => call<InteComerceOverview>('/overview', p);
export const fetchInteComerceStrategic       = (p: InteComerceParams) => call<InteComerceStrategic>('/strategic', p);
export const fetchInteComerceFunnel          = (p: InteComerceParams) => call<InteComerceFunnel>('/funnel', p);
export const fetchInteComerceDisqualify      = (p: InteComerceParams) => call<InteComerceReason[]>('/disqualify-reasons', p);
export const fetchInteComerceDaily           = (p: InteComerceParams) => call<InteComerceDaily[]>('/daily', p);
export const fetchInteComerceCollaborators   = (p: InteComerceParams) => call<InteComerceCollaborator[]>('/collaborators', p);
export const fetchInteComerceTeams           = (p: InteComerceParams) => call<InteComerceTeam[]>('/teams', p);