// backend/services/inteComerceCache.js
const TTL_MS = 5 * 60_000;
const STALE_MS = 60 * 60_000;
const MAX_ENTRIES = 100;

const cache = new Map();
const inFlight = new Map();

function store(key, data) {
  cache.delete(key);
  cache.set(key, { data, at: Date.now(), refreshing: false });

  while (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

function load(key, fetcher) {
  const pending = inFlight.get(key);
  if (pending) return pending;

  const request = Promise.resolve()
    .then(fetcher)
    .then((data) => {
      store(key, data);
      return data;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

export async function cached(key, fetcher, options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const ttlMs = options.ttlMs ?? TTL_MS;
  const staleMs = options.staleMs ?? STALE_MS;

  // Manual refresh: ignora cache/entrada stale e dispara fetcher.
  // Se já existe request em voo para a mesma chave, reutiliza a
  // promessa (evita disparo duplicado quando o usuário clica 2x).
  if (forceRefresh) {
    return load(key, fetcher);
  }

  const entry = cache.get(key);
  const age = entry ? Date.now() - entry.at : Infinity;

  if (entry && age < ttlMs) return entry.data;

  if (entry && age < staleMs) {
    if (!entry.refreshing) {
      entry.refreshing = true;
      void load(key, fetcher).catch((error) => {
        entry.refreshing = false;
        console.error(
          '[inte-comerce-cache] Atualização em segundo plano falhou:',
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    return entry.data;
  }

  return load(key, fetcher);
}

/**
 * Invalida uma chave específica do cache. Útil para testes ou se
 * algum dia precisarmos expor um endpoint de invalidação.
 */
export function invalidate(key) {
  cache.delete(key);
}