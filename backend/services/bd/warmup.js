// backend/services/bd/warmup.js
// ─────────────────────────────────────────────────────────────────────────────
// Scheduler de warmup de cache.
//
// Cada job:
//   • Roda UMA vez logo após o boot (após delay + jitter, para não colidir
//     com os outros jobs no mesmo segundo).
//   • Repete a cada `intervalMs` com ±jitter (carga espalhada no DB).
//   • Tem HARD TIMEOUT — job travado não bloqueia o loop.
//   • Aplica BACKOFF EXPONENCIAL em falhas consecutivas (até 10× o interval).
//   • Respeita limite GLOBAL DE CONCORRÊNCIA (semáforo).
//   • É AGENDADO APÓS o término da execução anterior — sem sobreposição.
//
// Ciclo de vida:
//   registerWarmup(name, cfg)   → registra + agenda primeira execução
//   runWarmupNow(name)          → força execução imediata (ops/migração)
//   getWarmupStatus()           → snapshot para /health/warmup
//   stopAllWarmup({ drainMs })  → interrompe agendamento + aguarda in-flight
//   resetWarmupScheduler()      → limpa estado (para testes)
// ─────────────────────────────────────────────────────────────────────────────

import { cacheRefresh } from './cacheFirst.js';

// ─── Configuração global (sobrescreva via registerWarmup) ────────────────────
const GLOBAL = {
  initialDelayMs: 2_000,
  initialDelayJitterMs: 1_000,
  intervalJitterPct: 0.10, // ±10% no intervalMs
  jobTimeoutMs: 60_000,
  maxConcurrent: 5,
  maxBackoffMultiplier: 10,
};

// ─── Estado ──────────────────────────────────────────────────────────────────
const jobs = new Map();         // name → job
const timers = new Map();       // name → timeout handle
const slotQueue = [];           // waiters do semáforo global
let globalRunning = 0;
let shuttingDown = false;

// ═════════════════════════════════════════════════════════════════════════════
// Semáforo global (protege o DB de N jobs simultâneos)
// ═════════════════════════════════════════════════════════════════════════════
async function acquireSlot() {
  if (globalRunning < GLOBAL.maxConcurrent) {
    globalRunning++;
    return;
  }
  await new Promise(resolve => slotQueue.push(resolve));
  // Slot foi transferido diretamente — não precisa incrementar.
}

function releaseSlot() {
  const next = slotQueue.shift();
  if (next) {
    // Transfere o slot direto — globalRunning fica inalterado
    next();
  } else {
    globalRunning--;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Timeout com limpeza correta (não vaza timer nem deixa promise órfã)
// ═════════════════════════════════════════════════════════════════════════════
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

// ═════════════════════════════════════════════════════════════════════════════
// Cálculo do próximo interval (base + backoff)
// ═════════════════════════════════════════════════════════════════════════════
function computeCurrentInterval(job) {
  if (job.consecutiveFailures === 0) return job.intervalMs;
  const multiplier = Math.min(job.consecutiveFailures, 5); // até 32×
  const backoffMs = job.intervalMs * Math.pow(2, multiplier);
  const cap = job.intervalMs * GLOBAL.maxBackoffMultiplier;
  return Math.min(backoffMs, cap);
}

// ═════════════════════════════════════════════════════════════════════════════
// Execução de um job (isolada — não mexe no agendamento)
// ═════════════════════════════════════════════════════════════════════════════
async function executeJob(job) {
  if (job.running) {
    // Já em execução (manual trigger durante run agendado) — ignora
    return;
  }
  if (shuttingDown) return;

  job.running = true;
  job.runCount++;
  await acquireSlot();

  const started = Date.now();
  try {
    await withTimeout(
      cacheRefresh(job.key, job.loader, {
        ttlMs: job.ttlMs,
        staleMs: job.staleMs,
      }),
      job.timeoutMs,
      `job=${job.name}`
    );

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

// ═════════════════════════════════════════════════════════════════════════════
// Agendamento recursivo (próximo run só depois do atual terminar)
// ═════════════════════════════════════════════════════════════════════════════
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
 * Registra um job. Se já existir, é substituído (registrar de novo é
 * idempotente — útil em hot-reload de dev).
 *
 * @param {string} name
 * @param {{
 *   key: string,
 *   loader: () => Promise<any>,
 *   ttlMs: number,
 *   staleMs?: number,
 *   intervalMs: number,
 *   timeoutMs?: number,
 *   enabled?: boolean,
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
  if (!Number.isFinite(cfg.ttlMs) || cfg.ttlMs <= 0) {
    throw new Error(`[warmup:${name}] ttlMs inválido`);
  }
  if (cfg.enabled === false) {
    return;
  }

  // Cancela o anterior se já existia (hot-reload)
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
    ttlMs: cfg.ttlMs,
    staleMs: cfg.staleMs ?? Math.max(cfg.ttlMs * 5, 300_000),
    intervalMs: cfg.intervalMs,
    timeoutMs: cfg.timeoutMs ?? GLOBAL.jobTimeoutMs,

    // Estado observável
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

  // Primeira execução: delay + jitter inicial para espalhar o boot
  const initialDelay =
    GLOBAL.initialDelayMs + Math.random() * GLOBAL.initialDelayJitterMs;
  const timer = setTimeout(() => {
    executeJob(job).finally(() => scheduleNext(job));
  }, initialDelay);
  if (timer.unref) timer.unref();
  timers.set(name, timer);
}

/**
 * Força execução imediata (ignora agendamento e backoff).
 * Útil após migração de dados ou intervenção de ops.
 *
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function runWarmupNow(name) {
  const job = jobs.get(name);
  if (!job) {
    throw new Error(`[warmup] job desconhecido: ${name}`);
  }
  await executeJob(job);
}

/**
 * Status completo — use em /health/warmup.
 *
 * @returns {Array<{
 *   name: string,
 *   key: string,
 *   intervalMs: number,
 *   currentIntervalMs: number,
 *   health: 'healthy' | 'degraded' | 'failing' | 'running' | 'idle',
 *   lastRunAt: string | null,
 *   ageMs: number | null,
 *   lastDurationMs: number,
 *   lastError: string | null,
 *   consecutiveFailures: number,
 *   runCount: number,
 *   successCount: number,
 *   failureCount: number,
 *   running: boolean,
 * }>}
 */
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
  // Ordena por "mais problemáticos primeiro"
  const order = { failing: 0, degraded: 1, running: 2, idle: 3, healthy: 4 };
  out.sort((a, b) => (order[a.health] ?? 9) - (order[b.health] ?? 9));
  return out;
}

/**
 * Encerra o scheduler.
 *
 * - Cancela todos os timers (nenhum job novo é agendado)
 * - Aguarda jobs em execução terminarem até `drainMs`
 * - Após o drain, libera as referências
 *
 * Deve ser chamado no SIGTERM/SIGINT do server.js.
 *
 * @param {{ drainMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export async function stopAllWarmup({ drainMs = 5_000 } = {}) {
  shuttingDown = true;
  console.log('[warmup] iniciando shutdown...');

  // 1. Cancela todos os timers
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();

  // 2. Aguarda in-flight terminarem (com timeout)
  const start = Date.now();
  while (Date.now() - start < drainMs) {
    const stillRunning = [...jobs.values()].some(j => j.running);
    if (!stillRunning) break;
    await new Promise(r => setTimeout(r, 100));
  }

  const stragglers = [...jobs.values()].filter(j => j.running).length;
  if (stragglers > 0) {
    console.warn(
      `[warmup] ${stragglers} job(s) ainda em execução após ${drainMs}ms de drain — prosseguindo`
    );
  }

  jobs.clear();
  console.log('[warmup] scheduler encerrado');
}

/**
 * Reset completo (apenas para testes).
 * NÃO use em produção.
 */
export function resetWarmupScheduler() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  jobs.clear();
  slotQueue.length = 0;
  globalRunning = 0;
  shuttingDown = false;
}