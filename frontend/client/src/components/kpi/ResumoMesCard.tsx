// src/components/kpi/ResumoMesCard.tsx
import React from "react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { TrendingUp, TrendingDown } from "lucide-react";
import type { PaceProjecao } from "@/lib/diagnostico";
import { formatNumero, formatPct } from "@/lib/format";

interface ResumoMesCardProps {
  titulo: string;
  icon: React.ElementType;
  atual: number;
  meta: number;
  pace: PaceProjecao;
  onClick?: () => void;
}

export function ResumoMesCard({
  titulo,
  icon: Icon,
  atual,
  meta,
  pace,
  onClick,
}: ResumoMesCardProps) {
  const percentual = meta > 0 ? (atual / meta) * 100 : 0;
  const gap = pace.gap ?? 0;
  const projetado = pace.projecao ?? 0;

  // Cor neutra para barra de progresso (sem classificação de status)
  const progressColor = "#2563eb"; // azul 600

  return (
    <Card
      className={cn(
        "cursor-pointer transition-all hover:shadow-md",
        onClick && "hover:border-blue-400"
      )}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon size={18} className="text-slate-500" />
          <h3 className="text-sm font-semibold text-slate-700">{titulo}</h3>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-3">
        <div>
          <p className="text-[11px] text-slate-500">Realizado</p>
          <p className="text-xl font-bold text-slate-900">{formatNumero(atual)}</p>
        </div>
        <div>
          <p className="text-[11px] text-slate-500">Meta</p>
          <p className="text-xl font-bold text-slate-900">{formatNumero(meta)}</p>
        </div>
      </div>

      {/* Barra de progresso */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
          <span>Atingimento</span>
          <span>{formatPct(percentual, 0)}</span>
        </div>
        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${Math.min(100, percentual)}%`,
              backgroundColor: progressColor,
            }}
          />
        </div>
      </div>

      {/* Pace e projeção */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-slate-500">Pace atual</p>
          <p className="font-semibold text-slate-900">
            {pace.paceAtual.toFixed(2)}/dia
          </p>
        </div>
        <div>
          <p className="text-slate-500">Projeção</p>
          <p className="font-semibold text-slate-900 flex items-center gap-1">
            {gap >= 0 ? (
              <TrendingUp size={12} className="text-green-600" />
            ) : (
              <TrendingDown size={12} className="text-red-500" />
            )}
            {formatNumero(projetado)}
          </p>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-slate-400">
        Gap: {gap >= 0 ? "+" : ""}{formatNumero(gap)} vs meta
      </p>
    </Card>
  );
}