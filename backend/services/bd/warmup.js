// backend/services/bd/warmup.js
// ─────────────────────────────────────────────────────────────────────────────
// Scheduler de warmup de cache.
//
// **NOVO PADRÃO (recomendado)**: registre `loader` como `() => loadX({ ...params,
// forceRefresh: true, priority: 'low' })`. O próprio loader (via cacheFirst)
// gerencia TTL/L1/L2 e refaz o pipeline. O warmup vira um "orquestrador"
// puro — só agenda, timeout, backoff e observabilidade.
//
// **LEGACY**: se você ainda tem um loader "cru" (que NÃO usa cacheFirst),
// registre com `cacheMode: 'cacheRefresh'` para que o warmup envolva com
// `cacheRefresh(job.key, job.loader, { ttlMs, staleMs })` como antes.
// ─────────────────────────────────────────────────────────────────────────────

import { cacheRefresh } from './cacheFirst.js';

const GLOBAL = {
  initialDelayMs: 2_000,
  initialDelayJitterMs: 1_000,
  intervalJitterPct: 0.10,
  jobTimeoutMs: 60_000,
  maxConcurrent: 5,
  maxBackoffMultiplier: 10,
};

const jobs = new Map();
const timers = new Map();
const slotQueue = [];
let globalRunning = 0;
let shuttingDown = false;

// ── Semáforo global ──────────────────────────────────────────────────────────
async function acquireSlot() {
  if (globalRunning < GLOBAL.maxConcurrent) {
    globalRunning++;
    return;
  }
  await new Promise(resolve => slotQueue.push(resolve));
}
function releaseSlot() {
  const next = slotQueue.shift();
  if (next) next();
  else globalRunning--;
}

// ── Timeout ──────────────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[warmup] ${label} timeout após ${ms}ms`));
    }, ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Backoff ──────────────────────────────────────────────────────────────────
function computeCurrentInterval(job) {
  if (job.consecutiveFailures === 0) return job.intervalMs;
  const multiplier = Math.min(job.consecutiveFailures, 5);
  const backoffMs = job.intervalMs * Math.pow(2, multiplier);
  const cap = job.intervalMs * GLOBAL.maxBackoffMultiplier;
  return Math.min(backoffMs, cap);
}

// ── Execução de um job ───────────────────────────────────────────────────────
async function executeJob(job) {
  if (job.running) return;
  if (shuttingDown) return;

  job.running = true;
  job.runCount++;
  await acquireSlot();

  const started = Date.now();
  try {
    const work = job.cacheMode === 'cacheRefresh'
      ? cacheRefresh(job.key, job.loader, {
          ttlMs: job.ttlMs ?? 60_000,
          staleMs: job.staleMs ?? 300_000,
        })
      : job.loader(); // ← loader self-cached (forceRefresh+low já embutido)

    await withTimeout(work, job.timeoutMs, `job=${job.name}`);

    job.lastRunAt = Date.now();
    job.lastDurationMs = job.lastRunAt - started;
    job.lastError = null;
    job.lastErrorMessage = null;
    job.consecutiveFailures = 0;
    job.successCount++;
  } catch (err) {
    job.lastRunAt = Date.now();
    job.lastDurationMs = job.lastRunAt - started;
    job.lastError = Date.now();
    job.lastErrorMessage = err?.message || String(err);
    job.consecutiveFailures++;
    job.failureCount++;
    console.error(
      `[warmup:${job.name}] falha #${job.consecutiveFailures}: ${job.lastErrorMessage}`
    );
  } finally {
    job.running = false;
    releaseSlot();
  }
}

// ── Agendamento recursivo ────────────────────────────────────────────────────
function scheduleNext(job) {
  if (shuttingDown) return;
  const base = computeCurrentInterval(job);
  const jitter = base * (Math.random() * 2 - 1) * GLOBAL.intervalJitterPct;
  const delay = Math.max(1_000, Math.round(base + jitter));
  const timer = setTimeout(() => {
    executeJob(job).finally(() => scheduleNext(job));
  }, delay);
  if (timer.unref) timer.unref();
  timers.set(job.name, timer);
}

// ═════════════════════════════════════════════════════════════════════════════
// API pública
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Registra um job.
 *
 * Novo padrão (loaders self-cached):
 *   registerWarmup('emitidos:prod', {
 *     key: 'emitidos:prod',           // label de observabilidade
 *     loader: () => loadEmitidos({
 *       start, end, equipe, produto, mode: 'producao',
 *       forceRefresh: true, priority: 'low',
 *     }),
 *     intervalMs: 120_000,
 *   });
 *
 * Legacy (loader cru, sem cacheFirst interno):
 *   registerWarmup('raw', {
 *     key: 'raw:...',
 *     loader: () => db.query(sql),
 *     ttlMs: 60_000, staleMs: 300_000,
 *     intervalMs: 60_000,
 *     cacheMode: 'cacheRefresh',
 *   });
 *
 * @param {string} name
 * @param {{
 *   key: string,
 *   loader: () => Promise<any>,
 *   intervalMs: number,
 *   timeoutMs?: number,
 *   enabled?: boolean,
 *   cacheMode?: 'loader' | 'cacheRefresh',   // default: 'loader'
 *   ttlMs?: number,                          // obrigatório só em 'cacheRefresh'
 *   staleMs?: number,                        // idem
 * }} cfg
 */
export function registerWarmup(name, cfg) {
  if (typeof name !== 'string' || !name) {
    throw new Error('[warmup] name deve ser uma string não-vazia');
  }
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`[warmup:${name}] cfg é obrigatório`);
  }
  if (typeof cfg.key !== 'string' || !cfg.key) {
    throw new Error(`[warmup:${name}] key é obrigatória`);
  }
  if (typeof cfg.loader !== 'function') {
    throw new Error(`[warmup:${name}] loader deve ser função`);
  }
  if (!Number.isFinite(cfg.intervalMs) || cfg.intervalMs <= 0) {
    throw new Error(`[warmup:${name}] intervalMs inválido`);
  }

  const cacheMode = cfg.cacheMode ?? 'loader';
  if (cacheMode === 'cacheRefresh') {
    if (!Number.isFinite(cfg.ttlMs) || cfg.ttlMs <= 0) {
      throw new Error(`[warmup:${name}] ttlMs é obrigatório com cacheMode='cacheRefresh'`);
    }
  }

  if (cfg.enabled === false) return;

  const previous = jobs.get(name);
  if (previous) {
    const t = timers.get(name);
    if (t) clearTimeout(t);
    timers.delete(name);
  }

  const job = {
    name,
    key: cfg.key,
    loader: cfg.loader,
    cacheMode,
    ttlMs: cfg.ttlMs ?? null,
    staleMs: cfg.staleMs ?? null,
    intervalMs: cfg.intervalMs,
    timeoutMs: cfg.timeoutMs ?? GLOBAL.jobTimeoutMs,

    running: false,
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    lastRunAt: 0,
    lastDurationMs: 0,
    lastError: null,
    lastErrorMessage: null,
  };

  jobs.set(name, job);

  const initialDelay = GLOBAL.initialDelayMs + Math.random() * GLOBAL.initialDelayJitterMs;
  const timer = setTimeout(() => {
    executeJob(job).finally(() => scheduleNext(job));
  }, initialDelay);
  if (timer.unref) timer.unref();
  timers.set(name, timer);
}

export async function runWarmupNow(name) {
  const job = jobs.get(name);
  if (!job) throw new Error(`[warmup] job desconhecido: ${name}`);
  await executeJob(job);
}

export function getWarmupStatus() {
  const now = Date.now();
  const out = [];
  for (const job of jobs.values()) {
    const ageMs = job.lastRunAt ? now - job.lastRunAt : null;
    const threshold = job.intervalMs * 2;

    let health;
    if (shuttingDown) health = 'idle';
    else if (job.running) health = 'running';
    else if (!job.lastRunAt) health = 'idle';
    else if (job.consecutiveFailures >= 3) health = 'failing';
    else if (ageMs > threshold) health = 'degraded';
    else health = 'healthy';

    out.push({
      name: job.name,
      key: job.key,
      cacheMode: job.cacheMode,
      intervalMs: job.intervalMs,
      currentIntervalMs: computeCurrentInterval(job),
      health,
      lastRunAt: job.lastRunAt ? new Date(job.lastRunAt).toISOString() : null,
      ageMs,
      lastDurationMs: job.lastDurationMs,
      lastError: job.lastErrorMessage,
      consecutiveFailures: job.consecutiveFailures,
      runCount: job.runCount,
      successCount: job.successCount,
      failureCount: job.failureCount,
      running: job.running,
    });
  }
  const order = { failing: 0, degraded: 1, running: 2, idle: 3, healthy: 4 };
  out.sort((a, b) => (order[a.health] ?? 9) - (order[b.health] ?? 9));
  return out;
}

export async function stopAllWarmup({ drainMs = 5_000 } = {}) {
  shuttingDown = true;
  console.log('[warmup] iniciando shutdown...');
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  const start = Date.now();
  while (Date.now() - start < drainMs) {
    if (![...jobs.values()].some(j => j.running)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const stragglers = [...jobs.values()].filter(j => j.running).length;
  if (stragglers > 0) {
    console.warn(`[warmup] ${stragglers} job(s) ainda em execução após ${drainMs}ms`);
  }
  jobs.clear();
  console.log('[warmup] scheduler encerrado');
}

export function resetWarmupScheduler() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  jobs.clear();
  slotQueue.length = 0;
  globalRunning = 0;
  shuttingDown = false;
}