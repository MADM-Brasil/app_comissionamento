// backend/services/bd/cacheFirst.js
// ─────────────────────────────────────────────────────────────────────────────
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { cacheGet, cacheDelete, cacheSetMany } from './cache.js';
import { singleflight } from './singleflight.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

// ─── Constantes ──────────────────────────────────────────────────────────────
const STALE_PREFIX = 'stale:';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_MS = 300_000;       // 5min
const MIN_REFRESH_INTERVAL_MS = 5_000; 
const MAX_REFRESH_TRACK_ENTRIES = 10_000;

// ─── L1 (in-process) ─────────────────────────────────────────────────────────
const L1_MAX_ENTRIES = 500;
const L1_DEFAULT_STALE_MS = 300_000;

// ─── Limites configuráveis ───────────────────────────────────────────
const MAX_L2_BYTES =
  Number(process.env.CACHE_FIRST_MAX_L2_BYTES) || 1_000_000; 
const FAST_SIZE_CHECK_THRESHOLD = 5000; // heurística rápida para arrays grandes
const CACHE_GET_FAST_TIMEOUT_MS =
  Number(process.env.CACHE_FIRST_FAST_TIMEOUT_MS) || 300; // ms

// ─── Compressão para L2 (FIX 8) ──────────────────────────────────────────────
const L2_COMPRESS_ENABLED = process.env.CACHE_FIRST_L2_COMPRESS !== '0';
// Acima disso nem tenta comprimir (evita travar CPU com payloads absurdos).
const MAX_L2_COMPRESS_INPUT_BYTES =
  Number(process.env.CACHE_FIRST_MAX_L2_COMPRESS_INPUT_BYTES) || 50_000_000; // 50 MB
const GZ_MARKER = '__cacheFirstGz';

// ─── Estado interno (por processo) ───────────────────────────────────────────
const l1Cache = new Map(); // key → { value, at, ttlMs, staleMs }
const lastRefreshAttempt = new Map(); // key → timestamp da última tentativa em bg
const TIMEOUT_SENTINEL = Symbol('cache-timeout');

const stats = {
  l1Hits: 0,
  l1StaleHits: 0,
  freshHits: 0,
  staleHits: 0,
  misses: 0,
  refreshesTriggered: 0,
  refreshesSkipped: 0,
  loaderErrors: 0,
  fastTimeouts: 0,
  l2SkipsDueToSize: 0,
  l2WriteFailures: 0,
  l2Compressed: 0,
  l2CompressFailures: 0,
  l2DecompressFailures: 0,
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
// L1 (in-process)
// ═════════════════════════════════════════════════════════════════════════════
function l1Get(key) {
  const entry = l1Cache.get(key);
  if (!entry) return null;

  const age = Date.now() - entry.at;
  if (age > entry.staleMs) {
    l1Cache.delete(key);
    return null;
  }

  return {
    value: entry.value,
    // 'fresh' quando ainda dentro do TTL; 'stale' quando está na janela
    // de stale-while-revalidate (TTL expirou mas ainda pode servir).
    isFresh: age <= entry.ttlMs,
    isStale: age > entry.ttlMs && age <= entry.staleMs,
  };
}

function l1Set(key, value, ttlMs, staleMs) {
  l1Cache.delete(key);
  l1Cache.set(key, {
    value,
    at: Date.now(),
    ttlMs: ttlMs ?? DEFAULT_TTL_MS,
    staleMs: staleMs ?? Math.max((ttlMs ?? DEFAULT_TTL_MS) * 5, L1_DEFAULT_STALE_MS),
  });
  while (l1Cache.size > L1_MAX_ENTRIES) {
    const oldest = l1Cache.keys().next().value;
    if (oldest === undefined) break;
    l1Cache.delete(oldest);
  }
}

function l1Invalidate(key) {
  l1Cache.delete(key);
}

// ═════════════════════════════════════════════════════════════════════════════
// Size estimation — FIX 3
// Estimativa rápida que evita JSON.stringify de payloads gigantes.
// ═════════════════════════════════════════════════════════════════════════════
function estimateSize(value) {
  if (value == null) return 0;
  try {
    if (typeof value === 'string') return value.length * 2;

    if (Array.isArray(value)) {
      if (value.length > FAST_SIZE_CHECK_THRESHOLD) {
        // Sample 100 itens para estimar sem serializar o array inteiro
        const sampleSize = Math.min(100, value.length);
        const sampleBytes = JSON.stringify(value.slice(0, sampleSize)).length;
        return Math.round((sampleBytes / sampleSize) * value.length);
      }
      return JSON.stringify(value).length;
    }
    if (typeof value === 'object' && Array.isArray(value.rows)) {
      const rows = value.rows;
      if (rows.length > FAST_SIZE_CHECK_THRESHOLD) {
        const sampleSize = Math.min(100, rows.length);
        const sampleBytes = JSON.stringify(rows.slice(0, sampleSize)).length;
        return Math.round((sampleBytes / sampleSize) * rows.length) + 200; 
      }
    }

    return JSON.stringify(value).length;
  } catch {

    return Infinity;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Compressão L2
// ═════════════════════════════════════════════════════════════════════════════
function isCompressedEnvelope(v) {
  return (
    v != null &&
    typeof v === 'object' &&
    v[GZ_MARKER] === 1 &&
    typeof v.data === 'string'
  );
}

/**
 * Comprime o valor para caber em L2.
 * @returns {Promise<{ envelope: object, rawBytes: number, l2Bytes: number } | null>}
 *          null se não couber mesmo comprimido.
 */
async function compressForL2(value, key) {
  if (!L2_COMPRESS_ENABLED) return null;
  try {
    const json = JSON.stringify(value);
    if (json == null || json.length > MAX_L2_COMPRESS_INPUT_BYTES) return null;
    const buf = await gzipAsync(json, { level: 6 });
    const data = buf.toString('base64');
    // +60B do envelope JSON
    const l2Bytes = data.length + 60;
    if (l2Bytes > MAX_L2_BYTES) return { envelope: null, rawBytes: json.length, l2Bytes };
    return {
      envelope: { [GZ_MARKER]: 1, enc: 'gzip-base64', data },
      rawBytes: json.length,
      l2Bytes,
    };
  } catch (err) {
    stats.l2CompressFailures++;
    console.warn(
      `[cacheFirst] falha ao comprimir para L2 (key="${key}"):`,
      err?.message || err,
    );
    return null;
  }
}

async function decodeFromL2(v, key) {
  if (!isCompressedEnvelope(v)) return v;
  try {
    const buf = await gunzipAsync(Buffer.from(v.data, 'base64'));
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    stats.l2DecompressFailures++;
    console.warn(
      `[cacheFirst] falha ao descomprimir L2 (key="${key}") — tratando como miss:`,
      err?.message || err,
    );
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Fast-fail cacheGet 
// ═════════════════════════════════════════════════════════════════════════════
async function cacheGetSafe(key) {
  let timeoutId;
  try {
    const result = await Promise.race([
      cacheGet(key).catch(() => null),
      new Promise((resolve) => {
        timeoutId = setTimeout(
          () => resolve(TIMEOUT_SENTINEL),
          CACHE_GET_FAST_TIMEOUT_MS,
        );
      }),
    ]);
    if (result === TIMEOUT_SENTINEL) {
      stats.fastTimeouts++;
      return null;
    }
    // FIX 8: descomprime envelopes gzip gravados por loadAndCache
    return await decodeFromL2(result, key);
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// loadAndCache
// ═════════════════════════════════════════════════════════════════════════════
function loadAndCache(key, loader, opts) {
  const { ttlMs, staleMs } = opts;

  return singleflight(`fetch:${key}`, async () => {
    try {
      const value = await loader();
      l1Set(key, value, ttlMs, staleMs);
      let l2Value = value;
      const size = estimateSize(value);
      if (size > MAX_L2_BYTES) {
        const compressed = await compressForL2(value, key);
        if (compressed?.envelope) {
          stats.l2Compressed++;
          l2Value = compressed.envelope;
        } else {
          l2Value = null;
          stats.l2SkipsDueToSize++;
          const detail = compressed
            ? ` (comprimido: ${compressed.l2Bytes}B)`
            : '';
          console.warn(
            `[cacheFirst] payload ${size}B${detail} excede MAX_L2_BYTES=${MAX_L2_BYTES} — ` +
            `mantendo só L1 (key="${key}")`,
          );
        }
      }

      if (l2Value != null) {
        try {
          await cacheSetMany([
            { key: staleKeyOf(key), value: l2Value, ttlMs: staleMs },
            { key, value: l2Value, ttlMs },
          ]);
        } catch (err) {
          stats.l2WriteFailures++;
          console.warn(
            `[cacheFirst] cacheSetMany falhou (key="${key}"):`,
            err?.message || err,
          );
        }
      }

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
// Resolução interna 
// ═════════════════════════════════════════════════════════════════════════════
async function resolve(key, loader, opts) {
  // ── 0. L1 in-process (fast path) ───────────────────────────
  const l1 = l1Get(key);
  if (l1) {
    if (l1.isFresh) {
      stats.l1Hits++;
      return { value: l1.value, source: 'l1' };
    }
    if (l1.isStale) {
      stats.l1StaleHits++;
      // Stale-while-revalidate em L1: retorna já + refresh em background
      if (shouldAttemptRefresh(key)) {
        trackRefreshAttempt(key);
        stats.refreshesTriggered++;
        loadAndCache(key, loader, opts).catch((err) => {
          console.error(
            `[cacheFirst] L1-stale bg refresh falhou (key="${key}"):`,
            err?.message || err,
          );
        });
      } else {
        stats.refreshesSkipped++;
      }
      return { value: l1.value, source: 'l1-stale' };
    }
  }

  // ── 1. cache fresco (Redis) ────────────────────────────────
  const fresh = await cacheGetSafe(key);
  if (fresh != null) {
    stats.freshHits++;
    // Popula L1 para próximo request evitar Redis
    l1Set(key, fresh, opts.ttlMs, opts.staleMs);
    return { value: fresh, source: 'fresh' };
  }

  // ── 2. cache stale + refresh em background ─────────────────
  const stale = await cacheGetSafe(staleKeyOf(key));
  if (stale != null) {
    stats.staleHits++;
    l1Set(key, stale, opts.ttlMs, opts.staleMs);

    if (shouldAttemptRefresh(key)) {
      trackRefreshAttempt(key);
      stats.refreshesTriggered++;

      // Fire-and-forget. singleflight dedupe: se 100 usuários chegarem
      // aqui em STALE ao mesmo tempo, só 1 dispara o loader.
      loadAndCache(key, loader, opts).catch((err) => {
        console.error(
          `[cacheFirst] refresh bg falhou (key="${key}"):`,
          err?.message || err,
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
 * Cache-first com stale-while-revalidate + singleflight + L1 in-process.
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
 * @returns {Promise<{ value: T, source: 'l1' | 'l1-stale' | 'fresh' | 'stale' | 'miss' }>}
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
 * Invalida L1 antes do load para garantir que o novo valor
 * sobrescreve qualquer entrada antiga in-process.
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
  l1Invalidate(key);
  return loadAndCache(key, loader, resolved);
}

/**
 * Invalida uma key (remove L1 + fresh + stale do Redis + reseta backoff).
 * Use em endpoints de escrita quando os dados mudaram e você não
 * quer esperar o TTL expirar.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function cacheInvalidate(key) {
  if (!key || typeof key !== 'string') return;
  lastRefreshAttempt.delete(key);
  l1Invalidate(key);
  await Promise.all([
    cacheDelete(key).catch(() => {}),
    cacheDelete(staleKeyOf(key)).catch(() => {}),
  ]);
}

/**
 * Estatísticas para /health/warmup ou diagnóstico.
 */
export function cacheFirstStats() {
  const total =
    stats.l1Hits +
    stats.l1StaleHits +
    stats.freshHits +
    stats.staleHits +
    stats.misses;

  const hitRatio =
    total > 0
      ? Number(
          (
            (stats.l1Hits +
              stats.l1StaleHits +
              stats.freshHits +
              stats.staleHits) /
            total
          ).toFixed(4),
        )
      : null;

  return {
    ...stats,
    hitRatio,
    l1Size: l1Cache.size,
    l1MaxEntries: L1_MAX_ENTRIES,
    trackedRefreshKeys: lastRefreshAttempt.size,
    totalRequests: total,
    limits: {
      maxL2Bytes: MAX_L2_BYTES,
      fastTimeoutMs: CACHE_GET_FAST_TIMEOUT_MS,
      l2CompressEnabled: L2_COMPRESS_ENABLED,
      maxL2CompressInputBytes: MAX_L2_COMPRESS_INPUT_BYTES,
    },
  };
}