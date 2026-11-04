import { API_BASE } from '@/lib/api';

export interface NaoTabuladaRow {
  agente: string;
  supervisor: string;
  total_nao_tabuladas: number;
}

export interface TabulacoesParams {
  start: string;
  end: string;
  equipe?: string;
  colaborador?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function fetchNaoTabuladas(params: TabulacoesParams): Promise<NaoTabuladaRow[]> {
  const url = new URL(`${API_BASE}/tabulacoes/nao-tabuladas`, window.location.origin);
  url.searchParams.append('start', params.start);
  url.searchParams.append('end', params.end);
  if (params.equipe && params.equipe !== 'todas') {
    url.searchParams.append('equipe', params.equipe);
  }
  if (params.colaborador && params.colaborador !== 'todos') {
    url.searchParams.append('colaborador', params.colaborador);
  }

  const response = await fetch(url.toString(), { credentials: 'include' });
  const raw = await response.text();
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(
      `Resposta não-JSON em ${url.pathname}. Verifique se a rota /api/tabulacoes está montada no Express.`,
    );
  }

  const payload = isRecord(body) ? body : null;
  if (!response.ok || payload?.success !== true) {
    const message = typeof payload?.error === 'string' ? payload.error : null;
    throw new Error(message || `Erro ${response.status} ao carregar tabulações.`);
  }
  if (!Array.isArray(payload.data)) {
    throw new Error('Formato inválido na resposta de tabulações.');
  }

  return payload.data
    .filter(isRecord)
    .map((row): NaoTabuladaRow => {
      return {
        agente: String(row.agente || '').trim(),
        supervisor: String(row.supervisor || '').trim(),
        total_nao_tabuladas: Number(row.total_nao_tabuladas) || 0,
      };
    })
    .filter((row) => row.agente && row.supervisor && row.total_nao_tabuladas > 0);
}
