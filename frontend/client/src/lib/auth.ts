// src/lib/auth.ts
import { useAppStore } from "@/lib/dataStore";

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3007/api';

export interface UserData {
  id: string;               // e‑mail (identificador único)
  nome: string;
  email: string;
  equipe: string;           // nome_equipe
  cargo: string;            // cargo/grupo
  status: string;
  periodo: string;
}

// ============================================================
// FUNÇÃO AUXILIAR – obtém o token CSRF (busca se não existir)
// ============================================================
async function ensureCsrfToken(): Promise<string> {
  let token = localStorage.getItem('csrfToken');
  if (token) return token;

  try {
    const res = await fetch(`${API_BASE}/csrf-token`, { credentials: 'include' });
    const data = await res.json();
    if (data.csrfToken && data.csrfToken !== 'disabled') {
      localStorage.setItem('csrfToken', data.csrfToken);
      return data.csrfToken;
    }
  } catch (e) {
    console.warn('⚠️ Não foi possível obter CSRF token:', e);
  }
  return '';
}

function getCsrfToken(): string {
  return localStorage.getItem('csrfToken') || '';
}

// ============================================================
// FUNÇÃO AUXILIAR – trata a resposta da API
// ============================================================
async function handleApiResponse(response: Response, defaultMessage: string) {
  const contentLength = response.headers.get('content-length');
  if (contentLength === '0' || response.status === 204) {
    if (response.status === 403) {
      throw new Error('Token CSRF inválido ou ausente. Recarregue a página e tente novamente.');
    }
    return {};
  }

  let data;
  try {
    data = await response.json();
  } catch (e) {
    const text = await response.text();
    console.error('❌ Resposta não é JSON:', text.substring(0, 200));
    throw new Error(`Resposta inválida do servidor: ${text.substring(0, 100)}`);
  }

  if (!response.ok) {
    throw new Error(data.error || defaultMessage || `Erro ${response.status}`);
  }

  if (data.success === false) {
    throw new Error(data.error || defaultMessage);
  }

  return data;
}

// ============================================================
// LOGIN – envia credenciais e recebe tempToken para 2FA
// ============================================================
export async function login(email: string, password: string, rememberMe: boolean = false) {
  await ensureCsrfToken();

  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': getCsrfToken(),
    },
    credentials: 'include',
    body: JSON.stringify({ email, password, rememberMe }),
  });

  return handleApiResponse(response, 'Erro no login');
}

// ============================================================
// VERIFICAÇÃO 2FA – valida o código e autentica a sessão
// ============================================================
export async function verify2FA(tempToken: string, code: string) {
  await ensureCsrfToken();

  const response = await fetch(`${API_BASE}/auth/verify-2fa`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': getCsrfToken(),
    },
    credentials: 'include',
    body: JSON.stringify({ tempToken, code }),
  });

  const data = await handleApiResponse(response, 'Código inválido');

  if (data.user) {
    // Garante que o objeto tenha o campo 'cargo' (mesmo que a API envie 'grupo' por compatibilidade)
    const normalizedUser = {
      ...data.user,
      cargo: data.user.cargo || data.user.grupo,   // fallback seguro
      id: data.user.id || data.user.email || '',
    };
    useAppStore.getState().setCurrentUser(normalizedUser);

    // Dispara o carregamento de dados em segundo plano (não bloqueia o redirecionamento)
    const { loadCollaboratorsAndMetrics, loadRawMetrics } = useAppStore.getState();
    Promise.all([
      loadCollaboratorsAndMetrics(),
      loadRawMetrics()
    ]).catch(err => console.error('Erro ao carregar dados:', err));
  }

  return data;
}

// ============================================================
// REENVIO DE CÓDIGO 2FA
// ============================================================
export async function resendCode() {
  await ensureCsrfToken();

  const response = await fetch(`${API_BASE}/auth/resend-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-csrf-token': getCsrfToken(),
    },
    credentials: 'include',
    body: JSON.stringify({}),
  });

  return handleApiResponse(response, 'Erro ao reenviar código');
}

// ============================================================
// VERIFICA SE A SESSÃO JÁ ESTÁ ATIVA (rota /auth/me)
// ============================================================
export async function fetchCurrentUser(): Promise<UserData | null> {
  await ensureCsrfToken();
  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      method: 'GET',
      headers: { 'x-csrf-token': getCsrfToken() },
      credentials: 'include',
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data.success && data.user) {
      const normalizedUser = {
        ...data.user,
        cargo: data.user.cargo || data.user.grupo,
        id: data.user.id || data.user.email || '',
      };
      useAppStore.getState().setCurrentUser(normalizedUser);
      return normalizedUser;
    }
    return null;
  } catch (e) {
    console.error('Erro ao verificar sessão:', e);
    return null;
  }
}

// ============================================================
// LOGOUT – destrói a sessão e limpa dados locais
// ============================================================
export async function logout() {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: {
        'x-csrf-token': getCsrfToken(),
      },
      credentials: 'include',
    });
  } catch (e) {
    // ignora
  }

  // Limpa apenas o CSRF token e a persistência do Zustand – a sessão é destruída no backend
  localStorage.removeItem('csrfToken');
  localStorage.removeItem('madm-storage');
  sessionStorage.clear();
  useAppStore.getState().resetStore();
}