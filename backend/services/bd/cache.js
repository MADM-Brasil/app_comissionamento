// backend/services/bd/cache.js
// ─────────────────────────────────────────────────────────────────────────────
// Cache híbrido Redis + memória local (L1).
//
// Interface pública:
//   cacheGet(key)                  → value | null
//   cacheSet(key, value, ttlMs)    → void
//   cacheGetMany(keys)             → { [key]: value }
//   cacheDelete(key)               → void
//   cacheDeleteByPrefix(prefix)    → void
//   cacheKeyOf(prefix, params)     → string   (key determinística)
//   cacheStats()                   → { ...contadores, hitRatio, ... }
//   cacheClearLocal()              → void     (usado no shutdown)
//
// Comportamento:
//   • Redis up      → Redis é a fonte primária; L1 também é populado (fallback).
//   • Redis down    → L1 responde; requests não travam (timeout de 800ms/op).
//   • Redis cai     → L1 já tem cópia recente (populado no último cacheSet).
//   • Valor corrompido no Redis → é descartado e L1 responde.
//
// Compatível com cacheFirst.js (importa cacheGet, cacheSet).
// ─────────────────────────────────────────────────────────────────────────────

import { redis } from './redis.js';

const DEFAULT_TTL_MS = 60_000;
const LOCAL_MAX_SIZE = 500;
const LOCAL_MAX_ENTRY_BYTES = 512 * 1024; // 512 KB por entrada
const REDIS_OP_TIMEOUT_MS = 800;          // timeout por comando Redis

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
};

// ─── Timeout para operações Redis ────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`[cache] ${label} timeout após ${ms}ms`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Estimativa de tamanho em bytes ─────────────────────────────────────────
function estimateBytes(str) {
  // Aproximação conservadora: UTF-8, ~2 bytes/char na média.
  return str.length * 2;
}

// ─── LRU: move a key para o final (mais recente) ────────────────────────────
function lruTouch(key) {
  const entry = localCache.get(key);
  if (!entry) return;
  localCache.delete(key);
  localCache.set(key, entry);
}

// ─── LRU: evict do mais antigo quando estoura capacidade ────────────────────
function lruEvictIfNeeded() {
  while (localCache.size > LOCAL_MAX_SIZE) {
    const oldestKey = localCache.keys().next().value;
    if (oldestKey === undefined) break;
    localCache.delete(oldestKey);
    stats.evictions++;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GET
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheGet(key) {
  // 1. Redis primeiro
  if (redis) {
    try {
      const raw = await withTimeout(redis.get(key), REDIS_OP_TIMEOUT_MS, 'get');
      if (raw != null) {
        try {
          const parsed = JSON.parse(raw);
          stats.hitsRedis++;
          return parsed;
        } catch (parseErr) {
          stats.parseErrors++;
          console.warn(`[cache] JSON inválido em "${key}":`, parseErr.message);
          // Descarta a entrada corrompida
          redis.del(key).catch(() => {});
        }
      }
    } catch (err) {
      stats.errorsRedis++;
      console.warn('[cache] get falhou, tentando L1:', err.message);
    }
  }

  // 2. L1
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

// ═════════════════════════════════════════════════════════════════════════════
// SET
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  // Jitter de ±15% evita expiração simultânea após o warmup.
  // TTL mínimo de 1s para não criar entradas praticamente inválidas.
  const jittered = Math.max(
    1_000,
    Math.round(ttlMs + (Math.random() * 0.3 - 0.15) * ttlMs)
  );

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    console.warn(`[cache] não foi possível serializar "${key}":`, err.message);
    return;
  }

  const sizeBytes = estimateBytes(serialized);

  // 1. Redis (sempre, quando disponível)
  if (redis) {
    try {
      await withTimeout(
        redis.set(key, serialized, 'PX', jittered),
        REDIS_OP_TIMEOUT_MS,
        'set'
      );
      stats.setsRedis++;
    } catch (err) {
      stats.errorsRedis++;
      console.warn('[cache] set Redis falhou, mantendo só L1:', err.message);
    }
  }

  // 2. L1 (SEMPRE) — garante fallback real se Redis cair depois.
  //    Valores acima do limite ficam apenas no Redis.
  if (sizeBytes <= LOCAL_MAX_ENTRY_BYTES) {
    localCache.set(key, {
      value,
      expiresAt: Date.now() + jittered,
      sizeBytes,
    });
    lruTouch(key);
    lruEvictIfNeeded();
    stats.setsLocal++;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GET em lote (usa MGET — 1 round-trip para N keys)
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheGetMany(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return {};

  const result = {};

  if (redis) {
    try {
      const raws = await withTimeout(
        redis.mget(...keys),
        REDIS_OP_TIMEOUT_MS,
        'mget'
      );
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
      stats.errorsRedis++;
      console.warn('[cache] mget falhou:', err.message);
    }
  }

  // Completa com L1 o que faltou
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
// DELETE por key exata (Redis + L1)
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheDelete(key) {
  if (redis) {
    try {
      await withTimeout(redis.del(key), REDIS_OP_TIMEOUT_MS, 'del');
    } catch (err) {
      stats.errorsRedis++;
      console.warn('[cache] delete falhou:', err.message);
    }
  }
  localCache.delete(key);
}

// ═════════════════════════════════════════════════════════════════════════════
// DELETE por prefixo (Redis + L1)
// ─────────────────────────────────────────────────────────────────────────────
// SCAN garante que não bloqueia o Redis (diferente de KEYS *).
// Pode retornar a mesma key em iterações diferentes — DEL nisso é no-op.
// ═════════════════════════════════════════════════════════════════════════════
export async function cacheDeleteByPrefix(prefix) {
  if (redis) {
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
      if (deleted > 0) {
        console.log(`[cache] deleteByPrefix "${prefix}" → ${deleted} keys no Redis`);
      }
    } catch (err) {
      stats.errorsRedis++;
      console.warn('[cache] deleteByPrefix Redis falhou:', err.message);
    }
  }

  // L1 sempre limpa — mesmo se Redis falhou, L1 pode ter cópia stale
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
// Stats / observabilidade (usado por /health/warmup)
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
    counters: { ...stats },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Limpeza interna (graceful shutdown)
// ═════════════════════════════════════════════════════════════════════════════
export function cacheClearLocal() {
  localCache.clear();
}