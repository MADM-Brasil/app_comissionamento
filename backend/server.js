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

const app = express();
const PORT = process.env.PORT || 3007;
const isProduction = process.env.NODE_ENV === 'production';

// ============================================================
// CONFIGURAÇÃO DE COOKIES
// ============================================================
// COOKIE_SECURE:
//   true  → cookies só via HTTPS (produção atrás de Traefik/Dokploy).
//   false → sem flag Secure (dev local / proxy sem X-Forwarded-Proto).
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

/**
 * Suporta wildcards no estilo "https://*.dominio.com".
 * Necessário porque o pacote `cors` faz comparação literal por padrão.
 */
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
    // Sem origin = curl, health check interno, same-origin. Permitir.
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
// Gera o token para todas as requisições (mesmo em GET /).
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

/**
 * Verificação CSRF — aplicada apenas às rotas protegidas (depois das públicas).
 * Ignora métodos seguros (GET/HEAD/OPTIONS).
 */
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
// Mostra sid, estado de autenticação e cookies em cada request /api.
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

// Health checks — precisam vir ANTES dos middlewares de proteção.
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ pong: true }));

// CSRF token (usado pelo frontend antes do login).
app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken });
});

// Autenticação (login, 2FA, logout, recuperação de senha, /me).
// Toda a lógica vive em routes/auth.js.
app.use('/api/auth', authRoutes);

// ============================================================
// MIDDLEWARES DE PROTEÇÃO (aplicados a tudo abaixo)
// ============================================================
app.use(csrfProtection);
app.use((req, res, next) => {
  if (req.session?.isAuthenticated) return next();
  return res.status(401).json({ success: false, error: 'Não autenticado' });
});

// ============================================================
// ARQUIVOS ESTÁTICOS (uploads) — protegidos por sessão
// ============================================================
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

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