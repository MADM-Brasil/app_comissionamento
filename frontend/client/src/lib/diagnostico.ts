export function calcularPaceProjecao(atual: number, meta: number, diasDecorridos: number, diasTotais: number): number {
  if (!meta || !diasTotais) return 0;
  const progresso = diasDecorridos / diasTotais;
  return progresso > 0 ? (atual / meta) / progresso : 0;
}

export function classificarPace(pace: number, meta: number): "acima" | "em-dia" | "abaixo" {
  if (!meta) return "abaixo";
  if (pace >= 1.05) return "acima";
  if (pace >= 0.95) return "em-dia";
  return "abaixo";
}
