// src/lib/discadorFilters.ts
// Filtros de equipe / unidade / colaborador do "Resultado do Discador".
// Funções puras (sem React) para poderem ser testadas isoladamente.

import type { DiscadorRow } from "./resultDiscador";

/** Sem acento, minúsculo, espaços colapsados. Mesma regra do SQL (sqlNameKey). */
export function normKey(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** "Equipe A / Equipe B" → ["equipe a", "equipe b"] (colaborador em mais de uma equipe). */
export function teamKeys(nomeEquipe: string | null | undefined): string[] {
  return String(nomeEquipe ?? "")
    .split(" / ")
    .map(normKey)
    .filter(Boolean);
}

export interface CollabLike {
  id?: number | string | null;
  colaboradorId?: number | string | null;
  colaborador_id?: number | string | null;
  name?: string | null;
  unidadeId?: number | string | null;
}

export function collabId(c: CollabLike): string | null {
  const v = c.id ?? c.colaboradorId ?? c.colaborador_id;
  return v == null || v === "" ? null : String(v);
}

export interface CollabIndex {
  byName: Map<string, CollabLike>;
  byId: Map<string, CollabLike>;
}

export function buildCollabIndex(collaborators: CollabLike[]): CollabIndex {
  const byName = new Map<string, CollabLike>();
  const byId = new Map<string, CollabLike>();
  for (const c of collaborators) {
    const k = normKey(c.name);
    if (k && !byName.has(k)) byName.set(k, c);
    const id = collabId(c);
    if (id && !byId.has(id)) byId.set(id, c);
  }
  return { byName, byId };
}

/** Unidade da linha: vem do backend (unidade_id); se faltar, cai no cadastro pelo nome normalizado. */
export function rowUnidadeId(r: DiscadorRow, idx: CollabIndex): number | null {
  if (r.unidade_id != null) return Number(r.unidade_id);
  const c =
    (r.colaborador_id != null ? idx.byId.get(String(r.colaborador_id)) : undefined) ??
    idx.byName.get(normKey(r.agent_name));
  return c?.unidadeId == null || c.unidadeId === "" ? null : Number(c.unidadeId);
}

export interface ScopeFilters {
  equipe: string;        // "todas" = sem filtro
  colaborador: string;   // "todos" = sem filtro
  unidadeId?: number;
}

export function matchesEquipe(r: DiscadorRow, equipe: string): boolean {
  if (!equipe || equipe === "todas") return true;
  return teamKeys(r.nome_equipe).includes(normKey(equipe));
}

export function matchesColaborador(r: DiscadorRow, colaborador: string, idx: CollabIndex): boolean {
  if (!colaborador || colaborador === "todos") return true;
  const wanted = normKey(colaborador);
  if (normKey(r.agent_name) === wanted) return true;
  // Mesmo colaborador por id (nome do discador diferente do nome do cadastro)
  const c = idx.byName.get(wanted);
  const id = c ? collabId(c) : null;
  return id != null && r.colaborador_id != null && String(r.colaborador_id) === id;
}

export function matchesUnidade(r: DiscadorRow, unidadeId: number | undefined, idx: CollabIndex): boolean {
  if (unidadeId == null) return true;
  return rowUnidadeId(r, idx) === Number(unidadeId);
}

export function applyScope(rows: DiscadorRow[], f: ScopeFilters, idx: CollabIndex): DiscadorRow[] {
  return rows.filter(
    (r) =>
      matchesEquipe(r, f.equipe) &&
      matchesColaborador(r, f.colaborador, idx) &&
      matchesUnidade(r, f.unidadeId, idx),
  );
}

/**
 * Esconde agentes ocultos (cargo/status na blacklist) por correspondência EXATA
 * de id ou nome normalizado. Linhas com assinatura nunca são escondidas: a
 * assinatura aconteceu e precisa entrar no total da equipe/unidade.
 */
export function isHiddenRow(
  r: DiscadorRow,
  hidden: { ids: Set<string>; names: Set<string> },
): boolean {
  if ((r.assinados || 0) > 0) return false;
  if (r.colaborador_id != null && hidden.ids.has(String(r.colaborador_id))) return true;
  return hidden.names.has(normKey(r.agent_name));
}
