// src/lib/recommendations.ts

// ============================================================
// RECOMENDAÇÕES TEMPORÁRIAS (TTL 24h)
//
// Persistência em `localStorage` para não exigir alterações no banco.
// Emite um evento custom + ouve o evento `storage` para refletir
// mudanças entre abas do mesmo navegador.
// ============================================================

const STORAGE_KEY = "madm_temp_recommendations_v1";
const EVENT_NAME = "madm:recommendations-changed";
export const TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

export type RecommendationPriority = "info" | "warning" | "danger";

export interface TemporaryRecommendation {
  id: string;
  targetId: string;
  targetName: string;
  targetEmail: string;
  authorId: string;
  authorName: string;
  authorCargo: string;
  text: string;
  priority: RecommendationPriority;
  createdAt: number;
  expiresAt: number;
}

function safeParse(raw: string | null): TemporaryRecommendation[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Retorna TODAS as recomendações ativas (não expiradas). */
export function getAllRecommendations(): TemporaryRecommendation[] {
  if (typeof window === "undefined") return [];
  const all = safeParse(localStorage.getItem(STORAGE_KEY));
  const now = Date.now();
  const active = all.filter((r) => r.expiresAt > now);
  // Limpa as expiradas para não acumular
  if (active.length !== all.length) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(active));
    } catch { /* ignore */ }
  }
  return active;
}

/** Recomendações ativas para um colaborador específico (por id). */
export function getActiveRecommendationsFor(targetId: string): TemporaryRecommendation[] {
  if (!targetId) return [];
  return getAllRecommendations().filter((r) => r.targetId === targetId);
}

/** Cria uma recomendação com TTL de 24h. */
export function addRecommendation(
  rec: Omit<TemporaryRecommendation, "id" | "createdAt" | "expiresAt">
): TemporaryRecommendation {
  const now = Date.now();
  const entry: TemporaryRecommendation = {
    ...rec,
    id: `rec_${now}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  const all = getAllRecommendations();
  const next = [entry, ...all];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  emitChange();
  return entry;
}

/** Remove uma recomendação por id. */
export function removeRecommendation(id: string): void {
  const all = getAllRecommendations();
  const next = all.filter((r) => r.id !== id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* ignore */ }
  emitChange();
}

function emitChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(EVENT_NAME));
  }
}

/** Escuta mudanças (mesmo tab e entre abas). Retorna função de unsubscribe. */
export function subscribeRecommendations(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = () => listener();
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  window.addEventListener(EVENT_NAME, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT_NAME, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** Rótulo de tempo restante ("3h 15min", "45min", "expirada"). */
export function getRemainingTimeLabel(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expirada";
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}