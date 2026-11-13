// backend/services/cache.js
// ─────────────────────────────────────────────────────────────────────────────
// Cache híbrido Redis + memória local.
//
// Comportamento:
//   • Redis disponível  → usa Redis (cache compartilhado entre instâncias).
//   • Redis indisponível → cai para Map em memória (funciona, mas isolado).
//   • Jitter de ±15% no TTL evita thundering herd.
//
// Todas as funções são async para funcionar com Redis.
// ─────────────────────────────────────────────────────────────────────────────

import { redis } from './redis.js';

const DEFAULT_TTL_MS = 60_000;
const LOCAL_MAX_SIZE = 500;

const localCache = new Map();

// ─── GET ─────────────────────────────────────────────────────────────────────
export async function cacheGet(key) {
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.warn('[cache] get falhou, fallback local:', err.message);
    }
  }

  const entry = localCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    localCache.delete(key);
    return null;
  }
  return entry.value;
}

// ─── SET ─────────────────────────────────────────────────────────────────────
export async function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  // Jitter: ±15% no TTL para evitar que N caches expirem no mesmo segundo
  const jittered = Math.round(ttlMs + (Math.random() * 0.3 - 0.15) * ttlMs);

  if (redis) {
    try {
      await redis.set(key, JSON.stringify(value), 'PX', jittered);
      return;
    } catch (err) {
      console.warn('[cache] set falhou, fallback local:', err.message);
    }
  }

  localCache.set(key, { value, expiresAt: Date.now() + jittered });
  if (localCache.size > LOCAL_MAX_SIZE) {
    localCache.delete(localCache.keys().next().value);
  }
}

// ─── DELETE por prefixo ──────────────────────────────────────────────────────
export async function cacheDeleteByPrefix(prefix) {
  if (redis) {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(
          cursor,
          'MATCH', `${prefix}*`,
          'COUNT', 100
        );
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
      return;
    } catch (err) {
      console.warn('[cache] deleteByPrefix falhou:', err.message);
    }
  }

  for (const k of [...localCache.keys()]) {
    if (k.startsWith(prefix)) localCache.delete(k);
  }
}

// ─── Key determinística ──────────────────────────────────────────────────────
export function cacheKeyOf(prefix, params) {
  const sorted = Object.keys(params || {}).sort().reduce((acc, k) => {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') acc[k] = v;
    return acc;
  }, {});
  return `${prefix}:${JSON.stringify(sorted)}`;
}

// ─── Stats ───────────────────────────────────────────────────────────────────
export function cacheStats() {
  return {
    redisConnected: Boolean(redis && redis.status === 'ready'),
    localSize: localCache.size,
  };
}