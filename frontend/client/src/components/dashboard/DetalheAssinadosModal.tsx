// src/components/dashboard/DetalheAssinadosModal.tsx
import { createPortal } from 'react-dom';
import { Link } from 'wouter';
import { X } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { formatNumero } from '@/lib/format';
import type { Collaborator } from '@/lib/dataStore';

// ---------------------------------------------------------------
// Cores dos times (mantidas para o gráfico de distribuição)
// ---------------------------------------------------------------
const CORES_TIME = ['#2563eb', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];

// ---------------------------------------------------------------
// Componentes internos
// ---------------------------------------------------------------
function AvatarLocal({ nome, size = 40 }: { nome: string; size?: number }) {
  const inicial = (nome || '?')[0].toUpperCase();
  return (
    <div
      className="flex items-center justify-center rounded-full bg-blue-500 text-white font-bold"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {inicial}
    </div>
  );
}

// ---------------------------------------------------------------
// Modal
// ---------------------------------------------------------------
interface DetalheAssinadosModalProps {
  titulo: string;
  colaboradores: Collaborator[];
  atual: number;
  onFechar: () => void;
}

export function DetalheAssinadosModal({
  titulo,
  colaboradores,
  atual,
  onFechar,
}: DetalheAssinadosModalProps) {
  // Apenas quem assinou
  const contribuiram = [...colaboradores]
    .filter((c) => c.assinados > 0)
    .sort((a, b) => b.assinados - a.assinados);

  // Top 8 contribuintes
  const topContribuintes = contribuiram.slice(0, 8).map((c) => ({
    nome: c.name.split(' ').slice(0, 2).join(' '),
    assinados: c.assinados,
  }));

  // Distribuição por time
  const porTime = Array.from(
    contribuiram.reduce((mapa, c) => {
      mapa.set(c.equipeNome, (mapa.get(c.equipeNome) ?? 0) + c.assinados);
      return mapa;
    }, new Map<string, number>()),
  )
    .map(([time, assinados]) => ({ time: time.replace('Equipe ', ''), assinados }))
    .sort((a, b) => b.assinados - a.assinados);

  // Funil: Recebidos → Assinados → Protocolados
  const funil = [
    { etapa: 'Recebidos', valor: contribuiram.reduce((s, c) => s + (c.emitidos || 0), 0) },
    { etapa: 'Assinados', valor: atual },
    { etapa: 'Protocolados', valor: contribuiram.reduce((s, c) => s + c.protocolados, 0) },
  ];

  // Taxa de protocolados dos top contribuintes
  const conversaoTopContribuintes = contribuiram.slice(0, 8).map((c) => ({
    nome: c.name.split(' ')[0],
    taxa: c.assinados > 0 ? (c.protocolados / c.assinados) * 100 : 0,
  }));

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-10"
      onClick={onFechar}
    >
      <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <Card className="relative shadow-2xl">
          {/* Cabeçalho */}
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">{titulo}</h2>
              <p className="text-sm text-slate-500">
                {formatNumero(atual)} assinado(s) — {contribuiram.length} colaborador(es) contribuíram
              </p>
            </div>
            <button
              onClick={onFechar}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
              aria-label="Fechar modal"
            >
              <X size={18} />
            </button>
          </div>

          {/* Conteúdo */}
          <div className="p-5">
            {contribuiram.length === 0 ? (
              <p className="text-sm text-slate-500">Ninguém assinou nesse período.</p>
            ) : (
              <>
                {/* Gráficos: Top contribuintes e Distribuição por time */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <div>
                    <p className="text-[12px] font-medium text-slate-500 mb-2">
                      Top contribuintes
                    </p>
                    <ResponsiveContainer width="100%" height={Math.max(140, topContribuintes.length * 28)}>
                      <BarChart data={topContribuintes} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="nome" tick={{ fontSize: 11, fill: '#475569' }} width={100} tickLine={false} axisLine={false} />
                        <Tooltip formatter={(v) => [formatNumero(Number(v)), 'Assinados']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                        <Bar dataKey="assinados" fill="#2563eb" radius={[0, 4, 4, 0]} barSize={14} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>

                  {porTime.length > 1 && (
                    <div>
                      <p className="text-[12px] font-medium text-slate-500 mb-2">
                        Distribuição por time
                      </p>
                      <ResponsiveContainer width="100%" height={Math.max(140, topContribuintes.length * 28)}>
                        <BarChart data={porTime} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="time" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} />
                          <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={28} />
                          <Tooltip formatter={(v) => [formatNumero(Number(v)), 'Assinados']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                          <Bar dataKey="assinados" radius={[4, 4, 0, 0]} barSize={28}>
                            {porTime.map((_, indice) => (
                              <Cell key={indice} fill={CORES_TIME[indice % CORES_TIME.length]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>

                {/* Funil */}
                <div className="mb-4">
                  <p className="text-[12px] font-medium text-slate-500 mb-2">
                    Funil: Recebidos → Assinados → Protocolados
                  </p>
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart data={funil} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="etapa" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={32} />
                      <Tooltip formatter={(v) => [formatNumero(Number(v)), 'Total']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                      <Bar dataKey="valor" radius={[4, 4, 0, 0]} barSize={36}>
                        <Cell fill="#0ea5e9" />
                        <Cell fill="#2563eb" />
                        <Cell fill="#10b981" />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Taxa de protocolados dos top contribuintes (linha) */}
                <div className="mb-4">
                  <p className="text-[12px] font-medium text-slate-500 mb-2">
                    Taxa de protocolados — top contribuintes
                  </p>
                  <ResponsiveContainer width="100%" height={140}>
                    <LineChart data={conversaoTopContribuintes} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="nome" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={32} unit="%" />
                      <Tooltip formatter={(v) => [`${Number(v).toFixed(0)}%`, 'Taxa de protocolados']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                      <Line type="monotone" dataKey="taxa" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                {/* Lista completa */}
                <ul className="space-y-2 max-h-[35vh] overflow-y-auto pr-1">
                  {contribuiram.map((colab) => (
                    <li key={colab.id} className="flex items-center gap-3 rounded-lg border border-slate-200 p-2.5">
                      <AvatarLocal nome={colab.name} size={32} />
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/colaboradores/${colab.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onFechar();
                          }}
                          className="text-sm font-semibold text-slate-900 hover:underline truncate block"
                        >
                          {colab.name}
                        </Link>
                        <p className="text-[12px] text-slate-500 truncate">{colab.equipeNome}</p>
                      </div>
                      <span className="text-base font-bold text-slate-900 shrink-0 w-10 text-right">
                        {formatNumero(colab.assinados)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>,
    document.body,
  );
}