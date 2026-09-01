// src/lib/passwordRecovery.ts
const API_BASE = import.meta.env.VITE_API_URL || '/api';

async function handleResponse(response: Response, defaultErrorMessage: string) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || defaultErrorMessage);
  }
  return data;
}

export async function requestPasswordReset(email: string) {
  const response = await fetch(`${API_BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
    credentials: 'include', // ✅ garante envio do cookie de sessão
  });
  return handleResponse(response, 'Erro ao enviar código de recuperação.');
}

export async function verifyResetCode(email: string, code: string) {
  const response = await fetch(`${API_BASE}/auth/verify-reset-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
    credentials: 'include', // ✅ garante envio do cookie de sessão
  });
  return handleResponse(response, 'Erro ao verificar código.');
}

export async function resetPassword(resetToken: string, newPassword: string) {
  const response = await fetch(`${API_BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resetToken, newPassword }),
    credentials: 'include', // ✅ garante envio do cookie de sessão
  });
  return handleResponse(response, 'Erro ao redefinir senha.');
}