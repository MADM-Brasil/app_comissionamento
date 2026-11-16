// backend/services/bd/cacheFirst.js
// ─────────────────────────────────────────────────────────────────────────────
// Orquestrador cache-first com:
//   • L1 in-process (fast path, ANTES de qualquer I/O com Redis)
//   • Redis + L2 (via cache.js)
//   • Singleflight (deduplicação de cargas concorrentes)
//   • Stale-while-revalidate (retorna stale + refresh em background)
//   • Backoff de refresh (evita storm quando o loader falha)
//
// Ordem de resolução:
//   0. L1 fresco        (in-process)          → retorna, 0 I/O
//   1. L1 stale         (in-process)          → retorna + agenda refresh bg
//   2. cache fresco     (Redis via cacheGet)  → retorna + popula L1
//   3. cache stale      (Redis via cacheGet)  → retorna + popula L1 + agenda refresh
//   4. cache vazio      → singleflight(loader) → popula L1 + L2 → retorna
//
// ✅ FIX 1: L1 in-process como fast path ANTES de Redis. Antes, cada
//           request pagava o round-trip ao Redis mesmo para keys quentes.
// ✅ FIX 2: Fast-fail no cacheGet (300ms). Não deixa o timeout de 2s do
//           cache.js propagar — falha rápido e cai para L1.
// ✅ FIX 3: Size guard (1 MB). Payloads grandes (20k linhas de demanda)
//           ficam SÓ em L1 — não tentam escrever/lê do Redis.
// ✅ FIX 4: cacheSetMany não é fatal. Se Redis write falha, o valor já
//           está em L1 e o caller recebe o valor mesmo assim.
// ✅ FIX 5: L1 com stale-while-revalidate completo (isFresh/isStale).
// ✅ FIX 6: Env-configurável: CACHE_FIRST_MAX_L2_BYTES,
//           CACHE_FIRST_FAST_TIMEOUT_MS.
// ✅ FIX 7: cacheFirstStats() expõe l1Hits/l1StaleHits/fastTimeouts/etc.
//
// NÃO garantido (por design — trade-off consciente):
//   • Invalidação exata durante um load em voo. Se `cacheInvalidate(K)`
//     for chamado enquanto um `cacheFirst(K)` está pendente, o resultado
//     desse load pode sobrescrever o cache recém-invalidado. Use
//     `cacheRefresh(K, loader)` para forçar nova escrita atômica.
//   • Coordenação entre processos. Cada worker (PM2 cluster) tem seu
//     próprio L1 e `singleflight`. Em cluster com 2 workers, uma key
//     fria pode gerar até 2 queries concorrentes (uma por worker).
//     Para o porte atual, é aceitável.
// ─────────────────────────────────────────────────────────────────────────────

import { cacheGet, cacheDelete, cacheSetMany } from './cache.js';
import { singleflight } from './singleflight.js';

// ─── Constantes ──────────────────────────────────────────────────────────────
const STALE_PREFIX = 'stale:';
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_STALE_MS = 300_000;       // 5min
const MIN_REFRESH_INTERVAL_MS = 5_000;  // backoff por key em falha
const MAX_REFRESH_TRACK_ENTRIES = 10_000;

// ─── L1 (in-process) ─────────────────────────────────────────────────────────
const L1_MAX_ENTRIES = 500;
const L1_DEFAULT_STALE_MS = 300_000;

// ─── Limites configuráveis (FIX 6) ───────────────────────────────────────────
const MAX_L2_BYTES =
  Number(process.env.CACHE_FIRST_MAX_L2_BYTES) || 1_000_000; // 1 MB
const FAST_SIZE_CHECK_THRESHOLD = 5000; // heurística rápida para arrays grandes
const CACHE_GET_FAST_TIMEOUT_MS =
  Number(process.env.CACHE_FIRST_FAST_TIMEOUT_MS) || 300; // ms

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
// L1 (in-process) — FIX 1 + FIX 5
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

    // Padrão { rows: [...] } (retorno de loaders SQL)
    if (typeof value === 'object' && Array.isArray(value.rows)) {
      const rows = value.rows;
      if (rows.length > FAST_SIZE_CHECK_THRESHOLD) {
        const sampleSize = Math.min(100, rows.length);
        const sampleBytes = JSON.stringify(rows.slice(0, sampleSize)).length;
        return Math.round((sampleBytes / sampleSize) * rows.length) + 200; // +overhead do wrapper
      }
    }

    return JSON.stringify(value).length;
  } catch {
    // Se não serializável, trata como muito grande (não vai pra L2)
    return Infinity;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Fast-fail cacheGet — FIX 2
// Não deixa o timeout de 2s do cache.js travar o request.
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
    return result;
  } catch {
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// loadAndCache
//
// É o ÚNICO caminho que invoca o loader.
// Foreground (MISS) e background (STALE-refresh) usam a MESMA chave de
// singleflight → concorrência real = 1 query, sempre.
//
// ✅ FIX 1: L1 é populado ANTES de tocar Redis (fast path imediato).
// ✅ FIX 3: size guard pula L2 se payload > MAX_L2_BYTES.
// ✅ FIX 4: falha em cacheSetMany NÃO é fatal (já temos L1).
// ═════════════════════════════════════════════════════════════════════════════
function loadAndCache(key, loader, opts) {
  const { ttlMs, staleMs } = opts;

  return singleflight(`fetch:${key}`, async () => {
    try {
      const value = await loader();

      // ✅ FIX 1: L1 SEMPRE — mesmo se L2 falhar ou for grande demais
      l1Set(key, value, ttlMs, staleMs);

      // ✅ FIX 3: size guard antes de tocar Redis
      const size = estimateSize(value);
      if (size > MAX_L2_BYTES) {
        stats.l2SkipsDueToSize++;
        console.warn(
          `[cacheFirst] payload ${size}B excede MAX_L2_BYTES=${MAX_L2_BYTES} — ` +
          `mantendo só L1 (key="${key}")`,
        );
      } else {
        try {
          await cacheSetMany([
            { key: staleKeyOf(key), value, ttlMs: staleMs },
            { key, value, ttlMs },
          ]);
        } catch (err) {
          // ✅ FIX 4: cacheSetMany não é fatal — L1 já tem o valor
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
// Resolução interna (retorna { value, source })
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
 * ⚠️ Se houver um load em voo para essa key, o resultado desse load
 * pode sobrescrever a invalidação quando terminar. Use
 * `cacheRefresh` em vez de `cacheInvalidate`, ou aguarde o load.
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
    },
  };
}