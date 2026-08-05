export function ehSupervisor(nome?: string): boolean {
  if (!nome) return false;
  const n = nome.trim().toLowerCase();
  return n.includes("supervisor") || n.includes("coord") || n.includes("coordenador");
}
