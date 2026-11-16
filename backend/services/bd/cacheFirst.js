// backend/services/bd/cacheFirst.js
// ─────────────────────────────────────────────────────────────────────────────
// Orquestrador cache-first com:
//   • Redis + L1 (via cache.js)
//   • Singleflight (deduplicação de cargas concorrentes)
//   • Stale-while-revalidate (retorna stale + refresh em background)
//   • Backoff de refresh (evita storm quando loader falha)
//
// Ordem de resolução:
//   1. cache fresco  (TTL curto)        → retorna, 0 queries
//   2. cache stale   (TTL longo)        → retorna stale + agenda refresh (deduplicado)
//   3. cache vazio   → singleflight(loader) → popula stale+fresh → retorna
//
// Garantias:
//   • N requests simultâneos na mesma key = 1 execução do loader
//     (mesmo quando alguns estão em MISS e outros em STALE).
//   • Falha no loader não gera mais de 1 tentativa a cada
//     MIN_REFRESH_INTERVAL_MS por key (backoff global).
//   • `stale` é gravado antes do retorno da função → sempre há fallback.
//   • Redis indisponível → L1 responde (cache.js cuida do fallback).
//
// NÃO garantido (por design — é trade-off consciente):
//   • Invalidação exata durante um load em voo. Se `cacheInvalidate(K)`
//     for chamado enquanto um `cacheFirst(K)` está pendente, o resultado
//     desse load pode sobrescrever o cache recém-invalidado. Nesse caso,
//     use `cacheRefresh(K, loader)` para forçar uma nova escrita atômica,
//     ou aguarde o load terminar antes de invalidar.
//   • Coordenação entre processos. Cada worker (PM2 cluster) tem seu
//     próprio `singleflight` e `lastRefreshAttempt`. Em cluster com 2
//     workers, uma key fria pode gerar até 2 queries concorrentes
//     (uma por worker). Para o porte atual (10-40 QPS), é aceitável.
//     Se virar gargalo, usar Redis SET NX como lock distribuído.
// ─────────────────────────────────────────────────────────────────────────────

import { cacheGet, cacheSet, cacheDelete } from './cache.js';
import { singleflight } from './singleflight.js';

// ─── Constantes ──────────────────────────────────────────────────────────────
const STALE_PREFIX = 'stale:';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_MS = 300_000;       // 5min
const MIN_REFRESH_INTERVAL_MS = 5_000;  // backoff por key em falha
const MAX_REFRESH_TRACK_ENTRIES = 10_000;

// ─── Estado interno (por processo) ───────────────────────────────────────────
const lastRefreshAttempt = new Map(); // key → timestamp da última tentativa em bg

const stats = {
  freshHits: 0,
  staleHits: 0,
  misses: 0,
  refreshesTriggered: 0,
  refreshesSkipped: 0,
  loaderErrors: 0,
};

// ─── Helpers internos ────────────────────────────────────────────────────────
function staleKeyOf(key) {
  return STALE_PREFIX + key;
}

function trackRefreshAttempt(key) {
  lastRefreshAttempt.set(key, Date.now());
  if (lastRefreshAttempt.size > MAX_REFRESH_TRACK_ENTRIES) {
    const oldest = lastRefreshAttempt.keys().next().value;
    if (oldest !== undefined) lastRefreshAttempt.delete(oldest);
  }
}

function shouldAttemptRefresh(key) {
  const last = lastRefreshAttempt.get(key) || 0;
  return Date.now() - last >= MIN_REFRESH_INTERVAL_MS;
}

function resolveOptions(opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const staleMs = opts.staleMs ?? Math.max(ttlMs * 5, DEFAULT_STALE_MS);
  if (staleMs <= ttlMs) {
    // stale deveria ser maior que fresco — se não for, corrige silenciosamente
    return { ttlMs, staleMs: ttlMs * 5 };
  }
  return { ttlMs, staleMs };
}

function validate(key, loader) {
  if (!key || typeof key !== 'string') {
    throw new Error('[cacheFirst] key deve ser uma string não-vazia');
  }
  if (typeof loader !== 'function') {
    throw new Error(`[cacheFirst] loader deve ser função (key="${key}")`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Núcleo: executa o loader via singleflight e grava stale+fresh.
//
// É o ÚNICO caminho que invoca o loader.
// Foreground (MISS) e background (STALE-refresh) usam a MESMA chave
// de singleflight → concorrência real = 1 query, sempre.
// ═════════════════════════════════════════════════════════════════════════════
function loadAndCache(key, loader, opts) {
  const { ttlMs, staleMs } = opts;

  return singleflight(`fetch:${key}`, async () => {
    try {
      const value = await loader();

      // stale primeiro (é o fallback — queremos garantir que ele existe).
      // Aguardado: se o processo morrer logo depois, ainda temos stale.
      await cacheSet(staleKeyOf(key), value, staleMs).catch(() => {});

      // fresh depois (é o primário). Fire-and-forget: não bloqueia o retorno.
      // Ordem de comandos no Redis é preservada por conexão (ioredis), então
      // o próximo cacheGet(key) já verá o valor gravado.
      cacheSet(key, value, ttlMs).catch(() => {});

      // Sucesso → libera o backoff desta key para futuras tentativas
      lastRefreshAttempt.delete(key);

      return value;
    } catch (err) {
      stats.loaderErrors++;
      // Mantém o backoff ativo — próxima tentativa só após MIN_REFRESH_INTERVAL_MS
      throw err;
    }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Resolução interna (retorna { value, source })
// ═════════════════════════════════════════════════════════════════════════════
async function resolve(key, loader, opts) {
  // ── 1. cache fresco ────────────────────────────────────────
  const fresh = await cacheGet(key).catch(() => null);
  if (fresh != null) {
    stats.freshHits++;
    return { value: fresh, source: 'fresh' };
  }

  // ── 2. cache stale + refresh em background ─────────────────
  const stale = await cacheGet(staleKeyOf(key)).catch(() => null);
  if (stale != null) {
    stats.staleHits++;

    if (shouldAttemptRefresh(key)) {
      trackRefreshAttempt(key);
      stats.refreshesTriggered++;

      // Fire-and-forget. singleflight dedupe: se 100 usuários chegarem
      // aqui em STALE ao mesmo tempo, só 1 dispara o loader.
      loadAndCache(key, loader, opts).catch((err) => {
        console.error(
          `[cacheFirst] refresh bg falhou (key="${key}"):`,
          err?.message || err
        );
      });
    } else {
      stats.refreshesSkipped++;
    }

    return { value: stale, source: 'stale' };
  }

  // ── 3. cache vazio: espera o loader (singleflight) ─────────
  stats.misses++;
  const value = await loadAndCache(key, loader, opts);
  return { value, source: 'miss' };
}

// ═════════════════════════════════════════════════════════════════════════════
// API PÚBLICA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Cache-first com stale-while-revalidate + singleflight.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} loader
 * @param {{ ttlMs?: number, staleMs?: number }} [opts]
 * @returns {Promise<T>}
 *
 * @example
 *   const rows = await cacheFirst(
 *     metricCacheKey('emitidos', { start, end, equipe, produto }),
 *     () => loadEmitidos({ start, end, equipe, produto }),
 *     { ttlMs: 120_000, staleMs: 900_000 }
 *   );
 */
export async function cacheFirst(key, loader, opts) {
  validate(key, loader);
  const resolved = resolveOptions(opts);
  const { value } = await resolve(key, loader, resolved);
  return value;
}

/**
 * Igual a cacheFirst, mas retorna `{ value, source }`.
 * Útil para endpoints que querem expor `X-Cache: HIT/STALE/MISS`.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} loader
 * @param {{ ttlMs?: number, staleMs?: number }} [opts]
 * @returns {Promise<{ value: T, source: 'fresh' | 'stale' | 'miss' }>}
 */
export async function cacheFirstWithMeta(key, loader, opts) {
  validate(key, loader);
  const resolved = resolveOptions(opts);
  return resolve(key, loader, resolved);
}

/**
 * Força reload (ignora cache). Usado pelo warmup.js.
 * Se um load já está em voo para essa key, junta-se a ele
 * (graças ao singleflight) em vez de disparar outro.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} loader
 * @param {{ ttlMs?: number, staleMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function cacheRefresh(key, loader, opts) {
  validate(key, loader);
  const resolved = resolveOptions(opts);
  return loadAndCache(key, loader, resolved);
}

/**
 * Invalida uma key (remove fresh + stale + reseta backoff).
 * Use em endpoints de escrita quando os dados mudaram e você não
 * quer esperar o TTL expirar.
 *
 * ⚠️ Se houver um load em voo para essa key, o resultado desse load
 * pode sobrescrever a invalidação quando terminar. Nesse caso, use
 * `cacheRefresh` em vez de `cacheInvalidate`, ou aguarde o load.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function cacheInvalidate(key) {
  if (!key || typeof key !== 'string') return;
  lastRefreshAttempt.delete(key);
  await Promise.all([
    cacheDelete(key).catch(() => {}),
    cacheDelete(staleKeyOf(key)).catch(() => {}),
  ]);
}

/**
 * Estatísticas para /health/warmup ou diagnóstico.
 */
export function cacheFirstStats() {
  const total = stats.freshHits + stats.staleHits + stats.misses;
  const hitRatio = total > 0
    ? Number(((stats.freshHits + stats.staleHits) / total).toFixed(4))
    : null;

  return {
    ...stats,
    hitRatio,
    trackedRefreshKeys: lastRefreshAttempt.size,
    totalRequests: total,
  };
}