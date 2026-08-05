export function formatNumero(valor: number): string {
  return new Intl.NumberFormat("pt-BR").format(Math.round(valor || 0));
}

export function formatPct(valor: number, casasDecimais = 1): string {
  return `${valor.toFixed(casasDecimais)}%`;
}

export const STATUS_COLOR: Record<string, string> = {
  critico: "#ef4444",
  alto: "#f97316",
  medio: "#f59e0b",
  baixo: "#10b981",
  sucesso: "#10b981",
  default: "#64748b",
};

export const STATUS_LABEL: Record<string, string> = {
  critico: "Crítico",
  alto: "Alto",
  medio: "Médio",
  baixo: "Baixo",
  sucesso: "Sucesso",
  default: "Sem status",
};
