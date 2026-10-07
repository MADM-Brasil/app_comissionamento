// backend/routes/auth.js
import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import twoFactorService from '../services/twoFactorService.js';
import { pool } from '../services/db.js';

const router = express.Router();
console.log('✅ [AUTH] Módulo de autenticação carregado');

// Grupos (cargos) com permissão de acesso ao sistema.
const GRUPOS_PERMITIDOS = [
  'Elite',
  'Supervisor',
  'Análise de segurado',
  'Concomitante',
  'Salesops',
  'Quinquenio',
  'Quinquênio ',       // mantido por compatibilidade com a base
  'Coordenador',
  'CEO',
  'Diretoria',
];

// ============================================================
// HELPERS
// ============================================================

/**
 * Constrói o objeto de usuário no formato esperado pelo frontend.
 * Frontend espera: { id, nome, email, equipe|nome_equipe, cargo, status, periodo }
 */
function buildUserPayload(row) {
  return {
    id: row.id_assessor,
    nome: row.nome,
    email: row.email,
    equipe: row.nome_equipe,
    nome_equipe: row.nome_equipe, // compat: server.js devolve nome_equipe
    cargo: row.cargo,
    status: row.status,
    periodo: row.periodo,
  };
}

/**
 * Busca o usuário pelo e-mail com validação de cargo permitido.
 * Retorna a linha completa (inclui senha_colaborador_hash).
 */
async function findUserByEmail(email) {
  const result = await pool.query(
    `SELECT
        a.id_assessor,
        c.email,
        c.nome,
        c.nome_equipe,
        c.cargo,
        c.status,
        c.periodo,
        a.senha_colaborador_hash
     FROM app_comissionamento.view_app_metricas_assessores a
     INNER JOIN core.view_app_colaboradores c
        ON LOWER(TRIM(a.email)) = LOWER(TRIM(c.email))
     WHERE LOWER(TRIM(a.email)) = LOWER(TRIM($1))
       AND TRIM(c.cargo) = ANY($2)`,
    [email, GRUPOS_PERMITIDOS]
  );
  return result.rows[0] || null;
}

/**
 * Wrapper de save da sessão que retorna uma Promise.
 * Garante persistência antes de responder (importante com store em Postgres).
 */
function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

// ============================================================
// ROTA DE TESTE (diagnóstico)
// ============================================================
router.get('/test', (req, res) => {
  res.json({ success: true, message: 'Rota auth/test funcionando' });
});

// ============================================================
// /me — verifica sessão ativa e devolve dados do usuário
// ============================================================
router.get('/me', async (req, res) => {
  if (!req.session?.isAuthenticated || !req.session?.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }

  try {
    const row = await findUserByEmail(req.session.userId);
    if (!row) {
      // Sessão órfã (usuário removido / cargo alterado). Destrói e informa 401.
      return req.session.destroy(() =>
        res.status(401).json({ success: false, error: 'Usuário não encontrado' })
      );
    }
    return res.json({ success: true, user: buildUserPayload(row) });
  } catch (err) {
    console.error('Erro em /auth/me:', err);
    return res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// /login — valida credenciais e dispara 2FA
// ============================================================
router.post('/login', async (req, res) => {
  const { email, password, rememberMe } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'E-mail e senha são obrigatórios' });
  }

  console.log(`🔐 [LOGIN] tentativa: email=${email} rememberMe=${!!rememberMe}`);

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      console.log(`❌ Login: usuário não encontrado/sem permissão: ${email}`);
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    const match = await bcrypt.compare(password, user.senha_colaborador_hash);
    if (!match) {
      console.log(`❌ Login: senha incorreta para ${email}`);
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    // Envia código 2FA (chave = e-mail, igual ao server.js)
    const sendResult = await twoFactorService.sendCode(user.email, user.nome);
    if (!sendResult.success) {
      console.log(`❌ Falha ao enviar 2FA: ${sendResult.error}`);
      return res.status(500).json({ success: false, error: sendResult.error || 'Erro ao enviar código' });
    }

    // Configura duração da sessão
    const maxAge = rememberMe
      ? 30 * 24 * 60 * 60 * 1000   // 30 dias
      : 24 * 60 * 60 * 1000;       // 1 dia
    req.session.cookie.maxAge = maxAge;
    req.session.cookie.expires = new Date(Date.now() + maxAge);

    // Marca sessão em estado "pré-2FA"
    req.session.userId = user.email;
    req.session.isAuthenticated = false;
    req.session.tempToken = sendResult.tempToken;
    req.session.ip = req.ip;
    req.session.userAgent = req.headers['user-agent'];

    await saveSession(req);

    console.log(`✅ 2FA enviado para ${email}`);
    return res.json({
      success: true,
      requiresTwoFactor: true,
      tempToken: sendResult.tempToken,
    });
  } catch (err) {
    console.error('Erro em /auth/login:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }
});

// ============================================================
// /verify-2fa — valida código e conclui autenticação
// ============================================================
router.post('/verify-2fa', async (req, res) => {
  const { tempToken, code } = req.body || {};
  const userId = req.session?.userId;   // e-mail (definido no /login)
  const storedToken = req.session?.tempToken;

  if (!userId || !storedToken) {
    return res.status(400).json({ success: false, error: 'Sessão inválida.' });
  }
  if (!code) {
    return res.status(400).json({ success: false, error: 'Código é obrigatório' });
  }
  // Se o frontend mandar o tempToken, validamos contra o da sessão.
  // (Protege contra reuso de código em outra sessão.)
  if (tempToken && tempToken !== storedToken) {
    return res.status(401).json({ success: false, error: 'Token de verificação inválido.' });
  }

  try {
    const verification = twoFactorService.verifyCode(userId, code);
    if (!verification.success) {
      return res.status(401).json({ success: false, error: verification.error || 'Código inválido' });
    }

    // Promove a sessão para autenticada
    delete req.session.tempToken;
    req.session.isAuthenticated = true;

    await saveSession(req);

    // Busca dados frescos do usuário
    const row = await findUserByEmail(userId);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    const userPayload = buildUserPayload(row);

    // accessToken é opcional (frontend atual não usa, mas mantemos compat)
    const accessToken = crypto.randomBytes(32).toString('hex');

    return res.json({
      success: true,
      accessToken,
      user: userPayload,
    });
  } catch (err) {
    console.error('Erro em /auth/verify-2fa:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }
});

// ============================================================
// /resend-code — reenvia código 2FA
// ============================================================
router.post('/resend-code', async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Sessão inválida' });
  }

  try {
    const row = await findUserByEmail(userId);
    if (!row) {
      return res.status(404).json({ success: false, error: 'Usuário não encontrado' });
    }

    const result = await twoFactorService.resendCode(row.email, row.nome);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error || 'Erro ao reenviar código' });
    }

    // Atualiza o tempToken na sessão (se o serviço gerar um novo)
    if (result.tempToken) {
      req.session.tempToken = result.tempToken;
      await saveSession(req);
    }

    return res.json({ success: true, tempToken: result.tempToken });
  } catch (err) {
    console.error('Erro em /auth/resend-code:', err);
    return res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// /logout — destrói a sessão
// ============================================================
router.post('/logout', (req, res) => {
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

// ============================================================
// /forgot-password — envia código de recuperação
// ============================================================
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ success: false, error: 'E-mail é obrigatório' });
  }

  try {
    const row = await findUserByEmail(email);
    if (!row) {
      return res.status(404).json({ success: false, error: 'E-mail não encontrado ou sem permissão.' });
    }

    const sendResult = await twoFactorService.sendPasswordResetCode(row.email, row.nome);
    if (!sendResult.success) {
      return res.status(500).json({ success: false, error: sendResult.error || 'Erro ao enviar código' });
    }

    // Guarda o e-mail como chave do reset (consistente com server.js)
    req.session.resetEmail = row.email;
    req.session.resetName = row.email;   // chave usada no verifyPasswordResetCode

    await saveSession(req);

    return res.json({ success: true, message: 'Código de recuperação enviado para o e-mail.' });
  } catch (err) {
    console.error('Erro em /auth/forgot-password:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// ============================================================
// /verify-reset-code — valida código e gera resetToken
// ============================================================
router.post('/verify-reset-code', async (req, res) => {
  const { email, code } = req.body || {};

  if (!email || !code) {
    return res.status(400).json({ success: false, error: 'E-mail e código são obrigatórios' });
  }

  const resetName = req.session?.resetName;
  const storedEmail = req.session?.resetEmail;

  if (!resetName || !storedEmail || storedEmail !== email) {
    return res.status(400).json({
      success: false,
      error: 'Sessão de recuperação inválida ou e-mail divergente.',
    });
  }

  try {
    const verification = twoFactorService.verifyPasswordResetCode(resetName, code);
    if (!verification.success) {
      return res.status(401).json({ success: false, error: verification.error || 'Código inválido' });
    }

    req.session.resetToken = verification.resetToken;
    await saveSession(req);

    return res.json({ success: true, resetToken: verification.resetToken });
  } catch (err) {
    console.error('Erro em /auth/verify-reset-code:', err);
    return res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// /reset-password — atualiza a senha
// ============================================================
router.post('/reset-password', async (req, res) => {
  const { resetToken, newPassword } = req.body || {};

  const storedToken = req.session?.resetToken;
  const email = req.session?.resetEmail;

  if (!email || !storedToken || storedToken !== resetToken) {
    return res.status(401).json({ success: false, error: 'Token inválido ou sessão expirada' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ success: false, error: 'A senha deve ter pelo menos 6 caracteres' });
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const updateResult = await pool.query(
      `UPDATE app_comissionamento.metricas_assessores
          SET senha_colaborador_hash = $1,
              updated_at = NOW()
        WHERE LOWER(TRIM(email)) = LOWER(TRIM($2))
        RETURNING id_assessor`,
      [hashedPassword, email]
    );

    if (updateResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Assessor não encontrado' });
    }

    // Limpa dados de reset
    delete req.session.resetToken;
    delete req.session.resetEmail;
    delete req.session.resetName;

    await saveSession(req);

    return res.json({ success: true, message: 'Senha redefinida com sucesso' });
  } catch (err) {
    console.error('Erro em /auth/reset-password:', err);
    return res.status(500).json({ success: false, error: 'Erro ao atualizar senha' });
  }
});

export default router;