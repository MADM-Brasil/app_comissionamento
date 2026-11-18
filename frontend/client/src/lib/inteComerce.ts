// src/lib/inteComerce.ts

import { API_BASE } from '@/lib/api';

// ───────────────────────────────────────────────────────────
// Tipos (inalterados)
// ───────────────────────────────────────────────────────────
export interface InteComerceParams {
  start: string;
  end: string;
  mode?: 'safra' | 'producao' | 'producao-3-meses';
  selectedDay?: string;
  equipe?: string;
  colaboradorId?: string | number;
  produto?: string;
  unidadeId?: number;
}

export interface InteComerceOverview {
  recebidos: number; trabalhados_proxy: number; em_contato_crm: number;
  assinados: number; ganhos: number; protocolados: number; desqualificados: number;
}

export interface InteComerceStrategic {
  recebidos: number; em_contato: number; assinados: number;
  assinados_que_ganharam: number;
  pct_recebidos_ate_assinados: number;
  pct_recebidos_ate_em_contato: number;
  pct_assinados_ate_ganhos: number;
  variacao_safra_sem_maturidade_equivalente: number | null;
}

export interface InteComerceFunnel {
  recebidos: number; trabalhados: number; em_contato: number;
  coleta: number; emitidos: number; assinados: number;
  ganhos: number; protocolados: number; desqualificados_saida: number;
  coleta_sem_contato_observado: number;
}

export interface InteComerceReason {
  motivo: string; deals_desqualificados: number;
}

export interface InteComerceCollaborator {
  colaborador_id: string; colaborador: string; equipe_atual: string;
  recebimentos_deal_dia: number; trabalhados: number; em_contato: number;
  coleta: number; emitidos?: number; assinados: number; ganhos: number; protocolados: number;
  pct_olos_pendente: number | null; pct_hubspot_pendente: number | null;
}

export interface InteComerceTeam {
  equipe: string; recebimentos_assessor_deal_dia: number;
  deals_unicos_da_equipe: number; trabalhados: number; em_contato: number;
  coleta: number; emitidos?: number; assinados: number; ganhos: number; protocolados: number;
}

export interface InteComerceDaily {
  dia: string; recebidos: number; assinados_ate_corte: number;
  taxa_safra_pct: number | null;
}

export interface InteComerceAll {
  overview: InteComerceOverview;
  strategic: InteComerceStrategic;
  funnel: InteComerceFunnel;
  daily: InteComerceDaily[];
  reasons: InteComerceReason[];
  dataAsOf: string;
  safraComparison?: {
    day: Pick<InteComerceOverview, 'recebidos'|'assinados'|'ganhos'|'protocolados'>;
    month: Pick<InteComerceOverview, 'recebidos'|'assinados'|'ganhos'|'protocolados'>;
  };
  productionComparison?: {
    day: Pick<InteComerceOverview, 'recebidos'|'assinados'|'ganhos'|'protocolados'>;
    month: Pick<InteComerceOverview, 'recebidos'|'assinados'|'ganhos'|'protocolados'>;
  };
}

// ───────────────────────────────────────────────────────────
// Erro tipado
// ───────────────────────────────────────────────────────────
export interface InteComerceAttempt {
  base: string;
  variant: 'canonical' | 'aliases' | 'post';
  url: string;
  status: number;
  contentType: string;
  preview: string;
}

export class InteComerceHttpError extends Error {
  readonly path: string;
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly isNonJson: boolean;
  readonly bodyPreview: string;
  readonly attempts?: ReadonlyArray<InteComerceAttempt>;

  constructor(opts: {
    path: string; url: string; status: number; contentType: string;
    isNonJson: boolean; bodyPreview: string; message: string;
    attempts?: ReadonlyArray<InteComerceAttempt>;
  }) {
    super(opts.message);
    this.name = 'InteComerceHttpError';
    this.path = opts.path; this.url = opts.url; this.status = opts.status;
    this.contentType = opts.contentType; this.isNonJson = opts.isNonJson;
    this.bodyPreview = opts.bodyPreview; this.attempts = opts.attempts;
  }

  get isEndpointMissing(): boolean { return this.status === 404 || this.isNonJson; }
  get isStartEndComplaint(): boolean {
    return this.status === 400 && START_END_RE.test(this.bodyPreview || this.message);
  }
  get isUpstreamTimeout(): boolean {
    return this.status === 504 || this.status === 0;
  }
}

const START_END_RE = /start\s*(e|&)\s*end|start.*end.*obrigat|inicio.*fim/i;

// ───────────────────────────────────────────────────────────
// Multi-base + variantes de param naming
// ───────────────────────────────────────────────────────────
let resolvedBase: string | null = null;
let resolvedVariant: 'canonical' | 'aliases' | 'post' | null = null;

// Timeout por tentativa HTTP. Deve ser > timeout do Traefik (~60s) para
// que o 504 do upstream seja a primeira coisa que recebemos — assim
// conseguimos propagar o erro real em vez de AbortError genérico.
const FETCH_TIMEOUT_MS = 120_000;

function getCandidateBases(): string[] {
  const out: string[] = [];
  const push = (b: string) => {
    if (b == null) return;
    if (!out.includes(b)) out.push(b);
  };
  if (resolvedBase != null) push(resolvedBase);
  push(API_BASE);
  push('/api');
  // NUNCA incluir '' — a base vazia mapeia para /metrics/inte-comerce/*
  // que no proxy do frontend cai no SPA fallback (index.html 200),
  // poluindo o log e mascarando o diagnóstico. Se /api falhar, é erro
  // real e deve ser propagado.
  return out;
}

function joinPath(base: string, path: string): string {
  const cb = String(base).replace(/\/+$/, '');
  const cp = path.startsWith('/') ? path : `/${path}`;
  return `${cb}${cp}`;
}

type ParamVariant = 'canonical' | 'aliases';

function buildUrlWithBase(
  base: string, path: string, params: InteComerceParams, variant: ParamVariant,
): string {
  const relative = `/metrics/inte-comerce${path}`;
  const fullPath = joinPath(base, relative);
  const origin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost';

  let url: URL;
  try { url = new URL(fullPath, origin); }
  catch { url = new URL(fullPath); }

  if (variant === 'aliases') {
    // Nomes alternativos — cobrem handlers que leem inicio/fim_exclusivo
    // ou data_inicio/data_fim por bug de copy-paste do serviço interno.
    url.searchParams.set('inicio', params.start);
    url.searchParams.set('fim_exclusivo', params.end);
    url.searchParams.set('data_inicio', params.start);
    url.searchParams.set('data_fim', params.end);
    // mantém os canônicos também — se o handler for híbrido, funciona
    url.searchParams.set('start', params.start);
    url.searchParams.set('end', params.end);
  } else {
    url.searchParams.set('start', params.start);
    url.searchParams.set('end', params.end);
  }

  if (params.mode) url.searchParams.set('mode', params.mode);
  if (params.selectedDay) url.searchParams.set('selectedDay', params.selectedDay);
  if (params.equipe && params.equipe !== 'todas') url.searchParams.set('equipe', params.equipe);
  if (params.colaboradorId != null && String(params.colaboradorId).trim() !== '') {
    url.searchParams.set('colaboradorId', String(params.colaboradorId));
  }
  if (params.produto && params.produto !== 'Todos') url.searchParams.set('produto', params.produto);
  if (params.unidadeId != null) url.searchParams.set('unidadeId', String(params.unidadeId));
  return url.toString();
}

export function debugInteComerceUrl(path: string, params: InteComerceParams): string {
  const bases = getCandidateBases();
  const variant = resolvedVariant === 'aliases' ? 'aliases' : 'canonical';
  return buildUrlWithBase(bases[0] ?? '', path, params, variant);
}

function isDebugEnabled(): boolean {
  try {
    const meta = import.meta as unknown as {
      env?: { DEV?: boolean; MODE?: string };
    };
    if (meta?.env?.DEV === true) return true;
    if (typeof meta?.env?.MODE === 'string' && meta.env.MODE !== 'production') return true;
  } catch { /* ignore */ }
  try {
    const g = globalThis as unknown as {
      process?: { env?: { NODE_ENV?: string } };
    };
    if (g.process?.env?.NODE_ENV != null && g.process.env.NODE_ENV !== 'production') return true;
  } catch { /* ignore */ }
  return false;
}

// ───────────────────────────────────────────────────────────
// Uma tentativa HTTP
// ───────────────────────────────────────────────────────────
interface FetchOutcome {
  ok: boolean;
  status: number;
  contentType: string;
  bodyPreview: string;
  data: unknown | null;
  url: string;
  variant: InteComerceAttempt['variant'];
  startEndComplaint: boolean;
  missing: boolean;
  timedOut: boolean;
}

async function attemptFetch(
  url: string,
  variant: InteComerceAttempt['variant'],
  init: RequestInit,
): Promise<FetchOutcome> {
  const base: Omit<
    FetchOutcome,
    'ok'|'data'|'startEndComplaint'|'missing'|'timedOut'|'status'|'bodyPreview'
  > & { status: number; bodyPreview: string } = {
    url, variant, status: 0, contentType: '', bodyPreview: '',
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    clearTimeout(timeoutId);
    const aborted =
      (e as { name?: string })?.name === 'AbortError' ||
      // Alguns browsers usam DOMException com code 20
      (e as { code?: number })?.code === 20;
    if (aborted) {
      if (isDebugEnabled()) {
        // eslint-disable-next-line no-console
        console.warn(`[inteComerce] timeout ${FETCH_TIMEOUT_MS}ms em ${url}`);
      }
      return {
        ...base,
        ok: false, status: 0,
        bodyPreview: `timeout após ${FETCH_TIMEOUT_MS}ms`,
        data: null, startEndComplaint: false, missing: false, timedOut: true,
      };
    }
    return {
      ...base,
      ok: false, status: 0,
      bodyPreview: e instanceof Error ? e.message : String(e),
      data: null, startEndComplaint: false, missing: false, timedOut: false,
    };
  }
  clearTimeout(timeoutId);

  const ct = res.headers.get('content-type') || '';
  const isJson = ct.includes('application/json');
  const text = await res.text().catch(() => '');
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 200);

  // Diagnóstico: 200 + HTML = SPA fallback. Não deveria acontecer se
  // as bases estão corretas, mas se acontecer, registra o URL para
  // facilitar rastrear proxy mal configurado.
  if (res.ok && !isJson && /<html|<!doctype html/i.test(text)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[inteComerce] resposta HTML (SPA fallback) em ${url} — ` +
      `verifique se o proxy está roteando /api/* para o backend.`,
    );
  }

  let data: unknown = null;
  let parsed: any = null;
  if (isJson) {
    try { parsed = JSON.parse(text); } catch { /* ignore */ }
  }

  const serverMsg = String(parsed?.error || parsed?.message || preview || '');
  const startEndComplaint = res.status === 400 && START_END_RE.test(serverMsg);
  const missing = res.status === 404 || !isJson;

  if (res.ok && isJson && parsed?.success) {
    return {
      ...base,
      ok: true, status: res.status, contentType: ct, bodyPreview: preview,
      data: parsed.data, startEndComplaint: false, missing: false, timedOut: false,
    };
  }

  return {
    ...base,
    ok: false, status: res.status, contentType: ct, bodyPreview: preview,
    data: null, startEndComplaint, missing, timedOut: false,
  };
}

// ───────────────────────────────────────────────────────────
// call() — multi-base + multi-variant
// ───────────────────────────────────────────────────────────
async function call<T>(path: string, params: InteComerceParams): Promise<T> {
  if (!params.start || !params.end) {
    throw new InteComerceHttpError({
      path, url: '', status: 0, contentType: '', isNonJson: false, bodyPreview: '',
      message:
        `start e end obrigatórios (antes do fetch): ` +
        `start="${params.start ?? ''}", end="${params.end ?? ''}".`,
    });
  }

  const bases = getCandidateBases();
  const attempts: InteComerceAttempt[] = [];
  let sawStartEndComplaint = false;
  let sawMissing = false;
  let sawTimeout = false;

  // Se já sabemos a variante que funcionou, tenta ela primeiro.
  const variantOrder: Array<InteComerceAttempt['variant']> =
    resolvedVariant === 'aliases'
      ? ['aliases', 'canonical', 'post']
      : resolvedVariant === 'post'
      ? ['post', 'canonical', 'aliases']
      : ['canonical', 'aliases', 'post'];

  for (const base of bases) {
    for (const variant of variantOrder) {
      const isPost = variant === 'post';
      const canonicalUrl = buildUrlWithBase(
        base, path, params,
        variant === 'aliases' ? 'aliases' : 'canonical',
      );

      if (isDebugEnabled()) {
        // eslint-disable-next-line no-console
        console.debug(`[inteComerce] ${isPost ? 'POST' : 'GET'} ${variant} → ${canonicalUrl}`);
      }

      const init: RequestInit = isPost
        ? {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              ...params,
              inicio: params.start,
              fim_exclusivo: params.end,
              data_inicio: params.start,
              data_fim: params.end,
            }),
          }
        : {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'application/json' },
          };

      const outcome = await attemptFetch(canonicalUrl, variant, init);

      attempts.push({
        base, variant, url: canonicalUrl,
        status: outcome.status, contentType: outcome.contentType,
        preview: outcome.bodyPreview.slice(0, 140),
      });

      if (outcome.ok) {
        resolvedBase = base;
        resolvedVariant = variant;
        return outcome.data as T;
      }

      if (outcome.timedOut) {
        sawTimeout = true;
        // Timeout do cliente (upstream travado sem resposta). Não adianta
        // tentar aliases/post — o servidor não está respondendo nada.
        break;
      }
      if (outcome.startEndComplaint) {
        sawStartEndComplaint = true;
        // Próxima variante dentro da MESMA base
        continue;
      }
      if (outcome.missing) {
        sawMissing = true;
        // 404/HTML — não adianta variantes dessa base, vai pra próxima
        break;
      }
      // Outros erros (401/403/5xx) — propaga, não faz sentido continuar
      throw new InteComerceHttpError({
        path, url: canonicalUrl, status: outcome.status,
        contentType: outcome.contentType, isNonJson: !outcome.contentType.includes('json'),
        bodyPreview: outcome.bodyPreview,
        attempts,
        message:
          `HTTP ${outcome.status} em ${path} (${variant}, base "${base || '(vazio)'}"): ` +
          (outcome.bodyPreview || '(sem corpo)'),
      });
    }
  }

  // Todas as combinações falharam — monta diagnóstico
  const detail = attempts
    .map((a) =>
      `  • base "${a.base || '(vazio)'}" [${a.variant}] → HTTP ${a.status}` +
      (a.contentType ? `, CT="${a.contentType}"` : '') +
      (a.preview ? `: ${a.preview}` : ''),
    )
    .join('\n');

  let cause = 'Router /metrics/inte-comerce NÃO está registrado no backend.';
  if (sawTimeout) {
    cause =
      `Upstream respondeu com timeout (sem corpo). O backend ou o proxy ` +
      `(Traefik/Nginx) está levando > ${FETCH_TIMEOUT_MS}ms para responder. ` +
      `Verifique duração do HubSpot e timeouts do Traefik.`;
  } else if (sawStartEndComplaint) {
    cause =
      `Router responde, mas rejeita start/end em TODAS as variantes ` +
      `(canonical, aliases, POST). O handler lê req.query/req.body com nomes ` +
      `diferentes do esperado — corrija o router (deve usar ` +
      `req.query.start / req.query.end, ou aceitar inicio/fim_exclusivo).`;
  } else if (sawMissing) {
    cause =
      `Router NÃO está montado em nenhuma base testada. Confirme em server.js:\n` +
      `   app.use('/api/metrics/inte-comerce', inteComerceRouter);`;
  }

  throw new InteComerceHttpError({
    path, url: attempts[0]?.url ?? '', status: attempts[0]?.status ?? 0,
    contentType: attempts[0]?.contentType ?? '',
    isNonJson: !(attempts[0]?.contentType ?? '').includes('json'),
    bodyPreview: attempts[0]?.preview ?? '',
    attempts,
    message:
      `Nenhuma combinação (base × variante) respondeu JSON válido para ${path}.\n` +
      `Tentativas:\n${detail}\n\n→ ${cause}`,
  });
}

// ───────────────────────────────────────────────────────────
// Probe (diagnóstico)
// ───────────────────────────────────────────────────────────
export interface InteComerceProbeResult extends InteComerceAttempt {
  ok: boolean;
}

export async function probeInteComerceEndpoints(
  params: InteComerceParams,
): Promise<InteComerceProbeResult[]> {
  const bases = getCandidateBases();
  const out: InteComerceProbeResult[] = [];

  await Promise.all(
    bases.flatMap((base) =>
      (['canonical', 'aliases', 'post'] as const).map(async (variant) => {
        const url = buildUrlWithBase(base, '/strategic', params,
          variant === 'aliases' ? 'aliases' : 'canonical');
        const init: RequestInit = variant === 'post'
          ? {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({
                ...params, inicio: params.start, fim_exclusivo: params.end,
                data_inicio: params.start, data_fim: params.end,
              }),
            }
          : { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' } };

        const o = await attemptFetch(url, variant, init);
        out.push({
          base, variant, url, ok: o.ok, status: o.status,
          contentType: o.contentType, preview: o.bodyPreview.slice(0, 120),
        });
      }),
    ),
  );

  out.sort((a, b) =>
    bases.indexOf(a.base) - bases.indexOf(b.base) ||
    ['canonical','aliases','post'].indexOf(a.variant) - ['canonical','aliases','post'].indexOf(b.variant),
  );

  // eslint-disable-next-line no-console
  console.table(out.map((r) => ({
    base: r.base || '(vazio)', variant: r.variant,
    status: r.status, 'content-type': r.contentType, ok: r.ok,
  })));

  return out;
}

// ───────────────────────────────────────────────────────────
// Endpoints individuais 
// ───────────────────────────────────────────────────────────
export const fetchInteComerceOverview = (p: InteComerceParams) =>
  call<InteComerceOverview>('/overview', p);
export const fetchInteComerceStrategic = (p: InteComerceParams) =>
  call<InteComerceStrategic>('/strategic', p);
export const fetchInteComerceFunnel = (p: InteComerceParams) =>
  call<InteComerceFunnel>('/funnel', p);
export const fetchInteComerceDisqualify = (p: InteComerceParams) =>
  call<InteComerceReason[]>('/disqualify-reasons', p);
export const fetchInteComerceDaily = (p: InteComerceParams) =>
  call<InteComerceDaily[]>('/daily', p);
export const fetchInteComerceCollaborators = (p: InteComerceParams) =>
  call<InteComerceCollaborator[]>('/collaborators', p);
export const fetchInteComerceTeams = (p: InteComerceParams) =>
  call<InteComerceTeam[]>('/teams', p);

// ───────────────────────────────────────────────────────────
// /all com fallback para endpoints individuais
// ───────────────────────────────────────────────────────────
export async function fetchInteComerceAll(
  p: InteComerceParams,
): Promise<InteComerceAll> {
  try {
    return await call<InteComerceAll>('/all', p);
  } catch (err) {
    const httpErr = err instanceof InteComerceHttpError ? err : null;

    // Só cai para individuais quando o problema é "rota /all não existe"
    // ou "router /all rejeita start/end". Em 504/5xx NÃO cai — se o
    // backend está lento, disparar 5 timeouts em paralelo só piora.
    const shouldFallback =
      !!httpErr && (httpErr.isEndpointMissing || httpErr.isStartEndComplaint);

    if (!shouldFallback) {
      // Melhora a mensagem para o caso específico de upstream timeout,
      // que é o sintoma de produção mais comum (Traefik corta em 60s).
      if (httpErr?.isUpstreamTimeout) {
        const attemptsDetail = (httpErr.attempts ?? [])
          .map((a) => `  • ${a.variant} ${a.url} → HTTP ${a.status}${a.preview ? `: ${a.preview}` : ''}`)
          .join('\n');
        throw new Error(
          `Upstream timeout em /metrics/inte-comerce/all. ` +
          `O backend (ou o Traefik) não respondeu em tempo. ` +
          `Verifique duração do HubSpot (fetchHubSpotOverview) e timeouts do Traefik.\n` +
          (attemptsDetail ? `Tentativas:\n${attemptsDetail}\n` : '') +
          `Original: ${httpErr.message}`,
        );
      }
      throw err;
    }

    // eslint-disable-next-line no-console
    console.warn(
      `[inteComerce] /all indisponível (HTTP ${httpErr!.status}). ` +
      `Tentando endpoints individuais.`,
    );

    try {
      const [overview, strategic, funnel, reasons, daily] = await Promise.all([
        fetchInteComerceOverview(p),
        fetchInteComerceStrategic(p),
        fetchInteComerceFunnel(p),
        fetchInteComerceDisqualify(p),
        fetchInteComerceDaily(p),
      ]);
      return {
        overview, strategic, funnel, daily, reasons,
        dataAsOf: new Date().toISOString(),
      };
    } catch (fallbackErr) {
      const fb = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(
        `Falha em /all (HTTP ${httpErr!.status}) e nos endpoints individuais: ${fb}`,
      );
    }
  }
}