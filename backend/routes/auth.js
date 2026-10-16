// backend/routes/auth.js
import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import twoFactorService from '../services/twoFactorService.js';
import { pool } from '../services/db.js';
import { accessControl } from '../services/access-control.js';

const router = express.Router();
console.log('✅ [AUTH] Módulo de autenticação carregado');

// ============================================================
// AUTORIZAÇÃO DE CARGO — fonte única de verdade: access-control.js
// ============================================================
function cargoPermitido(cargo, status) {
  if (!cargo) return false;

  if (status && accessControl.normalize(status) === 'desativado') {
    return false;
  }

  const level = accessControl.getCargoLevel(cargo);
  if (level === undefined) return false;
  return level >= accessControl.LEVELS.ASSESSOR;
}

// ============================================================
// HELPER — salva sessão e devolve Promise
// ============================================================
function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

// ============================================================
// HELPER — monta o objeto `user` padronizado devolvido ao front.
// Centraliza a lista de campos para não esquecer nenhum.
// ============================================================
function buildPublicUser(row) {
  const level = accessControl.getAccessLevel(row.cargo, row.status);
  const levelName = accessControl.getLevelName(level);

  return {
    id: row.id_assessor ?? row.id ?? null,
    name: row.nome,
    nome: row.nome,
    email: row.email,
    equipe: row.nome_equipe,
    nome_equipe: row.nome_equipe,
    grupo: row.cargo,
    cargo: row.cargo,
    status: row.status,
    periodo: row.periodo,
    unidade_id: row.unidade_id != null ? Number(row.unidade_id) : null, // ✅
    accessLevel: levelName,
  };
}

// ============================================================
// ROTA DE TESTE
// ============================================================
router.get('/test', (req, res) => {
  console.log('🔍 Rota /auth/test foi chamada');
  res.json({ success: true, message: 'Rota auth/test funcionando' });
});

// ============================================================
// /me — verifica sessão ativa
//
// Devolve o usuário da sessão. Como a sessão é populada no 2FA
// com o objeto completo (incluindo unidade_id), este endpoint
// reflete os dados corretos sem precisar de query extra.
// ============================================================
router.get('/me', (req, res) => {
  if (req.session.user) {
    return res.json({ success: true, user: req.session.user });
  }
  return res.status(401).json({ success: false, error: 'Não autenticado' });
});

// ============================================================
// /login — valida senha e envia 2FA
// ============================================================
router.post('/login', async (req, res) => {
  console.log('🔐 [LOGIN] Rota /login foi chamada');
  const { email, password, rememberMe } = req.body;
  console.log(`🔐 Tentativa de login: email=${email}, rememberMe=${rememberMe}`);

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'E-mail e senha são obrigatórios' });
  }

  try {
    // ✅ Inclui c.unidade_id no SELECT
    const result = await pool.query(
      `SELECT 
          a.id_assessor,
          c.email,
          c.nome,
          a.senha_colaborador_hash,
          c.nome_equipe,
          c.cargo,
          c.status,
          c.periodo,
          c.unidade_id
       FROM app_comissionamento.view_app_metricas_assessores a
       INNER JOIN core.view_app_colaboradores c 
           ON LOWER(TRIM(a.email)) = LOWER(TRIM(c.email))
       WHERE LOWER(TRIM(a.email)) = LOWER(TRIM($1))`,
      [email]
    );

    const user = result.rows[0];
    if (!user) {
      console.log(`❌ Login falhou: usuário não encontrado para ${email}`);
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    if (!cargoPermitido(user.cargo, user.status)) {
      const level = accessControl.getCargoLevel(user.cargo);
      const levelName = accessControl.getLevelName(level ?? accessControl.LEVELS.NONE);
      console.log(
        `🚫 Login negado: cargo="${user.cargo}" status="${user.status}" ` +
        `nível=${levelName}`
      );
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    console.log(
      `👤 Usuário encontrado: ${user.nome}, cargo="${user.cargo}", ` +
      `status=${user.status}, unidade_id=${user.unidade_id}`
    );

    const match = await bcrypt.compare(password, user.senha_colaborador_hash);
    if (!match) {
      console.log(`❌ Login falhou: senha incorreta para ${email}`);
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    // Duração da sessão
    if (rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
      req.session.cookie.expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      console.log('🔑 Sessão estendida para 30 dias (rememberMe ativo)');
    } else {
      req.session.cookie.maxAge = 24 * 60 * 60 * 1000;
      req.session.cookie.expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      console.log('🔑 Sessão padrão de 1 dia (rememberMe desativado)');
    }

    // ✅ tempUser agora inclui unidade_id
    req.session.tempUser = {
      id_assessor: user.id_assessor,
      email: user.email,
      nome: user.nome,
      nome_equipe: user.nome_equipe,
      cargo: user.cargo,
      status: user.status,
      periodo: user.periodo,
      unidade_id: user.unidade_id != null ? Number(user.unidade_id) : null,
    };
    req.session.userId = user.email;

    const sendResult = await twoFactorService.sendCode(user.email, user.nome);
    if (!sendResult.success) {
      console.log(`❌ Falha ao enviar código 2FA: ${sendResult.error}`);
      return res.status(500).json({ success: false, error: sendResult.error });
    }

    await saveSession(req);

    console.log(`✅ Código 2FA enviado para ${email}`);
    return res.json({ success: true, requiresTwoFactor: true, tempToken: user.nome });
  } catch (err) {
    console.error('Erro em /login:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: 'Erro interno' });
    }
  }
});

// ============================================================
// /verify-2fa — valida código e conclui autenticação
// ============================================================
router.post('/verify-2fa', async (req, res) => {
  const { tempToken, code } = req.body;

  const verification = twoFactorService.verifyCode(tempToken, code);
  if (!verification.success) {
    return res.status(401).json({ success: false, error: verification.error });
  }

  const user = req.session.tempUser;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Sessão expirada. Faça login novamente.' });
  }

  if (!cargoPermitido(user.cargo, user.status)) {
    console.log(`🚫 [2FA] autorização revogada para ${user.email} (cargo="${user.cargo}", status="${user.status}")`);
    return req.session.destroy(() =>
      res.status(401).json({ success: false, error: 'Acesso não autorizado' })
    );
  }

  req.session.user = user;
  req.session.userId = user.email;
  req.session.isAuthenticated = true;
  delete req.session.tempUser;

  const accessToken = crypto.randomBytes(32).toString('hex');

  await saveSession(req);

  console.log(
    `✅ [2FA] usuário autenticado: ${user.email} ` +
    `(cargo=${user.cargo}, unidade_id=${user.unidade_id ?? 'null'})`
  );

  // ✅ Resposta padronizada via buildPublicUser, incluindo unidade_id
  return res.json({
    success: true,
    accessToken,
    user: buildPublicUser(user),
  });
});

// ============================================================
// /resend-code — reenvia código 2FA
// ============================================================
router.post('/resend-code', async (req, res) => {
  const user = req.session.tempUser;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Sessão inválida' });
  }
  const sendResult = await twoFactorService.resendCode(user.nome, user.email);
  if (!sendResult.success) {
    return res.status(500).json({ success: false, error: sendResult.error });
  }
  res.json({ success: true });
});

// ============================================================
// /logout — destrói a sessão
// ============================================================
router.post('/logout', (req, res) => {
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
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, error: 'E-mail é obrigatório' });
  }

  try {
    const result = await pool.query(
      `SELECT c.nome, a.email, c.cargo, c.status
       FROM app_comissionamento.view_app_metricas_assessores a
       INNER JOIN core.view_app_colaboradores c 
           ON LOWER(TRIM(a.email)) = LOWER(TRIM(c.email))
       WHERE LOWER(TRIM(a.email)) = LOWER(TRIM($1))`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'E-mail não encontrado ou sem permissão.' });
    }

    const user = result.rows[0];

    if (!cargoPermitido(user.cargo, user.status)) {
      return res.status(404).json({ success: false, error: 'E-mail não encontrado ou sem permissão.' });
    }

    const userId = user.nome;
    const userEmail = user.email;

    const sendResult = await twoFactorService.sendPasswordResetCode(userEmail, userId);
    if (!sendResult.success) {
      return res.status(500).json({ success: false, error: sendResult.error });
    }

    req.session.resetEmail = email;
    req.session.resetName = userId;

    await saveSession(req);

    res.json({ success: true, message: 'Código de recuperação enviado para o e-mail.' });
  } catch (err) {
    console.error('Erro em forgot-password:', err);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// ============================================================
// /verify-reset-code — valida código e gera resetToken
// ============================================================
router.post('/verify-reset-code', async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    return res.status(400).json({ success: false, error: 'E-mail e código são obrigatórios' });
  }

  const resetName = req.session.resetName;
  const storedEmail = req.session.resetEmail;

  if (!resetName || storedEmail !== email) {
    return res.status(400).json({ success: false, error: 'Sessão de recuperação inválida ou e-mail divergente.' });
  }

  try {
    const verification = twoFactorService.verifyPasswordResetCode(resetName, code);
    if (!verification.success) {
      return res.status(401).json({ success: false, error: verification.error });
    }

    req.session.resetToken = verification.resetToken;
    await saveSession(req);

    res.json({ success: true, resetToken: verification.resetToken });
  } catch (err) {
    console.error('Erro em verify-reset-code:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// /reset-password — atualiza a senha
// ============================================================
router.post('/reset-password', async (req, res) => {
  const { resetToken, newPassword } = req.body;

  const storedToken = req.session.resetToken;
  const email = req.session.resetEmail;

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

    delete req.session.resetToken;
    delete req.session.resetEmail;
    delete req.session.resetName;

    await saveSession(req);

    res.json({ success: true, message: 'Senha redefinida com sucesso' });
  } catch (err) {
    console.error('Erro em reset-password:', err);
    res.status(500).json({ success: false, error: 'Erro ao atualizar senha' });
  }
});

export default router;