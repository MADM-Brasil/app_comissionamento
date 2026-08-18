// routes/passwordReset.js
import express from 'express';
import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();

// Configurações
const EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.gmail.com';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '587');
const EMAIL_USER = process.env.EMAIL_USER || 'felipe.oliveiramadm@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS || 'qkoduqxuqvkuvihq';
const JWT_SECRET = process.env.JWT_SECRET || 'sua-chave-secreta-mudar';
const CODE_EXPIRATION_MS = 10 * 60 * 1000; // 10 minutos

// Armazenamento temporário (use Redis ou banco em produção)
const resetCodes = new Map();

// Transporte do Nodemailer
const transporter = nodemailer.createTransport({
  host: EMAIL_HOST,
  port: EMAIL_PORT,
  secure: false,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

function generateResetCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendResetCodeEmail(toEmail, code) {
  const mailOptions = {
    from: `"MADM Brasil" <${EMAIL_USER}>`,
    to: toEmail,
    subject: '🔐 Código de recuperação de senha - MADM Brasil',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px;">
        <h2 style="color: #09175b;">Recuperação de senha</h2>
        <p>Seu código de verificação é:</p>
        <div style="background:#f4f4f4; padding:15px; font-size:28px; letter-spacing:5px; font-weight:bold; text-align:center;">
          ${code}
        </div>
        <p>Expira em 10 minutos.</p>
        <small>MADM Brasil - Segurança</small>
      </div>
    `,
  };
  await transporter.sendMail(mailOptions);
}

router.post('/request-reset', async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ message: 'E-mail é obrigatório' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: 'Formato de e-mail inválido' });
  }

  try {

    const code = generateResetCode();
    const expiresAt = Date.now() + CODE_EXPIRATION_MS;
    resetCodes.set(email, { code, expiresAt });
    await sendResetCodeEmail(email, code);

    setTimeout(() => {
      const stored = resetCodes.get(email);
      if (stored && stored.expiresAt === expiresAt) resetCodes.delete(email);
    }, CODE_EXPIRATION_MS);

    res.status(200).json({ message: 'Código enviado com sucesso' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Erro ao enviar e-mail' });
  }
});

router.post('/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ message: 'E-mail e código são obrigatórios' });
  }

  const record = resetCodes.get(email);
  if (!record) {
    return res.status(400).json({ message: 'Nenhum código solicitado para este e-mail' });
  }
  if (Date.now() > record.expiresAt) {
    resetCodes.delete(email);
    return res.status(400).json({ message: 'Código expirado. Solicite um novo.' });
  }
  if (record.code !== code) {
    return res.status(400).json({ message: 'Código inválido' });
  }

  const resetToken = jwt.sign(
    { email, purpose: 'password_reset' },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
  resetCodes.delete(email);
  res.status(200).json({ message: 'Código verificado', resetToken });
});

export default router;