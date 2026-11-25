// backend/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool, logDatabaseAccess, waitForDatabase, closePool } from './services/bd/db.js';
import { PostgreSqlSessionStore } from './PostgreSqlSessionStore.js';
import { redis, redisSub, closeRedis } from './services/bd/redis.js';

// ---------- Routers ----------
import authRoutes from './routes/auth.js';
import colaboradoresRoutes from './routes/colaboradores.js';
import metricsRouter from './routes/metrics.js';
import inteComerceRoutes from './routes/inte_comerce.js';
import tabelaComissoesRoutes from './routes/tabela-comissoes.js';
import adminRoutes from './routes/admin.js';
import userRouter from './routes/user.js';
import suporteRouter from './routes/suporte.js';
import campanhasRoutes from './routes/campanhas.js';
import notificacoesRoutes from './routes/notificacoes.js';
import tabulacoesRoutes from './routes/tabulacoes.js';
import discadorRouter from './routes/discador.js';

// ---------- Serviço de background ----------
import { startNotificationEngine } from './services/notificationEngine.js';

// ═══════════════════════════════════════════════════════════════════════════
// ═══ CORRIGIDO: workers NÃO são mais importados estaticamente ═══
// ═══════════════════════════════════════════════════════════════════════════
// Antes:
//   import { startTicketQueue } from './services/ticketQueue.js';
//   import { startLinkHubBatchQueue } from './services/linkHubBatchQueue.js';
//
// Motivo da remoção: qualquer erro de parse ESM (export inexistente,
// syntax error, dependência faltando) em um worker mata o processo
// ANTES do app.listen rodar, com `código 1` — e o `app.listen` nunca
// chega a executar. Foi exatamente o que aconteceu quando o
// ticketQueue.js referenciou uma função que não existia em hubspot.js.
//
// Agora:
//   • Workers são carregados via `import()` dinâmico DEPOIS do listen.
//   • `try/catch` individual por worker — backend sobe mesmo se falharem.
//   • `/api/health/worker` expõe o estado de cada worker.
//   • `WORKER_ENABLED=false` permite rodar backend sozinho (recomendado
//     em produção: worker em processo separado para isolar falhas).
//   • `stopWorker()` no shutdown garante que o worker termina seus
//     processamentos em voo ANTES do pool fechar — sem isso, tickets em
//     `processando` falham com "Cannot use a pool after calling end"
//     e ficam travados até o reset de órfão do próximo boot.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ═══ Warmup / cache / singleflight ═══
// ═══════════════════════════════════════════════════════════════════════════
import { setupWarmups, stopPeriodRotation } from './services/bd/warmupSetup.js';
import { stopAllWarmup, getWarmupStatus } from './services/bd/warmup.js';
import { singleflightSize, singleflightStats } from './services/bd/singleflight.js';
import { cacheStats } from './services/bd/cache.js';
import { cacheFirstStats } from './services/bd/cacheFirst.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// WORKER — estado gerenciado (import dinâmico)
// ============================================================
// Cada worker tem seu próprio slot. `module` guarda o namespace após o
// carregamento (para stop() no shutdown e status() no health). `promise`
// serve para o shutdown aguardar um carregamento em andamento.

const workers = {
  ticketQueue: {
    module:  null,
    promise: null,
    error:   null,
  },
  linkHubBatchQueue: {
    module:  null,
    promise: null,
    error:   null,
  },
};

// ============================================================
// REDE DE SEGURANÇA GLOBAL
//
// Erros de infraestrutura (pool esgotado, conexão caída, timeout)
// NÃO matam o processo. São logados e seguem. Só erros realmente
// desconhecidos (bugs) contam para o limiar que encerra o processo.
// Isso evita crash-loop em picos de carga.
// ============================================================
const NON_FATAL_ERROR_PATTERNS = [
  'connection terminated',
  'connection timeout',
  'too many clients',
  'remaining connection slots',
  'query read timeout',
  'connect timeout',
  'timeout expired',
  'econnreset',
  'epipe',
  'econnrefused',
];

function isInfraError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  return NON_FATAL_ERROR_PATTERNS.some((p) => msg.includes(p));
}

const fatalTimestamps = [];
const FATAL_WINDOW_MS = 60_000;
const FATAL_THRESHOLD = 5;

function recordAndMaybeKill(kind, err) {
  if (isInfraError(err)) {
    console.warn(`[non-fatal:${kind}] ${err?.message || err}`);
    return;
  }
  console.error(`[fatal:${kind}]`, err?.stack || err);
  const now = Date.now();
  fatalTimestamps.push(now);
  while (fatalTimestamps.length && now - fatalTimestamps[0] > FATAL_WINDOW_MS) {
    fatalTimestamps.shift();
  }
  if (fatalTimestamps.length >= FATAL_THRESHOLD) {
    console.error(
      `[fatal] ${FATAL_THRESHOLD} erros não tratados em ${FATAL_WINDOW_MS / 1000}s — encerrando para evitar loop.`
    );
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => recordAndMaybeKill('unhandledRejection', reason));
process.on('uncaughtException', (err) => recordAndMaybeKill('uncaughtException', err));

pool.on('error', (err) => {
  console.warn('[db] conexão ociosa caiu:', err?.message || err);
});

const app = express();
const PORT = process.env.PORT || 3007;
const isProduction = process.env.NODE_ENV === 'production';

// ============================================================
// CACHE EM MEMÓRIA
// ============================================================
const _cache = new Map();
const _cacheMaxSize = Number(process.env.CACHE_MAX_SIZE || 500);
const _cacheDefaultTtl = Number(process.env.CACHE_DEFAULT_TTL_MS || 120_000);

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttlMs = _cacheDefaultTtl) {
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (_cache.size > _cacheMaxSize) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
}

function cacheDeleteByPrefix(prefix) {
  if (!prefix) { _cache.clear(); return; }
  for (const k of _cache.keys()) {
    if (k.startsWith(prefix)) _cache.delete(k);
  }
}

function cacheKeyOf(prefix, params) {
  const sorted = Object.keys(params || {}).sort().reduce((acc, k) => {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') acc[k] = v;
    return acc;
  }, {});
  return `${prefix}:${JSON.stringify(sorted)}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache.entries()) {
    if (now > v.expiresAt) _cache.delete(k);
  }
}, 60_000).unref?.();

// ============================================================
// CONFIGURAÇÃO DE COOKIES
// ============================================================
const cookieSecure = process.env.COOKIE_SECURE === 'true';
console.log(`[boot] NODE_ENV              = ${process.env.NODE_ENV || 'development'}`);
console.log(`[boot] PORT                  = ${PORT}`);
console.log(`[boot] cookieSecure          = ${cookieSecure} (COOKIE_SECURE=${process.env.COOKIE_SECURE || 'unset'})`);
console.log(`[boot] WORKER_ENABLED        = ${process.env.WORKER_ENABLED ?? '(default: true)'}`);

// ============================================================
// TRUST PROXY — necessário para req.secure / req.protocol
// refletirem X-Forwarded-Proto do Traefik/Dokploy.
// ============================================================
app.set('trust proxy', 1);

// ============================================================
// CORS
// ============================================================
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : ['http://localhost:3008'];

console.log(`[boot] ALLOWED_ORIGINS       = ${allowedOrigins.join(', ')}`);

function originMatches(origin, pattern) {
  if (pattern === origin) return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  return regex.test(origin);
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const ok = allowedOrigins.some((pattern) => originMatches(origin, pattern));
    if (ok) return callback(null, true);
    console.warn(`[cors] Origem bloqueada: ${origin}`);
    return callback(new Error('Origem não permitida pelo CORS'), false);
  },
  credentials: true,
}));

// ============================================================
// BODY PARSERS
// ============================================================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ============================================================
// HELMET
// ============================================================
const cspConnectExtra = [];
if (process.env.FRONTEND_URL) cspConnectExtra.push(process.env.FRONTEND_URL);
if (process.env.BACKEND_PUBLIC_URL) cspConnectExtra.push(process.env.BACKEND_PUBLIC_URL);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: [
        "'self'",
        'data:',
        'blob:',
        'https://d2xsxph8kpxj0f.cloudfront.net',
        'https://*.cloudfront.net',
      ],
      connectSrc: ["'self'", 'https:', 'wss:', ...cspConnectExtra],
      fontSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ============================================================
// COOKIE PARSER MANUAL
// ============================================================
app.use((req, res, next) => {
  const raw = req.headers.cookie || '';
  const cookies = {};
  raw.split(';').forEach((cookie) => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name] = decodeURIComponent(rest.join('='));
  });
  req.cookies = cookies;
  next();
});

// ============================================================
// CSRF — Double Submit Cookie
// ============================================================
app.use((req, res, next) => {
  if (!req.cookies?.['csrf-token']) {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf-token', token, {
      httpOnly: false,
      secure: cookieSecure,
      sameSite: 'lax',
      path: '/',
    });
    req.csrfToken = token;
  } else {
    req.csrfToken = req.cookies['csrf-token'];
  }
  next();
});

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.headers['x-csrf-token'] || req.body?._csrf;
  const cookieToken = req.cookies?.['csrf-token'];
  if (!token || !cookieToken || token !== cookieToken) {
    return res.status(403).json({ success: false, error: 'CSRF token inválido.' });
  }
  next();
}

// ============================================================
// SESSION STORE
// Cache em memória + Redis, leituras deduplicadas e touch em lote.
// Ver comentário no topo de PostgreSqlSessionStore.js.
// ============================================================
const sessionStore = new PostgreSqlSessionStore(pool, { redis, redisSub });

// ============================================================
// ROTAS PÚBLICAS SEM SESSÃO
// Registradas ANTES do middleware de sessão: health checks, token CSRF
// e imagens de /uploads não precisam de sessão e, antes, cada uma delas
// consultava o banco para carregar a sessão do usuário.
// ============================================================

// ============================================================
// HEALTH / MONITORAMENTO — público, antes de auth/CSRF
// ============================================================
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ pong: true }));

// Health do banco. Use com monitor externo (UptimeRobot, cron curl
// etc.) para alertar quando `waiting > 0`.
app.get('/api/health/db', async (req, res) => {
  const started = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: pool.options?.max ?? null,
    };
    const ok = poolStats.waiting === 0;
    return res.status(ok ? 200 : 503).json({
      ok,
      ms: Date.now() - started,
      pool: poolStats,
    });
  } catch (err) {
    return res.status(503).json({
      ok: false,
      ms: Date.now() - started,
      error: err?.message || String(err),
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ═══ NOVO: health do worker ═══
// ═══════════════════════════════════════════════════════════════════════════
// Expõe o status do worker de movimentações (modo_degradado, stats,
// funções obrigatórias do hubspot.js, etc.) sem precisar consultar o
// banco. Útil em:
//   • curl /api/health/worker para triagem rápida
//   • monitor externo alertar se `running=false` ou `modo_degradado=true`
//   • dashboard de operação
//
// Sem query string: retorna payload completo.
// Com ?brief=1: retorna só o essencial (running, modo_degradado, stats).
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/health/worker', (req, res) => {
  const brief = req.query.brief === '1';

  if (process.env.WORKER_ENABLED === 'false') {
    return res.status(200).json({
      success: true,
      loaded: false,
      motivo: 'WORKER_ENABLED=false (workers rodando em processo separado)',
    });
  }

  const out = {};
  let allOk = true;
  let anyLoaded = false;

  // ── ticketQueue ──────────────────────────────────────────────────
  {
    const w = workers.ticketQueue;
    if (w.error) {
      out.ticketQueue = { loaded: false, erro_carregamento: w.error.message };
      allOk = false;
    } else if (!w.module) {
      out.ticketQueue = { loaded: false, motivo: 'carregando' };
      allOk = false;
    } else {
      try {
        const st = w.module.status();
        const ok = st.running && !st.modo_degradado;
        if (!ok) allOk = false;
        anyLoaded = true;
        const payload = { loaded: true, ok, ...st };
        if (brief) delete payload.exports_hubspot;
        out.ticketQueue = payload;
      } catch (err) {
        out.ticketQueue = { loaded: true, erro: err?.message || String(err) };
        allOk = false;
      }
    }
  }

  // ── linkHubBatchQueue ────────────────────────────────────────────
  {
    const w = workers.linkHubBatchQueue;
    if (w.error) {
      out.linkHubBatchQueue = { loaded: false, erro_carregamento: w.error.message };
      allOk = false;
    } else if (!w.module) {
      out.linkHubBatchQueue = { loaded: false, motivo: 'carregando' };
      allOk = false;
    } else {
      try {
        const st = w.module.statusLinkHubBatchQueue?.() || { running: false };
        const ok = st.running === true;
        if (!ok) allOk = false;
        anyLoaded = true;
        out.linkHubBatchQueue = { loaded: true, ok, ...st };
      } catch (err) {
        out.linkHubBatchQueue = { loaded: true, erro: err?.message || String(err) };
        allOk = false;
      }
    }
  }

  const success = allOk && anyLoaded;
  return res.status(success ? 200 : 503).json({ success, workers: out });
});

// ═══════════════════════════════════════════════════════════════════════════
// ═══ NOVO: health do warmup / cache / singleflight ═══
// Retorna 200 quando todos os jobs estão saudáveis (failing=0, degraded=0).
// Retorna 503 quando algum job está travado ou falhando consecutivamente.
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/health/warmup', (req, res) => {
  try {
    const brief = req.query.brief === '1';
    const jobs = getWarmupStatus();
    const summary = {
      total: jobs.length,
      healthy: jobs.filter((j) => j.health === 'healthy').length,
      degraded: jobs.filter((j) => j.health === 'degraded').length,
      failing: jobs.filter((j) => j.health === 'failing').length,
      idle: jobs.filter((j) => j.health === 'idle').length,
      running: jobs.filter((j) => j.health === 'running').length,
    };
    const ok = summary.failing === 0 && summary.degraded === 0;

    const payload = {
      success: ok,
      summary,
      inflight: singleflightSize(),
      singleflight: singleflightStats(),
      cache: cacheStats(),
      cacheFirst: cacheFirstStats(),
    };
    if (!brief) payload.jobs = jobs;

    return res.status(ok ? 200 : 503).json(payload);
  } catch (err) {
    console.error('[health/warmup] erro:', err);
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// Estatísticas do session store (quantas idas ao banco foram evitadas).
app.get('/api/health/sessions', (req, res) => {
  res.json({ success: true, ...sessionStore.stats() });
});

// ============================================================
// CSRF TOKEN ENDPOINT
// ============================================================
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken });
});

// ============================================================
// ARQUIVOS ESTÁTICOS (uploads) — públicos, inavegáveis
// ============================================================
app.use(
  '/uploads',
  (req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  },
  express.static(path.join(process.cwd(), 'uploads'), {
    fallthrough: true,
    index: false,
    dotfiles: 'ignore',
  })
);

// ============================================================
// SESSÃO
// ============================================================
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'chave-secreta-sessao',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    secure: cookieSecure,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/',
  },
}));

// ============================================================
// LOG DE AUTENTICAÇÃO
// Controlado por env. Em produção, 1 console.log por request
// × N usuários pode virar gargalo no stdout. Ative com
// LOG_AUTH_VERBOSE=true apenas ao depurar.
// ============================================================
const LOG_AUTH_VERBOSE = process.env.LOG_AUTH_VERBOSE === 'true' || !isProduction;

app.use((req, res, next) => {
  if (!LOG_AUTH_VERBOSE) return next();
  const reqPath = req.path || '';
  const skip =
    reqPath === '/api/health' ||
    reqPath === '/api/ping' ||
    reqPath === '/api/csrf-token';
  if (reqPath.startsWith('/api/') && !skip) {
    const sid = req.sessionID ? `${req.sessionID.slice(0, 8)}…` : 'none';
    const authed = Boolean(req.session?.isAuthenticated);
    const cookieNames = Object.keys(req.cookies || {}).join(',') || 'none';
    console.log(
      `[auth] ${req.method} ${reqPath} | sid=${sid} | autenticado=${authed} | cookies=${cookieNames}`
    );
  }
  next();
});

// ============================================================
// AUTH — público (o router decide o que expor)
// ============================================================
app.use('/api/auth', authRoutes);

// ============================================================
// MIDDLEWARES DE PROTEÇÃO
// ============================================================
app.use(csrfProtection);
app.use((req, res, next) => {
  if (req.session?.isAuthenticated) return next();
  return res.status(401).json({ success: false, error: 'Não autenticado' });
});

// ============================================================
// ROTAS PROTEGIDAS
// ============================================================

// Cache de 2 min — a rota devolve até 178 linhas por usuário e é
// chamada a cada navegação. Com 20 usuários simultâneos, o cache
// elimina ~95% das queries ao banco.
app.get('/api/metricas-assessores', async (req, res) => {
  try {
    const { mes, email, colaborador_id } = req.query;
    if (!mes) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetro "mes" (YYYY-MM) é obrigatório',
      });
    }

    const key = cacheKeyOf('metricas-assessores', { mes, email, colaborador_id });
    const cached = cacheGet(key);
    if (cached) {
      return res.json({ success: true, data: cached, cached: true });
    }

    let query = `
      SELECT id_assessor, email, data_metrica,
             comissao_bonus,
             peso_meta_assinados_diario, peso_meta_ganho_diario,
             peso_meta_assinados_semanal, peso_meta_ganho_semanal,
             peso_meta_assinados_mensal, peso_meta_ganho_mensal,
             meta_gols_assinados, meta_gols_ganhos
      FROM app_comissionamento.view_app_metricas_assessores
      WHERE TO_CHAR(data_metrica::date, 'YYYY-MM') = $1
    `;
    const params = [mes];
    let paramIdx = 2;

    if (email) {
      query += ` AND LOWER(TRIM(email)) = LOWER(TRIM($${paramIdx}))`;
      params.push(email);
      paramIdx++;
    }
    if (colaborador_id) {
      query += ` AND id_assessor::text = $${paramIdx}`;
      params.push(colaborador_id);
      paramIdx++;
    }
    query += ' ORDER BY email';

    const result = await pool.query(query, params);
    cacheSet(key, result.rows, 120_000);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro em /api/metricas-assessores:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

app.use('/api', colaboradoresRoutes);
app.use('/api/metrics', metricsRouter);
app.use('/api/metrics/inte-comerce', inteComerceRoutes);
app.use('/api/tabela-comissoes', tabelaComissoesRoutes);
app.use('/api/campanhas', campanhasRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRouter);
app.use('/api/suporte', suporteRouter);
app.use('/api/notificacoes', notificacoesRoutes);
app.use('/api/tabulacoes', tabulacoesRoutes);
app.use('/api/discador', discadorRouter);

// Cache de 5 min — chamado a cada navegação
app.get('/api/admin/months', async (req, res) => {
  try {
    const cacheKey = 'admin-months';
    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, cached: true });
    }
    const result = await pool.query(
      `SELECT DISTINCT data_metrica::date
         FROM app_comissionamento.view_app_metricas_assessores
        ORDER BY data_metrica DESC`
    );
    const months = result.rows.map((r) => {
      const d = new Date(r.data_metrica);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    });
    cacheSet(cacheKey, months, 5 * 60_000);
    res.json({ success: true, data: months });
  } catch (err) {
    console.error('Erro ao buscar meses:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Invalidação manual do cache. Chame após operações que mudam
// dados que alimentam o cache (movimentação de leads, edição de
// métricas etc.).
app.post('/api/admin/cache/invalidate', (req, res) => {
  const prefix = typeof req.body?.prefix === 'string' ? req.body.prefix : '';
  cacheDeleteByPrefix(prefix);
  res.json({ success: true, invalidated: prefix || 'all' });
});

// ============================================================
// TRATAMENTO DE ERRO
// ============================================================
app.use((err, req, res, next) => {
  // Em produção, log compacto — não polui o stdout com stack trace
  // quando o erro é conhecido (ex.: pool caído durante pico).
  if (isProduction && isInfraError(err)) {
    console.warn(`[erro-conhecido] ${req.method} ${req.path}: ${err?.message || err}`);
  } else if (isProduction) {
    console.error(`❌ Erro em ${req.method} ${req.path}: ${err?.message || err}`);
  } else {
    console.error('❌ Erro não tratado:', err);
  }
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erro interno' });
});

// ============================================================
// GRACEFUL SHUTDOWN
//
// Ordem importa:
//   1) Para de aceitar novas conexões HTTP
//   2) Para o worker — deixa tickets em voo terminarem (ou faz
//      timeout e devolve para fila via reset de órfão no próximo
//      boot). SEM isso, o `closePool` quebra tickets em
//      `processando` com "Cannot use a pool after calling end".
//   3) Para o warmup scheduler
//   4) Grava touches de sessão pendentes
//   5) Fecha o pool do PostgreSQL (libera slots imediatamente)
//   6) Fecha o Redis
// ============================================================
let server = null;
let shuttingDown = false;

async function stopWorker() {
  const entries = Object.entries(workers);

  await Promise.allSettled(entries.map(async ([name, w]) => {
    try {
      if (w.promise) {
        try { await w.promise; } catch { /* já logado no catch do carregamento */ }
      }

      // ticketQueue.js exporta `stop`
      // linkHubBatchQueue.js exporta `stopLinkHubBatchQueue`
      const stopFn = w.module?.stop || w.module?.stopLinkHubBatchQueue;
      if (typeof stopFn === 'function') {
        await stopFn({ timeoutMs: 10_000 });
        console.log(`[shutdown] worker ${name} parado`);
      }
    } catch (err) {
      console.error(
        `[shutdown] erro ao parar worker ${name}:`,
        err?.message || err
      );
    }
  }));
}


async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} recebido — encerrando...`);

  // 1) Para de aceitar novas conexões HTTP
  if (server) {
    await new Promise((resolve) => {
      server.close(() => {
        console.log('[shutdown] servidor HTTP encerrado');
        resolve();
      });
      setTimeout(resolve, 10_000); // failsafe
    });
  }

  // 2) Worker — ANTES de fechar o pool (senão tickets em processando
  // quebram com "pool after end" e ficam travados até reset de órfão)
  await stopWorker();

  // 3) Warmup scheduler — também usa o pool
  try {
    stopPeriodRotation();
    await stopAllWarmup({ drainMs: 5_000 });
    console.log('[shutdown] warmup scheduler encerrado');
  } catch (err) {
    console.error('[shutdown] erro ao parar warmup:', err?.message || err);
  }

  // 4) Grava os últimos touches de sessão pendentes (usa o pool)
  try {
    await sessionStore.close();
    console.log('[shutdown] session store encerrado');
  } catch (err) {
    console.error('[shutdown] erro ao encerrar session store:', err?.message || err);
  }

  // 5) Fecha o pool do PostgreSQL
  try {
    await closePool();
    console.log('[shutdown] pool do PostgreSQL encerrado');
  } catch (err) {
    console.error('[shutdown] erro ao fechar pool:', err?.message || err);
  }

  // 6) Fecha conexões do Redis
  try {
    await closeRedis();
  } catch (err) {
    console.error('[shutdown] erro ao fechar Redis:', err?.message || err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============================================================
// CARREGAMENTO DINÂMICO DO WORKER
//
// Chamado DEPOIS do app.listen. O import é dinâmico para que
// qualquer erro (parse ESM, export faltando, dependência ausente)
// fique contido aqui e NÃO derrube o backend.
// ============================================================
function startWorkerAsync() {
  if (process.env.WORKER_ENABLED === 'false') {
    console.log('[boot] workers desativados (WORKER_ENABLED=false)');
    return;
  }

  // ── ticketQueue (CRM) ────────────────────────────────────────────
  workers.ticketQueue.promise = import('./services/ticketQueue.js')
    .then((mod) => {
      workers.ticketQueue.module = mod;
      const startFn = mod.start || mod.startTicketQueue;
      if (typeof startFn !== 'function') {
        throw new Error(
          'ticketQueue.js não expõe start/startTicketQueue. ' +
          `Exports disponíveis: ${Object.keys(mod).sort().join(', ')}`
        );
      }
      return startFn();
    })
    .then(() => console.log('[boot] ✅ worker ticketQueue iniciado'))
    .catch((err) => {
      workers.ticketQueue.error = err;
      console.error('[boot] ⚠️  ticketQueue NÃO carregou (backend segue):', err.message);
    });

  // ── linkHubBatchQueue (Link Hub) ─────────────────────────────────
  if (process.env.LINKHUB_ENABLED === 'false') {
    console.log('[boot] linkHubBatchQueue desativado (LINKHUB_ENABLED=false)');
  } else {
    workers.linkHubBatchQueue.promise = import('./services/linkHubBatchQueue.js')
      .then((mod) => {
        workers.linkHubBatchQueue.module = mod;
        if (typeof mod.startLinkHubBatchQueue !== 'function') {
          throw new Error(
            'linkHubBatchQueue.js não expõe startLinkHubBatchQueue. ' +
            `Exports disponíveis: ${Object.keys(mod).sort().join(', ')}`
          );
        }
        return mod.startLinkHubBatchQueue();
      })
      .then(() => console.log('[boot] ✅ worker linkHubBatchQueue iniciado'))
      .catch((err) => {
        workers.linkHubBatchQueue.error = err;
        console.error('[boot] ⚠️  linkHubBatchQueue NÃO carregou (backend segue):', err.message);
      });
  }
}

// ============================================================
// INICIALIZAÇÃO
// ============================================================
(async () => {
  try {
    await waitForDatabase();
    try {
      await logDatabaseAccess();
    } catch (error) {
      console.warn(
        '⚠️ Diagnóstico do banco indisponível; o servidor continuará e tentará consultar normalmente:',
        error.message
      );
    }

    console.log('✅ Conectado ao PostgreSQL');

    server = app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT} (${process.env.NODE_ENV || 'development'})`);

      // Warmup — popula cache em background. Chamado depois do
      // listen para não atrasar o boot.
      setupWarmups();
      console.log('[boot] warmup scheduler iniciado');

      startNotificationEngine();

      // Worker em import dinâmico — falha do worker NÃO derruba a API.
      startWorkerAsync();
    });
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco:', error);
    process.exit(1);
  }
})();

export { app, pool };