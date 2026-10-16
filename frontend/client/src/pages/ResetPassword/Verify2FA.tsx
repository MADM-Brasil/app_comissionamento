/*
 * Verify2FA — MADM Brasil
 * Autenticação: verificação do código de dois fatores (enviado por e-mail)
 */

import { useState } from "react";
import { useLocation } from "wouter";
import { Shield, ArrowLeft, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import logoImg from "@/components/img/logo.png";
import { verify2FA, resendCode } from "@/lib/auth";
import { useAppStore } from "@/lib/dataStore";
import { getDefaultLandingPage } from "@/lib/accessControl";

export default function Verify2FA() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [, setLocation] = useLocation();
  const setCurrentUser = useAppStore((state) => state.setCurrentUser);

  // Recupera o token temporário armazenado na primeira etapa (login)
  const tempToken = sessionStorage.getItem("tempToken");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    if (!tempToken) {
      setError("Sessão expirada. Faça login novamente.");
      setIsLoading(false);
      setTimeout(() => setLocation("/login"), 1500);
      return;
    }

    try {
      const data = await verify2FA(tempToken, code);
      localStorage.setItem("accessToken", data.accessToken);
      if (data.user) setCurrentUser(data.user);
      sessionStorage.removeItem("tempToken");

      // Redirect inteligente:
      // - Colaboradores da UNIDADE 3 → /home
      // - Demais usuários → / (comportamento anterior)
      const landingUser = data.user ?? useAppStore.getState().currentUser;
      setLocation(getDefaultLandingPage(landingUser));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (!tempToken) {
      setError("Sessão inválida. Tente fazer login novamente.");
      setTimeout(() => setLocation("/login"), 1500);
      return;
    }
    setIsResending(true);
    setError("");
    try {
      await resendCode();
      alert("Novo código enviado para seu e-mail.");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsResending(false);
    }
  };

  const handleGoBack = () => {
    sessionStorage.removeItem("tempToken");
    setLocation("/login");
  };

  // Se não houver tempToken, instrui o usuário a fazer login novamente
  if (!tempToken) {
    return (
      <div className="min-h-screen bg-[#f8f9fc] flex items-center justify-center p-6">
        <div className="w-full max-w-md text-center">
          <Shield className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <h2 className="text-lg font-bold text-gray-800">Sessão expirada</h2>
          <p className="text-sm text-gray-500 mt-2">
            O código de verificação expirou ou a sessão foi perdida. Faça login novamente.
          </p>
          <button
            onClick={() => setLocation("/login")}
            className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-[#09175b] text-white hover:opacity-90"
          >
            Ir para o login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f8f9fc] flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-24 h-24 mx-auto mb-4">
            <img
              src={logoImg}
              alt="MADM Brasil"
              className="w-full h-full object-cover rounded-2xl shadow-md"
            />
          </div>
          <h1 className="text-2xl font-black text-[#09175b]">MADM Brasil</h1>
        </div>

        {/* Card de verificação 2FA */}
        <div className="bg-white rounded-2xl shadow-lg overflow-hidden">
          <div className="px-6 pt-6 pb-2">
            <h2 className="text-xl font-bold text-gray-800">
              Verificação em duas etapas
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Digite o código de 6 dígitos enviado para o seu e-mail.
            </p>
          </div>

          <div className="p-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="2fa-code" className="block text-xs font-semibold text-gray-600 mb-1">
                  Código de autenticação
                </label>
                <div className="relative">
                  <Shield className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    id="2fa-code"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-[#09175b]/20"
                    placeholder="000000"
                    required
                    autoFocus
                    title="Código de 6 dígitos enviado por e-mail"
                    aria-label="Código de autenticação"
                  />
                </div>
              </div>

              {error && <p className="text-red-500 text-xs">{error}</p>}

              <button
                type="submit"
                disabled={isLoading}
                className={cn(
                  "w-full py-2.5 rounded-lg text-sm font-semibold text-white transition-all",
                  isLoading
                    ? "bg-gray-400 cursor-not-allowed"
                    : "bg-[#09175b] hover:opacity-90"
                )}
              >
                {isLoading ? "Verificando..." : "Verificar código"}
              </button>

              <div className="flex justify-between items-center">
                <button
                  type="button"
                  onClick={handleGoBack}
                  className="text-xs text-gray-500 hover:text-[#09175b] transition-colors flex items-center gap-1"
                >
                  <ArrowLeft className="w-3 h-3" />
                  Voltar ao login
                </button>

                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={isResending}
                  className="text-xs text-[#09175b] hover:underline flex items-center gap-1"
                >
                  <RefreshCw className={cn("w-3 h-3", isResending && "animate-spin")} />
                  {isResending ? "Enviando..." : "Reenviar código"}
                </button>
              </div>
            </form>
          </div>

          <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 text-center">
            <p className="text-[10px] text-gray-400">
              O código expira em 5 minutos. Verifique sua caixa de entrada ou spam.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}