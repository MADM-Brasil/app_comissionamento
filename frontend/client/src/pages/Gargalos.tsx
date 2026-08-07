// src/pages/Gargalos.tsx
import React, { useState, useMemo } from "react";
import clsx from "clsx";
import { Link } from "wouter";
import { useAppStore, type Collaborator, type RawMetrics } from "@/lib/dataStore";
import FilterBar from "@/components/FilterBar";
import { Card } from "@/components/ui/card";
import { KpiCard } from "@/components/kpi/KpiCard";
import { formatNumero } from "@/lib/format";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  GitMerge,
  ListTree,
  TrendingDown,
  Users,
  Loader2,
} from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";

// ===================== TIPOS E CONSTANTES =====================
// (Removidos NivelStatus, STATUS_COLOR e STATUS_LABEL)

interface Gargalo {
  id: string;
  titulo: string;
  descricao: string;
  tipo: "etapa_funil" | "colaborador" | "processo";
  perdaEstimada: number;
  impactoEstimado: string;
  colaboradorId?: string;
  recomendacoes: string[];
}

const TIPO_LABEL: Record<Gargalo["tipo"], string> = {
  etapa_funil: "Etapa do funil",
  colaborador: "Colaborador",
  processo: "Processo",
};

const TIPO_ICON = {
  etapa_funil: GitMerge,
  colaborador: Users,
  processo: ListTree,
} as const;

const TIPOS = Object.keys(TIPO_LABEL) as Gargalo["tipo"][];

// ===================== FILTROS DE VISIBILIDADE =====================
const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro', 'Equipe Reciclagem',""
];

const EXCLUDED_CARGOS = [
  "desativado", "assistente", "analista juridico", "gestor de projetos", "analista",
  "analista de discadora", "supervisor", "coordenador", "salesops", "ceo",
  "analista de crm", "desenvolvedor", "diretora", "analista de dados", "desenvolvedor make",
];

const normalize = (str: string): string =>
  (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const isDesativado = (c: Collaborator) =>
  normalize(c.cargo) === 'desativado' || normalize(c.equipeNome).includes('desativado');
const isColaboradorVisivel = (c: Collaborator) =>
  !isDesativado(c) &&
  !EXCLUDED_TEAMS.includes(c.equipeNome) &&
  !EXCLUDED_CARGOS.some(g => normalize(g) === normalize(c.cargo)) &&
  c.status === "ativo";

// ===================== FUNÇÕES AUXILIARES =====================
function pct(numerador: number, denominador: number): number {
  if (!denominador || denominador === 0) return 0;
  return (numerador / denominador) * 100;
}

// (função classificarStatus removida – não é mais necessária)

// ===================== MOTOR DE GARGALOS (BOTTLENECKS INTEGRADO) =====================
function detectarGargalos(
  colaboradores: Collaborator[],
  rawMetrics: RawMetrics,
  filters: { equipe?: string; colaborador?: string; produto?: string }
): Gargalo[] {
  const visiveis = colaboradores.filter(isColaboradorVisivel);
  const filtrados = visiveis.filter(c => {
    if (filters.equipe && c.equipeNome !== filters.equipe) return false;
    if (filters.colaborador && c.name !== filters.colaborador) return false;
    if (filters.produto && filters.produto !== "Todos" && c.produto !== filters.produto && c.cargo !== filters.produto) return false;
    return true;
  });

  const totalEmitidos = rawMetrics.emitidos || 0;
  const totalAssinados = rawMetrics.assinados || 0;
  const totalProtocolados = rawMetrics.protocolados || 0;

  const taxaRecebidosAssinados = pct(totalAssinados, totalEmitidos);
  const taxaProtocolados = pct(totalProtocolados, totalAssinados);

  const gargalos: Gargalo[] = [];

  if (totalEmitidos >= 5) {
    const perdaRA = totalEmitidos - totalAssinados;
    if (taxaRecebidosAssinados < 60 && perdaRA > 0) {
      gargalos.push({
        id: 'gargalo-etapa-assinatura',
        tipo: 'etapa_funil',
        titulo: 'Recebidos → Assinados abaixo do esperado',
        descricao: `${perdaRA} leads recebidos não foram assinados (${taxaRecebidosAssinados.toFixed(0)}% de conversão).`,
        impactoEstimado: `${perdaRA} oportunidade(s) potencialmente perdida(s)`,
        perdaEstimada: perdaRA,
        recomendacoes: ['Revisar qualificação do lead e follow-up.'],
      });
    }

    if (totalAssinados > 0) {
      const perdaAP = totalAssinados - totalProtocolados;
      if (taxaProtocolados < 70 && perdaAP > 0) {
        gargalos.push({
          id: 'gargalo-etapa-protocolo',
          tipo: 'etapa_funil',
          titulo: 'Assinados → Protocolados com baixa conversão',
          descricao: `${perdaAP} assinados ainda sem protocolo (${taxaProtocolados.toFixed(0)}% de conversão).`,
          impactoEstimado: `${perdaAP} processo(s) represado(s)`,
          perdaEstimada: perdaAP,
          recomendacoes: ['Definir SLA de protocolo e monitorar diariamente.'],
        });
      }
    }
  }

  const perdaRecebidosAssinados = totalEmitidos - totalAssinados;
  if (taxaRecebidosAssinados < 75 && perdaRecebidosAssinados > 0) {
    gargalos.push({
    id: 'gargalo-etapa-assinatura',
    tipo: 'etapa_funil',
    titulo: 'Recebidos → Assinados perde oportunidades',
    descricao: `${perdaRecebidosAssinados} recebido(s) não assinado(s) (${taxaRecebidosAssinados.toFixed(0)}%).`,
    impactoEstimado: `${perdaRecebidosAssinados} oportunidade(s) perdida(s)`,
    perdaEstimada: perdaRecebidosAssinados,
    recomendacoes: ['Revisar script de fechamento e reduzir o tempo de retorno ao cliente.'],
    });
  }

  if (filtrados.length > 0) {
    const comMetricas = filtrados.map(c => {
      const assinados = c.assinados || 0;
      const protocolados = c.protocolados || 0;
      const perda = assinados - protocolados;
      const conversaoAP = pct(protocolados, assinados);
      const metaMensal = c.metaMensalAssinados || 60;
      const atingimento = pct(assinados, metaMensal);
      // severidade removida
      return { colaborador: c, perda, conversaoAP, metaMensal, atingimento };
    });

    const pioresPorPerda = comMetricas
      .filter(x => (x.colaborador.assinados ?? 0) > 0 && x.perda > 0)
      .sort((a, b) => b.perda - a.perda)
      .slice(0, 3);

    for (const { colaborador, perda, conversaoAP } of pioresPorPerda) {
      gargalos.push({
        id: `gargalo-colaborador-${colaborador.id}`,
        tipo: 'colaborador',
        titulo: `${colaborador.name} concentra perda de protocolo`,
        descricao: `${perda} assinado(s) sem protocolo (conversão de ${conversaoAP.toFixed(0)}%).`,
        impactoEstimado: `${perda} processo(s) represado(s)`,
        perdaEstimada: perda,
        colaboradorId: String(colaborador.id),
        recomendacoes: ['Auditar a carteira e redistribuir casos parados.'],
      });
    }

    const metasComprometidas = comMetricas.filter(
      x => x.metaMensal > 0 && x.atingimento < 70 && (x.colaborador.assinados ?? 0) > 0
    );
    if (metasComprometidas.length >= 2 && filtrados.length >= 3) {
      const perdaEstimada = metasComprometidas.reduce(
        (a, x) => a + Math.max(0, x.metaMensal - (x.colaborador.assinados ?? 0)),
        0
      );
      gargalos.push({
        id: 'gargalo-metas',
        tipo: 'processo',
        titulo: 'Metas mensais comprometidas',
        descricao: `${metasComprometidas.length} colaborador(es) estão abaixo de 70% da meta de assinados.`,
        impactoEstimado: 'Risco ao resultado mensal da equipe',
        perdaEstimada,
        recomendacoes: ['Redistribuir carteira e acompanhar semanalmente.'],
      });
    }
  }

  return gargalos.sort((a, b) => b.perdaEstimada - a.perdaEstimada);
}

// ===================== COMPONENTE PRINCIPAL =====================
export default function GargalosPage() {
  const { collaborators, rawMetrics, currentStartDate } = useAppStore();

  const isLoading = collaborators.length === 0 && !currentStartDate;

  const [filters, setFilters] = useState({
    equipe: "todas",
    colaborador: "todos",
    produto: "Todos",
  });

  const motorFilters = useMemo(() => ({
    equipe: filters.equipe === "todas" ? undefined : filters.equipe,
    colaborador: filters.colaborador === "todos" ? undefined : filters.colaborador,
    produto: filters.produto === "Todos" ? undefined : filters.produto,
  }), [filters]);

  const gargalos = useMemo(() => {
    if (isLoading) return [];
    return detectarGargalos(collaborators, rawMetrics, motorFilters);
  }, [collaborators, rawMetrics, motorFilters, isLoading]);

  const [filtroTipo, setFiltroTipo] = useState<Gargalo["tipo"] | null>(null);
  const [expandidos, setExpandidos] = useState<Set<string>>(new Set());

  const toggle = (id: string) => setExpandidos(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const filtrados = gargalos.filter(g => !filtroTipo || g.tipo === filtroTipo);
  const perdaTotal = gargalos.reduce((a, g) => a + g.perdaEstimada, 0);

  return (
    <DashboardLayout title="Gargalos" subtitle="Onde a operação está perdendo conversão – e o que fazer a respeito.">
      <FilterBar onFilterChange={setFilters} showColaboradorFilter className="mb-6" />

      {isLoading && (
        <div className="flex justify-center items-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          <span className="ml-2 text-sm text-gray-500">Carregando dados...</span>
        </div>
      )}

      {!isLoading && (
        <>
          {/* KPIs resumo – removida a KPI “Críticos” */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
            <KpiCard titulo="Gargalos identificados" valor={formatNumero(gargalos.length)} icon={AlertTriangle} accent={gargalos.length ? "warning" : "success"} />
            <KpiCard titulo="Processos represados" valor={formatNumero(perdaTotal)} icon={TrendingDown} accent="danger" subtitulo="soma da perda estimada" />
            <KpiCard titulo="Por colaborador" valor={formatNumero(gargalos.filter(g => g.tipo === "colaborador").length)} icon={Users} accent="info" />
          </div>

          {/* Filtros por tipo */}
          <div className="flex flex-wrap gap-2 mb-4">
            <button
              onClick={() => setFiltroTipo(null)}
              className={clsx(
                "rounded-full px-3.5 py-1.5 text-[13px] font-medium border",
                filtroTipo === null ? "bg-blue-500/15 border-blue-500/40 text-blue-700" : "border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100"
              )}
            >
              Todos ({gargalos.length})
            </button>
            {TIPOS.map(tipo => {
              const Icon = TIPO_ICON[tipo];
              const count = gargalos.filter(g => g.tipo === tipo).length;
              if (!count) return null;
              return (
                <button
                  key={tipo}
                  onClick={() => setFiltroTipo(tipo)}
                  className={clsx(
                    "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium border",
                    filtroTipo === tipo ? "bg-blue-500/15 border-blue-500/40 text-blue-700" : "border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100"
                  )}
                >
                  <Icon size={13} /> {TIPO_LABEL[tipo]} ({count})
                </button>
              );
            })}
          </div>

          {/* Lista de gargalos – sem classificação de severidade */}
          {filtrados.length === 0 ? (
            <Card><p className="text-sm text-slate-500">Nenhum gargalo relevante identificado com esse filtro.</p></Card>
          ) : (
            <div className="space-y-3">
              {filtrados.map(g => {
                const aberto = expandidos.has(g.id);
                const TipoIcon = TIPO_ICON[g.tipo];
                return (
                  <Card key={g.id} padded={false} className="overflow-hidden">
                    <button onClick={() => toggle(g.id)} className="w-full flex items-center justify-between gap-4 p-4 text-left hover:bg-slate-50">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                          <AlertTriangle size={18} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <span className="flex items-center gap-1 text-[11px] text-slate-400">
                              <TipoIcon size={11} /> {TIPO_LABEL[g.tipo]}
                            </span>
                          </div>
                          <h3 className="text-sm font-semibold text-slate-900 truncate">{g.titulo}</h3>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-right hidden sm:block">
                          <p className="text-[11px] text-slate-500">Perda estimada</p>
                          <p className="text-sm font-semibold text-slate-900">{formatNumero(g.perdaEstimada)}</p>
                        </div>
                        <ChevronDown size={18} className={clsx("text-slate-400 transition-transform", aberto && "rotate-180")} />
                      </div>
                    </button>
                    {aberto && (
                      <div className="px-4 pb-4 pl-[68px] border-t border-slate-100 pt-3 animate-fade-in">
                        <p className="text-[13px] text-slate-600 max-w-2xl mb-1">{g.descricao}</p>
                        <p className="text-[12px] text-slate-500 mb-3">Impacto: {g.impactoEstimado}</p>
                        {g.colaboradorId && (
                          <Link to={`/colaboradores/${g.colaboradorId}`} className="mb-3 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                            ver colaborador <ArrowRight size={12} />
                          </Link>
                        )}
                        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 mb-1.5">Ação recomendada</p>
                        <ul className="space-y-1">
                          {g.recomendacoes.map((r, i) => (
                            <li key={i} className="text-[12.5px] text-slate-500 flex gap-1.5">
                              <span className="text-slate-400">•</span>{r}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
}