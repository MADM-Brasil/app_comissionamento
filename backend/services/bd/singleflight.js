// backend/services/bd/singleflight.js
// ─────────────────────────────────────────────────────────────────────────────
// Deduplicação de promises concorrentes por chave.
//
// Semântica:
//   singleflight('K', fn) chamado N vezes em paralelo:
//     → fn() executa UMA vez
//     → as N chamadas recebem a MESMA promise (mesmo valor OU mesmo erro)
//
// Garantias:
//   • Se fn() resolver, todas as N chamadas recebem o valor.
//   • Se fn() rejeitar, todas as N chamadas recebem o MESMO erro.
//     (não há retry automático — backoff é responsabilidade do caller)
//   • A entrada é removida do Map após a promise resolver/rejeitar (finally).
//     Novas chamadas começam uma nova execução.
//
// NÃO faz (por design — separação de responsabilidades):
//   • Timeout           → cada loader tem seu próprio (statement_timeout no DB,
//                          ou timeout no warmup.js). Adicionar timeout aqui
//                          criaria race com o do banco.
//   • Retry             → cacheFirst/warmup tratam backoff.
//   • Cancelamento      → promises não são canceláveis em JS.
//
// Observabilidade:
//   • singleflightSize()   → quantas keys estão em voo agora
//   • singleflightStats()  → snapshot completo para /health/warmup
// ─────────────────────────────────────────────────────────────────────────────

// key → { promise, startedAt, waiters }
const inflight = new Map();

const stats = {
  totalExecutions: 0,     // quantas vezes fn() de fato rodou
  totalDeduplications: 0, // quantas chamadas extras foram deduplicadas
  totalErrors: 0,
  peakInflight: 0,        // maior número de keys simultâneas já observado
};

/**
 * Executa `fn` deduplicando chamadas concorrentes na mesma `key`.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function singleflight(key, fn) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('[singleflight] key deve ser uma string não-vazia');
  }
  if (typeof fn !== 'function') {
    throw new Error(`[singleflight] fn deve ser função (key="${key}")`);
  }

  const existing = inflight.get(key);
  if (existing) {
    existing.waiters++;
    stats.totalDeduplications++;
    return existing.promise;
  }

  stats.totalExecutions++;

  const entry = {
    startedAt: Date.now(),
    waiters: 1,
    promise: null,
  };

  entry.promise = (async () => {
    try {
      return await fn();
    } catch (err) {
      stats.totalErrors++;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, entry);

  if (inflight.size > stats.peakInflight) {
    stats.peakInflight = inflight.size;
  }

  return entry.promise;
}

/**
 * Quantas keys estão em execução agora (para health checks rápidos).
 */
export function singleflightSize() {
  return inflight.size;
}

/**
 * Snapshot completo — use em /health/warmup.
 *
 * `keys[].ageMs` é o principal indicador de loader travado:
 *   • ageMs < 10s    → normal
 *   • ageMs 10–60s   → degradado (loader lento)
 *   • ageMs > 60s    → travado (investigar — pode ser lock no Postgres)
 *
 * @returns {{
 *   inflight: number,
 *   keys: Array<{ key: string, waiters: number, ageMs: number }>,
 *   counters: { totalExecutions: number, totalDeduplications: number,
 *               totalErrors: number, peakInflight: number },
 * }}
 */
export function singleflightStats() {
  const now = Date.now();
  const keys = [];
  for (const [key, entry] of inflight) {
    keys.push({
      key,
      waiters: entry.waiters,
      ageMs: now - entry.startedAt,
    });
  }
  // Mais antigas primeiro — as suspeitas
  keys.sort((a, b) => b.ageMs - a.ageMs);
  return {
    inflight: inflight.size,
    keys,
    counters: { ...stats },
  };
}

/**
 * Reset de contadores (útil em testes; inofensivo em produção).
 * Não afeta promises em voo — só os números agregados.
 */
export function singleflightResetStats() {
  stats.totalExecutions = 0;
  stats.totalDeduplications = 0;
  stats.totalErrors = 0;
  stats.peakInflight = 0;
}