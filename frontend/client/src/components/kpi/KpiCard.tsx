import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

interface KpiCardProps {
  titulo: string;
  valor: string;
  icon: LucideIcon;
  accent?: "brand" | "success" | "warning" | "danger" | "info";
  subtitulo?: string;
}

const ACCENT_STYLES: Record<NonNullable<KpiCardProps["accent"]>, string> = {
  brand: "text-blue-600 bg-blue-500/10",
  success: "text-emerald-500 bg-emerald-500/10",
  warning: "text-amber-500 bg-amber-500/10",
  danger: "text-red-500 bg-red-500/10",
  info: "text-sky-500 bg-sky-500/10",
};

export function KpiCard({ titulo, valor, icon: Icon, accent = "brand", subtitulo }: KpiCardProps) {
  return (
    <Card className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-slate-500">{titulo}</p>
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", ACCENT_STYLES[accent])}>
          <Icon size={16} />
        </span>
      </div>
      <p className="text-2xl font-semibold tracking-tight text-slate-900">{valor}</p>
      {subtitulo ? <p className="text-xs text-slate-500">{subtitulo}</p> : null}
    </Card>
  );
}
