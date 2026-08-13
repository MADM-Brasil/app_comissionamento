// backend/security/verif-2factory.js
import nodemailer from 'nodemailer';
import crypto from 'crypto';

// Armazenamento temporário dos códigos (chave: email ou userName, valor: { code, expires })
const codeStore = new Map();

// SendGrid – funciona em qualquer ambiente (inclusive Render)
const sendgridApiKey = process.env.SENDGRID_API_KEY || null;

// Credenciais SMTP (fallback)
const emailUser = process.env.EMAIL_USER;
const emailPass = process.env.EMAIL_PASS;
const hasSmtpCredentials = emailUser && emailPass;

let transporter;
if (hasSmtpCredentials) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: false,
    auth: {
      user: emailUser,
      pass: emailPass,
    },
  });
}

/**
 * Gera um código numérico de 6 dígitos
 */
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Envia e‑mail usando a API HTTP do SendGrid
 */
async function sendViaSendgrid(to, userName, code, isReset = false) {
  const url = 'https://api.sendgrid.com/v3/mail/send';
  const fromEmail = process.env.EMAIL_USER || 'noreply@madmbrasil.com';
  const subject = isReset ? 'Recuperação de senha - MADM Brasil' : 'Código de verificação - MADM Brasil';
  const html = isReset
    ? `<p>Olá ${userName || ''},</p>
       <p>Seu código de recuperação de senha é: <strong>${code}</strong></p>
       <p>Este código expira em 5 minutos.</p>`
    : `<p>Olá ${userName || ''},</p>
       <p>Seu código de verificação é: <strong>${code}</strong></p>
       <p>Este código expira em 5 minutos.</p>`;

  const data = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: fromEmail, name: 'MADM Brasil' },
    subject,
    content: [{ type: 'text/html', value: html }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sendgridApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SendGrid HTTP ${response.status}: ${errorText}`);
  }
}

/**
 * Envia o código de verificação por e‑mail.
 * Estratégia: SendGrid → SMTP → console
 */
async function sendCode(email, userName) {
  const code = generateCode();
  const expires = Date.now() + 5 * 60 * 1000; // 5 minutos
  codeStore.set(email, { code, expires });

  // 1. Tenta enviar via SendGrid
  if (sendgridApiKey) {
    try {
      await sendViaSendgrid(email, userName, code, false);
      console.log(`✅ [2FA] E-mail enviado via SendGrid para ${email}`);
      console.log(`📧 [2FA] Código: ${code}`);
      return { success: true, tempToken: email };
    } catch (err) {
      console.error(`❌ [2FA] SendGrid falhou: ${err.message}`);
    }
  }

  // 2. Tenta enviar via SMTP
  if (hasSmtpCredentials) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || `"MADM Brasil" <${emailUser}>`,
        to: email,
        subject: 'Código de verificação - MADM Brasil',
        html: `<p>Olá ${userName || ''},</p>
               <p>Seu código de verificação é: <strong>${code}</strong></p>
               <p>Este código expira em 5 minutos.</p>`,
      });
      console.log(`✅ [2FA] E-mail enviado via SMTP para ${email}`);
      console.log(`📧 [2FA] Código: ${code}`);
      return { success: true, tempToken: email };
    } catch (err) {
      console.error(`❌ [2FA] SMTP falhou: ${err.message}`);
    }
  }

  // 3. Fallback: console
  console.log(`📧 [2FA] Nenhum serviço de e‑mail disponível. Código para ${email}: ${code}`);
  return { success: true, tempToken: email };
}

/**
 * Envia código de recuperação de senha (reaproveita a lógica de envio, mas usa a chave userName)
 */
async function sendPasswordResetCode(email, userName) {
  const code = generateCode();
  const expires = Date.now() + 5 * 60 * 1000;
  // Usamos o userName como chave, conforme usado no verifyResetCode
  codeStore.set(userName, { code, expires });

  // 1. Tenta enviar via SendGrid
  if (sendgridApiKey) {
    try {
      await sendViaSendgrid(email, userName, code, true); // isReset = true
      console.log(`✅ [RESET] E-mail enviado via SendGrid para ${email}`);
      console.log(`📧 [RESET] Código: ${code}`);
      return { success: true, tempToken: userName };
    } catch (err) {
      console.error(`❌ [RESET] SendGrid falhou: ${err.message}`);
    }
  }

  // 2. Tenta SMTP
  if (hasSmtpCredentials) {
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || `"MADM Brasil" <${emailUser}>`,
        to: email,
        subject: 'Recuperação de senha - MADM Brasil',
        html: `<p>Olá ${userName || ''},</p>
               <p>Seu código de recuperação de senha é: <strong>${code}</strong></p>
               <p>Este código expira em 5 minutos.</p>`,
      });
      console.log(`✅ [RESET] E-mail enviado via SMTP para ${email}`);
      console.log(`📧 [RESET] Código: ${code}`);
      return { success: true, tempToken: userName };
    } catch (err) {
      console.error(`❌ [RESET] SMTP falhou: ${err.message}`);
    }
  }

  // 3. Console
  console.log(`📧 [RESET] Nenhum serviço de e‑mail disponível. Código para ${email}: ${code}`);
  return { success: true, tempToken: userName };
}

/**
 * Verifica se o código informado é válido e não expirou.
 */
function verifyCode(userId, code) {
  const entry = codeStore.get(userId);
  if (!entry) {
    return { success: false, error: 'Nenhum código encontrado. Solicite um novo.' };
  }
  if (Date.now() > entry.expires) {
    codeStore.delete(userId);
    return { success: false, error: 'Código expirado. Solicite um novo.' };
  }
  if (entry.code !== code) {
    return { success: false, error: 'Código inválido.' };
  }
  codeStore.delete(userId);
  return { success: true };
}

/**
 * Verifica o código de recuperação de senha e gera um token se válido.
 */
function verifyPasswordResetCode(userName, code) {
  const entry = codeStore.get(userName);
  if (!entry) {
    return { success: false, error: 'Nenhum código encontrado.' };
  }
  if (Date.now() > entry.expires) {
    codeStore.delete(userName);
    return { success: false, error: 'Código expirado.' };
  }
  if (entry.code !== code) {
    return { success: false, error: 'Código inválido.' };
  }
  codeStore.delete(userName);
  // Gera um token aleatório para autorizar o reset
  const resetToken = crypto.randomBytes(32).toString('hex');
  // Opcionalmente, poderia armazenar o token com expiração; mas usamos a sessão
  return { success: true, resetToken };
}

/**
 * Reenvia um novo código (remove o anterior e gera outro) – para 2FA.
 */
async function resendCode(userId, email) {
  codeStore.delete(userId);
  return sendCode(email, '');
}

/**
 * Remove o código do usuário.
 */
function clearCode(userId) {
  codeStore.delete(userId);
}

/**
 * Método mantido por compatibilidade.
 */
function stopTimer() {
  // Sem operação
}

export default {
  sendCode,
  verifyCode,
  resendCode,
  clearCode,
  stopTimer,
  sendPasswordResetCode,
  verifyPasswordResetCode,
};