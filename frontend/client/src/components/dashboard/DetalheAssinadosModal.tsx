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
import { Card } from '@/components/ui/card'; // ajuste o alias conforme seu projeto
import { cn } from '@/lib/utils';
import { formatNumero, formatPct } from '@/lib/format'; // ou '@/lib/utils'
import type { Collaborator } from '@/lib/dataStore';

// ---------------------------------------------------------------
// Cores e classificação de status
// ---------------------------------------------------------------
const CORES_TIME = ['#2563eb', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4'];

type NivelStatus = 'excelente' | 'bom' | 'atencao' | 'alerta' | 'critico';

const STATUS_COLOR: Record<NivelStatus, string> = {
  excelente: '#22c55e',
  bom: '#3b82f6',
  atencao: '#f59e0b',
  alerta: '#f97316',
  critico: '#ef4444',
};

const STATUS_LABEL: Record<NivelStatus, string> = {
  excelente: 'Excelente',
  bom: 'Bom',
  atencao: 'Atenção',
  alerta: 'Alerta',
  critico: 'Crítico',
};

function classificarConversao(protocolados: number, assinados: number): NivelStatus {
  if (assinados === 0) return 'critico';
  const taxa = (protocolados / assinados) * 100;
  if (taxa >= 80) return 'excelente';
  if (taxa >= 60) return 'bom';
  if (taxa >= 40) return 'atencao';
  if (taxa >= 20) return 'alerta';
  return 'critico';
}

function colaboradorStatus(colab: Collaborator): NivelStatus {
  return classificarConversao(colab.protocolados, colab.assinados);
}

// ---------------------------------------------------------------
// Componentes internos (evita dependências externas quebradas)
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

function StatusPillLocal({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    excelente: 'bg-green-100 text-green-700',
    bom: 'bg-blue-100 text-blue-700',
    atencao: 'bg-amber-100 text-amber-700',
    alerta: 'bg-orange-100 text-orange-700',
    critico: 'bg-red-100 text-red-700',
    ativo: 'bg-green-100 text-green-700',
    inativo: 'bg-red-100 text-red-700',
  };
  const labelMap: Record<string, string> = {
    excelente: 'Excelente',
    bom: 'Bom',
    atencao: 'Atenção',
    alerta: 'Alerta',
    critico: 'Crítico',
    ativo: 'Ativo',
    inativo: 'Inativo',
  };
  const colorClass = colorMap[status] || 'bg-gray-100 text-gray-700';
  const label = labelMap[status] || status;
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', colorClass)}>
      {label}
    </span>
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

  // Status da equipe (distribuição)
  const ORDEM_STATUS: NivelStatus[] = ['excelente', 'bom', 'atencao', 'alerta', 'critico'];
  const porStatus = ORDEM_STATUS.map((status) => ({
    status,
    label: STATUS_LABEL[status],
    quantidade: contribuiram.filter((c) => colaboradorStatus(c) === status).length,
  })).filter((s) => s.quantidade > 0);

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

                {/* Funil e Status */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                  <div>
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

                  <div>
                    <p className="text-[12px] font-medium text-slate-500 mb-2">
                      Status da equipe
                    </p>
                    <ResponsiveContainer width="100%" height={140}>
                      <BarChart data={porStatus} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                        <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#475569' }} tickLine={false} axisLine={false} />
                        <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                        <Tooltip formatter={(v) => [formatNumero(Number(v)), 'Colaboradores']} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                        <Bar dataKey="quantidade" radius={[4, 4, 0, 0]} barSize={28}>
                          {porStatus.map((s) => (
                            <Cell key={s.status} fill={STATUS_COLOR[s.status]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
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
                      <StatusPillLocal status={colaboradorStatus(colab)} />
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