import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/Card";

interface FunilChartProps {
  etapas: Array<{ stage: string; count: number; color?: string }>;
}

export function FunilChart({ etapas }: FunilChartProps) {
  const dados = etapas.map((etapa) => ({ ...etapa, count: Number(etapa.count || 0) }));

  return (
    <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={dados}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            <XAxis dataKey="stage" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey="count" radius={[6, 6, 0, 0]}>
              {dados.map((item, index) => (
                <Cell key={`${item.stage}-${index}`} fill={item.color || "#09175b"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
