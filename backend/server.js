// backend/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool, logDatabaseAccess, waitForDatabase, closePool } from './services/db.js';
import { PostgreSqlSessionStore } from './PostgreSqlSessionStore.js';

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

// ---------- Serviços de background ----------
import { startNotificationEngine } from './services/notificationEngine.js';
import { startTicketQueue } from './services/ticketQueue.js';
import { startLinkHubBatchQueue } from './services/linkHubBatchQueue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// REDE DE SEGURANÇA GLOBAL — refinada
//
// [CORRIGIDO] Erros de infraestrutura (pool esgotado, conexão
// caída, timeout) NÃO matam mais o processo. São logados e seguem.
// Só erros realmente desconhecidos (bugs) contam para o limiar
// que encerra o processo. Isso evita crash-loop em picos de carga.
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

// Rede de segurança do pool. Se `db.js` já tem `pool.on('error')`,
// este é redundante, mas inofensivo.
pool.on('error', (err) => {
  console.warn('[db] conexão ociosa caiu:', err?.message || err);
});

const app = express();
const PORT = process.env.PORT || 3007;
const isProduction = process.env.NODE_ENV === 'production';

// ============================================================
// CACHE EM MEMÓRIA
// ------------------------------------------------------------
// Cache simples para rotas que devolvem volumes grandes e
// estáveis (ex.: /api/metricas-assessores → 178 linhas/usuário).
// Com N usuários carregando a mesma tela, evita rodar a mesma
// query N vezes no mesmo intervalo.
//
// Para múltiplas instâncias, troque por Redis mantendo a mesma
// interface (get/set/deleteByPrefix). Para 1 instância, resolve
// o problema com custo zero.
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
console.log(`[boot] NODE_ENV       = ${process.env.NODE_ENV || 'development'}`);
console.log(`[boot] PORT           = ${PORT}`);
console.log(`[boot] cookieSecure   = ${cookieSecure} (COOKIE_SECURE=${process.env.COOKIE_SECURE || 'unset'})`);

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

console.log(`[boot] ALLOWED_ORIGINS = ${allowedOrigins.join(', ')}`);

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
// SESSÃO
// ============================================================
const sessionStore = new PostgreSqlSessionStore(pool);

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
// [CORRIGIDO] Controlado por env. Em produção, 1 console.log
// por request × N usuários pode virar gargalo no stdout.
// Ative com LOG_AUTH_VERBOSE=true apenas ao depurar.
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
// HEALTH / MONITORAMENTO — público, antes de auth/CSRF
// ============================================================
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ pong: true }));

// [NOVO] Health do banco. Use com monitor externo (UptimeRobot,
// cron curl, etc.) para alertar quando `waiting > 0`.
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

// ============================================================
// CSRF TOKEN ENDPOINT
// ============================================================
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken });
});

// ============================================================
// AUTH — público (o router decide o que expor)
// ============================================================
app.use('/api/auth', authRoutes);

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

// [CORRIGIDO] Cache de 2 min — a rota devolve até 178 linhas por
// usuário e é chamada a cada navegação. Com 20 usuários
// simultâneos, o cache elimina ~95% das queries ao banco.
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

// [CORRIGIDO] Cache de 5 min — chamado a cada navegação
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

// [NOVO] Invalidação manual do cache. Chame após operações que
// mudam dados que alimentam o cache (movimentação de leads,
// edição de métricas etc.). Exemplo:
//   fetch('/api/admin/cache/invalidate', {
//     method: 'POST', headers: {...}, body: JSON.stringify({ prefix: 'metricas' })
//   });
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
// [CORRIGIDO] Fecha o pool antes de sair. Sem isso, as conexões
// do processo ficam abertas no PostgreSQL por até
// `idleTimeoutMillis` (30s+), agravando "too many clients" em
// cada restart.
// ============================================================
let server = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} recebido — encerrando graciosamente...`);

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

  // 2) Fecha o pool do PostgreSQL (libera slots imediatamente)
  try {
    await closePool();
    console.log('[shutdown] pool do PostgreSQL encerrado');
  } catch (err) {
    console.error('[shutdown] erro ao fechar pool:', err?.message || err);
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
      startNotificationEngine();
      startTicketQueue();
      startLinkHubBatchQueue();
    });
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco:', error);
    process.exit(1);
  }
})();

export { app, pool };