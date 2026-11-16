// backend/services/bd/cache.js
// ─────────────────────────────────────────────────────────────────────────────
// Cache híbrido Redis + L1 (memória local) COM CIRCUIT BREAKER.
//
// Interface pública:
//   cacheGet(key)                  → value | null
//   cacheSet(key, value, ttlMs)    → void
//   cacheSetMany(entries)          → void   (pipeline, 1 round-trip p/ N sets)
//   cacheGetMany(keys)             → { [key]: value }
//   cacheDelete(key)               → void
//   cacheDeleteByPrefix(prefix)    → void
//   cacheKeyOf(prefix, params)     → string
//   cacheStats()                   → { ...contadores, hitRatio, circuit }
//   cacheClearLocal()              → void   (shutdown)
//
// ─────────────────────────────────────────────────────────────────────────────
// CIRCUIT BREAKER
// ─────────────────────────────────────────────────────────────────────────────
// O sintoma "Redis timeout após 800ms" quase sempre NÃO é Redis lento —
// é o event loop do Node travado em JSON.stringify de payloads grandes.
// O setTimeout(800ms) vence a corrida contra o `await redis.get()` que já
// resolveu, mas cuja promise só é entregue quando o event loop respira.
//
// Solução:
//   • 3 timeouts consecutivos → circuit ABRE por 60s.
//   • Operando aberto → skipa Redis, usa L1 direto (<1ms).
//   • Após 60s → half-open: 1 operação de teste.
//   • Sucesso → fecha. Falha → reabre por mais 60s.
//
// Efeito prático:
//   Sem CB: cada request paga REDIS_OP_TIMEOUT_MS durante o pico
//   Com CB: 3 requests pagam, o resto cai em L1 com <1ms
// ─────────────────────────────────────────────────────────────────────────────

import { redis } from './redis.js';

const DEFAULT_TTL_MS = 60_000;
const LOCAL_MAX_SIZE = 500;
const LOCAL_MAX_ENTRY_BYTES = 512 * 1024;
const REDIS_OP_TIMEOUT_MS = Number(process.env.REDIS_OP_TIMEOUT_MS) || 800;

// ─── L1: Map em memória com LRU ──────────────────────────────────────────────
const localCache = new Map(); // key → { value, expiresAt, sizeBytes }

// ─── Contadores ──────────────────────────────────────────────────────────────
const stats = {
  hitsRedis: 0,
  hitsLocal: 0,
  misses: 0,
  errorsRedis: 0,
  setsRedis: 0,
  setsLocal: 0,
  evictions: 0,
  parseErrors: 0,
  circuitOpens: 0,
  circuitSkips: 0,
};

// ═════════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER
// ═════════════════════════════════════════════════════════════════════════════
const CB = {
  failures: 0,
  failureThreshold: 3,
  openUntil: 0,
  openDurationMs: 60_000,
  lastOpenLog: 0,
};

function circuitOpen() {
  const now = Date.now();
  if (CB.failures < CB.failureThreshold) return false;
  if (now < CB.openUntil) return true;
  // Half-open: deixa 1 operação testar
  CB.openUntil = 0;
  return false;
}

function recordSuccess() {
  if (CB.failures > 0) {
    console.log(`[cache] circuit FECHADO — Redis voltou (${CB.failures} falhas resolvidas)`);
  }
  CB.failures = 0;
  CB.openUntil = 0;
}

function recordFailure() {
  CB.failures++;
  stats.errorsRedis++;
  if (CB.failures >= CB.failureThreshold && CB.openUntil === 0) {
    CB.openUntil = Date.now() + CB.openDurationMs;
    stats.circuitOpens++;
    // Loga só 1x por janela (evita spam no console)
    if (Date.now() - CB.lastOpenLog > 5000) {
      console.warn(
        `[cache] circuit ABERTO por ${CB.openDurationMs / 1000}s ` +
        `(${CB.failures} timeouts consecutivos) — operando só em L1`
      );
      CB.lastOpenLog = Date.now();
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[cache] ${label} timeout após ${ms}ms`)),
      ms
    );
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function estimateBytes(str) {
  // Aproximação UTF-8: ~2 bytes/char na média
  return str.length * 2;
}

// ─── LRU ────────────────────────────────────────────────────────────────────
function lruTouch(key) {
  const entry = localCache.get(key);
  if (!entry) return;
  localCache.delete(key);
  localCache.set(key, entry);
}

function lruEvictIfNeeded() {
  while (localCache.size > LOCAL_MAX_SIZE) {
    const oldestKey = localCache.keys().next().value;
    if (oldestKey === undefined) break;
    localCache.delete(oldestKey);
    stats.evictions++;
  }
}

// ─── helpers L1 ─────────────────────────────────────────────────────────────
function localGet(key) {
  const entry = localCache.get(key);
  if (!entry) {
    stats.misses++;
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    localCache.delete(key);
    stats.misses++;
    return null;
  }
  lruTouch(key);
  stats.hitsLocal++;
  return entry.value;
}

function localSet(key, value, expiresAt, sizeBytes) {
  if (sizeBytes > LOCAL_MAX_ENTRY_BYTES) return;
  localCache.set(key, { value, expiresAt, sizeBytes });
  lruTouch(key);
  lruEvictIfNeeded();
  stats.setsLocal++;
}

// ═════════════════════════════════════════════════════════════════════════════
// GET
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheGet(key) {
  if (redis && !circuitOpen()) {
    try {
      const raw = await withTimeout(redis.get(key), REDIS_OP_TIMEOUT_MS, 'get');
      recordSuccess();
      if (raw != null) {
        try {
          const parsed = JSON.parse(raw);
          stats.hitsRedis++;
          return parsed;
        } catch (parseErr) {
          stats.parseErrors++;
          console.warn(`[cache] JSON inválido em "${key}":`, parseErr.message);
          redis.del(key).catch(() => {});
        }
      }
    } catch (err) {
      recordFailure();
      // Loga só a PRIMEIRA falha do ciclo (evita spam)
      if (CB.failures === 1) {
        console.warn('[cache] get falhou, fallback L1:', err.message);
      }
    }
  } else if (redis && circuitOpen()) {
    stats.circuitSkips++;
  }

  return localGet(key);
}

// ═════════════════════════════════════════════════════════════════════════════
// SET (single key)
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  const jittered = Math.max(
    1_000,
    Math.round(ttlMs + (Math.random() * 0.3 - 0.15) * ttlMs)
  );

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    console.warn(`[cache] não serializável "${key}":`, err.message);
    return;
  }

  const sizeBytes = estimateBytes(serialized);

  if (redis && !circuitOpen()) {
    try {
      await withTimeout(
        redis.set(key, serialized, 'PX', jittered),
        REDIS_OP_TIMEOUT_MS,
        'set'
      );
      recordSuccess();
      stats.setsRedis++;
    } catch (err) {
      recordFailure();
      if (CB.failures === 1) {
        console.warn('[cache] set Redis falhou, mantendo só L1:', err.message);
      }
    }
  } else if (redis && circuitOpen()) {
    stats.circuitSkips++;
  }

  localSet(key, value, Date.now() + jittered, sizeBytes);
}

// ═════════════════════════════════════════════════════════════════════════════
// SET EM LOTE (pipeline — 1 round-trip para N SETs)
// ═════════════════════════════════════════════════════════════════════════════
// Usado pelo cacheFirst para gravar { stale, fresh } de uma vez.
// Sem isso, cada load gera 2 round-trips → 2 timeouts durante pico.
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheSetMany(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;

  const prepared = [];
  for (const { key, value, ttlMs = DEFAULT_TTL_MS } of entries) {
    try {
      const serialized = JSON.stringify(value);
      const sizeBytes = estimateBytes(serialized);
      const jittered = Math.max(
        1_000,
        Math.round(ttlMs + (Math.random() * 0.3 - 0.15) * ttlMs)
      );
      prepared.push({ key, serialized, jittered, value, sizeBytes });
    } catch (err) {
      console.warn(`[cache] setMany: não serializável "${key}":`, err.message);
    }
  }

  if (prepared.length === 0) return;

  if (redis && !circuitOpen()) {
    try {
      const pipeline = redis.pipeline();
      for (const e of prepared) {
        pipeline.set(e.key, e.serialized, 'PX', e.jittered);
      }
      await withTimeout(pipeline.exec(), REDIS_OP_TIMEOUT_MS, 'setMany');
      recordSuccess();
      stats.setsRedis += prepared.length;
    } catch (err) {
      recordFailure();
      if (CB.failures === 1) {
        console.warn('[cache] setMany Redis falhou, mantendo só L1:', err.message);
      }
    }
  } else if (redis && circuitOpen()) {
    stats.circuitSkips += prepared.length;
  }

  for (const e of prepared) {
    localSet(e.key, e.value, Date.now() + e.jittered, e.sizeBytes);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GET em lote (MGET — 1 round-trip para N GETs)
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheGetMany(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return {};
  const result = {};

  if (redis && !circuitOpen()) {
    try {
      const raws = await withTimeout(
        redis.mget(...keys),
        REDIS_OP_TIMEOUT_MS,
        'mget'
      );
      recordSuccess();
      raws.forEach((raw, i) => {
        if (raw == null) return;
        try {
          result[keys[i]] = JSON.parse(raw);
          stats.hitsRedis++;
        } catch {
          stats.parseErrors++;
          redis.del(keys[i]).catch(() => {});
        }
      });
    } catch (err) {
      recordFailure();
    }
  } else if (redis && circuitOpen()) {
    stats.circuitSkips += keys.length;
  }

  for (const key of keys) {
    if (key in result) continue;
    const entry = localCache.get(key);
    if (!entry) {
      stats.misses++;
      continue;
    }
    if (Date.now() > entry.expiresAt) {
      localCache.delete(key);
      stats.misses++;
      continue;
    }
    lruTouch(key);
    result[key] = entry.value;
    stats.hitsLocal++;
  }

  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// DELETE por key exata
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheDelete(key) {
  if (redis && !circuitOpen()) {
    try {
      await withTimeout(redis.del(key), REDIS_OP_TIMEOUT_MS, 'del');
      recordSuccess();
    } catch (err) {
      recordFailure();
      if (CB.failures === 1) {
        console.warn('[cache] delete falhou:', err.message);
      }
    }
  }
  localCache.delete(key);
}

// ═════════════════════════════════════════════════════════════════════════════
// DELETE por prefixo (SCAN — não bloqueia Redis)
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheDeleteByPrefix(prefix) {
  if (redis && !circuitOpen()) {
    try {
      let cursor = '0';
      let deleted = 0;
      do {
        const [next, keys] = await withTimeout(
          redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100),
          REDIS_OP_TIMEOUT_MS,
          'scan'
        );
        cursor = next;
        if (keys.length > 0) {
          await withTimeout(redis.del(...keys), REDIS_OP_TIMEOUT_MS, 'del');
          deleted += keys.length;
        }
      } while (cursor !== '0');
      recordSuccess();
      if (deleted > 0) {
        console.log(`[cache] deleteByPrefix "${prefix}" → ${deleted} keys no Redis`);
      }
    } catch (err) {
      recordFailure();
      if (CB.failures === 1) {
        console.warn('[cache] deleteByPrefix Redis falhou:', err.message);
      }
    }
  }

  // L1 limpa SEMPRE (mesmo se Redis falhou — L1 pode ter cópia stale)
  let localDeleted = 0;
  for (const k of [...localCache.keys()]) {
    if (k.startsWith(prefix)) {
      localCache.delete(k);
      localDeleted++;
    }
  }
  if (localDeleted > 0) {
    console.log(`[cache] deleteByPrefix "${prefix}" → ${localDeleted} keys no L1`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Key determinística
// ═════════════════════════════════════════════════════════════════════════════
export function cacheKeyOf(prefix, params) {
  const sorted = Object.keys(params || {})
    .sort()
    .reduce((acc, k) => {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') acc[k] = v;
      return acc;
    }, {});
  return `${prefix}:${JSON.stringify(sorted)}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Stats (usado por /api/health/warmup)
// ═════════════════════════════════════════════════════════════════════════════
export function cacheStats() {
  const total = stats.hitsRedis + stats.hitsLocal + stats.misses;
  const hitRatio =
    total > 0
      ? Number(((stats.hitsRedis + stats.hitsLocal) / total).toFixed(4))
      : null;

  let localBytes = 0;
  for (const entry of localCache.values()) localBytes += entry.sizeBytes || 0;

  return {
    redisConfigured: Boolean(redis),
    redisConnected: Boolean(redis && redis.status === 'ready'),
    localSize: localCache.size,
    localMaxSize: LOCAL_MAX_SIZE,
    localBytes,
    hitRatio,
    circuit: {
      open: circuitOpen(),
      failures: CB.failures,
      opens: stats.circuitOpens,
      skips: stats.circuitSkips,
    },
    counters: { ...stats },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Limpeza interna (graceful shutdown)
// ═════════════════════════════════════════════════════════════════════════════
export function cacheClearLocal() {
  localCache.clear();
}