import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Função existente
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
};
 
export const formatPercent = (value: number): string => { 
  return `${value.toFixed(1)}%`;
};