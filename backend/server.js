// backend/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

import { pool, logDatabaseAccess, waitForDatabase } from './services/db.js';
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

// ---------- Serviços de background ----------
import { startNotificationEngine } from './services/notificationEngine.js';
import { startTicketQueue } from './services/ticketQueue.js';
import { startLinkHubBatchQueue } from './services/linkHubBatchQueue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// REDE DE SEGURANÇA GLOBAL
// ------------------------------------------------------------
// Workers de background (linkHubBatchQueue, notificationEngine,
// ticketQueue) fazem `pool.query` fora do ciclo de request/response.
// Se uma dessas queries falhar (ex.: "Connection terminated due to
// connection timeout" após o Postgres fechar uma conexão ociosa),
// a promise rejeitada não tem nenhum `.catch` — e, por padrão, Node
// 22 encerra o processo em `unhandledRejection`.
//
// Aqui logamos e SEGUIMOS VIVOS. Os workers já têm try/catch por
// ciclo (ver linkHubBatchQueue.js); esta rede cobre qualquer outra
// promise esquecida em qualquer serviço.
// ============================================================
const fatalTimestamps = [];
const FATAL_WINDOW_MS = 60_000;
const FATAL_THRESHOLD = 5;

function recordFatal(kind, err) {
  const now = Date.now();
  fatalTimestamps.push(now);
  while (fatalTimestamps.length && now - fatalTimestamps[0] > FATAL_WINDOW_MS) {
    fatalTimestamps.shift();
  }
  console.error(`[fatal:${kind}]`, err && err.stack ? err.stack : err);
  if (fatalTimestamps.length >= FATAL_THRESHOLD) {
    console.error(
      `[fatal] ${FATAL_THRESHOLD} erros não tratados em ${FATAL_WINDOW_MS / 1000}s — encerrando para evitar loop.`
    );
    process.exit(1);
  }
}

process.on('unhandledRejection', (reason) => recordFatal('unhandledRejection', reason));
process.on('uncaughtException', (err) => recordFatal('uncaughtException', err));

// Listener no pool: o pg-pool emite 'error' quando uma conexão ociosa
// morre. Sem esse listener, o EventEmitter lança e derruba o processo.
// (Ideal também ter em db.js; aqui é redundância inofensiva.)
pool.on('error', (err) => {
  console.error('[db] conexão ociosa caiu:', err?.message || err);
});

const app = express();
const PORT = process.env.PORT || 3007;
const isProduction = process.env.NODE_ENV === 'production';

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
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$'
  );
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
// LOG DE DIAGNÓSTICO DE AUTENTICAÇÃO
// ============================================================
app.use((req, res, next) => {
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
// ROTAS PÚBLICAS — NÃO exigem sessão nem CSRF
// ============================================================
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ pong: true }));

app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken });
});

app.use('/api/auth', authRoutes);

// ============================================================
// ARQUIVOS ESTÁTICOS (uploads) — PÚBLICOS, porém inavegáveis
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

app.get('/api/metricas-assessores', async (req, res) => {
  try {
    const { mes, email, colaborador_id } = req.query;
    if (!mes) {
      return res.status(400).json({
        success: false,
        error: 'Parâmetro "mes" (YYYY-MM) é obrigatório',
      });
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
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro em /api/metricas-assessores:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

app.use('/api', colaboradoresRoutes);
app.use('/api/metrics/inte-comerce', inteComerceRoutes);
app.use('/api/metrics', metricsRouter);
app.use('/api/tabela-comissoes', tabelaComissoesRoutes);
app.use('/api/campanhas', campanhasRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRouter);
app.use('/api/suporte', suporteRouter);
app.use('/api/notificacoes', notificacoesRoutes);

app.get('/api/admin/months', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT data_metrica::date
         FROM app_comissionamento.view_app_metricas_assessores
        ORDER BY data_metrica DESC`
    );
    const months = result.rows.map((r) => {
      const d = new Date(r.data_metrica);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    });
    res.json({ success: true, data: months });
  } catch (err) {
    console.error('Erro ao buscar meses:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// TRATAMENTO DE ERRO
// ============================================================
app.use((err, req, res, next) => {
  console.error('❌ Erro não tratado:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erro interno' });
});

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

    app.listen(PORT, () => {
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