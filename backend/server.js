// backend/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import path from 'path';                                
import { fileURLToPath } from 'url';                   

import { pool } from './services/db.js';
import { PostgreSqlSessionStore } from './PostgreSqlSessionStore.js';
import twoFactorService from './security/verif-2factory.js';

// Importa os routers protegidos
import colaboradoresRoutes from './routes/colaboradores.js';
import metricsRouter from './routes/metrics.js';
import tabelaComissoesRoutes from './routes/tabela-comissoes.js';
import adminRoutes from './routes/admin.js';
import userRouter from './routes/user.js';
import suporteRouter from './routes/suporte.js';
import campanhasRoutes from './routes/campanhas.js';
import notificacoesRoutes from './routes/notificacoes.js';
import { startNotificationEngine } from './services/notificationEngine.js';

const __filename = fileURLToPath(import.meta.url);      
const __dirname = path.dirname(__filename);          

const app = express();
const PORT = process.env.PORT || 3007;

// ---------- Trust proxy ----------
app.set('trust proxy', 1);

// ---------- CORS ----------
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3008'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

// ---------- Body parsers ----------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ---------- SERVE ARQUIVOS ESTÁTICOS (uploads) SEM AUTENTICAÇÃO ----------
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// ---------- Helmet ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: [ "'self'",
  "data:",
  "blob:",
  "https://d2xsxph8kpxj0f.cloudfront.net",     // imagem do ranking
  "https://*.cloudfront.net"],
      connectSrc: ["'self'", process.env.FRONTEND_URL || 'http://localhost:3007'],
      fontSrc: ["'self'"],
    },
  },
}));

// ---------- Cookie Parser manual ----------
app.use((req, res, next) => {
  const raw = req.headers.cookie || '';
  const cookies = {};
  raw.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.trim().split('=');
    if (name) cookies[name] = decodeURIComponent(rest.join('='));
  });
  req.cookies = cookies;
  next();
});

// ---------- CSRF Double Submit Cookie ----------
app.use((req, res, next) => {
  if (!req.cookies?.['csrf-token']) {
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf-token', token, {
      httpOnly: false,
      secure: isProduction,
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
  const token = req.headers['x-csrf-token'] || req.body._csrf;
  const cookieToken = req.cookies?.['csrf-token'];
  if (!token || !cookieToken || token !== cookieToken) {
    return res.status(403).json({ success: false, error: 'CSRF token inválido.' });
  }
  next();
}

app.get('/api/csrf-token', (req, res) => {
  res.json({ csrfToken: req.csrfToken });
});

// ---------- Sessão ----------
const sessionStore = new PostgreSqlSessionStore(pool);

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'chave-secreta-sessao',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
  },
}));

// ========== FUNÇÃO AUXILIAR – período atual ==========
function getCurrentPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// ========== ROTAS PÚBLICAS (sem CSRF) ==========
app.get('/api/auth/ping', (req, res) => {
  if (!req.session.isAuthenticated) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  res.json({ pong: true, time: new Date().toISOString() });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body;
    const userResult = await pool.query(
      `SELECT email, nome, nome_equipe, cargo, status, periodo
       FROM core.view_app_colaboradores
       WHERE email = $1`,
      [email]
    );
    if (userResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }
    const user = userResult.rows[0];

    const twoFactorResult = await twoFactorService.sendCode(user.email, user.nome);
    if (!twoFactorResult.success) {
      return res.status(500).json({ success: false, error: twoFactorResult.error || 'Erro ao enviar código' });
    }

    req.session.cookie.maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    req.session.userId = user.email;
    req.session.tempToken = twoFactorResult.tempToken;
    req.session.ip = req.ip;
    req.session.userAgent = req.headers['user-agent'];

    req.session.save((err) => {
      if (err) {
        console.error('Erro ao salvar sessão:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
      }
      return res.json({ success: true, requiresTwoFactor: true, tempToken: twoFactorResult.tempToken });
    });
  } catch (error) {
    console.error('❌ Erro no login:', error);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

app.post('/api/auth/verify-2fa', async (req, res) => {
  try {
    const { tempToken, code } = req.body;
    const userId = req.session.userId;
    if (!userId || !tempToken) return res.status(400).json({ success: false, error: 'Sessão inválida.' });

    const verification = twoFactorService.verifyCode(userId, code);
    if (!verification.success) return res.status(401).json({ success: false, error: verification.error });

    delete req.session.tempToken;
    req.session.isAuthenticated = true;

    const userResult = await pool.query(
      `SELECT email, nome, nome_equipe, cargo, status, periodo
       FROM core.view_app_colaboradores
       WHERE email = $1`,
      [userId]
    );
    const user = userResult.rows[0];

    req.session.save((err) => {
      if (err) return res.status(500).json({ success: false, error: 'Erro ao salvar sessão' });
      return res.json({ success: true, user });
    });
  } catch (error) {
    console.error('❌ Erro na verificação 2FA:', error);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

app.post('/api/auth/resend-code', async (req, res) => {
  try {
    const userId = req.session.userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Sessão não encontrada' });
    const userResult = await pool.query(
      `SELECT email, nome FROM core.view_app_colaboradores WHERE email = $1`,
      [userId]
    );
    if (userResult.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    const user = userResult.rows[0];

    const result = await twoFactorService.resendCode(userId, user.email);
    if (result.success) {
      req.session.tempToken = result.tempToken;
      req.session.save(() => res.json({ success: true }));
    } else {
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('❌ Erro ao reenviar código:', error);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  if (!req.session) {
    res.clearCookie('connect.sid');
    return res.json({ success: true });
  }
  req.session.destroy((err) => {
    if (err) console.error('Erro ao destruir sessão:', err);
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  pool.query(
    `SELECT email, nome, nome_equipe, cargo, status, periodo
     FROM core.view_app_colaboradores
     WHERE email = $1`,
    [req.session.userId]
  ).then(result => {
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    res.json({ success: true, user: result.rows[0] });
  }).catch(error => {
    console.error('Erro ao obter usuário:', error);
    res.status(500).json({ success: false, error: 'Erro interno' });
  });
});

// ========== NOVAS ROTAS PÚBLICAS DE RECUPERAÇÃO DE SENHA ==========
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'E-mail é obrigatório' });

    const periodo = getCurrentPeriod();
    const result = await pool.query(
      `SELECT nome, email
       FROM core.view_app_colaboradores
       WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
         AND periodo = $2`,
      [email, periodo]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'E-mail não encontrado.' });
    }

    const user = result.rows[0];
    const sendResult = await twoFactorService.sendPasswordResetCode(user.email, user.nome);
    if (!sendResult.success) {
      return res.status(500).json({ success: false, error: sendResult.error });
    }

    req.session.resetEmail = email;
    req.session.resetName = user.nome;

    req.session.save((err) => {
      if (err) return res.status(500).json({ success: false, error: 'Erro ao salvar sessão' });
      res.json({ success: true, message: 'Código enviado para o e-mail.' });
    });
  } catch (err) {
    console.error('Erro em forgot-password:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

app.post('/api/auth/verify-reset-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ success: false, error: 'E-mail e código são obrigatórios' });

    if (!req.session.resetName || req.session.resetEmail !== email) {
      return res.status(400).json({ success: false, error: 'Sessão de recuperação inválida.' });
    }

    const verification = twoFactorService.verifyPasswordResetCode(req.session.resetName, code);
    if (!verification.success) {
      return res.status(401).json({ success: false, error: verification.error });
    }

    req.session.resetToken = verification.resetToken;
    req.session.save((err) => {
      if (err) return res.status(500).json({ success: false, error: 'Erro interno' });
      res.json({ success: true, resetToken: verification.resetToken });
    });
  } catch (err) {
    console.error('Erro em verify-reset-code:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    if (!resetToken || !newPassword) return res.status(400).json({ success: false, error: 'Token e nova senha são obrigatórios' });
    if (newPassword.length < 6) return res.status(400).json({ success: false, error: 'A senha deve ter pelo menos 6 caracteres' });

    if (!req.session.resetToken || req.session.resetToken !== resetToken) {
      return res.status(401).json({ success: false, error: 'Token inválido ou expirado' });
    }

    const email = req.session.resetEmail;
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const updateResult = await pool.query(
      `UPDATE app_comissionamento.metricas_assessores
       SET senha_colaborador_hash = $1, updated_at = NOW()
       WHERE LOWER(TRIM(email)) = LOWER(TRIM($2))
       RETURNING id_assessor`,
      [hashedPassword, email]
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    delete req.session.resetToken;
    delete req.session.resetEmail;
    delete req.session.resetName;

    req.session.save((err) => {
      if (err) return res.status(500).json({ success: false, error: 'Erro ao salvar sessão' });
      res.json({ success: true, message: 'Senha redefinida com sucesso.' });
    });
  } catch (err) {
    console.error('Erro em reset-password:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ========== MIDDLEWARES DE PROTEÇÃO (CSRF + Autenticação) ==========
app.use(csrfProtection);
app.use((req, res, next) => {
  if (req.session.isAuthenticated) return next();
  return res.status(401).json({ success: false, error: 'Não autenticado' });
});

// ========== ROTAS PROTEGIDAS ==========

// GET /api/metricas-assessores
app.get('/api/metricas-assessores', async (req, res) => {
  try {
    const { mes, email, colaborador_id } = req.query;
    if (!mes) return res.status(400).json({ success: false, error: 'Parâmetro "mes" (YYYY-MM) é obrigatório' });

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
    if (email) { query += ` AND LOWER(TRIM(email)) = LOWER(TRIM($${paramIdx}))`; params.push(email); paramIdx++; }
    if (colaborador_id) { query += ` AND id_assessor::text = $${paramIdx}`; params.push(colaborador_id); paramIdx++; }
    query += ' ORDER BY email';

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro em /api/metricas-assessores:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// Registro das rotas protegidas
app.use('/api', colaboradoresRoutes);
app.use('/api/metrics', metricsRouter);
app.use('/api/tabela-comissoes', tabelaComissoesRoutes);
app.use('/api/campanhas', campanhasRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRouter);
app.use('/api/suporte', suporteRouter);
app.use('/api/notificacoes', notificacoesRoutes);

// GET /api/admin/months
app.get('/api/admin/months', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT data_metrica::date 
       FROM app_comissionamento.view_app_metricas_assessores 
       ORDER BY data_metrica DESC`
    );
    const months = result.rows.map(r => {
      const d = new Date(r.data_metrica);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    });
    res.json({ success: true, data: months });
  } catch (err) {
    console.error('Erro ao buscar meses:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health checks
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ping', (req, res) => res.json({ pong: true }));

// Tratamento de erro
app.use((err, req, res, next) => {
  console.error('❌ Erro:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erro interno' });
});

// ---------- Inicialização ----------
(async () => {
  try {
    await pool.query('SELECT 1');
    console.log('✅ Conectado ao PostgreSQL');
    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT} (${process.env.NODE_ENV || 'development'})`);
      startNotificationEngine(); 
    });
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco:', error);
    process.exit(1);
  }
})();

export { app, pool }