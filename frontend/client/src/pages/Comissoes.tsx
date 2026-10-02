// src/pages/Comissoes.tsx
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, formatCurrency, type Campaign, type Collaborator, type TabelaComissaoItem } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import {
  DollarSign, Award, FileCheck, Target, Loader2, RefreshCw,
  FileText, Archive, XCircle, CalendarDays, TrendingUp, TrendingDown,
  Users, PhoneCall, CalendarClock, MessageCircle, ChevronDown, Search,
  Megaphone, Info, AlertCircle, Clock,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend,
} from "recharts";
import { calculator } from "@/lib/calculator";
// ← AJUSTADO: novos helpers que consideram campanhas ativas
import {
  fetchDailyMetrics,
  calcularGolsComCampanhas,
  calcularTotalGolsComCampanhas,
  calcularGolsDiariosComCampanhas,
  type CampaignLike,
} from "@/lib/metrics";
import {
  fetchAssinados,
  fetchGanhos,
  fetchLigacoes,
  fetchLigacoesTabulacoes,
  type CallMetrics,
  type CallTabulation,
  type CallTabulationCategory,
} from "@/lib/api";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  getActiveRecommendationsFor,
  subscribeRecommendations,
  getRemainingTimeLabel,
  type TemporaryRecommendation,
  type RecommendationPriority,
} from "@/lib/recommendations";

const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

// ============================================================
//  HELPERS DE DATA
// ============================================================
function toInclusiveEnd(end: string): string {
  if (!end) return end;
  const d = new Date(end + 'T00:00:00');
  if (isNaN(d.getTime())) return end;
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário','BackOffice',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro', 'Equipe Reciclagem','','Equipe Leonardo','Equipe Ariana'
];

const EXCLUDED_CARGOS = [
  "desativado","assistente","analista juridico","gestor de projetos","analista",
  "analista de discadora","coordenador","salesops","ceo",
  "analista de crm","desenvolvedor","diretora","analista de dados","desenvolvedor make",
];

const normalizeText = (text: string) => (text || '').trim().toLowerCase();
const normalizeName = (text: string) => normalizeText(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const EXCLUDED_TEAMS_SET = new Set(EXCLUDED_TEAMS.map(normalizeName));

// Filtra apenas campanhas validadas financeiramente e devolve no formato do helper
function getActiveCampaigns(campaigns: Campaign[]): CampaignLike[] {
  return (campaigns || []).filter(c => c?.validacao_financeiro) as unknown as CampaignLike[];
}

type CommissionOverviewRole = 'assessor' | 'supervisor' | 'coordenador';

interface CommissionOverviewItem {
  id: string;
  name: string;
  team: string;
  role: CommissionOverviewRole;
  assinados: number;
  ganhos: number;
  gols: number;
  commission: number | null;
  isSupervisorSR: boolean;
  collaborator: Collaborator;
}

// ============================================================
//  ESTILOS DE PRIORIDADE DAS RECOMENDAÇÕES TEMPORÁRIAS
// ============================================================
const PRIORITY_STYLES: Record<
  RecommendationPriority,
  { border: string; bg: string; text: string; Icon: React.ElementType }
> = {
  info: { border: "border-sky-200", bg: "bg-sky-50", text: "text-sky-700", Icon: Info },
  warning: { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-700", Icon: AlertCircle },
  danger: { border: "border-red-200", bg: "bg-red-50", text: "text-red-700", Icon: XCircle },
};

function getCommissionOverviewRole(colaborador: Collaborator): CommissionOverviewRole | null {
  const cargo = normalizeName(colaborador.cargo);
  const status = normalizeName(colaborador.status);
  if (!cargo || status === 'inativo' || status === 'desativado') return null;
  if (cargo === 'supervisor' || cargo === 'supervisor sr') return 'supervisor';
  if (cargo === 'coordenador') return 'coordenador';
  if (EXCLUDED_CARGOS.some(excluded => normalizeName(excluded) === cargo)) return null;
  return 'assessor';
}

function mapDailyMetricsByCollaborator(assinadosRows: any[], ganhosRows: any[]) {
  const metrics = new Map<string, Map<string, { date: string; assinados: number; ganhos: number }>>();
  const addRows = (rows: any[], field: 'assinados' | 'ganhos') => {
    rows.forEach(row => {
      const collaboratorKey = normalizeName(row.colaborador || '');
      const rawDate = row.periodo || row.data;
      if (!collaboratorKey || !rawDate) return;
      const date = String(rawDate).slice(0, 10);
      if (!metrics.has(collaboratorKey)) metrics.set(collaboratorKey, new Map());
      const byDate = metrics.get(collaboratorKey)!;
      const day = byDate.get(date) || { date, assinados: 0, ganhos: 0 };
      day[field] += Number(row.total) || 0;
      byDate.set(date, day);
    });
  };

  addRows(assinadosRows, 'assinados');
  addRows(ganhosRows, 'ganhos');

  return new Map(Array.from(metrics, ([name, byDate]) => [
    name,
    Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date)),
  ]));
}

function sumTeamAssinados(collaborators: any[], teamName: string): number {
  return collaborators.reduce((total, collaborator) => {
    if (normalizeText(collaborator.equipeNome) !== normalizeText(teamName)) return total;
    const cargo = normalizeText(collaborator.cargo);
    if (cargo.startsWith('supervisor') || cargo === 'coordenador' || cargo === 'administrativo') return total;
    return total + (Number(collaborator.assinados) || 0);
  }, 0);
}

function sumTeamGanhos(collaborators: any[], teamName: string): number {
  return collaborators.reduce((total, collaborator) => {
    if (normalizeText(collaborator.equipeNome) !== normalizeText(teamName)) return total;
    const cargo = normalizeText(collaborator.cargo);
    if (cargo.startsWith('supervisor') || cargo === 'coordenador' || cargo === 'administrativo') return total;
    return total + (Number(collaborator.ganhos) || 0);
  }, 0);
}

function sumTeamGols(collaborators: any[], teamName: string): number {
  return collaborators.reduce((total, collaborator) => {
    if (normalizeText(collaborator.equipeNome) !== normalizeText(teamName)) return total;
    const cargo = normalizeText(collaborator.cargo);
    if (cargo.startsWith('supervisor') || cargo === 'coordenador' || cargo === 'administrativo') return total;
    return total + (Number(collaborator.gols) || 0);
  }, 0);
}

// ============================================================
// ← AJUSTADO: cálculo de gols agora considera CAMPANHAS ATIVAS
//   sobre a regra base (assinados → gols).
//   Campanhas do tipo:
//     - GOLS: multiplica os gols do dia
//     - ASSINADOS: +floor(assinados/quantidadePorGol)
//     - PROGRESSIVA: substitui (assinados >= meta ? assinados : 0)
// ============================================================
function calculateAssessorGols(
  collaborator: Collaborator,
  dailyMetrics: Array<{ date: string; assinados: number; ganhos?: number }>,
  campaigns: CampaignLike[],
): number {
  if (isSpecialGroupColaborador(collaborator)) return 0;
  if (!dailyMetrics || dailyMetrics.length === 0) return 0;
  return calcularTotalGolsComCampanhas(
    dailyMetrics as any,
    campaigns,
  );
}

function calculateAssessorCommission(
  collaborator: Collaborator,
  dailyMetrics: Array<{ date: string; assinados: number; ganhos: number }>,
  commissionBands: TabelaComissaoItem[],
  campaigns: Campaign[],
): number {
  const ganhos = dailyMetrics.reduce((total, day) => total + (day.ganhos || 0), 0);
  const isSpecial = isSpecialGroupColaborador(collaborator);
  const productType = getFaixaProductType(collaborator);

  const commissionGanhos = calculator.calculateProductCommission(ganhos, productType, commissionBands);
  if (isSpecial || dailyMetrics.length === 0) return commissionGanhos;

  // ← AJUSTADO: gols agora consideram campanhas ativas
  const activeCampaigns = getActiveCampaigns(campaigns);
  const totalGols = calculateAssessorGols(collaborator, dailyMetrics as any, activeCampaigns);
  const comissaoGols = calculator.calculateGoalCommission(totalGols, commissionBands);
  return commissionGanhos + comissaoGols;
}

function isSpecialGroupColaborador(colaborador: any): boolean {
  const produto = (colaborador.produto || '').toLowerCase();
  const cargo = (colaborador.cargo || '').toLowerCase();
  const equipe = (colaborador.equipeNome || '').toLowerCase();

  const equipeQuinquenio = equipe.includes('quinquenio') || equipe.includes('quinquênio') || equipe.includes('tatiane');
  const equipeConcomitante = equipe.includes('concomitante');

  return produto === 'quinquenio' || produto === 'concomitante' ||
         cargo === 'quinquenio' || cargo === 'concomitante' ||
         equipeQuinquenio || equipeConcomitante;
}

function getFaixaProductType(colab: any): string {
  const rawProduct = (colab?.produto || '').toUpperCase().trim();
  if (rawProduct === 'JUDIT' || rawProduct === 'DISCADORA') {
    return 'AUXILIO ACIDENTE';
  }
  if (rawProduct === 'QUINQUENIO' || rawProduct === 'CONCOMITANTE') {
    return rawProduct;
  }

  const cargoNormalizado = (colab?.cargo || '').toLowerCase().trim();
  if (cargoNormalizado === 'quinquenio') return 'QUINQUENIO';
  if (cargoNormalizado === 'concomitante') return 'CONCOMITANTE';

  const equipeNormalizada = (colab?.equipeNome || '').toLowerCase().trim();
  if (equipeNormalizada.includes('quinquenio') || equipeNormalizada.includes('quinquênio') || equipeNormalizada.includes('tatiana')) {
    return 'QUINQUENIO';
  }
  if (equipeNormalizada.includes('concomitante')) {
    return 'CONCOMITANTE';
  }

  return 'AUXILIO ACIDENTE';
}

const SimpleTooltip = ({ active, payload, label }: any) => {
  if (active && payload?.length) {
    return (
      <div className="bg-white border border-[#e2e8f0] rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-[#0f172a] mb-1">{label}</p>
        {payload.map((entry: any, i: number) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {formatInt(entry.value)}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

const CustomTooltip = ({ active, payload, label, hideValues }: any) => {
  if (active && payload?.length) {
    return (
      <div className="bg-white border border-[#e2e8f0] rounded-lg p-3 shadow-lg text-xs">
        <p className="font-semibold text-[#0f172a] mb-1">{label}</p>
        {payload.map((entry: any, i: number) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {typeof entry.value === 'number' ? (hideValues ? '***' : formatCurrency(entry.value)) : entry.value}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

const ExtratoDialog = ({ dailyMetrics, dailyGols, campaigns, metaGolsAssinados, metaGolsGanhos, isSupervisor, onClose }: any) => {
  const allDates = new Set<string>();
  dailyMetrics.forEach((d: any) => allDates.add(d.date.slice(0, 10)));
  (campaigns || []).forEach((c: any) => {
    if (c.validacao_financeiro) {
      allDates.add(c.data_publicacao.split('T')[0]);
    }
  });

  const sortedDates = Array.from(allDates).sort();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="p-6 border-b border-[#e2e8f0] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-[#2F6FED]" />
            <h3 className="text-lg font-bold text-[#0f172a]">Extrato de Gols e Campanhas</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-[#94a3b8] hover:text-[#0f172a] hover:bg-[#f1f5f9]">
            <XCircle className="w-5 h-5" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto flex-1">
          <div className="space-y-4">
            {sortedDates.length > 0 ? (
              sortedDates.map((dateKey, idx) => {
                const day = dailyMetrics.find((d: any) => d.date.slice(0, 10) === dateKey) || {
                  date: dateKey, assinados: 0, ganhos: 0, perdidos: 0, emitidos: 0, protocolados: 0,
                };
                const golsInfo = dailyGols.find((g: any) => (g.date || '').slice(0, 10) === dateKey);
                // ← AJUSTADO: fallback também considera campanhas
                const golsDoDia = golsInfo?.gols ?? calcularGolsComCampanhas(
                  Number(day.assinados) || 0,
                  dateKey,
                  getActiveCampaigns(campaigns as Campaign[]),
                );

                const campanhasAprovadas = (campaigns || []).filter((c: any) => c.validacao_financeiro);
                const campanhasGols = campanhasAprovadas.filter((c: any) =>
                  c.tipo?.toUpperCase() === 'GOLS' && c.data_publicacao.split('T')[0] === dateKey
                );
                const campanhasAssinados = campanhasAprovadas.filter((c: any) =>
                  c.tipo?.toUpperCase() === 'ASSINADOS' && c.data_publicacao.split('T')[0] === dateKey
                );
                const campanhasProgressivas = campanhasAprovadas.filter((c: any) =>
                  c.tipo?.toUpperCase() === 'PROGRESSIVA' && c.data_publicacao.split('T')[0] === dateKey
                );
                const temCampanhas = campanhasGols.length > 0 || campanhasAssinados.length > 0 || campanhasProgressivas.length > 0;

                return (
                  <div key={idx} className={`p-4 rounded-xl border ${temCampanhas ? 'border-[#2F6FED] bg-[#eff6ff]' : 'border-[#e2e8f0]'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold text-[#0f172a]">{dateKey}</span>
                      {temCampanhas && <span className="badge success text-xs">Campanha ativa</span>}
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                      <div><p className="text-[#64748b]">Assinados</p><p className="font-bold">{formatInt(day.assinados || 0)}</p></div>
                      <div><p className="text-[#64748b]">Ganhos</p><p className="font-bold">{formatInt(day.ganhos || 0)}</p></div>
                      {!isSupervisor && (
                        <>
                          <div><p className="text-[#64748b]">Meta Ass.</p><p className="font-bold text-[#2F6FED]">{formatInt(Math.round(Number(metaGolsAssinados)))}</p></div>
                          <div><p className="text-[#64748b]">Meta Gan.</p><p className="font-bold text-[#16A34A]">{formatInt(Math.round(Number(metaGolsGanhos)))}</p></div>
                        </>
                      )}
                    </div>
                    <div className="mt-3 pt-3 border-t border-[#e2e8f0] flex justify-between items-center">
                      <span className="text-xs font-semibold">{isSupervisor ? "Total de ganhos" : "Gols do dia"}</span>
                      <span className={`text-lg font-black ${golsDoDia > 0 ? 'text-[#16A34A]' : 'text-[#94a3b8]'}`}>
                        {isSupervisor ? formatInt(day.ganhos || 0) : golsDoDia}
                      </span>
                    </div>
                    {temCampanhas && (
                      <div className="mt-3 pt-3 border-t border-[#e2e8f0]">
                        <p className="text-xs font-semibold text-[#2F6FED] mb-2">Campanhas ativas</p>
                        {campanhasGols.map((camp: any, cIdx: number) => (
                          <div key={`g-${cIdx}`} className="flex justify-between text-xs mb-1">
                            <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3 text-[#EA8C1D]" />Multiplica Gols</span>
                            <span className="font-bold text-[#EA8C1D]">×{camp.multiplicador}</span>
                          </div>
                        ))}
                        {campanhasAssinados.map((camp: any, cIdx: number) => (
                          <div key={`a-${cIdx}`} className="flex justify-between text-xs mb-1">
                            <span className="flex items-center gap-1"><FileCheck className="w-3 h-3 text-[#16A34A]" />+1 gol a cada {camp.multiplicador || 3} assinados</span>
                            <span className="font-bold text-[#16A34A]">+{Math.floor((Number(day.assinados) || 0) / (Number(camp.multiplicador) || 3))}</span>
                          </div>
                        ))}
                        {campanhasProgressivas.map((camp: any, cIdx: number) => (
                          <div key={`p-${cIdx}`} className="flex justify-between text-xs mb-1">
                            <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3 text-purple-500" />Progressiva (mín. {camp.multiplicador} assinados)</span>
                            <span className="font-bold text-purple-500">
                              {(Number(day.assinados) || 0) >= Number(camp.multiplicador) ? `${day.assinados} gols` : '0 gols'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="text-center text-[#94a3b8] py-8">Nenhum dado diário ou campanha disponível.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default function Comissoes() {
  const {
    currentStartDate, currentEndDate,
    collaborators: storeColabs, globalConfig, equipeConfigs, rawMetrics,
    loadCollaboratorsAndMetrics, loadWeeklyPerformanceData, loadRawMetrics,
    hideValues, tabelaComissoes, campaigns,
  } = useAppStore();

  const { currentUser, hasPermission, getAccessLevel, LEVELS } = useAccessControl();
  const canUseFilterBar = hasPermission("canViewTeam") || hasPermission("canAccessReports");

  const userLevel = getAccessLevel();
  const canViewCommissionOverview = userLevel === LEVELS.ADMINISTRATIVO || userLevel === LEVELS.SUPER_ADMIN;

  const [filters, setFilters] = useState<{
    equipe: string;
    colaborador: string;
    colaboradorId?: string | number;
    produto: string;
  }>({ equipe: "todas", colaborador: "todos", produto: "Todos" });

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dailyMetrics, setDailyMetrics] = useState<any[]>([]);
  const [dailyGols, setDailyGols] = useState<any[]>([]);
  const [weeklyMetrics, setWeeklyMetrics] = useState<any[]>([]);
  const [weeklyGols, setWeeklyGols] = useState<any[]>([]);
  const [callMetrics, setCallMetrics] = useState<CallMetrics[]>([]);
  const [commissionOverview, setCommissionOverview] = useState<CommissionOverviewItem[]>([]);
  const [commissionOverviewLoading, setCommissionOverviewLoading] = useState(false);
  const [commissionOverviewError, setCommissionOverviewError] = useState<string | null>(null);
  const [commissionOverviewSearch, setCommissionOverviewSearch] = useState('');
  const [updatingCommissionId, setUpdatingCommissionId] = useState<string | null>(null);
  const [expandedCallStage, setExpandedCallStage] = useState<CallTabulationCategory | null>(null);
  const [callTabulations, setCallTabulations] = useState<CallTabulation[]>([]);
  const [loadingCallTabulations, setLoadingCallTabulations] = useState(false);
  const [callTabulationsError, setCallTabulationsError] = useState<string | null>(null);
  const callTabulationsRequest = useRef(0);
  const commissionOverviewRequest = useRef(0);
  const [loadingDaily, setLoadingDaily] = useState(false);
  const [showExtrato, setShowExtrato] = useState(false);
  const [filterBarKey, setFilterBarKey] = useState(0);
  const isLoadingRef = useRef(false);

  const [tempRecsForColab, setTempRecsForColab] = useState<TemporaryRecommendation[]>([]);
  const [allTabulations, setAllTabulations] = useState<CallTabulation[]>([]);
  const [loadingAllTabulations, setLoadingAllTabulations] = useState(false);

  const activeCampaigns = useMemo(() => getActiveCampaigns(campaigns), [campaigns]);

  const reloadData = useCallback(async (showRefreshing = false) => {
    if (!currentStartDate || !currentEndDate || !currentUser) return;
    if (isLoadingRef.current && !showRefreshing) return;

    isLoadingRef.current = true;
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      let equipeApi: string | undefined;
      let colaboradorApi: string | undefined;
      let colaboradorIdApi: string | number | undefined;
      const produtoApi = filters.produto === "Todos" ? undefined : filters.produto;

      if (canUseFilterBar) {
        equipeApi = filters.equipe !== "todas" ? filters.equipe : undefined;
        colaboradorApi = filters.colaborador !== "todos" ? filters.colaborador : undefined;
        colaboradorIdApi = filters.colaboradorId;
      } else {
        const userColab = storeColabs.find(c => c.id === currentUser.id);
        if (userColab) {
          colaboradorApi = userColab.name;
          colaboradorIdApi = currentUser.id;
        } else {
          colaboradorIdApi = currentUser.id;
        }
      }

      const collaboratorsForSelection = useAppStore.getState().collaborators;
      const requestedColaborador = canUseFilterBar
        ? collaboratorsForSelection.find(c =>
          (colaboradorIdApi != null && String(c.id) === String(colaboradorIdApi)) ||
          (colaboradorApi != null && c.name === colaboradorApi)
        ) || (filters.colaborador === 'todos'
          ? collaboratorsForSelection.find(c => String(c.id) === String(currentUser.id))
          : undefined)
        : collaboratorsForSelection.find(c => String(c.id) === String(currentUser.id));
      const isSupervisorSelection = normalizeText(requestedColaborador?.cargo || '') === 'supervisor';

      if (isSupervisorSelection && requestedColaborador) {
        equipeApi = requestedColaborador.equipeNome || equipeApi;
        colaboradorApi = undefined;
        colaboradorIdApi = undefined;
      }

      const fimInclusivo = toInclusiveEnd(currentEndDate);

      const [calls] = await Promise.all([
        fetchLigacoes({
          start: currentStartDate,
          end: currentEndDate,
          inicio: currentStartDate,
          fim: fimInclusivo,
          equipe: equipeApi,
          colaborador: colaboradorApi,
          colaboradorId: colaboradorIdApi,
          produto: produtoApi,
        } as any).catch(err => {
          console.error('Erro ao carregar ligações:', err);
          return [] as CallMetrics[];
        }),
        loadCollaboratorsAndMetrics(equipeApi, colaboradorApi, colaboradorIdApi, produtoApi),
        loadRawMetrics({ equipeNome: equipeApi, colaboradorNome: colaboradorApi, colaboradorId: colaboradorIdApi, produto: produtoApi }),
        loadWeeklyPerformanceData(),
      ]);
      setCallMetrics(calls);

      const colaboradoresAtualizados = useAppStore.getState().collaborators;
      let targetColab: any;

      if (canUseFilterBar) {
        targetColab = requestedColaborador
          ? colaboradoresAtualizados.find(c => String(c.id) === String(requestedColaborador.id))
          : colaboradoresAtualizados.find(c => c.id === colaboradorIdApi || c.name === colaboradorApi);
      } else {
        targetColab = requestedColaborador
          ? colaboradoresAtualizados.find(c => String(c.id) === String(requestedColaborador.id))
          : colaboradoresAtualizados.find(c => c.id === currentUser.id);
      }

      setDailyMetrics([]);
      setDailyGols([]);
      setWeeklyMetrics([]);
      setWeeklyGols([]);

      if (targetColab) {
        const isSupervisor = (targetColab.cargo || '').toLowerCase() === 'supervisor';
        const isQuinquenio = (() => {
          const produto = (targetColab.produto || '').toLowerCase();
          const cargo = (targetColab.cargo || '').toLowerCase();
          const equipe = (targetColab.equipeNome || '').toLowerCase();
          return produto === 'quinquenio' || cargo === 'quinquenio' ||
                 equipe.includes('quinquenio') || equipe.includes('quinquênio') || equipe.includes('tatiane');
        })();
        const isConcomitante = (() => {
          const produto = (targetColab.produto || '').toLowerCase();
          const cargo = (targetColab.cargo || '').toLowerCase();
          const equipe = (targetColab.equipeNome || '').toLowerCase();
          return produto === 'concomitante' || cargo === 'concomitante' || equipe.includes('concomitante');
        })();

        if (isSupervisor) {
          setLoadingDaily(true);
          try {
            const equipeMembros = colaboradoresAtualizados.filter(c => c.equipeNome === targetColab.equipeNome && c.id !== targetColab.id);
            if (equipeMembros.length > 0) {
              const allDaily: any[] = [];
              for (const membro of equipeMembros) {
                const dailyMembro = await fetchDailyMetrics({
                  start: currentStartDate,
                  end: currentEndDate,
                  colaborador: membro.name,
                });
                allDaily.push(...dailyMembro);
              }
              const aggregated = new Map<string, any>();
              allDaily.forEach(day => {
                const key = day.date;
                if (!aggregated.has(key)) {
                  aggregated.set(key, { date: key, assinados: 0, ganhos: 0, perdidos: 0, emitidos: 0, protocolados: 0 });
                }
                const entry = aggregated.get(key)!;
                entry.assinados += day.assinados || 0;
                entry.ganhos += day.ganhos || 0;
                entry.perdidos += day.perdidos || 0;
                entry.emitidos += day.emitidos || 0;
                entry.protocolados += day.protocolados || 0;
              });
              const dailyAgregado = Array.from(aggregated.values()).sort((a, b) => a.date.localeCompare(b.date));
              setDailyMetrics(dailyAgregado);
              // ← AJUSTADO: gols com campanhas ativas
              setDailyGols(calcularGolsDiariosComCampanhas(dailyAgregado as any, activeCampaigns));
            }
          } catch (err) {
            console.error('Erro ao carregar dados diários da equipe:', err);
          } finally {
            setLoadingDaily(false);
          }
        } else if (!isQuinquenio && !isConcomitante) {
          setLoadingDaily(true);
          try {
            const daily = await fetchDailyMetrics({
              start: currentStartDate,
              end: currentEndDate,
              colaborador: targetColab.name,
            });
            setDailyMetrics(daily);

            // ← AJUSTADO: gols com campanhas
            setDailyGols(calcularGolsDiariosComCampanhas(daily, activeCampaigns));

            const now = new Date();
            const dayOfWeek = now.getDay();
            const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
            const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);

            const formatDateKey = (date: Date) => {
              const y = date.getFullYear();
              const m = String(date.getMonth() + 1).padStart(2, '0');
              const d = String(date.getDate()).padStart(2, '0');
              return `${y}-${m}-${d}`;
            };

            const weekly = await fetchDailyMetrics({
              start: formatDateKey(monday),
              end: formatDateKey(sunday),
              colaborador: targetColab.name,
            });
            setWeeklyMetrics(weekly);
            // ← AJUSTADO: gols semanais com campanhas
            setWeeklyGols(calcularGolsDiariosComCampanhas(weekly, activeCampaigns));
          } catch (err) {
            console.error('Erro ao carregar dados diários:', err);
          } finally {
            setLoadingDaily(false);
          }
        }
      }
    } catch (err: any) {
      console.error("❌ Comissoes: erro ao recarregar dados:", err);
      setError(err.message || "Falha ao recarregar dados.");
    } finally {
      isLoadingRef.current = false;
      if (showRefreshing) setRefreshing(false);
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate, filters, currentUser, canUseFilterBar, loadCollaboratorsAndMetrics, loadRawMetrics, loadWeeklyPerformanceData, storeColabs, campaigns, activeCampaigns]);

  const handleRefresh = useCallback(async () => { await reloadData(true); }, [reloadData]);

  const handleFilterChange = useCallback((newFilters: any) => {
    setFilters(prev => {
      if (
        prev.equipe === newFilters.equipe &&
        prev.colaborador === newFilters.colaborador &&
        String(prev.colaboradorId ?? '') === String(newFilters.colaboradorId ?? '') &&
        prev.produto === newFilters.produto
      ) {
        return prev;
      }
      return newFilters;
    });
  }, []);

  const handleSelectFromOverview = useCallback((item: CommissionOverviewItem) => {
    if (item.role === 'coordenador') {
      toast.info('Coordenadores não possuem visualização individual detalhada.');
      return;
    }

    try {
      const stored = localStorage.getItem("madm_filterBar_state_v1");
      const parsed = stored ? JSON.parse(stored) : {};
      localStorage.setItem("madm_filterBar_state_v1", JSON.stringify({
        equipe: item.team,
        colaborador: item.name,
        produto: parsed.produto || "Todos",
        searchTerm: "",
      }));
    } catch { /* ignore */ }

    setFilters({
      equipe: item.team,
      colaborador: item.name,
      colaboradorId: item.collaborator.id,
      produto: "Todos",
    });

    setFilterBarKey((k) => k + 1);

    toast.success(`Visualizando ${item.name}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (!currentStartDate || !currentEndDate || !currentUser) return;
    reloadData(false);
  }, [currentStartDate, currentEndDate, filters, currentUser]);

  const filteredColabs = useMemo(() => {
    let filtered = storeColabs.filter(c => {
      if (EXCLUDED_TEAMS_SET.has(normalizeName(c.equipeNome))) return false;
      if (EXCLUDED_CARGOS.some(cargo => normalizeName(c.cargo) === normalizeName(cargo))) return false;
      return true;
    });
    if (!canUseFilterBar) {
      if (currentUser && !filtered.some(c => c.id === currentUser.id)) {
        const userColab = storeColabs.find(c => c.id === currentUser.id);
        if (userColab) filtered = [userColab, ...filtered];
      }
    } else {
      if (filters.equipe !== "todas") filtered = filtered.filter(c => c.equipeNome === filters.equipe);
      if (filters.colaborador !== "todos") filtered = filtered.filter(c => c.name === filters.colaborador);
    }
    return filtered;
  }, [storeColabs, currentUser, filters, canUseFilterBar]);

  const userColab = useMemo(() => {
    if (canUseFilterBar) {
      return filteredColabs.find(c =>
        (filters.colaboradorId != null && String(c.id) === String(filters.colaboradorId)) ||
        c.name === filters.colaborador
      ) || (filters.colaborador === 'todos'
        ? filteredColabs.find(c => String(c.id) === String(currentUser?.id))
        : undefined);
    }
    return filteredColabs.find(c => c.id === currentUser?.id);
  }, [filteredColabs, currentUser, filters, canUseFilterBar]);

  useEffect(() => {
    if (!userColab) {
      setTempRecsForColab([]);
      return;
    }
    const refresh = () => setTempRecsForColab(getActiveRecommendationsFor(userColab.id));
    refresh();
    const unsub = subscribeRecommendations(refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, [userColab?.id]);

  useEffect(() => {
    if (!currentStartDate || !currentEndDate) return;
    if (!userColab) {
      setAllTabulations([]);
      return;
    }

    let cancelled = false;
    const loadAll = async () => {
      setLoadingAllTabulations(true);
      try {
        const isSupervisorFocus = (userColab.cargo || '').toLowerCase() === 'supervisor';

        let equipe = canUseFilterBar
          ? (filters.equipe !== 'todas' ? filters.equipe : undefined)
          : userColab.equipeNome;
        let colaborador = canUseFilterBar
          ? (filters.colaborador !== 'todos' ? filters.colaborador : undefined)
          : userColab.name;

        if (isSupervisorFocus) {
          equipe = userColab.equipeNome || equipe;
          colaborador = undefined;
        }

        const fimInclusivo = toInclusiveEnd(currentEndDate);
        const categorias: CallTabulationCategory[] = ['productive', 'appointments', 'occurrences', 'failures'];
        const resultados = await Promise.all(
          categorias.map(cat =>
            fetchLigacoesTabulacoes({
              start: currentStartDate,
              end: currentEndDate,
              inicio: currentStartDate,
              fim: fimInclusivo,
              equipe,
              colaborador,
              categoria: cat,
            } as any).catch(() => [] as CallTabulation[])
          )
        );

        if (cancelled) return;
        setAllTabulations(resultados.flat());
      } catch (err) {
        if (!cancelled) setAllTabulations([]);
      } finally {
        if (!cancelled) setLoadingAllTabulations(false);
      }
    };

    void loadAll();
    return () => { cancelled = true; };
  }, [currentStartDate, currentEndDate, filters.equipe, filters.colaborador, userColab?.id, canUseFilterBar]);

  const isSupervisorUser = (userColab?.cargo || '').toLowerCase() === 'supervisor';
  const isSpecialUser = userColab ? isSpecialGroupColaborador(userColab) : false;

  const isOverviewVisible =
    canViewCommissionOverview &&
    !loading &&
    filters.equipe === 'todas' &&
    filters.colaborador === 'todos';

  const commissionData = useMemo(() => {
    if (!userColab) return [];

    const isSpecial = isSpecialGroupColaborador(userColab);
    const isSupervisor = (userColab.cargo || '').toLowerCase() === 'supervisor';
    const isQuinquenio = (() => {
      const produto = (userColab.produto || '').toLowerCase();
      const cargo = (userColab.cargo || '').toLowerCase();
      const equipe = (userColab.equipeNome || '').toLowerCase();
      return produto === 'quinquenio' || cargo === 'quinquenio' ||
             equipe.includes('quinquenio') || equipe.includes('quinquênio') || equipe.includes('tatiane');
    })();
    const isConcomitante = (() => {
      const produto = (userColab.produto || '').toLowerCase();
      const cargo = (userColab.cargo || '').toLowerCase();
      const equipe = (userColab.equipeNome || '').toLowerCase();
      return produto === 'concomitante' || cargo === 'concomitante' || equipe.includes('concomitante');
    })();
    const isSR = Boolean(userColab.isSupervisorSR) || calculator.isSupervisorSR(userColab.email);

    let totalCommission = 0;
    let totalGols = 0;
    let comissaoAssinados = 0;
    let comissaoGols = 0;

    if (isSupervisor) {
      const totalGanEquipe = sumTeamGanhos(storeColabs, userColab.equipeNome);
      totalCommission = calculator.calculateSupervisorCommission(totalGanEquipe, isSR, tabelaComissoes);
      comissaoAssinados = totalCommission;
    } else if (isQuinquenio || isConcomitante) {
      const tipoTabela = isQuinquenio ? 'QUINQUENIO' : 'CONCOMITANTE';
      totalCommission = calculator.calculateProductCommission(userColab.ganhos || 0, tipoTabela, tabelaComissoes);
      comissaoAssinados = totalCommission;
    } else {
      if (dailyMetrics.length > 0) {
        // ← AJUSTADO: total de gols agora considera campanhas ativas
        totalGols = calcularTotalGolsComCampanhas(dailyMetrics as any, activeCampaigns);

        const ganhos = userColab.ganhos || 0;
        const productType = getFaixaProductType(userColab);
        comissaoGols = calculator.calculateGoalCommission(totalGols, tabelaComissoes);
        comissaoAssinados = calculator.calculateProductCommission(ganhos, productType, tabelaComissoes);
        totalCommission = comissaoGols + comissaoAssinados;
      }
    }

    return [{
      id: userColab.id,
      name: userColab.name,
      totalCommission,
      totalCycles: totalGols,
      comissaoAssinados,
      comissaoGols,
      assinados: userColab.assinados || 0,
      ganhos: isSpecial ? 0 : (userColab.ganhos || 0),
      protocolados: userColab.protocolados || 0,
      avatar: userColab.avatar || userColab.name.charAt(0).toUpperCase(),
      cargo: userColab.cargo,
      isSpecial,
      emitidos: userColab.emitidos || 0,
      perdidos: userColab.perdidos || 0,
      originalColab: userColab,
    }];
  }, [filteredColabs, tabelaComissoes, currentUser, filters, storeColabs, dailyMetrics, userColab, campaigns, activeCampaigns]);

  const loadCommissionOverview = useCallback(async () => {
    const requestId = ++commissionOverviewRequest.current;
    if (!canViewCommissionOverview || !currentStartDate || !currentEndDate || storeColabs.length === 0) {
      setCommissionOverview([]);
      setCommissionOverviewLoading(false);
      return;
    }

    setCommissionOverviewLoading(true);
    setCommissionOverviewError(null);
    try {
      const params = { start: currentStartDate, end: currentEndDate, granularity: 'daily' as const };
      const [assinadosRows, ganhosRows] = await Promise.all([
        fetchAssinados(params),
        fetchGanhos(params),
      ]);
      if (requestId !== commissionOverviewRequest.current) return;

      const dailyByCollaborator = mapDailyMetricsByCollaborator(assinadosRows, ganhosRows);

      const collaboratorsWithMetrics = storeColabs.map(collaborator => {
        const daily = dailyByCollaborator.get(normalizeName(collaborator.name)) || [];
        // ← AJUSTADO: gols com campanhas ativas
        const gols = calculateAssessorGols(collaborator, daily as any, activeCampaigns);
        return {
          ...collaborator,
          assinados: daily.reduce((total, day) => total + day.assinados, 0),
          ganhos: daily.reduce((total, day) => total + day.ganhos, 0),
          gols,
        };
      });

      const rows = storeColabs
        .filter(collaborator => !EXCLUDED_TEAMS_SET.has(normalizeName(collaborator.equipeNome)))
        .flatMap(collaborator => {
          const role = getCommissionOverviewRole(collaborator);
          if (!role) return [];

          const daily = dailyByCollaborator.get(normalizeName(collaborator.name)) || [];
          const individualSigned = daily.reduce((total, day) => total + day.assinados, 0);
          const individualGanhos = daily.reduce((total, day) => total + day.ganhos, 0);
          const individualGols = calculateAssessorGols(collaborator, daily as any, activeCampaigns);
          const isSupervisorSR = Boolean(collaborator.isSupervisorSR) || calculator.isSupervisorSR(collaborator.email);
          let assinados = individualSigned;
          let ganhos = individualGanhos;
          let gols = individualGols;
          let commission: number | null;

          if (role === 'supervisor') {
            assinados = sumTeamAssinados(collaboratorsWithMetrics, collaborator.equipeNome);
            ganhos = sumTeamGanhos(collaboratorsWithMetrics, collaborator.equipeNome);
            gols = sumTeamGols(collaboratorsWithMetrics, collaborator.equipeNome);
            commission = calculator.calculateSupervisorCommission(ganhos, isSupervisorSR, tabelaComissoes);
          } else if (role === 'coordenador') {
            assinados = sumTeamAssinados(collaboratorsWithMetrics, collaborator.equipeNome);
            ganhos = sumTeamGanhos(collaboratorsWithMetrics, collaborator.equipeNome);
            gols = sumTeamGols(collaboratorsWithMetrics, collaborator.equipeNome);
            commission = null;
          } else {
            commission = calculateAssessorCommission(collaborator, daily as any, tabelaComissoes, campaigns);
          }

          return [{
            id: String(collaborator.id),
            name: collaborator.name,
            team: collaborator.equipeNome,
            role,
            assinados,
            ganhos,
            gols,
            commission,
            isSupervisorSR,
            collaborator,
          }];
        })
        .sort((left, right) => left.team.localeCompare(right.team) || left.name.localeCompare(right.name));

      setCommissionOverview(rows);
    } catch (err: any) {
      if (requestId === commissionOverviewRequest.current) {
        setCommissionOverviewError(err.message || 'Não foi possível carregar a visão geral das comissões.');
      }
    } finally {
      if (requestId === commissionOverviewRequest.current) setCommissionOverviewLoading(false);
    }
  }, [canViewCommissionOverview, currentStartDate, currentEndDate, storeColabs, campaigns, tabelaComissoes, activeCampaigns]);

  useEffect(() => {
    void loadCommissionOverview();
    return () => { commissionOverviewRequest.current++; };
  }, [loadCommissionOverview]);

  const refreshCommissionOverviewItem = async (item: CommissionOverviewItem) => {
    if (item.role === 'coordenador') return;
    setUpdatingCommissionId(item.id);
    setCommissionOverviewError(null);
    try {
      let assinados = item.assinados;
      let ganhos = item.ganhos;
      let gols = item.gols;
      let commission: number;

      if (item.role === 'supervisor') {
        const assessorNames = new Set(storeColabs
          .filter(collaborator => getCommissionOverviewRole(collaborator) === 'assessor')
          .filter(collaborator => normalizeName(collaborator.equipeNome) === normalizeName(item.team))
          .map(collaborator => normalizeName(collaborator.name)));

        const [assinadosRows, ganhosRows] = await Promise.all([
          fetchAssinados({ start: currentStartDate, end: currentEndDate, equipe: item.team, granularity: 'daily' }),
          fetchGanhos({ start: currentStartDate, end: currentEndDate, equipe: item.team, granularity: 'daily' }),
        ]);

        assinados = assinadosRows.reduce((total, row) =>
          assessorNames.has(normalizeName(row.colaborador)) ? total + (Number(row.total) || 0) : total, 0);
        ganhos = ganhosRows.reduce((total, row) =>
          assessorNames.has(normalizeName(row.colaborador)) ? total + (Number(row.total) || 0) : total, 0);

        // ← AJUSTADO: gols do supervisor com campanhas
        const memberDailyResults = await Promise.all(
          storeColabs
            .filter(c => getCommissionOverviewRole(c) === 'assessor')
            .filter(c => normalizeName(c.equipeNome) === normalizeName(item.team))
            .map(async (member) => {
              const daily = await fetchDailyMetrics({
                start: currentStartDate,
                end: currentEndDate,
                colaborador: member.name,
              }).catch(() => [] as any[]);
              return [member, daily] as const;
            })
        );
        gols = memberDailyResults.reduce(
          (sum, [member, daily]) => sum + calculateAssessorGols(member, daily as any, activeCampaigns),
          0
        );

        commission = calculator.calculateSupervisorCommission(ganhos, item.isSupervisorSR, tabelaComissoes);
      } else {
        const daily = await fetchDailyMetrics({
          start: currentStartDate,
          end: currentEndDate,
          colaborador: item.name,
        });
        assinados = daily.reduce((total, day) => total + (Number(day.assinados) || 0), 0);
        ganhos = daily.reduce((total, day) => total + (Number(day.ganhos) || 0), 0);
        // ← AJUSTADO: gols individuais com campanhas
        gols = calculateAssessorGols(item.collaborator, daily as any, activeCampaigns);
        commission = calculateAssessorCommission(item.collaborator, daily as any, tabelaComissoes, campaigns);
      }

      setCommissionOverview(items => items.map(entry => entry.id === item.id
        ? { ...entry, assinados, ganhos, gols, commission }
        : entry));
    } catch (err: any) {
      setCommissionOverviewError(err.message || `Falha ao atualizar ${item.name}.`);
    } finally {
      setUpdatingCommissionId(null);
    }
  };

  const filteredCommissionOverview = useMemo(() => {
    const query = normalizeName(commissionOverviewSearch);
    if (!query) return commissionOverview;
    return commissionOverview.filter(item =>
      normalizeName(item.name).includes(query) || normalizeName(item.team).includes(query)
    );
  }, [commissionOverview, commissionOverviewSearch]);

  const commissionChartData = useMemo(() => {
    const item = commissionData[0];
    if (!item) return [];

    const data = [
      { name: 'Comissão mês', value: item.comissaoAssinados, color: '#2F6FED' },
    ];
    if (!item.isSpecial && !isSupervisorUser) {
      data.push({ name: 'Comissão Gols', value: item.comissaoGols, color: '#16A34A' });
    }
    return data;
  }, [commissionData, isSupervisorUser]);

  const teamMembers = useMemo(() => {
    if (!isSupervisorUser || !userColab) return [];
    return storeColabs.filter(c => c.equipeNome === userColab.equipeNome && c.id !== userColab.id);
  }, [isSupervisorUser, userColab, storeColabs]);

  const totals = useMemo(() => {
    const comissao = commissionData.reduce((s, i) => s + i.totalCommission, 0);
    const ciclos = commissionData.reduce((s, i) => s + i.totalCycles, 0);
    return { comissao, ciclos };
  }, [commissionData]);

  const avgProgress = useMemo(() => {
    if (!commissionData.length) return 0;
    const sum = commissionData.reduce((acc, i) => {
      const pctAss = i.originalColab?.metaMensalAssinados ? (i.assinados / i.originalColab.metaMensalAssinados) * 100 : 0;
      const pctProt = i.originalColab?.metaMensalGanhos ? (i.protocolados / i.originalColab.metaMensalGanhos) * 100 : 100;
      return acc + Math.min(pctAss, pctProt);
    }, 0);
    return sum / commissionData.length;
  }, [commissionData]);

  const displayCurrency = (val: number) => hideValues ? "R$ ****" : formatCurrency(val);

  const summaryCards = [
    { label: "Comissão Total Estimada", value: totals.comissao, icon: DollarSign, color: "#2F6FED", isCurrency: true },
    { label: "Gols", value: totals.ciclos, icon: Award, color: "#16A34A", isInteger: true },
    { label: "Vendas Fechadas", value: rawMetrics.ganhos, icon: FileCheck, color: "#EA8C1D", isInteger: true },
    { label: "Atingimento da meta", value: avgProgress, icon: Target, color: "#8B5CF6", isPercent: true },
  ];

  const userData = commissionData[0] || null;
  const recebidos = userData?.emitidos || 0;
  const assinados = userData?.assinados || 0;
  const protocolados = userData?.protocolados || 0;
  const ganhos = userData?.ganhos || 0;
  const perdidos = userData?.perdidos || 0;

  const metaGolsAss = userColab?.metaGolsAssinados ?? 3;
  const metaGolsGan = userColab?.metaGolsGanhos ?? 3;

  const taxaConversaoGeral = recebidos > 0 ? (assinados / recebidos) * 100 : 0;
  const taxaConversaoProtocolados = assinados > 0 ? (protocolados / assinados) * 100 : 0;

  const calcPercent = (value: number, target: number) => target > 0 ? Math.min((value / target) * 100, 100) : 0;

  const callFunnelStages = useMemo(() => {
    const totals = callMetrics.reduce((sum, row) => ({
      total: sum.total + (Number(row.total_ligacoes) || 0),
      productive: sum.productive + (Number(row.produtivas) || 0),
      appointments: sum.appointments + (Number(row.agendamentos) || 0),
      occurrences: sum.occurrences + (Number(row.ocorrencias) || 0),
      failures: sum.failures + (Number(row.insucessos) || 0),
    }), { total: 0, productive: 0, appointments: 0, occurrences: 0, failures: 0 });

    return [
      { key: null, label: 'Total de ligações', count: totals.total, color: '#09175b', icon: PhoneCall },
      { key: 'productive' as const, label: 'Produtivas', count: totals.productive, color: '#34a853', icon: FileCheck },
      { key: 'appointments' as const, label: 'Agendamentos', count: totals.appointments, color: '#f59e0b', icon: CalendarClock },
      { key: 'occurrences' as const, label: 'Ocorrências', count: totals.occurrences, color: '#64748b', icon: MessageCircle },
      { key: 'failures' as const, label: 'Improdutiva', count: totals.failures, color: '#ef4444', icon: XCircle },
    ];
  }, [callMetrics]);

  const callFunnelLayout = useMemo(() => {
    const widths = [100, 82, 64, 46, 28];
    return callFunnelStages.map((stage, index) => ({ ...stage, widthPct: widths[index] }));
  }, [callFunnelStages]);

  const recomendacoes: string[] = [];

  if (userData) {
    if (userData.originalColab?.metaMensalAssinados && userData.assinados < userData.originalColab.metaMensalAssinados * 0.7) {
      recomendacoes.push("Você está abaixo de 70% da meta de assinados. Reforce as atividades de fechamento.");
    }
    if (taxaConversaoGeral < 50) {
      recomendacoes.push("Sua taxa de conversão (recebidos → assinados) está baixa. Revise sua abordagem de qualificação.");
    }
    if (taxaConversaoProtocolados < 50 && assinados > 0) {
      recomendacoes.push("Menos da metade dos seus assinados foram protocolados. Acompanhe os processos pendentes.");
    }
    if (userData.totalCycles < 5 && userData.totalCycles > 0) {
      recomendacoes.push("Seus gols totais estão baixos. Concentre-se em bater as metas diárias para acumular mais gols.");
    }
  }

  const totalLigacoes = callFunnelStages.find(s => s.key === null)?.count ?? 0;
  const ligacoesProdutivas = callFunnelStages.find(s => s.key === "productive")?.count ?? 0;

  const sumTabulationsByName = (patterns: string[]): number => {
    return allTabulations.reduce((sum, t) => {
      const nome = normalizeName(t.tabulacao);
      const matched = patterns.some(p => nome.includes(normalizeName(p)));
      return matched ? sum + (Number(t.total) || 0) : sum;
    }, 0);
  };

  if (totalLigacoes > 0) {
    const taxaProdutivas = (ligacoesProdutivas / totalLigacoes) * 100;

    if (taxaProdutivas > 50) {
      recomendacoes.push(
        `🎉 Parabéns! ${taxaProdutivas.toFixed(0)}% das suas ligações foram produtivas no período. Excelente trabalho — continue assim!`
      );
    } else if (taxaProdutivas < 40) {
      recomendacoes.push(
        `Apenas ${taxaProdutivas.toFixed(0)}% das suas ligações foram produtivas. Revise o script de abordagem e o horário dos contatos.`
      );
    }

    const totalAgendamentos = sumTabulationsByName(['trabalhando', 'retornar liga']);
    const taxaAgendamentos = (totalAgendamentos / totalLigacoes) * 100;
    if (taxaAgendamentos > 5) {
      recomendacoes.push(
        `Você registrou ${taxaAgendamentos.toFixed(1)}% de agendamentos. Ótimo ritmo! Melhores horários para uma nova tentativa de contato: 8:10, 10:12 e 12:14.`
      );
    }

    const totalNaoTabulada = sumTabulationsByName(['nao tabulada', 'não tabulada', 'tempo excedido']);
    if (totalNaoTabulada > 3) {
      recomendacoes.push(
        `Foram registradas ${formatInt(totalNaoTabulada)} ocorrências de "Não Tabulada - Tempo Excedido" no período. Evite deixar atendimentos sem a devida tabulação.`
      );
    }

    const totalQueda = sumTabulationsByName(['queda']);
    const taxaQueda = (totalQueda / totalLigacoes) * 100;
    if (taxaQueda > 10) {
      recomendacoes.push(
        `Você tem ${taxaQueda.toFixed(1)}% de quedas de ligação. Recomendamos acompanhar a estabilidade da rede e a conexão com a internet. \n`+
        `OBS: a tabulação de "Queda" deve ser utilizada quando a ligação for encerrada antes da conclusão do atendimento.`
      );
    }

    const totalMuda = sumTabulationsByName(['muda', 'mudo']);
    const taxaMuda = (totalMuda / totalLigacoes) * 100;
    if (taxaMuda > 10) {
      recomendacoes.push(
        `${taxaMuda.toFixed(1)}% das ligações foram tabuladas como "Mudas". Recomendamos que verifique o funcionamento dos equipamentos e separe os casos para serem avaliados por nossa equipe. \n`+
        `OBS: A tabulção de Ligaçoes mudas deve ser utilizada quando não houver comunicação/áudio do cliente.`
      );
    }
  }

  const toggleCallStage = async (category: CallTabulationCategory) => {
    if (expandedCallStage === category) {
      callTabulationsRequest.current++;
      setExpandedCallStage(null);
      setLoadingCallTabulations(false);
      return;
    }

    const requestId = ++callTabulationsRequest.current;
    setExpandedCallStage(category);
    setCallTabulations([]);
    setCallTabulationsError(null);
    setLoadingCallTabulations(true);

    try {
      const isSupervisorFocus = (userColab?.cargo || '').toLowerCase() === 'supervisor';

      let equipe = canUseFilterBar
        ? (filters.equipe !== 'todas' ? filters.equipe : undefined)
        : userColab?.equipeNome;
      let colaborador = canUseFilterBar
        ? (filters.colaborador !== 'todos' ? filters.colaborador : undefined)
        : userColab?.name;

      if (isSupervisorFocus) {
        equipe = userColab?.equipeNome || equipe;
        colaborador = undefined;
      }

      const fimInclusivo = toInclusiveEnd(currentEndDate);
      const data = await fetchLigacoesTabulacoes({
        start: currentStartDate,
        end: currentEndDate,
        inicio: currentStartDate,
        fim: fimInclusivo,
        equipe,
        colaborador,
        categoria: category,
      } as any);
      if (requestId === callTabulationsRequest.current) setCallTabulations(data);
    } catch (err: any) {
      if (requestId === callTabulationsRequest.current) {
        setCallTabulationsError(err.message || 'Erro ao carregar tabulações.');
      }
    } finally {
      if (requestId === callTabulationsRequest.current) setLoadingCallTabulations(false);
    }
  };

  const evolucaoDiariaData = useMemo(() => {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
    const diasSemana = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

    const days = Array.from({ length: 5 }, (_, i) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      return date;
    });

    const formatKey = (date: Date) => {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };

    const formatLabel = (date: Date) => {
      const dayName = diasSemana[date.getDay()];
      const dd = String(date.getDate()).padStart(2, '0');
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      return `${dayName} ${dd}/${mm}`;
    };

    const metricsMap = new Map(weeklyMetrics.map(d => [d.date?.slice(0, 10), d]));
    const golsMap = new Map(weeklyGols.map(g => [g.date?.slice(0, 10), g.gols]));

    return days.map(date => {
      const key = formatKey(date);
      const metricas = metricsMap.get(key) || {};
      // ← AJUSTADO: fallback também aplica campanhas ativas
      const gols =
        golsMap.get(key) ??
        calcularGolsComCampanhas(
          Number((metricas as any).assinados) || 0,
          key,
          activeCampaigns,
        );

      return {
        label: formatLabel(date),
        assinados: (metricas as any).assinados || 0,
        ganhos: (metricas as any).ganhos || 0,
        gols,
      };
    });
  }, [weeklyMetrics, weeklyGols, activeCampaigns]);

  return (
    <DashboardLayout title="Painel de Comissões" subtitle="Suas comissões, calculadas pela soma de Gols diários, semanais e mensais">
      {canUseFilterBar && (
        <FilterBar
          key={filterBarKey}
          onFilterChange={handleFilterChange}
          showColaboradorFilter={true}
          className="mb-6"
          onRefresh={handleRefresh}
        />
      )}

      {showExtrato && (
        <ExtratoDialog
          dailyMetrics={dailyMetrics}
          dailyGols={dailyGols}
          campaigns={campaigns}
          metaGolsAssinados={metaGolsAss}
          metaGolsGanhos={metaGolsGan}
          isSupervisor={isSupervisorUser}
          onClose={() => setShowExtrato(false)}
        />
      )}

      {loading && (
        <div className="flex justify-center items-center py-4">
          <Loader2 className="w-5 h-5 animate-spin text-[#2F6FED]" />
          <span className="ml-2 text-sm text-[#64748b]">Carregando seus dados...</span>
        </div>
      )}

      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg text-sm mb-4">
          <p>{error}</p>
          <button onClick={() => reloadData(true)} className="mt-2 px-4 py-2 bg-red-600 text-white rounded-lg text-xs hover:bg-red-700">Tentar novamente</button>
        </div>
      )}

      {canViewCommissionOverview && !loading && !isOverviewVisible && (
        <div className="mb-6 flex items-center gap-2 text-xs text-[#64748b] bg-[#f8fafc] border border-[#e2e8f0] rounded-lg px-3 py-2">
          <Users className="w-3.5 h-3.5 text-[#2F6FED]" />
          <span>A Visão Geral das Comissões fica disponível quando nenhum filtro de equipe ou colaborador está aplicado.</span>
        </div>
      )}

      {isOverviewVisible && (
        <div className="card p-5 mb-6 animate-fade-in-up">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-[#2F6FED]" />
              <h3 className="text-sm font-bold text-[#0f172a]">Visão Geral das Comissões</h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#eff6ff] text-[#2F6FED] font-medium">
                {filteredCommissionOverview.length} colaboradores
              </span>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                placeholder="Buscar por nome ou equipe..."
                value={commissionOverviewSearch}
                onChange={(e) => setCommissionOverviewSearch(e.target.value)}
                className="pl-8 pr-3 py-1.5 text-xs rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#09175b]/20 w-64"
              />
            </div>
          </div>

          {commissionOverviewLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-[#2F6FED]" />
            </div>
          ) : commissionOverviewError ? (
            <div className="bg-red-50 text-red-700 p-3 rounded-lg text-xs">{commissionOverviewError}</div>
          ) : filteredCommissionOverview.length === 0 ? (
            <div className="text-center text-[#94a3b8] py-6 text-xs">
              {commissionOverviewSearch ? "Nenhum resultado encontrado." : "Nenhum dado disponível."}
            </div>
          ) : (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto custom-scrollbar">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white z-10">
                  <tr className="border-b border-[#e2e8f0] text-left text-[#64748b]">
                    <th className="py-2 px-3 font-medium">Colaborador</th>
                    <th className="py-2 px-3 font-medium">Equipe</th>
                    <th className="py-2 px-3 font-medium">Cargo</th>
                    <th className="py-2 px-3 font-medium text-right">Assinados</th>
                    <th className="py-2 px-3 font-medium text-right">Ganhos</th>
                    <th className="py-2 px-3 font-medium text-right">Gols</th>
                    <th className="py-2 px-3 font-medium text-right">Comissão</th>
                    <th className="py-2 px-3 font-medium text-center">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCommissionOverview.map((item) => (
                    <tr
                      key={item.id}
                      className={cn(
                        "border-b border-[#f1f5f9] hover:bg-[#f8fafc] transition-colors",
                        updatingCommissionId === item.id && "opacity-60"
                      )}
                    >
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center font-bold text-[10px] flex-shrink-0">
                            {item.collaborator.avatar || item.name.charAt(0).toUpperCase()}
                          </div>
                          <span className="font-medium text-[#0f172a] truncate">{item.name}</span>
                        </div>
                      </td>
                      <td className="py-2 px-3 text-[#475569] truncate">{item.team || '—'}</td>
                      <td className="py-2 px-3">
                        <span
                          className={cn(
                            "inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium capitalize",
                            item.role === 'supervisor' && "bg-[#eff6ff] text-[#2F6FED]",
                            item.role === 'coordenador' && "bg-[#f5f3ff] text-[#8B5CF6]",
                            item.role === 'assessor' && "bg-[#f0fdf4] text-[#16A34A]",
                          )}
                        >
                          {item.role}
                          {item.isSupervisorSR && ' SR'}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right text-[#475569]">{formatInt(item.assinados)}</td>
                      <td className="py-2 px-3 text-right font-semibold text-[#0f172a]">{formatInt(item.ganhos)}</td>
                      <td className="py-2 px-3 text-right font-semibold text-[#16A34A]">{formatInt(item.gols)}</td>
                      <td className="py-2 px-3 text-right font-semibold text-[#2F6FED]">
                        {item.commission == null ? '—' : displayCurrency(item.commission)}
                      </td>
                      <td className="py-2 px-3 text-center">
                        <button
                          onClick={() => handleSelectFromOverview(item)}
                          disabled={item.role === 'coordenador' || updatingCommissionId === item.id}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[10px] font-medium text-[#2F6FED] hover:bg-[#eff6ff] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          title={item.role === 'coordenador' ? 'Coordenadores não têm visualização individual' : 'Ver detalhes deste colaborador'}
                        >
                          <Target className="w-3 h-3" />
                          Ver detalhes
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!loading && filteredColabs.length === 0 && !error && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-center text-amber-800 text-sm">Nenhum dado de comissão encontrado para você.</div>
      )}

      {!loading && filteredColabs.length > 0 && (
        <>
          {userColab ? (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                {summaryCards.map((card, idx) => {
                  const Icon = card.icon;
                  let displayValue = card.isPercent ? `${card.value.toFixed(1)}%` : card.isCurrency ? displayCurrency(card.value) : formatInt(card.value);
                  return (
                    <div key={card.label} className="card animate-fade-in-up" style={{ animationDelay: `${idx * 80}ms` }}>
                      <div className="flex items-center gap-3 mb-3">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${card.color}15` }}>
                          <Icon className="w-4.5 h-4.5" style={{ color: card.color }} />
                        </div>
                        <span className="text-xs text-[#64748b] font-medium">{card.label}</span>
                      </div>
                      <div className="kpi-value mb-1" style={{ color: "#0f172a" }}>{displayValue}</div>
                    </div>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <div className="card p-5 flex flex-col order-3 lg:col-span-2">
                  <h3 className="text-sm font-bold mb-4">Comissão Total do Colaborador</h3>
                  {commissionData.length === 0 ? (
                    <div className="text-center text-[#94a3b8] py-8">Nenhum dado disponível.</div>
                  ) : (
                    <>
                      <div className="flex-1" style={{ minHeight: '300px' }}>
                        <ResponsiveContainer width="100%" height={300}>
                          <BarChart data={commissionChartData} layout="vertical" margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                            <XAxis
                              type="number"
                              domain={[0, 9000]}
                              ticks={[0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]}
                              tickFormatter={v => hideValues ? "***" : formatCurrency(v)}
                              tick={{ fontSize: 11, fill: "#64748b" }}
                            />
                            <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: "#64748b" }} />
                            <Tooltip content={<CustomTooltip hideValues={hideValues} />} />
                            <Bar dataKey="value" name="Comissão" barSize={44} radius={[0, 4, 4, 0]}>
                              {commissionChartData.map(item => <Cell key={item.name} fill={item.color} />)}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>

                      {commissionData.map((item) => {
                        const colab = item.originalColab;
                        const productType = getFaixaProductType(colab);
                        const faixas = tabelaComissoes
                          .filter(f => f.tipo === productType)
                          .sort((a, b) => a.faixa_min - b.faixa_min);
                        const goalGap = calculator.calculateGoalGap(item.totalCycles, tabelaComissoes);

                        let productGapInfo: { gap: number; nextValue: number } | null = null;
                        if (faixas.length > 0) {
                          const ganhosAtuais = item.ganhos;
                          const proximaFaixa = faixas.find(f => f.faixa_min > ganhosAtuais);
                          if (proximaFaixa) {
                            productGapInfo = { gap: proximaFaixa.faixa_min - ganhosAtuais, nextValue: proximaFaixa.faixa_min };
                          } else if (ganhosAtuais < faixas[0].faixa_min) {
                            productGapInfo = { gap: faixas[0].faixa_min - ganhosAtuais, nextValue: faixas[0].faixa_min };
                          }
                        }

                        let supervisorGapInfo: { gap: number; nextValue: number } | null = null;
                        if (isSupervisorUser) {
                          const totalGanEquipe = sumTeamGanhos(storeColabs, colab.equipeNome);
                          const isSR = Boolean(colab.isSupervisorSR) || calculator.isSupervisorSR(colab.email);
                          supervisorGapInfo = calculator.calculateSupervisorGap(totalGanEquipe, isSR, tabelaComissoes);
                        }

                        return (
                          <div key={item.id} className="mt-4 p-3 bg-[#f8fafc] rounded-lg text-xs space-y-2">
                            {isSupervisorUser ? (
                              <>
                                <p><span className="font-semibold text-[#2F6FED]">Ganhos da equipe:</span> {formatInt(sumTeamGanhos(storeColabs, colab.equipeNome))}</p>
                                {supervisorGapInfo ? (
                                  <p>
                                    <span className="font-semibold text-[#8B5CF6]">Próxima faixa:</span>{' '}
                                    faltam <span className="font-bold">{formatInt(supervisorGapInfo.gap)}</span> ganhos para a faixa mínima de {formatInt(supervisorGapInfo.nextValue)}.
                                  </p>
                                ) : (
                                  <p className="text-[#94a3b8]">Você já está na faixa máxima de supervisor.</p>
                                )}
                              </>
                            ) : (
                              <>
                                {goalGap ? (
                                  <p><span className="font-semibold text-[#8B5CF6]">Gols:</span> faltam <span className="font-bold">{formatInt(goalGap.gap)}</span> gols para a próxima faixa (mín. {formatInt(goalGap.nextValue)}).</p>
                                ) : (
                                  <p className="text-[#94a3b8]">Você já está na faixa máxima de gols.</p>
                                )}

                                {productGapInfo ? (
                                  <p><span className="font-semibold text-[#2F6FED]">Ganhos:</span> faltam <span className="font-bold">{formatInt(productGapInfo.gap)}</span> ganhos para a próxima faixa (mín. {formatInt(productGapInfo.nextValue)}).</p>
                                ) : (
                                  <p className="text-[#94a3b8]">
                                    {faixas.length === 0 ? `Nenhuma faixa de ganhos configurada para ${productType}.` : "Você já está na faixa máxima de ganhos."}
                                  </p>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </>
                  )}

                  <button
                    onClick={() => {
                      if (dailyMetrics.length === 0) {
                        toast.error('Nenhum dado diário disponível para exibir extrato.');
                        return;
                      }
                      setShowExtrato(true);
                    }}
                    className="mt-4 w-full py-2 px-4 inline-flex items-center justify-center gap-2 text-xs font-semibold rounded-lg border border-[#2F6FED] text-[#2F6FED] hover:bg-[#eff6ff] transition-colors"
                  >
                    <CalendarDays className="w-4 h-4" />
                    Ver Extrato de Gols e Campanhas
                  </button>
                </div>

                {!isSupervisorUser && (
                  <div className="card p-5 order-1">
                    <h3 className="text-sm font-bold mb-4">Metas vs Realizado</h3>
                    <div className="space-y-5 max-h-[420px] overflow-y-auto pr-2 custom-scrollbar">
                      {commissionData.map((item) => {
                        const colabOriginal = item.originalColab;
                        const metaDiarioAss = Number(colabOriginal?.pesoDiarioAssinados ?? colabOriginal?.metaDiarioAssinados ?? 3);
                        const metaDiarioProt = Number(colabOriginal?.pesoDiarioGanhos ?? colabOriginal?.metaDiarioGanhos ?? 3);
                        const metaSemanalAss = Number(colabOriginal?.pesoSemanalAssinados ?? colabOriginal?.metaSemanalAssinados ?? 15);
                        const metaSemanalProt = Number(colabOriginal?.pesoSemanalGanhos ?? colabOriginal?.metaSemanalGanhos ?? 15);
                        const metaMensalAss = Number(colabOriginal?.pesoMensalAssinados ?? colabOriginal?.metaMensalAssinados ?? 60);
                        const metaMensalProt = Number(colabOriginal?.pesoMensalGanhos ?? colabOriginal?.metaMensalGanhos ?? 60);
                        const metaGolsAss = Number(colabOriginal?.metaGolsAssinados ?? 3);
                        const metaGolsGan = Number(colabOriginal?.metaGolsGanhos ?? 3);

                        const now = new Date();
                        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                        const dayOfWeek = now.getDay();
                        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
                        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
                        const sunday = new Date(monday);
                        sunday.setDate(monday.getDate() + 6);
                        const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
                        const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
                        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
                        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                        const monthStartStr = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-${String(monthStart.getDate()).padStart(2, '0')}`;
                        const monthEndStr = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`;

                        const dailyDataDiario = dailyMetrics.filter(d => d.date && d.date.slice(0,10) === todayStr);
                        const dailyDataSemanal = dailyMetrics.filter(d => d.date && d.date.slice(0,10) >= mondayStr && d.date.slice(0,10) <= sundayStr);
                        const dailyDataMensal = dailyMetrics.filter(d => d.date && d.date.slice(0,10) >= monthStartStr && d.date.slice(0,10) <= monthEndStr);

                        const assinadosDiario = dailyDataDiario.reduce((sum, d) => sum + (Number(d.assinados) || 0), 0);
                        const assinadosSemanal = dailyDataSemanal.reduce((sum, d) => sum + (Number(d.assinados) || 0), 0);
                        const assinadosMensal = dailyDataMensal.reduce((sum, d) => sum + (Number(d.assinados) || 0), 0);

                        const protocoladosDiario = dailyDataDiario.reduce((sum, d) => sum + (Number(d.protocolados) || 0), 0);
                        const protocoladosSemanal = dailyDataSemanal.reduce((sum, d) => sum + (Number(d.protocolados) || 0), 0);
                        const protocoladosMensal = dailyDataMensal.reduce((sum, d) => sum + (Number(d.protocolados) || 0), 0);

                        const ganhosDiario = dailyDataDiario.reduce((sum, d) => sum + (Number(d.ganhos) || 0), 0);

                        const periodos = [
                          { label: "Diário (hoje)", metaAss: metaDiarioAss, metaProt: metaDiarioProt, atualAss: assinadosDiario, atualProt: protocoladosDiario, colorAss: "#2F6FED", colorProt: "#16A34A" },
                          { label: "Semanal (semana atual)", metaAss: metaSemanalAss, metaProt: metaSemanalProt, atualAss: assinadosSemanal, atualProt: protocoladosSemanal, colorAss: "#EA8C1D", colorProt: "#16A34A" },
                          { label: "Mensal (mês atual)", metaAss: metaMensalAss, metaProt: metaMensalProt, atualAss: assinadosMensal, atualProt: protocoladosMensal, colorAss: "#8B5CF6", colorProt: "#16A34A" },
                        ];

                        return (
                          <div key={item.id || item.name}>
                            <div className="flex items-center gap-3 mb-3">
                              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center text-xs font-bold">{item.avatar}</div>
                              <div><span className="font-medium text-[#0f172a] text-sm">{item.name}</span></div>
                            </div>

                            {periodos.map((p) => {
                              const pctAss = calcPercent(p.atualAss, p.metaAss);
                              const pctProt = p.metaProt > 0 ? calcPercent(p.atualProt, p.metaProt) : 0;
                              const faltaAss = Math.max(0, p.metaAss - p.atualAss);
                              const faltaProt = Math.max(0, p.metaProt - p.atualProt);

                              return (
                                <div key={p.label} className="mb-3 last:mb-0">
                                  <p className="text-xs font-semibold text-[#475569] mb-1">{p.label}</p>
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] text-[#64748b] w-12">Assin.</span>
                                    <div className="flex-1 progress-bar h-2">
                                      <div className="progress-fill" style={{ width: `${pctAss}%`, background: p.colorAss }} />
                                    </div>
                                    <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">{formatInt(p.atualAss)}/{formatInt(p.metaAss)}</span>
                                    <span className="text-[10px] font-medium" style={{ color: p.colorAss }}>{pctAss.toFixed(0)}%</span>
                                  </div>
                                  <div className="text-[9px] text-[#94a3b8] ml-14 mb-1">{faltaAss > 0 ? `Faltam ${formatInt(faltaAss)}` : "Atingido"}</div>
                                  {!item.isSpecial && (
                                    <>
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] text-[#64748b] w-12">Prot.</span>
                                        <div className="flex-1 progress-bar h-2">
                                          <div className="progress-fill" style={{ width: `${pctProt}%`, background: p.colorProt }} />
                                        </div>
                                        <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">{formatInt(p.atualProt)}/{formatInt(p.metaProt)}</span>
                                        <span className="text-[10px] font-medium" style={{ color: p.colorProt }}>{pctProt.toFixed(0)}%</span>
                                      </div>
                                      <div className="text-[9px] text-[#94a3b8] ml-14 mb-1">{faltaProt > 0 ? `Faltam ${formatInt(faltaProt)}` : "Atingido"}</div>
                                    </>
                                  )}
                                </div>
                              );
                            })}

                            <div className="mt-3 pt-3 border-t border-[#e2e8f0]">
                              <p className="text-xs font-semibold text-[#475569] mb-1">Gols (hoje)</p>
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-[10px] text-[#64748b] w-12">Assin.</span>
                                <div className="flex-1 progress-bar h-2">
                                  <div className="progress-fill" style={{ width: `${calcPercent(assinadosDiario, metaGolsAss)}%`, background: "#2F6FED" }} />
                                </div>
                                <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">{formatInt(assinadosDiario)}/{formatInt(metaGolsAss)}</span>
                                <span className="text-[10px] font-medium" style={{ color: "#2F6FED" }}>{calcPercent(assinadosDiario, metaGolsAss).toFixed(0)}%</span>
                              </div>
                              {!item.isSpecial && (
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-[10px] text-[#64748b] w-12">Ganhos</span>
                                  <div className="flex-1 progress-bar h-2">
                                    <div className="progress-fill" style={{ width: `${calcPercent(ganhosDiario, metaGolsGan)}%`, background: "#16A34A" }} />
                                  </div>
                                  <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">{formatInt(ganhosDiario)}/{formatInt(metaGolsGan)}</span>
                                  <span className="text-[10px] font-medium" style={{ color: "#16A34A" }}>{calcPercent(ganhosDiario, metaGolsGan).toFixed(0)}%</span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="card p-5 order-2">
                  <h3 className="text-sm font-bold mb-5 text-[#09175b]">Ligações (Pipeline Visual)</h3>
                  {callMetrics.length === 0 ? (
                    <div className="text-center text-[#94a3b8] py-8">Nenhuma ligação encontrada no período.</div>
                  ) : (
                    <div className="flex flex-col items-center gap-0 w-full">
                      {callFunnelLayout.map(stage => {
                        const Icon = stage.icon;
                        const isExpanded = stage.key != null && expandedCallStage === stage.key;
                        const percentageOfTotal = callFunnelStages[0].count > 0 ? (stage.count / callFunnelStages[0].count) * 100 : 0;
                        return (
                          <div key={stage.label} className="w-full flex flex-col items-center">
                            {stage.key ? (
                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                aria-controls={`call-tabulations-${stage.key}`}
                                onClick={() => toggleCallStage(stage.key!)}
                                className="flex items-center justify-between gap-2 px-3 py-2 sm:px-4 sm:py-3 rounded-xl flex-wrap text-left transition-colors"
                                style={{
                                  width: `${stage.widthPct}%`,
                                  maxWidth: '100%',
                                  minWidth: '0',
                                  background: `${stage.color}15`,
                                  border: `1.5px solid ${stage.color}30`,
                                }}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: stage.color }} />
                                  <span className="text-xs font-semibold break-words" style={{ color: stage.color }}>{stage.label}</span>
                                </div>
                                <span className="flex items-center gap-2 flex-shrink-0">
                                  <span className="text-sm font-black" style={{ color: stage.color }}>{formatInt(stage.count)}</span>
                                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} style={{ color: stage.color }} />
                                </span>
                              </button>
                            ) : (
                              <div
                                className="flex items-center justify-between gap-2 px-3 py-2 sm:px-4 sm:py-3 rounded-xl flex-wrap"
                                style={{
                                  width: `${stage.widthPct}%`,
                                  maxWidth: '100%',
                                  background: `${stage.color}15`,
                                  border: `1.5px solid ${stage.color}30`,
                                }}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: stage.color }} />
                                  <span className="text-xs font-semibold break-words" style={{ color: stage.color }}>{stage.label}</span>
                                </div>
                                <span className="text-sm font-black flex-shrink-0" style={{ color: stage.color }}>{formatInt(stage.count)}</span>
                              </div>
                            )}
                            <p className="py-1 text-[10px] text-[#64748b]">{percentageOfTotal.toFixed(1)}% do total</p>
                            {isExpanded && (
                              <div id={`call-tabulations-${stage.key}`} className="mt-2 w-full p-3 rounded-lg border border-[#e2e8f0] bg-white">
                                {loadingCallTabulations ? (
                                  <div className="flex justify-center py-3"><Loader2 className="w-4 h-4 animate-spin text-[#09175b]" /></div>
                                ) : callTabulationsError ? (
                                  <p className="text-xs text-red-600">{callTabulationsError}</p>
                                ) : callTabulations.length > 0 ? (
                                  <div className="space-y-2">
                                    {callTabulations.map(item => (
                                      <div key={item.tabulacao} className="flex items-center justify-between gap-3 text-xs">
                                        <span className="text-[#475569]">{item.tabulacao}</span>
                                        <span className="font-bold text-[#0f172a]">{formatInt(item.total)}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-xs text-[#64748b]">Nenhuma tabulação encontrada.</p>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {isSupervisorUser && (
                  <div className="card p-5 order-1">
                    <h3 className="text-sm font-bold mb-4">Equipe (Assinados / Ganhos)</h3>
                    <div className="space-y-2 max-h-[420px] overflow-y-auto pr-2 custom-scrollbar">
                      {teamMembers.length > 0 ? (
                        teamMembers.map(member => (
                          <div key={member.id} className="flex items-center justify-between text-xs p-2 bg-[#f8fafc] rounded-lg">
                            <div className="flex items-center gap-2">
                              <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center font-bold text-[10px]">
                                {member.avatar || member.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="font-medium text-[#0f172a]">{member.name}</span>
                            </div>
                            <div className="flex items-center gap-4">
                              <span>Ass: <b>{formatInt(member.assinados)}</b></span>
                              <span>Ganhos: <b>{formatInt(member.ganhos)}</b></span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="text-center text-[#94a3b8] py-4 text-xs">Nenhum membro na equipe.</div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="card p-5 mb-6">
                <h3 className="text-sm font-bold mb-4">Seus Números</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
                  <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><FileText className="w-4 h-4 text-[#2F6FED] mx-auto mb-1" /><p className="text-[11px]">Emitidos</p><p className="text-base font-semibold">{formatInt(recebidos)}</p></div>
                  <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><FileCheck className="w-4 h-4 text-[#16A34A] mx-auto mb-1" /><p className="text-[11px]">Assinados</p><p className="text-base font-semibold">{formatInt(assinados)}</p></div>
                  <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><Award className="w-4 h-4 text-[#EA8C1D] mx-auto mb-1" /><p className="text-[11px]">Ganhos</p><p className="text-base font-semibold">{formatInt(ganhos)}</p></div>
                  <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><Archive className="w-4 h-4 text-[#8B5CF6] mx-auto mb-1" /><p className="text-[11px]">Protocolados</p><p className="text-base font-semibold">{formatInt(protocolados)}</p></div>
                  <div className="bg-[#f8fafc] rounded-lg p-3 text-center"><XCircle className="w-4 h-4 text-[#DC2626] mx-auto mb-1" /><p className="text-[11px]">Perdidos</p><p className="text-base font-semibold">{formatInt(perdidos)}</p></div>
                </div>
              </div>

              {tempRecsForColab.length > 0 && (
                <div className="card p-5 mb-6 animate-fade-in-up border-l-4 border-l-[#EA8C1D]">
                  <div className="flex items-center gap-2 mb-4">
                    <Megaphone className="w-4 h-4 text-[#EA8C1D]" />
                    <h3 className="text-sm font-bold text-[#0f172a]">Orientações do Supervisor</h3>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#EA8C1D]/10 text-[#EA8C1D] font-medium">ativas por 24h</span>
                  </div>
                  <ul className="space-y-2">
                    {tempRecsForColab.map((r) => {
                      const style = PRIORITY_STYLES[r.priority];
                      const PIcon = style.Icon;
                      return (
                        <li key={r.id} className={cn("flex gap-3 items-start p-3 rounded-lg border", style.border, style.bg)}>
                          <PIcon size={15} className={cn("mt-0.5 shrink-0", style.text)} />
                          <div className="flex-1 min-w-0">
                            <p className={cn("text-[13px] whitespace-pre-wrap break-words", style.text)}>{r.text}</p>
                            <p className="text-[10px] text-slate-500 mt-1 flex flex-wrap items-center gap-2">
                              <span>{r.authorName} · {r.authorCargo}</span>
                              <span className="inline-flex items-center gap-1"><Clock size={10} /> expira em {getRemainingTimeLabel(r.expiresAt)}</span>
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {!isSupervisorUser && !isSpecialUser && (
                <div className="card p-5 mb-6">
                  <h3 className="text-sm font-bold mb-4">Evolução Diária</h3>
                  {evolucaoDiariaData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={evolucaoDiariaData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 11 }} width={28} allowDecimals={false} />
                        <Tooltip content={<SimpleTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Bar dataKey="assinados" fill="#2F6FED" name="Assinados" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="ganhos" fill="#16A34A" name="Ganhos" radius={[4, 4, 0, 0]} />
                        <Bar dataKey="gols" fill="#8B5CF6" name="Gols" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="text-center text-[#94a3b8] py-8">Dados de evolução diária indisponíveis.</div>
                  )}
                </div>
              )}

              {recomendacoes.length > 0 && (
                <div className="card p-5 mb-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-bold">Recomendações</h3>
                    {loadingAllTabulations && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
                        <Loader2 size={10} className="animate-spin" /> atualizando tabulações...
                      </span>
                    )}
                  </div>
                  <ul className="space-y-2">
                    {recomendacoes.map((r, i) => (
                      <li key={i} className="flex gap-2 text-[13px] text-[#475569] bg-[#f8fafc] border border-[#e2e8f0] rounded-lg p-3">
                        <span className="text-[#2F6FED]">→</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="card p-5 mb-6">
                <h3 className="text-sm font-bold mb-3">Como a comissão é calculada</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-[#64748b]">
                  <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">1. Regra base por assinados:</span> 3→1, 5→2, 7→3, 9→4, 11→5 (cada +2 assinados = +1 gol).</div>
                  <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">2. Campanhas ativas:</span> multiplicam, somam ou substituem os gols do dia (GOLS / ASSINADOS / PROGRESSIVA).</div>
                  <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">3. Comissão total:</span> soma da faixa de ganhos + faixa de gols.</div>
                  <div className="bg-[#f8fafc] rounded-lg p-3"><span className="font-bold text-[#0f172a]">4. Faixas por ganhos:</span> produtos (AUXILIO ACIDENTE, QUINQUENIO, CONCOMITANTE) e supervisores (SUPERVISOR, SUPERVISOR SR) usam <b>ganhos</b> como base.</div>
                </div>
              </div>
            </>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
              Selecione um colaborador no filtro acima para visualizar as comissões.
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
}