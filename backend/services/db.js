// backend/services/db.js
// ─────────────────────────────────────────────────────────────────────────────
// Pool PostgreSQL com 3 pools separados por tipo de carga:
//   • pool            → API geral (login, suporte, colaboradores) — rápido
//   • analyticsPool   → /metrics/* (dashboard, comissões) — lento, isolado
//   • sessionsPool    → PostgreSqlSessionStore — frequente, curto
//
// Por que pools separados?
//   Uma query lenta de /metrics/ganhos não pode consumir os slots do pool
//   que serve /api/auth/me, /suporte/* e movimentação de leads. Isolar
//   evita que um pico de dashboard derrube o sistema inteiro.
//
// Compatibilidade com `metrics.js`:
//   O `metrics.js` atual usa `import db from './db.js'` e `db.query(...)`.
//   O default export abaixo roteia `query` para o analyticsPool para que
//   esse arquivo funcione SEM precisar mudar. Se outro arquivo um dia
//   usar `import db from './db.js'` e esperar o pool principal, troque
//   para o import nomeado: `import { pool } from './db.js'`.
// ─────────────────────────────────────────────────────────────────────────────

import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

// ─── helpers de env ──────────────────────────────────────────────────────────
const numericEnv = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const boolEnv = (name, fallback = false) => {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
};

// ─── configuração base da conexão ────────────────────────────────────────────
const connectionString = process.env.DATABASE_URL;

let dbConfig;
if (connectionString) {
  // Se DATABASE_URL existe, usa ela. SSL controlado por DB_SSL.
  const useSSL = process.env.DB_SSL === 'true';
  dbConfig = {
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
  };
} else {
  // Desenvolvimento local — monta a partir de variáveis individuais.
  const dbPassword = process.env.DB_PASSWORD || '';
  if (typeof dbPassword !== 'string') {
    console.error('❌ DB_PASSWORD não é uma string:', typeof dbPassword);
    process.exit(1);
  }

  dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: dbPassword,
    database: process.env.DB_NAME || 'madm',
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  };
}

const LOG_CONNECTIONS = boolEnv('DB_LOG_CONNECTIONS', false);

// ═════════════════════════════════════════════════════════════════════════════
// POOL PRINCIPAL — API geral
// ═════════════════════════════════════════════════════════════════════════════
export const pool = new Pool({
  ...dbConfig,
  max: numericEnv('DB_POOL_MAX', 20),
  idleTimeoutMillis: numericEnv('DB_IDLE_TIMEOUT_MS', 30_000),
  connectionTimeoutMillis: numericEnv('DB_CONNECTION_TIMEOUT_MS', 10_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: 'madm-api',

  // Guardas de execução (podem ser sobrescritas por env).
  statement_timeout: numericEnv('DB_STATEMENT_TIMEOUT_MS', 60_000),
  query_timeout: numericEnv('DB_QUERY_TIMEOUT_MS', 60_000),
});

pool.on('connect', (client) => {
  if (LOG_CONNECTIONS) console.log('✅ [db:api] nova conexão');
  // Listener por cliente: erros em queries deste cliente não derrubam o pool.
  client.on('error', (err) => {
    if (LOG_CONNECTIONS) console.error('❌ [db:api] erro no cliente:', err.message);
  });
});

// Sem este handler, uma conexão idle que cai (restart do PG, firewall,
// timeout de NAT) gera unhandledRejection e derruba o processo.
pool.on('error', (err) => {
  console.warn('[db:api] erro em conexão idle:', err?.message || err);
});

// ═════════════════════════════════════════════════════════════════════════════
// POOL DE ANALYTICS — /metrics/*
// ═════════════════════════════════════════════════════════════════════════════
export const analyticsPool = new Pool({
  ...dbConfig,
  max: numericEnv('DB_ANALYTICS_POOL_MAX', 3),
  idleTimeoutMillis: numericEnv('DB_ANALYTICS_IDLE_TIMEOUT_MS', 60_000),
  connectionTimeoutMillis: numericEnv('DB_ANALYTICS_CONNECTION_TIMEOUT_MS', 15_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: 'madm-analytics',

  // Analytics é inerentemente lento. Timeout maior para não abortar
  // relatórios legítimos, mas ainda finito para não travar para sempre.
  statement_timeout: numericEnv('DB_ANALYTICS_STATEMENT_TIMEOUT_MS', 180_000),
  query_timeout: numericEnv('DB_ANALYTICS_QUERY_TIMEOUT_MS', 180_000),
});

analyticsPool.on('connect', (client) => {
  if (LOG_CONNECTIONS) console.log('✅ [db:analytics] nova conexão');
  client.on('error', (err) => {
    if (LOG_CONNECTIONS) console.error('❌ [db:analytics] erro no cliente:', err.message);
  });
});

analyticsPool.on('error', (err) => {
  console.warn('[db:analytics] erro em conexão idle:', err?.message || err);
});

// ═════════════════════════════════════════════════════════════════════════════
// POOL DE SESSIONS — PostgreSqlSessionStore
// ═════════════════════════════════════════════════════════════════════════════
export const sessionsPool = new Pool({
  ...dbConfig,
  max: numericEnv('DB_SESSIONS_POOL_MAX', 2),
  idleTimeoutMillis: numericEnv('DB_SESSIONS_IDLE_TIMEOUT_MS', 30_000),
  connectionTimeoutMillis: numericEnv('DB_SESSIONS_CONNECTION_TIMEOUT_MS', 10_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: 'madm-sessions',

  // Sessions são consultas curtas (SELECT/UPDATE em sessoes_app).
  // Timeout baixo para não empilhar conexões.
  statement_timeout: numericEnv('DB_SESSIONS_STATEMENT_TIMEOUT_MS', 15_000),
  query_timeout: numericEnv('DB_SESSIONS_QUERY_TIMEOUT_MS', 15_000),
});

sessionsPool.on('connect', (client) => {
  if (LOG_CONNECTIONS) console.log('✅ [db:sessions] nova conexão');
  client.on('error', (err) => {
    if (LOG_CONNECTIONS) console.error('❌ [db:sessions] erro no cliente:', err.message);
  });
});

sessionsPool.on('error', (err) => {
  console.warn('[db:sessions] erro em conexão idle:', err?.message || err);
});

// ─── waitForDatabase ────────────────────────────────────────────────────────
// Em produção: retry infinito (orquestrador reinicia o container se travar).
// Em dev: 6 tentativas (~30s) para falhar rápido e mostrar o erro real.
export async function waitForDatabase({
  retryDelayMs = 5000,
  maxAttempts = process.env.NODE_ENV === 'production' ? Infinity : 6,
} = {}) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) {
        console.log(`✅ Banco disponível após ${attempt} tentativa(s).`);
      }
      return;
    } catch (error) {
      console.error(
        `❌ Banco indisponível (tentativa ${attempt}). Nova tentativa em ${retryDelayMs} ms: ${error.message}`
      );
      if (attempt >= maxAttempts) {
        throw new Error(`Banco inacessível após ${attempt} tentativa(s): ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

// ─── helpers de query ───────────────────────────────────────────────────────
export const query = (text, params) => pool.query(text, params);
export const analyticsQuery = (text, params) => analyticsPool.query(text, params);

// ─── withPoolClient — conexão dedicada com timeout duro ─────────────────────
// Use em qualquer lugar que precise de uma transação real. Garante que
// o client seja liberado mesmo em erro e que a espera no connect() não
// seja infinita.
export async function withPoolClient(fn, { timeoutMs = 15_000, label = 'db', which = 'api' } = {}) {
  const targetPool = which === 'analytics' ? analyticsPool
                   : which === 'sessions'  ? sessionsPool
                   : pool;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[db] connect timeout (${label}) após ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const client = await Promise.race([targetPool.connect(), timeout]).finally(() => clearTimeout(timer));

  try {
    return await fn(client);
  } finally {
    try { client.release(); } catch (e) {
      console.warn(`[db] release falhou (${label}):`, e?.message || e);
    }
  }
}

// ─── poolStats — para /health/db ────────────────────────────────────────────
export function poolStats() {
  return {
    api: {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: pool.options.max,
    },
    analytics: {
      total: analyticsPool.totalCount,
      idle: analyticsPool.idleCount,
      waiting: analyticsPool.waitingCount,
      max: analyticsPool.options.max,
    },
    sessions: {
      total: sessionsPool.totalCount,
      idle: sessionsPool.idleCount,
      waiting: sessionsPool.waitingCount,
      max: sessionsPool.options.max,
    },
  };
}

// ─── pingDb — para /health/db ───────────────────────────────────────────────
export async function pingDb(timeoutMs = 5000) {
  const started = Date.now();
  try {
    await withPoolClient(
      (c) => c.query('SELECT 1'),
      { timeoutMs, label: 'ping', which: 'api' }
    );
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: err?.message || String(err) };
  }
}

// ─── logDatabaseAccess — diagnóstico do boot ────────────────────────────────
export const logDatabaseAccess = async () => {
  const result = await pool.query(`
    SELECT current_database() AS db,
           current_user AS db_user,
           has_schema_privilege(current_user, 'core', 'USAGE') AS core_usage,
           has_table_privilege(current_user, 'core.view_app_colaboradores', 'SELECT') AS colaboradores_select
  `);
  const schemaResult = await pool.query('SHOW search_path');
  const details = result.rows[0];

  console.log('🔎 [DB DEBUG] database:', details.db);
  console.log('🔎 [DB DEBUG] user:', details.db_user);
  console.log('🔎 [DB DEBUG] core USAGE:', details.core_usage);
  console.log('🔎 [DB DEBUG] view SELECT:', details.colaboradores_select);
  console.log('🔎 [DB DEBUG] search_path:', schemaResult.rows[0].search_path);
};

// ─── closePool — encerramento gracioso ──────────────────────────────────────
// Chamado em SIGTERM/SIGINT pelo server.js. Fecha os 3 pools em paralelo.
// Sem isso, as conexões do processo ficam abertas no PG por até
// `idleTimeoutMillis` (30s+), agravando "too many clients" em cada restart.
let shuttingDown = false;
export async function closePool() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('[db] encerrando pools...');
  const results = await Promise.allSettled([
    pool.end().then(() => console.log('[db] pool api encerrado')),
    analyticsPool.end().then(() => console.log('[db] pool analytics encerrado')),
    sessionsPool.end().then(() => console.log('[db] pool sessions encerrado')),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[db] erro ao encerrar pool:', r.reason?.message || r.reason);
    }
  }
}

// ─── boot: config efetiva (facilita triagem) ────────────────────────────────
// Aparece no log de boot. Use DB_QUIET_BOOT=true para silenciar.
if (!boolEnv('DB_QUIET_BOOT', false)) {
  console.log(
    '[db] api       max=%d idle=%dms conn=%dms stmt=%dms qry=%dms',
    pool.options.max,
    pool.options.idleTimeoutMillis,
    pool.options.connectionTimeoutMillis,
    pool.options.statement_timeout,
    pool.options.query_timeout,
  );
  console.log(
    '[db] analytics max=%d idle=%dms conn=%dms stmt=%dms qry=%dms',
    analyticsPool.options.max,
    analyticsPool.options.idleTimeoutMillis,
    analyticsPool.options.connectionTimeoutMillis,
    analyticsPool.options.statement_timeout,
    analyticsPool.options.query_timeout,
  );
  console.log(
    '[db] sessions  max=%d idle=%dms conn=%dms stmt=%dms qry=%dms',
    sessionsPool.options.max,
    sessionsPool.options.idleTimeoutMillis,
    sessionsPool.options.connectionTimeoutMillis,
    sessionsPool.options.statement_timeout,
    sessionsPool.options.query_timeout,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORT default
// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANTE: o `query` do default export aponta para o analyticsPool,
// NÃO para o pool principal. Isso é intencional.
//
// Motivo: o único arquivo hoje que faz `import db from './db.js'` é o
// `metrics.js`, e todas as queries dele são de analytics (agregações
// pesadas de dashboard). Roteá-las para o pool dedicado evita saturar
// o pool principal com queries lentas.
//
// Se algum dia outro arquivo fizer `import db from './db.js'` esperando
// o pool principal, troque para o import nomeado:
//   import { pool } from './db.js';
export default {
  pool,
  analyticsPool,
  sessionsPool,
  query: analyticsQuery,      // ← roteia para analytics
  analyticsQuery,
  poolStats,
  pingDb,
  withPoolClient,
};