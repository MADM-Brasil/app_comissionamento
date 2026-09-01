// backend/routes/auth.js
import express from 'express';
import bcrypt from 'bcrypt';
import twoFactorService from '../services/twoFactorService.js';
import { pool } from '../services/db.js';
import crypto from 'crypto';

const router = express.Router();
console.log('✅ [AUTH] Módulo de autenticação carregado');

// ============================================================
// ROTA DE TESTE (para diagnóstico)
// ============================================================
router.get('/test', (req, res) => {
  console.log('🔍 Rota /auth/test foi chamada');
  res.json({ success: true, message: 'Rota auth/test funcionando' });
});

// ============================================================
// ROTA PARA VERIFICAR SESSÃO ATIVA
// ============================================================
router.get('/me', (req, res) => {
  if (req.session.user) {
    return res.json({
      success: true,
      user: req.session.user
    });
  }
  return res.status(401).json({ success: false, error: 'Não autenticado' });
});

// ============================================================
// ROTA DE LOGIN (com suporte a rememberMe)
// ============================================================
router.post('/login', async (req, res) => {
  console.log('🔐 [LOGIN] Rota /login foi chamada');
  const { email, password, rememberMe } = req.body;

  const gruposPermitidos = [
    'Elite', 'Supervisor', 'Análise de segurado', 'Concomitante',
    'Salesops', 'Quinquenio', 'Quinquênio ',
    'Coordenador', 'CEO', 'Diretoria'
  ];

  console.log(`🔐 Tentativa de login: email=${email}, rememberMe=${rememberMe}`);

  try {
    const result = await pool.query(
      `SELECT 
          a.id_assessor,
          c.email,
          c.nome,
          a.senha_colaborador_hash,
          c.nome_equipe,
          c.cargo,
          c.status,
          c.periodo
       FROM app_comissionamento.view_app_metricas_assessores a
       INNER JOIN core.view_app_colaboradores c 
           ON LOWER(TRIM(a.email)) = LOWER(TRIM(c.email))
       WHERE LOWER(TRIM(a.email)) = LOWER(TRIM($1))
         AND TRIM(c.cargo) = ANY($2)`,
      [email, gruposPermitidos]
    );

    const user = result.rows[0];
    if (!user) {
      console.log(`❌ Login falhou: usuário não encontrado para ${email}`);
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    console.log(`👤 Usuário encontrado: ${user.nome}, cargo="${user.cargo}", status=${user.status}`);

    const match = await bcrypt.compare(password, user.senha_colaborador_hash);
    if (!match) {
      console.log(`❌ Login falhou: senha incorreta para ${email}`);
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    // Define duração da sessão
    if (rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 dias
      req.session.cookie.expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      console.log('🔑 Sessão estendida para 30 dias (rememberMe ativo)');
    } else {
      req.session.cookie.maxAge = 24 * 60 * 60 * 1000; // 1 dia
      req.session.cookie.expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      console.log('🔑 Sessão padrão de 1 dia (rememberMe desativado)');
    }

    // Dados temporários para 2FA
    req.session.tempUser = {
      id_assessor: user.id_assessor,
      email: user.email,
      nome: user.nome,
      nome_equipe: user.nome_equipe,
      cargo: user.cargo,
      status: user.status,
      periodo: user.periodo
    };

    // Envia código 2FA
    const sendResult = await twoFactorService.sendCode(user.email, user.nome);
    if (!sendResult.success) {
      console.log(`❌ Falha ao enviar código 2FA: ${sendResult.error}`);
      return res.status(500).json({ success: false, error: sendResult.error });
    }

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
// VERIFICAÇÃO 2FA
// ============================================================
router.post('/verify-2fa', async (req, res) => {
  const { tempToken, code } = req.body;
  const verification = twoFactorService.verifyCode(tempToken, code);
  if (!verification.success) {
    return res.status(401).json({ success: false, error: verification.error });
  }
  const user = req.session.tempUser;
  if (!user) {
    return res.status(401).json({ success: false, error: 'Sessão expirada' });
  }
  req.session.user = user;
  delete req.session.tempUser;
  const accessToken = crypto.randomBytes(32).toString('hex');

  req.session.save((err) => {
    if (err) {
      console.error('Erro ao salvar sessão no verify-2fa:', err);
      return res.status(500).json({ success: false, error: 'Erro interno' });
    }
    res.json({
      success: true,
      accessToken,
      user: {
        id: user.id_assessor,
        name: user.nome,
        email: user.email,
        equipe: user.nome_equipe,
        grupo: user.cargo,
        status: user.status,
        periodo: user.periodo
      }
    });
  });
});

// ============================================================
// REENVIO DE CÓDIGO 2FA
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
// LOGOUT
// ============================================================
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Erro ao destruir sessão:', err);
    res.json({ success: true });
  });
});

// ============================================================
// RECUPERAÇÃO DE SENHA (usando e‑mail)
// ============================================================

// 1. Envia código de recuperação
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, error: 'E-mail é obrigatório' });
  }

  const gruposPermitidos = [
    'Elite', 'Supervisor', 'Análise de segurado', 'Concomitante',
    'Salesops', 'Quinquenio', 'Quinquênio ',
    'Coordenador', 'CEO', 'Diretoria'
  ];

  try {
    // ✅ CORRIGIDO: busca por e-mail sem exigir período
    const result = await pool.query(
      `SELECT 
          c.nome,
          a.email
       FROM app_comissionamento.view_app_metricas_assessores a
       INNER JOIN core.view_app_colaboradores c 
           ON LOWER(TRIM(a.email)) = LOWER(TRIM(c.email))
       WHERE LOWER(TRIM(a.email)) = LOWER(TRIM($1))
         AND TRIM(c.cargo) = ANY($2)`,
      [email, gruposPermitidos]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'E-mail não encontrado ou sem permissão.' });
    }

    const user = result.rows[0];
    const userId = user.nome;
    const userEmail = user.email;

    const sendResult = await twoFactorService.sendPasswordResetCode(userEmail, userId);
    if (!sendResult.success) {
      return res.status(500).json({ success: false, error: sendResult.error });
    }

    req.session.resetEmail = email;
    req.session.resetName = userId;

    res.json({ success: true, message: 'Código de recuperação enviado para o e-mail.' });
  } catch (err) {
    console.error('Erro em forgot-password:', err);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// 2. Verifica o código e gera token de reset
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

    req.session.save((err) => {
      if (err) {
        console.error('Erro ao salvar sessão:', err);
        return res.status(500).json({ success: false, error: 'Erro interno' });
      }
      res.json({ success: true, resetToken: verification.resetToken });
    });
  } catch (err) {
    console.error('Erro em verify-reset-code:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// 3. Redefine a senha – UPDATE 
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
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // UPDATE na tabela original (não na view)
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

    // Limpa a sessão
    delete req.session.resetToken;
    delete req.session.resetEmail;
    delete req.session.resetName;

    req.session.save((err) => {
      if (err) console.error('Erro ao salvar sessão após reset:', err);
      res.json({ success: true, message: 'Senha redefinida com sucesso' });
    });
  } catch (err) {
    console.error('Erro em reset-password:', err);
    res.status(500).json({ success: false, error: 'Erro ao atualizar senha' });
  }
});

export default router;