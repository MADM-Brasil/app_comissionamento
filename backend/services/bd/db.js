// backend/services/bd/db.js
// ─────────────────────────────────────────────────────────────────────────────
// Pools PostgreSQL separados por tipo de carga:
//
//   • pool            → API geral (login, colaboradores, campanhas, suporte)
//   • analyticsPool   → metricLoaders.js (dashboard, comissões — lento)
//   • sessionsPool    → PostgreSqlSessionStore (frequente, curto)
//
// Por que pools separados?
//   Uma query lenta de métricas não pode consumir os slots que servem
//   /api/auth/me, /suporte/* e movimentação de leads. Isolar evita que um
//   pico de dashboard derrube o sistema inteiro.
// ─────────────────────────────────────────────────────────────────────────────

import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS DE ENV
// ═════════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO BASE
// ═════════════════════════════════════════════════════════════════════════════

const connectionString = process.env.DATABASE_URL;

let dbConfig;
if (connectionString) {
  const useSSL = process.env.DB_SSL === 'true';
  dbConfig = {
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
  };
} else {
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
  statement_timeout: numericEnv('DB_STATEMENT_TIMEOUT_MS', 60_000),
  query_timeout: numericEnv('DB_QUERY_TIMEOUT_MS', 60_000),
});

pool.on('connect', (client) => {
  if (LOG_CONNECTIONS) console.log('✅ [db:api] nova conexão');
  client.on('error', (err) => {
    if (LOG_CONNECTIONS) console.error('❌ [db:api] erro no cliente:', err.message);
  });
});

pool.on('error', (err) => {
  console.warn('[db:api] erro em conexão idle:', err?.message || err);
});

// ═════════════════════════════════════════════════════════════════════════════
// POOL DE ANALYTICS — metricLoaders.js
// ═════════════════════════════════════════════════════════════════════════════

export const analyticsPool = new Pool({
  ...dbConfig,
  max: numericEnv('DB_ANALYTICS_POOL_MAX', 3),
  idleTimeoutMillis: numericEnv('DB_ANALYTICS_IDLE_TIMEOUT_MS', 60_000),
  connectionTimeoutMillis: numericEnv('DB_ANALYTICS_CONNECTION_TIMEOUT_MS', 15_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  application_name: 'madm-analytics',
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

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS DE QUERY (named exports)
// ═════════════════════════════════════════════════════════════════════════════

/** Query no pool principal (API geral). */
export const query = (text, params) => pool.query(text, params);

/** Alias de `query` — só para deixar a intenção explícita em código novo. */
export const mainQuery = query;

/** Query no pool de analytics (metricLoaders.js). */
export const analyticsQuery = (text, params) => analyticsPool.query(text, params);

/** Query no pool de sessions (session store). */
export const sessionsQuery = (text, params) => sessionsPool.query(text, params);

// ═════════════════════════════════════════════════════════════════════════════
// waitForDatabase
// ═════════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════════
// withPoolClient — conexão dedicada com timeout duro
// ═════════════════════════════════════════════════════════════════════════════

export async function withPoolClient(fn, { timeoutMs = 15_000, label = 'db', which = 'api' } = {}) {
  const targetPool = which === 'analytics' ? analyticsPool
                   : which === 'sessions'  ? sessionsPool
                   : pool;

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[db] connect timeout (${label}) após ${timeoutMs}ms`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });

  const client = await Promise.race([targetPool.connect(), timeout]).finally(() => clearTimeout(timer));

  try {
    return await fn(client);
  } finally {
    try {
      client.release();
    } catch (e) {
      console.warn(`[db] release falhou (${label}):`, e?.message || e);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// poolStats — para /health/db
// ═════════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════════
// pingDb — para /health/db
// ═════════════════════════════════════════════════════════════════════════════

export async function pingDb(timeoutMs = 5000) {
  const started = Date.now();
  try {
    await withPoolClient(
      (c) => c.query('SELECT 1'),
      { timeoutMs, label: 'ping', which: 'api' }
    );
    return { ok: true, pool: 'api', ms: Date.now() - started };
  } catch (err) {
    return { ok: false, pool: 'api', ms: Date.now() - started, error: err?.message || String(err) };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// logDatabaseAccess — diagnóstico do boot
// ═════════════════════════════════════════════════════════════════════════════

export const logDatabaseAccess = async () => {
  try {
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
  } catch (err) {
    console.warn('⚠️ [DB DEBUG] não foi possível inspecionar permissões:', err.message);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// closePool — encerramento gracioso
// ═════════════════════════════════════════════════════════════════════════════

let shuttingDown = false;

function endWithTimeout(p, name, timeoutMs = 15_000) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[db] ${name}.end() não respondeu em ${timeoutMs}ms — prosseguindo`);
      resolve();
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
  return Promise.race([p.then(() => console.log(`[db] pool ${name} encerrado`)), timeout])
    .finally(() => clearTimeout(timer));
}

export async function closePool() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('[db] encerrando pools...');
  const results = await Promise.allSettled([
    endWithTimeout(pool.end(), 'api'),
    endWithTimeout(analyticsPool.end(), 'analytics'),
    endWithTimeout(sessionsPool.end(), 'sessions'),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[db] erro ao encerrar pool:', r.reason?.message || r.reason);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// BOOT: log da configuração efetiva
// ─────────────────────────────────────────────────────────────────────────────

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

export default {
  pool,
  analyticsPool,
  sessionsPool,
  query,
  mainQuery,
  analyticsQuery,
  sessionsQuery,
  poolStats,
  pingDb,
  withPoolClient,
  waitForDatabase,
  logDatabaseAccess,
  closePool,
};