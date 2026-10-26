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
// Regra: nível >= JURIDICO (inclui Analista/Coordenador/Supervisor
// Jurídico, Assessor, Supervisão, Coordenador, Admin, Super Admin).
// ============================================================
function cargoPermitido(cargo, status) {
  if (!cargo) return false;
  if (status && accessControl.normalize(status) === 'desativado') return false;
  const level = accessControl.getCargoLevel(cargo);
  if (level === undefined) return false;
  return level >= accessControl.LEVELS.JURIDICO;
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

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
    unidade_id: row.unidade_id != null ? Number(row.unidade_id) : null,
    accessLevel: levelName,
  };
}

router.get('/test', (req, res) => {
  console.log('🔍 Rota /auth/test foi chamada');
  res.json({ success: true, message: 'Rota auth/test funcionando' });
});

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
    const result = await pool.query(
      `SELECT
          m.id_assessor,
          c.email,
          c.nome,
          m.senha_colaborador_hash,
          c.nome_equipe,
          c.cargo,
          c.status,
          c.periodo,
          c.unidade_id
       FROM core.view_app_colaboradores c
       INNER JOIN app_comissionamento.metricas_assessores m
           ON LOWER(TRIM(m.email)) = LOWER(TRIM(c.email))
       WHERE LOWER(TRIM(c.email)) = LOWER(TRIM($1))
       LIMIT 1`,
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
      console.log(`🚫 Login negado: cargo="${user.cargo}" status="${user.status}" nível=${levelName}`);
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    // Se existe em metricas_assessores mas sem hash (raro):
    // sinaliza primeiro acesso para o frontend.
    if (!user.senha_colaborador_hash) {
      console.log(`⚠️  Login: ${email} existe em metricas_assessores mas sem hash.`);
      return res.status(409).json({
        success: false,
        error: 'Conta sem senha cadastrada. Use "Esqueci minha senha" para definir a senha inicial.',
        code: 'FIRST_ACCESS',
      });
    }

    const match = await bcrypt.compare(password, user.senha_colaborador_hash);
    if (!match) {
      console.log(`❌ Login falhou: senha incorreta para ${email}`);
      return res.status(401).json({ success: false, error: 'Credenciais inválidas' });
    }

    if (rememberMe) {
      req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
      req.session.cookie.expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      console.log('🔑 Sessão estendida para 30 dias (rememberMe ativo)');
    } else {
      req.session.cookie.maxAge = 24 * 60 * 60 * 1000;
      req.session.cookie.expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      console.log('🔑 Sessão padrão de 1 dia (rememberMe desativado)');
    }

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
    console.log(`🚫 [2FA] autorização revogada para ${user.email}`);
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

  console.log(`✅ [2FA] usuário autenticado: ${user.email} (cargo=${user.cargo})`);
  return res.json({ success: true, accessToken, user: buildPublicUser(user) });
});

router.post('/resend-code', async (req, res) => {
  const user = req.session.tempUser;
  if (!user) return res.status(401).json({ success: false, error: 'Sessão inválida' });
  const sendResult = await twoFactorService.resendCode(user.nome, user.email);
  if (!sendResult.success) return res.status(500).json({ success: false, error: sendResult.error });
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Erro ao destruir sessão:', err);
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// ============================================================
// /forgot-password — envia código (reset OU primeiro acesso)
//
// REGRA ATUAL:
//   - Colaborador existe em view_app_colaboradores + cargo/status
//     permitidos → SEMPRE envia o código.
//   - Se NÃO tem hash em metricas_assessores → marca
//     `resetFirstAccess = true`. O /reset-password criará a senha.
//   - Se tem hash → fluxo tradicional de reset.
// ============================================================
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, error: 'E-mail é obrigatório' });
  }

  try {
    const result = await pool.query(
      `SELECT
          c.nome,
          c.email,
          c.cargo,
          c.status,
          m.id_assessor,
          (m.senha_colaborador_hash IS NOT NULL) AS tem_senha
       FROM core.view_app_colaboradores c
       LEFT JOIN app_comissionamento.metricas_assessores m
           ON LOWER(TRIM(m.email)) = LOWER(TRIM(c.email))
       WHERE LOWER(TRIM(c.email)) = LOWER(TRIM($1))
       LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      console.log(`[forgot-password] Colaborador não encontrado em view_app_colaboradores: ${email}`);
      return res.status(404).json({ success: false, error: 'E-mail não encontrado ou sem permissão.' });
    }

    const user = result.rows[0];

    if (!cargoPermitido(user.cargo, user.status)) {
      const level = accessControl.getAccessLevel(user.cargo, user.status);
      console.log(
        `[forgot-password] Cargo bloqueado: email=${email} cargo="${user.cargo}" ` +
        `status="${user.status}" nivel=${accessControl.getLevelName(level)}`
      );
      return res.status(404).json({ success: false, error: 'E-mail não encontrado ou sem permissão.' });
    }

    const isFirstAccess = !user.tem_senha;
    const userId = user.nome;
    const userEmail = user.email;

    const sendResult = await twoFactorService.sendPasswordResetCode(userEmail, userId);
    if (!sendResult.success) {
      console.log(`[forgot-password] Falha ao enviar código: ${sendResult.error}`);
      return res.status(500).json({ success: false, error: sendResult.error });
    }

    req.session.resetEmail = email;
    req.session.resetName = userId;
    // Guarda o contexto para o /reset-password decidir INSERT x UPDATE
    // e revalidar cargo/status (defesa contra desativação entre etapas).
    req.session.resetFirstAccess = isFirstAccess;
    req.session.resetCargo = user.cargo;
    req.session.resetStatus = user.status;

    await saveSession(req);

    console.log(
      `[forgot-password] Código enviado para ${email} ` +
      `(firstAccess=${isFirstAccess}, cargo="${user.cargo}")`
    );

    res.json({
      success: true,
      message: isFirstAccess
        ? 'Enviamos um código de verificação. Ao confirmá-lo, você definirá sua senha de primeiro acesso.'
        : 'Código de recuperação enviado para o e-mail.',
      isFirstAccess,
    });
  } catch (err) {
    console.error('Erro em forgot-password:', err);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

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

    res.json({
      success: true,
      resetToken: verification.resetToken,
      isFirstAccess: Boolean(req.session.resetFirstAccess),
    });
  } catch (err) {
    console.error('Erro em verify-reset-code:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// /reset-password — define a senha (UPDATE ou INSERT)
//
//   - Se já existe linha em metricas_assessores → UPDATE.
//   - Se NÃO existe (primeiro acesso JURIDICO etc.) → INSERT
//     usando id_assessor de view_app_colaboradores.
//
// Defesas:
//   - Exige resetToken válido na sessão.
//   - Revalida cargoPermitido usando o cargo/status capturado em
//     /forgot-password (protege contra desativação no meio do fluxo).
// ============================================================
router.post('/reset-password', async (req, res) => {
  const { resetToken, newPassword } = req.body;

  const storedToken = req.session.resetToken;
  const email = req.session.resetEmail;
  const resetCargo = req.session.resetCargo;
  const resetStatus = req.session.resetStatus;

  if (!email || !storedToken || storedToken !== resetToken) {
    return res.status(401).json({ success: false, error: 'Token inválido ou sessão expirada' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ success: false, error: 'A senha deve ter pelo menos 6 caracteres' });
  }
  if (!cargoPermitido(resetCargo, resetStatus)) {
    return res.status(403).json({ success: false, error: 'Cadastro não autorizado a definir senha.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // 1) Tenta UPDATE (fluxo tradicional de reset)
    const updateResult = await pool.query(
      `UPDATE app_comissionamento.metricas_assessores
       SET senha_colaborador_hash = $1, updated_at = NOW()
       WHERE LOWER(TRIM(email)) = LOWER(TRIM($2))
       RETURNING id_assessor`,
      [hashedPassword, email]
    );

    if (updateResult.rowCount === 0) {
      // 2) Primeiro acesso — INSERT
      const colab = await pool.query(
        `SELECT id_assessor, nome FROM core.view_app_colaboradores
         WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1`,
        [email]
      );
      if (colab.rowCount === 0) {
        console.log(`[reset-password] Colaborador não encontrado em view_app_colaboradores: ${email}`);
        return res.status(404).json({ success: false, error: 'Colaborador não encontrado.' });
      }
      const { id_assessor, nome } = colab.rows[0];

      await pool.query(
        `INSERT INTO app_comissionamento.metricas_assessores
           (id_assessor, email, nome, senha_colaborador_hash, updated_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [id_assessor, email, nome, hashedPassword]
      );
      console.log(`[reset-password] Primeiro acesso: senha criada para ${email} (id_assessor=${id_assessor}).`);
    } else {
      console.log(`[reset-password] Senha atualizada para ${email}.`);
    }

    delete req.session.resetToken;
    delete req.session.resetEmail;
    delete req.session.resetName;
    delete req.session.resetFirstAccess;
    delete req.session.resetCargo;
    delete req.session.resetStatus;

    await saveSession(req);

    res.json({ success: true, message: 'Senha definida com sucesso' });
  } catch (err) {
    console.error('Erro em reset-password:', err);
    res.status(500).json({ success: false, error: 'Erro ao atualizar senha' });
  }
});

export default router;