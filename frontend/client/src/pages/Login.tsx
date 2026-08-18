// src/pages/Login.tsx
import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Eye, EyeOff, Shield, Mail, Lock, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import logoImg from "../components/img/logo.png";
import { login, verify2FA, resendCode } from "@/lib/auth";
import { useAppStore } from "@/lib/dataStore";
import { API_BASE } from "@/lib/api";

export default function Login() {
  const [step, setStep] = useState<"credentials" | "2fa">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [rememberMe, setRememberMe] = useState(false);
  const [, setLocation] = useLocation();

  const isSubmittingRef = useRef(false);
  const redirectDoneRef = useRef(false);

  // CSRF token on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/csrf-token`, { credentials: "include" });
        const data = await res.json();
        if (data.csrfToken && data.csrfToken !== "disabled") {
          localStorage.setItem("csrfToken", data.csrfToken);
        }
      } catch (_) {}
    })();
  }, []);

  // Redirect if already authenticated (e.g., session restored)
  useEffect(() => {
    const currentUser = useAppStore.getState().currentUser;
    if (currentUser?.email && !redirectDoneRef.current) {
      redirectDoneRef.current = true;
      setLocation("/");
    }
  }, [setLocation]);

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setError("");
    setIsLoading(true);

    try {
      const data = await login(email, password, rememberMe);
      if (data.requiresTwoFactor) {
        setTempToken(data.tempToken);
        setStep("2fa");
      } else {
        if (data.user) {
          useAppStore.getState().setCurrentUser(data.user);
          if (!redirectDoneRef.current) {
            redirectDoneRef.current = true;
            setLocation("/");
          }
        }
      }
    } catch (err: any) {
      setError(err.message || "Erro ao fazer login");
    } finally {
      setIsLoading(false);
      isSubmittingRef.current = false;
    }
  };

  const handleTwoFactorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current) return;
    if (!tempToken) {
      setError("Sessão expirada. Faça login novamente.");
      setStep("credentials");
      return;
    }
    isSubmittingRef.current = true;
    setError("");
    setIsLoading(true);

    try {
      await verify2FA(tempToken, twoFactorCode);
      // verify2FA already updates the store; now we redirect manually
      if (!redirectDoneRef.current) {
        redirectDoneRef.current = true;
        setLocation("/");
      }
    } catch (err: any) {
      setError(err.message || "Código inválido");
      isSubmittingRef.current = false; // allow retry
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!tempToken) {
      setError("Sessão inválida. Tente novamente.");
      setStep("credentials");
      return;
    }
    setError("");
    setIsLoading(true);
    try {
      await resendCode();
      alert("✅ Novo código enviado para seu e-mail.");
    } catch (err: any) {
      setError(err.message || "Erro ao reenviar código.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8f9fc] flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-24 h-24 mx-auto mb-4">
            <img src={logoImg} alt="MADM Brasil" className="w-full h-full object-cover rounded-2xl shadow-md" />
          </div>
          <h1 className="text-2xl font-black text-[#09175b]">MADM Brasil</h1>
        </div>

        <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
          <div className="px-6 pt-6 pb-2">
            <h2 className="text-xl font-bold text-gray-800">
              {step === "credentials" ? "Acesse sua conta" : "Verificação em duas etapas"}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              {step === "credentials"
                ? "Insira suas credenciais para continuar"
                : `Digite o código de 6 dígitos enviado para ${email}`}
            </p>
          </div>

          <div className="p-6">
            {step === "credentials" ? (
              <form onSubmit={handleCredentialsSubmit} className="space-y-4">
                {/* Email field */}
                <div>
                  <label htmlFor="email" className="block text-xs font-semibold text-gray-600 mb-1">E-mail</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#09175b]/20"
                      placeholder="seu@madmbrasil.com"
                      required
                      autoFocus
                    />
                  </div>
                </div>

                {/* Password field */}
                <div>
                  <label htmlFor="password" className="block text-xs font-semibold text-gray-600 mb-1">Senha</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full pl-9 pr-10 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#09175b]/20"
                      placeholder="••••••••"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Remember me */}
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="rememberMe"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="w-4 h-4 text-[#09175b] border-gray-300 rounded focus:ring-[#09175b]"
                  />
                  <label htmlFor="rememberMe" className="text-xs text-gray-600 cursor-pointer">
                    Lembrar‑me
                  </label>
                </div>

                {error && <p className="text-red-500 text-xs">{error}</p>}

                <button
                  type="submit"
                  disabled={isLoading}
                  className={cn(
                    "w-full py-2.5 rounded-lg text-sm font-semibold text-white transition-all",
                    isLoading ? "bg-gray-400 cursor-not-allowed" : "bg-[#09175b] hover:opacity-90"
                  )}
                >
                  {isLoading ? "Entrando..." : "Entrar"}
                </button>

                <div className="text-center">
                  <p className="text-[13px] text-gray-500">
                    Esqueceu a senha?{" "}
                    <button
                      type="button"
                      onClick={() => setLocation("/forgot-password")}
                      className="text-[#09175b] hover:underline font-medium"
                    >
                      Clique aqui
                    </button>
                  </p>
                </div>
              </form>
            ) : (
              <form onSubmit={handleTwoFactorSubmit} className="space-y-4">
                <div>
                  <label htmlFor="2fa-code" className="block text-xs font-semibold text-gray-600 mb-1">Código de verificação</label>
                  <div className="relative">
                    <Shield className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <input
                      id="2fa-code"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={twoFactorCode}
                      onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, ""))}
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#09175b]/20"
                      placeholder="000000"
                      required
                      autoFocus
                    />
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1 flex items-center gap-1">
                    <Mail className="w-3 h-3" />
                    Enviamos um código para {email}
                  </p>
                </div>

                {error && <p className="text-red-500 text-xs">{error}</p>}

                <button
                  type="submit"
                  disabled={isLoading}
                  className={cn(
                    "w-full py-2.5 rounded-lg text-sm font-semibold text-white transition-all",
                    isLoading ? "bg-gray-400 cursor-not-allowed" : "bg-[#09175b] hover:opacity-90"
                  )}
                >
                  {isLoading ? "Verificando..." : "Verificar código"}
                </button>

                <div className="flex justify-between items-center">
                  <button
                    type="button"
                    onClick={() => setStep("credentials")}
                    className="text-xs text-gray-500 hover:text-[#09175b] transition-colors"
                  >
                    ← Voltar ao login
                  </button>
                  <button
                    type="button"
                    onClick={handleResendCode}
                    disabled={isLoading}
                    className="text-xs text-[#09175b] hover:underline flex items-center gap-1"
                  >
                    <RefreshCw className={cn("w-3 h-3", isLoading && "animate-spin")} />
                    Reenviar código
                  </button>
                </div>
              </form>
            )}
          </div>

          <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 text-center">
            <p className="text-[10px] text-gray-400">
              {step === "credentials"
                ? "Sistema seguro com autenticação de dois fatores por e-mail."
                : "O código expira em 5 minutos. Verifique sua caixa de entrada, spam ou lixo eletrônico."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}