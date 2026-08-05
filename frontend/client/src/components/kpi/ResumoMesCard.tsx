import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatNumero, formatPct } from "@/lib/format";

interface ResumoMesCardProps {
  titulo: string;
  icon: LucideIcon;
  atual: number;
  meta: number;
  pace: number;
  statusPace: "acima" | "em-dia" | "abaixo";
  onClick?: () => void;
}

export function ResumoMesCard({ titulo, icon: Icon, atual, meta, pace, statusPace, onClick }: ResumoMesCardProps) {
  const percentual = meta > 0 ? (atual / meta) * 100 : 0;

  return (
    <Card className="cursor-pointer rounded-xl border border-slate-200 bg-white p-4 shadow-sm" onClick={onClick}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-slate-500">{titulo}</p>
          <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{formatNumero(atual)}</p>
          <p className="mt-1 text-xs text-slate-500">Meta {formatNumero(meta)} · {formatPct(percentual, 1)}</p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600">
          <Icon size={18} />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-slate-500">Pace</span>
        <span className="font-semibold text-slate-900">{pace.toFixed(1)}x</span>
      </div>
      <div className="mt-1 text-xs text-slate-500">Status: {statusPace}</div>
    </Card>
  );
}
