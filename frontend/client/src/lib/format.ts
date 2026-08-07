// src/lib/format.ts

export function formatNumero(valor: number): string {
  return new Intl.NumberFormat("pt-BR").format(Math.round(valor || 0));
}

export function formatPct(valor: number, casasDecimais = 1): string {
  return `${valor.toFixed(casasDecimais)}%`;
}

export function formatMoeda(valor: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(valor);
}