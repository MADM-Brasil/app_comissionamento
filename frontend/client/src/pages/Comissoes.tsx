// src/pages/Comissoes.tsx
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import FilterBar from "@/components/FilterBar";
import { useAppStore, formatCurrency, type Campaign, type Collaborator, type TabelaComissaoItem } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import {
  DollarSign, Award, FileCheck, Target, Loader2, RefreshCw,
  FileText, Archive, XCircle, CalendarDays, TrendingUp,
  Users, PhoneCall, CalendarClock, MessageCircle, ChevronDown, Search,
  Megaphone, Info, AlertCircle, Clock,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, Legend, LabelList,
} from "recharts";
import { calculator } from "@/lib/calculator";
import {
  fetchDailyMetrics,
  calcularGolsComCampanhas,
  calcularTotalGolsComCampanhas,
  calcularGolsDiariosComCampanhas,
  calcularGolsPorAssinados,
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

function getMonthDateRange(date: string): { start: string; end: string } {
  const [year, month] = date.slice(0, 7).split('-').map(Number);
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const nextMonth = new Date(year, month, 1);
  const end = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;
  return { start: `${monthKey}-01`, end };
}

const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário','BackOffice',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro', 'Equipe Reciclagem','','Equipe Leonardo','Equipe Ariana', 'Equipe Elizandra'
];

const EXCLUDED_CARGOS = [
  "desativado","assistente","analista juridico","gestor de projetos","analista",
  "analista de discadora","coordenador","salesops","ceo",
  "analista de crm","desenvolvedor","diretora","analista de dados","desenvolvedor make",
];

const normalizeText = (text: string) => (text || '').trim().toLowerCase();
const normalizeName = (text: string) => normalizeText(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const EXCLUDED_TEAMS_SET = new Set(EXCLUDED_TEAMS.map(normalizeName));

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
  if (cargo.startsWith('supervisor')) return 'supervisor';
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

function calculateAssessorGols(
  collaborator: Collaborator,
  dailyMetrics: Array<{ date: string; assinados: number; ganhos?: number }>,
  campaigns: CampaignLike[],
): number {
  if (isSpecialGroupColaborador(collaborator)) return 0;
  if (!dailyMetrics || dailyMetrics.length === 0) return 0;
  return calcularTotalGolsComCampanhas(dailyMetrics as any, campaigns);
}

function calculateAssessorCommission(
  collaborator: Collaborator,
  dailyMetrics: Array<{ date: string; assinados: number; ganhos: number }>,
  commissionBands: TabelaComissaoItem[],
  campaigns: CampaignLike[],
): number {
  const ganhos = dailyMetrics.reduce((total, day) => total + (day.ganhos || 0), 0);
  const productType = getFaixaProductType(collaborator);
  const productCommission = calculator.calculateProductCommission(ganhos, productType, commissionBands);
  const totalGols = calculateAssessorGols(collaborator, dailyMetrics, campaigns);
  const goalCommission = calculator.calculateGoalCommission(totalGols, commissionBands);
  return productCommission + goalCommission;
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
  if (equipeNormalizada.includes('quinquenio') || equipeNormalizada.includes('quinquênio') || equipeNormalizada.includes('tatiane')) {
    return 'QUINQUENIO';
  }
  if (equipeNormalizada.includes('concomitante')) {
    return 'CONCOMITANTE';
  }

  return 'AUXILIO ACIDENTE';
}

// ============================================================
//  CAMPANHA CAMPGANHOS_2026
// ============================================================
const CAMPGANHOS_2026_PARENT = 'CAMPGANHOS_2026';
const CAMPGANHOS_DIA_2026 = 'CAMPGANHOS_DIA_2026';
const CAMPGANHOS_MEN_2026 = 'CAMPGANHOS_MEN_2026';
const CAMPGANHOS_SEM_2026_SUPER = 'CAMPGANHOS_SEM_2026_SUPER';
const CAMPGANHOS_MEN_2026_SUPER = 'CAMPGANHOS_MEN_2026_SUPER';

interface CampGanhosFaixa {
  faixa_min: number;
  faixa_max: number | null;
  valor_comissao: number;
}

interface CampGanhosDia { date: string; ganhos: number; valor: number; }
interface CampGanhosSemana { weekKey: string; ganhos: number; valor: number; dias: string[]; }

interface CampGanhosResult {
  ativo: boolean;
  estimativa_dia: number;
  estimativa_semana: number;
  comissao_mes_assessor: number;
  comissao_mes_supervisor: number;
  ganhos_mes: number;
  detalhes: { dias: CampGanhosDia[]; semanas: CampGanhosSemana[]; };
}

const EMPTY_CAMPGANHOS_RESULT: CampGanhosResult = {
  ativo: false,
  estimativa_dia: 0,
  estimativa_semana: 0,
  comissao_mes_assessor: 0,
  comissao_mes_supervisor: 0,
  ganhos_mes: 0,
  detalhes: { dias: [], semanas: [] },
};

function isCampGanhos2026Active(campaigns: Campaign[]): boolean {
  return (campaigns || []).some(c =>
    (c?.tipo || '').toUpperCase() === CAMPGANHOS_2026_PARENT && !!c.validacao_financeiro
  );
}

// ============================================================
//  parseFaixaDescricao (permissivo)
// ------------------------------------------------------------
// Aceita, em ordem:
//   1) JSON: {"valor": 500, "max": 79}
//   2) "X|Y" : "500|79"
//   3) Número puro: "500"
//   4) Regex fallback: qualquer texto com números — primeiro é `valor`,
//      segundo (se houver) é `max`.
// ============================================================
function parseFaixaDescricao(descricao: string): { valor: number; max: number | null } | null {
  const raw = String(descricao || '').trim();
  if (!raw) return null;

  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      const valor = Number(obj.valor ?? obj.valor_comissao ?? obj.value ?? obj.comissao);
      const faixaMax = obj.max ?? obj.faixa_max;
      const max = faixaMax == null ? null : Number(faixaMax);
      if (Number.isFinite(valor)) return { valor, max: Number.isFinite(max) ? max : null };
    } catch { /* segue */ }
  }

  if (raw.includes('|')) {
    const [v, m] = raw.split('|').map(s => s.trim());
    const valor = Number(v);
    const max = m === '' || m == null ? null : Number(m);
    if (Number.isFinite(valor)) return { valor, max: Number.isFinite(max) ? max : null };
  }

  const only = Number(raw);
  if (Number.isFinite(only)) return { valor: only, max: null };

  const numMatches = raw.match(/-?\d+(?:[.,]\d+)?/g);
  if (numMatches && numMatches.length > 0) {
    const toNum = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));
    const valor = toNum(numMatches[0]);
    const max = numMatches[1] != null ? toNum(numMatches[1]) : null;
    if (Number.isFinite(valor)) return { valor, max: Number.isFinite(max) ? max : null };
  }

  return null;
}

function extractFaixas(
  campaigns: Campaign[],
  tipo: string,
  commissionBands: TabelaComissaoItem[] = [],
  useTableFallback = false,
): CampGanhosFaixa[] {
  const faixasPorMinimo = new Map<number, CampGanhosFaixa>();

  for (const c of campaigns || []) {
    if ((c.tipo || '').trim().toUpperCase() !== tipo) continue;
    const faixa_min = Number(c.multiplicador);
    if (!Number.isFinite(faixa_min) || faixa_min <= 0) continue;
    const parsed = parseFaixaDescricao(c.descricao);
    if (!parsed) continue;
    faixasPorMinimo.set(faixa_min, { faixa_min, faixa_max: parsed.max, valor_comissao: parsed.valor });
  }

  if (faixasPorMinimo.size === 0 && useTableFallback) {
    for (const band of commissionBands) {
      if ((band.tipo || '').trim().toUpperCase() !== tipo) continue;
      const faixa_min = Number(band.faixa_min);
      if (!Number.isFinite(faixa_min) || faixa_min <= 0) continue;
      const faixaMax = Number(band.faixa_max);
      faixasPorMinimo.set(faixa_min, {
        faixa_min,
        faixa_max: Number.isFinite(faixaMax) && faixaMax > 0 ? faixaMax : null,
        valor_comissao: Number(band.valor_comissao) || 0,
      });
    }
  }

  const faixas = Array.from(faixasPorMinimo.values());
  faixas.sort((a, b) => a.faixa_min - b.faixa_min);
  for (let i = 0; i < faixas.length; i++) {
    if (faixas[i].faixa_max == null && i < faixas.length - 1) {
      faixas[i].faixa_max = faixas[i + 1].faixa_min - 1;
    }
  }
  return faixas;
}

// ============================================================
//  Faixa mensal do SUPERVISOR
// ------------------------------------------------------------
// Sempre usa CAMPGANHOS_MEN_2026_SUPER.
// Não cai mais para CAMPGANHOS_MEN_2026 (faixa do assessor).
// Se a faixa SUPER não estiver em `campaigns` nem em `tabelaComissoes`,
// retorna vazio (comissão de campanha = 0) e emite um console.warn com
// os tipos realmente disponíveis — para facilitar o diagnóstico.
// ============================================================
function extractSupervisorMonthlyCampaignBands(
  campaigns: Campaign[],
  commissionBands: TabelaComissaoItem[],
): CampGanhosFaixa[] {
  const bands = extractFaixas(campaigns, CAMPGANHOS_MEN_2026_SUPER, commissionBands, true);
  if (bands.length === 0 && typeof window !== 'undefined' && (window as any).__DEBUG_COMISSOES__) {
    const tiposCampanhas = Array.from(
      new Set((campaigns || []).map(c => (c.tipo || '').trim().toUpperCase()).filter(Boolean))
    ).sort();
    const tiposTabela = Array.from(
      new Set((commissionBands || []).map(b => (b.tipo || '').trim().toUpperCase()).filter(Boolean))
    ).sort();
    // eslint-disable-next-line no-console
    console.warn(
      `[Comissoes] Faixa mensal do supervisor "${CAMPGANHOS_MEN_2026_SUPER}" não encontrada.`,
      '\n  Tipos em campaigns      →', tiposCampanhas,
      '\n  Tipos em tabelaComissoes →', tiposTabela,
      '\n  Ative o modo de debug com: window.__DEBUG_COMISSOES__ = true',
    );
  }
  return bands;
}

function calcFaixaValue(faixas: CampGanhosFaixa[], ganhos: number): number {
  const value = Number(ganhos) || 0;
  if (!faixas.length) return 0;
  for (const f of faixas) {
    const max = f.faixa_max == null ? Infinity : f.faixa_max;
    if (value >= f.faixa_min && value <= max) return f.valor_comissao;
  }
  return 0;
}

function getTierProgress(faixas: CampGanhosFaixa[], ganhos: number) {
  const currentGains = Math.max(0, Number(ganhos) || 0);
  const current = faixas.find(f =>
    currentGains >= f.faixa_min && currentGains <= (f.faixa_max ?? Infinity)
  );
  const next = faixas.find(f => f.faixa_min > currentGains);
  const target = next?.faixa_min ?? current?.faixa_max ?? faixas[0]?.faixa_min ?? 0;
  const progress = next
    ? Math.min(100, (currentGains / Math.max(target, 1)) * 100)
    : current ? 100 : target > 0 ? Math.min(100, (currentGains / target) * 100) : 0;

  return {
    hasBands: faixas.length > 0,
    currentGains,
    current,
    next,
    gap: next ? Math.max(0, next.faixa_min - currentGains) : 0,
    target,
    progress,
  };
}

function getWeekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return dateStr;
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const dd = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function formatWeekRange(weekKey: string): string {
  const monday = new Date(`${weekKey}T00:00:00`);
  if (isNaN(monday.getTime())) return weekKey;
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d: Date) =>
    `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${fmt(monday)} — ${fmt(sunday)}`;
}

function calcularCampGanhos2026(
  dailyMetrics: Array<{ date: string; ganhos?: number }>,
  campaigns: Campaign[],
  commissionBands: TabelaComissaoItem[] = [],
): CampGanhosResult {
  if (!isCampGanhos2026Active(campaigns)) {
    return { ...EMPTY_CAMPGANHOS_RESULT };
  }

  const faixasDia = extractFaixas(campaigns, CAMPGANHOS_DIA_2026, commissionBands, true);
  const faixasMes = extractFaixas(campaigns, CAMPGANHOS_MEN_2026, commissionBands, true);
  const faixasSemSuper = extractFaixas(campaigns, CAMPGANHOS_SEM_2026_SUPER, commissionBands, true);
  const faixasMesSuper = extractSupervisorMonthlyCampaignBands(campaigns, commissionBands);

  const dias: CampGanhosDia[] = [];
  let estimativa_dia = 0;
  let ganhos_mes = 0;
  const semanasMap = new Map<string, { weekKey: string; ganhos: number; valor: number; dias: string[] }>();

  for (const day of dailyMetrics || []) {
    const dateKey = String(day.date || '').slice(0, 10);
    if (!dateKey) continue;
    const ganhos = Number(day.ganhos) || 0;
    const valor = calcFaixaValue(faixasDia, ganhos);
    dias.push({ date: dateKey, ganhos, valor });
    estimativa_dia += valor;
    ganhos_mes += ganhos;

    const wk = getWeekKey(dateKey);
    if (!semanasMap.has(wk)) semanasMap.set(wk, { weekKey: wk, ganhos: 0, valor: 0, dias: [] });
    const entry = semanasMap.get(wk)!;
    entry.ganhos += ganhos;
    entry.dias.push(dateKey);
  }

  const semanas: CampGanhosSemana[] = Array.from(semanasMap.values())
    .sort((a, b) => a.weekKey.localeCompare(b.weekKey))
    .map(w => ({
      weekKey: w.weekKey,
      ganhos: w.ganhos,
      dias: w.dias,
      valor: calcFaixaValue(faixasSemSuper, w.ganhos),
    }));

  const estimativa_semana = semanas.reduce((s, w) => s + w.valor, 0);
  const comissao_mes_assessor = calcFaixaValue(faixasMes, ganhos_mes);
  const comissao_mes_supervisor = calcFaixaValue(faixasMesSuper, ganhos_mes);

  return {
    ativo: true,
    estimativa_dia,
    estimativa_semana,
    comissao_mes_assessor,
    comissao_mes_supervisor,
    ganhos_mes,
    detalhes: { dias, semanas },
  };
}

// ============================================================
//  Próxima faixa da campanha ativa (barra de progresso)
// ============================================================
interface NextTierInfo {
  currentGains: number;
  currentValue: number;
  currentMin: number;
  nextMin: number;
  nextValue: number;
  gap: number;
  tierLabel: string;
  tipoCampanha: string;
}

function computeNextTierInfo(
  campaigns: Campaign[],
  dailyMetrics: Array<{ date: string; ganhos?: number }>,
  role: 'assessor' | 'supervisor' | 'coordenador',
  commissionBands: TabelaComissaoItem[],
): NextTierInfo | null {
  if (!isCampGanhos2026Active(campaigns)) return null;

  const isAssessor = role === 'assessor';
  const tipo = isAssessor ? CAMPGANHOS_DIA_2026 : CAMPGANHOS_SEM_2026_SUPER;
  const faixas = extractFaixas(campaigns, tipo, commissionBands, true);
  if (!faixas.length) return null;

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;

  const relevantDays = isAssessor
    ? dailyMetrics.filter(d => String(d.date).slice(0, 10) === todayStr)
    : dailyMetrics.filter(d => {
        const dt = String(d.date).slice(0, 10);
        return dt >= mondayStr && dt <= sundayStr;
      });

  const currentGains = relevantDays.reduce((s, d) => s + (Number(d.ganhos) || 0), 0);

  let currentValue = 0;
  let currentMin = 0;
  for (const f of faixas) {
    const max = f.faixa_max == null ? Infinity : f.faixa_max;
    if (currentGains >= f.faixa_min && currentGains <= max) {
      currentValue = f.valor_comissao;
      currentMin = f.faixa_min;
      break;
    }
  }

  let nextMin = 0;
  let nextValue = 0;
  for (const f of faixas) {
    if (f.faixa_min > currentGains) {
      nextMin = f.faixa_min;
      nextValue = f.valor_comissao;
      break;
    }
  }

  return {
    currentGains,
    currentValue,
    currentMin,
    nextMin,
    nextValue,
    gap: Math.max(0, nextMin - currentGains),
    tierLabel: isAssessor ? 'Hoje' : 'Semana',
    tipoCampanha: tipo,
  };
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
        {payload.map((entry: any, i: number) => {
          const details = entry.payload || {};
          return (
            <div key={i}>
              <p style={{ color: entry.color }} className="font-medium">
                {entry.name}: {typeof entry.value === 'number' ? (hideValues ? '***' : formatCurrency(entry.value)) : entry.value}
              </p>
              {details.gainsLabel && (
                <div className="mt-1 text-[#475569] space-y-0.5">
                  <p>{details.gainsLabel}: {formatInt(details.currentGains)} ganhos</p>
                  {details.hasBands ? (
                    <>
                      {details.nextTierMin != null ? (
                        <p>Faltam {formatInt(details.gap)} para a faixa mínima de {formatInt(details.nextTierMin)}.</p>
                      ) : <p>{details.currentTierMin != null ? 'Faixa máxima atingida.' : 'Nenhuma faixa atingida.'}</p>}
                      {details.currentTierMin != null && (
                        <p>Faixa atual ({formatInt(details.currentTierMin)}): {hideValues ? 'R$ ****' : formatCurrency(details.currentTierCommission)}</p>
                      )}
                      {details.nextTierMin != null && (
                        <p>Próxima faixa ({formatInt(details.nextTierMin)}): {hideValues ? 'R$ ****' : formatCurrency(details.nextTierCommission)}</p>
                      )}
                    </>
                  ) : <p>Nenhuma faixa configurada.</p>}
                  <p className="text-[#64748b]">{details.monthValueLabel}</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }
  return null;
};

// ============================================================
//  EXTRATO DIALOG
// ------------------------------------------------------------
// Layout adaptativo:
//   - ASSESSOR → cartões DIÁRIOS + "Estimativa do dia (CAMPGANHOS_DIA_2026)"
//   - SUPERVISOR/COORDENADOR → cartões SEMANAIS (Seg–Dom) +
//     "Estimativa da semana (CAMPGANHOS_SEM_2026_SUPER)"
// ============================================================
const ExtratoDialog = ({
  dailyMetrics,
  campaignDailyMetrics,
  campaigns,
  isSupervisor,
  campGanhos2026,
  loading,
  onClose,
}: any) => {
  const allDates = new Set<string>();
  dailyMetrics.forEach((d: any) => allDates.add(d.date.slice(0, 10)));
  campaignDailyMetrics.forEach((d: any) => allDates.add(d.date.slice(0, 10)));
  (campaigns || []).forEach((c: any) => {
    if (c.validacao_financeiro) {
      allDates.add(c.data_publicacao.split('T')[0]);
    }
  });

  const sortedDates = Array.from(allDates).sort();

  const totalGanhosPeriodo = (dailyMetrics || []).reduce(
    (sum: number, d: any) => sum + (Number(d.ganhos) || 0),
    0
  );
  const totalGanhosDemandaAtual = (campaignDailyMetrics || []).reduce(
    (sum: number, d: any) => sum + (Number(d.ganhos) || 0),
    0
  );
  const totalGanhosReprimida = Math.max(0, totalGanhosPeriodo - totalGanhosDemandaAtual);
  const pctDemandaAtual = totalGanhosPeriodo > 0
    ? (totalGanhosDemandaAtual / totalGanhosPeriodo) * 100
    : 0;

  const campGanhosDiaMap = new Map<string, number>(
    (campGanhos2026?.detalhes?.dias || []).map((d: CampGanhosDia) => [d.date, d.valor])
  );
  const campGanhosSemanaMap = new Map<string, number>(
    (campGanhos2026?.detalhes?.semanas || []).map((s: CampGanhosSemana) => [s.weekKey, s.valor])
  );
  const campGanhosAtivo = !!campGanhos2026?.ativo;

  const supervisorWeeks = useMemo(() => {
    const weekMap = new Map<string, {
      weekKey: string;
      days: Set<string>;
      assinados: number;
      ganhos: number;
      protocolados: number;
      ganhosDemandaAtual: number;
    }>();

    const ensure = (dateKey: string) => {
      const wk = getWeekKey(dateKey);
      if (!weekMap.has(wk)) {
        weekMap.set(wk, {
          weekKey: wk,
          days: new Set(),
          assinados: 0,
          ganhos: 0,
          protocolados: 0,
          ganhosDemandaAtual: 0,
        });
      }
      return weekMap.get(wk)!;
    };

    dailyMetrics.forEach((d: any) => {
      const dateKey = String(d.date || '').slice(0, 10);
      if (!dateKey) return;
      const w = ensure(dateKey);
      w.days.add(dateKey);
      w.assinados += Number(d.assinados) || 0;
      w.ganhos += Number(d.ganhos) || 0;
      w.protocolados += Number(d.protocolados) || 0;
    });

    campaignDailyMetrics.forEach((d: any) => {
      const dateKey = String(d.date || '').slice(0, 10);
      if (!dateKey) return;
      const w = ensure(dateKey);
      w.days.add(dateKey);
      w.ganhosDemandaAtual += Number(d.ganhos) || 0;
    });

    return Array.from(weekMap.values())
      .map(w => ({
        ...w,
        days: Array.from(w.days).sort(),
        estimativaSemana: campGanhosSemanaMap.get(w.weekKey) ?? 0,
      }))
      .sort((a, b) => a.weekKey.localeCompare(b.weekKey));
  }, [dailyMetrics, campaignDailyMetrics, campGanhosSemanaMap]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
        <div className="p-6 border-b border-[#e2e8f0] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-[#2F6FED]" />
            <h3 className="text-lg font-bold text-[#0f172a]">Extrato de Campanhas e Métricas</h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#eff6ff] text-[#2F6FED] font-medium">
              Mês completo
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#fff7ed] text-[#EA8C1D] font-medium">
              {isSupervisor ? 'Visão semanal' : 'Visão diária'}
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-[#94a3b8] hover:text-[#0f172a] hover:bg-[#f1f5f9]">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-[#2F6FED]" />
              <p className="text-xs text-[#64748b]">Carregando dados do mês...</p>
            </div>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-xl border border-[#e2e8f0] bg-[#f8fafc]">
                  <p className="text-[10px] text-[#64748b] uppercase font-semibold tracking-wide">
                    Ganhos totais no mês
                  </p>
                  <p className="text-2xl font-black text-[#0f172a] mt-1">{formatInt(totalGanhosPeriodo)}</p>
                  <p className="text-[10px] text-[#94a3b8] mt-0.5">Inclui demanda reprimida</p>
                </div>

                <div className="p-3 rounded-xl border border-[#EA8C1D] bg-[#fff7ed]">
                  <p className="text-[10px] text-[#EA8C1D] uppercase font-semibold tracking-wide">
                    Ganhos na demanda do mês
                  </p>
                  <p className="text-2xl font-black text-[#EA8C1D] mt-1">{formatInt(totalGanhosDemandaAtual)}</p>
                  <p className="text-[10px] text-[#94a3b8] mt-0.5">
                    {pctDemandaAtual.toFixed(0)}% do total · Considerado pela CAMPGANHOS_2026
                  </p>
                </div>

                <div className="p-3 rounded-xl border border-[#e2e8f0] bg-[#f8fafc]">
                  <p className="text-[10px] text-[#64748b] uppercase font-semibold tracking-wide">
                    Demanda reprimida
                  </p>
                  <p className="text-2xl font-black text-[#64748b] mt-1">{formatInt(totalGanhosReprimida)}</p>
                  <p className="text-[10px] text-[#94a3b8] mt-0.5">Não entra na campanha</p>
                </div>
              </div>

              {campGanhosAtivo && (
                <div className="mb-4 p-3 rounded-xl border border-[#EA8C1D] bg-[#fff7ed] text-xs">
                  <p className="font-bold text-[#EA8C1D] mb-1">Campanha CAMPGANHOS_2026 ativa</p>
                  {isSupervisor ? (
                    <p className="text-[#475569]">
                      Estimativa Semana: <b>{formatCurrency(campGanhos2026.estimativa_semana)}</b> · Comissão Mensal (soma no total):
                      {' '}<b>{formatCurrency(campGanhos2026.comissao_mes_supervisor)}</b>
                    </p>
                  ) : (
                    <p className="text-[#475569]">
                      Estimativa Dia: <b>{formatCurrency(campGanhos2026.estimativa_dia)}</b> · Comissão Mensal (soma no total):
                      {' '}<b>{formatCurrency(campGanhos2026.comissao_mes_assessor)}</b>
                    </p>
                  )}
                </div>
              )}

              {isSupervisor ? (
                <div className="space-y-4">
                  {supervisorWeeks.length > 0 ? (
                    supervisorWeeks.map((week) => {
                      const ganhosReprimidaSemana = Math.max(0, week.ganhos - week.ganhosDemandaAtual);
                      const pctDemandaSemana = week.ganhos > 0
                        ? (week.ganhosDemandaAtual / week.ganhos) * 100
                        : 0;
                      const daysWithCampaign = week.days.filter((d: string) => {
                        return (campaigns || []).some((c: any) =>
                          c.validacao_financeiro && c.data_publicacao.split('T')[0] === d
                        );
                      });
                      const temCampanhas = daysWithCampaign.length > 0;

                      return (
                        <div
                          key={week.weekKey}
                          className={`p-4 rounded-xl border ${temCampanhas || (campGanhosAtivo && week.estimativaSemana > 0) ? 'border-[#2F6FED] bg-[#eff6ff]' : 'border-[#e2e8f0]'}`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-[#0f172a]">
                                Semana {formatWeekRange(week.weekKey)}
                              </span>
                              <span className="text-[10px] text-[#94a3b8]">
                                ({week.days.length} dia{week.days.length > 1 ? 's' : ''} com movimentação)
                              </span>
                            </div>
                            {temCampanhas && <span className="badge success text-xs">Campanha ativa</span>}
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                            <div>
                              <p className="text-[#64748b]">Assinados</p>
                              <p className="font-bold">{formatInt(week.assinados)}</p>
                            </div>

                            <div>
                              <p className="text-[#64748b]">Ganhos totais</p>
                              <p className="font-bold">{formatInt(week.ganhos)}</p>
                              {ganhosReprimidaSemana > 0 && (
                                <p className="text-[10px] text-[#94a3b8] mt-0.5">
                                  Reprimida: {formatInt(ganhosReprimidaSemana)}
                                </p>
                              )}
                            </div>

                            <div>
                              <p className="text-[#EA8C1D] font-semibold">Na demanda do mês</p>
                              <p className="font-bold text-[#EA8C1D]">{formatInt(week.ganhosDemandaAtual)}</p>
                              {week.ganhos > 0 && (
                                <p className="text-[10px] text-[#94a3b8] mt-0.5">
                                  {pctDemandaSemana.toFixed(0)}% da semana
                                </p>
                              )}
                            </div>

                            <div>
                              <p className="text-[#64748b]">Protocolados</p>
                              <p className="font-bold">{formatInt(week.protocolados)}</p>
                            </div>
                          </div>

                          {campGanhosAtivo && (
                            <div className="mt-3 pt-3 border-t border-[#e2e8f0] flex justify-between items-center">
                              <span className="text-xs font-semibold">
                                Estimativa da semana (CAMPGANHOS_SEM_2026_SUPER)
                              </span>
                              <span className={`text-lg font-black ${week.estimativaSemana > 0 ? 'text-[#EA8C1D]' : 'text-[#94a3b8]'}`}>
                                {formatCurrency(week.estimativaSemana)}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-center text-[#94a3b8] py-8">Nenhum dado semanal ou campanha disponível.</div>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  {sortedDates.length > 0 ? (
                    sortedDates.map((dateKey, idx) => {
                      const fullDay = dailyMetrics.find((d: any) => d.date.slice(0, 10) === dateKey) || {
                        date: dateKey, assinados: 0, ganhos: 0, perdidos: 0, emitidos: 0, protocolados: 0,
                      };
                      const ganhosTotais = Number(fullDay.ganhos) || 0;

                      const campaignDay = campaignDailyMetrics.find((d: any) => d.date.slice(0, 10) === dateKey);
                      const ganhosDemandaAtual = Number(campaignDay?.ganhos) || 0;
                      const ganhosReprimidaDia = Math.max(0, ganhosTotais - ganhosDemandaAtual);
                      const pctDemandaDia = ganhosTotais > 0
                        ? (ganhosDemandaAtual / ganhosTotais) * 100
                        : 0;

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

                      const campGanhosDiaValor = campGanhosDiaMap.get(dateKey) ?? 0;

                      return (
                        <div
                          key={idx}
                          className={`p-4 rounded-xl border ${temCampanhas || (campGanhosAtivo && campGanhosDiaValor > 0) ? 'border-[#2F6FED] bg-[#eff6ff]' : 'border-[#e2e8f0]'}`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-semibold text-[#0f172a]">{dateKey}</span>
                            {temCampanhas && <span className="badge success text-xs">Campanha ativa</span>}
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                            <div>
                              <p className="text-[#64748b]">Assinados</p>
                              <p className="font-bold">{formatInt(fullDay.assinados || 0)}</p>
                            </div>

                            <div>
                              <p className="text-[#64748b]">Ganhos totais</p>
                              <p className="font-bold">{formatInt(ganhosTotais)}</p>
                              {ganhosReprimidaDia > 0 && (
                                <p className="text-[10px] text-[#94a3b8] mt-0.5">
                                  Reprimida: {formatInt(ganhosReprimidaDia)}
                                </p>
                              )}
                            </div>

                            <div>
                              <p className="text-[#EA8C1D] font-semibold">Na demanda do mês</p>
                              <p className="font-bold text-[#EA8C1D]">{formatInt(ganhosDemandaAtual)}</p>
                              {ganhosTotais > 0 && (
                                <p className="text-[10px] text-[#94a3b8] mt-0.5">
                                  {pctDemandaDia.toFixed(0)}% do dia
                                </p>
                              )}
                            </div>

                            <div>
                              <p className="text-[#64748b]">Protocolados</p>
                              <p className="font-bold">{formatInt(fullDay.protocolados || 0)}</p>
                            </div>
                          </div>

                          {campGanhosAtivo && (
                            <div className="mt-3 pt-3 border-t border-[#e2e8f0] flex justify-between items-center">
                              <span className="text-xs font-semibold">
                                Estimativa do dia (CAMPGANHOS_DIA_2026)
                              </span>
                              <span className={`text-lg font-black ${campGanhosDiaValor > 0 ? 'text-[#EA8C1D]' : 'text-[#94a3b8]'}`}>
                                {formatCurrency(campGanhosDiaValor)}
                              </span>
                            </div>
                          )}

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
                                </div>
                              ))}
                              {campanhasProgressivas.map((camp: any, cIdx: number) => (
                                <div key={`p-${cIdx}`} className="flex justify-between text-xs mb-1">
                                  <span className="flex items-center gap-1">
                                    <TrendingUp className="w-3 h-3 text-purple-500" />
                                    Progressiva (mín. {Number(camp.multiplicador) || 0} assinados)
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
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================
//  PÁGINA PRINCIPAL
// ============================================================
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
  const [teamDailyMetricsByCollaborator, setTeamDailyMetricsByCollaborator] = useState<Record<string, any[]>>({});
  const [campaignDailyMetrics, setCampaignDailyMetrics] = useState<any[]>([]);
  const [weeklyMetrics, setWeeklyMetrics] = useState<any[]>([]);
  const [callMetrics, setCallMetrics] = useState<CallMetrics[]>([]);
  const [commissionOverview, setCommissionOverview] = useState<CommissionOverviewItem[]>([]);
  const [commissionOverviewLoading, setCommissionOverviewLoading] = useState(false);
  const [commissionOverviewError, setCommissionOverviewError] = useState<string | null>(null);
  const [commissionOverviewSearch, setCommissionOverviewSearch] = useState('');
  const [updatingCommissionId, setUpdatingCommissionId] = useState<string | null>(null);
  const [expandedTeamMemberId, setExpandedTeamMemberId] = useState<string | null>(null);
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

  const [extratoDailyMetrics, setExtratoDailyMetrics] = useState<any[]>([]);
  const [extratoLoading, setExtratoLoading] = useState(false);
  const extratoRequest = useRef(0);

  const activeCampaigns = useMemo(() => getActiveCampaigns(campaigns), [campaigns]);

  const campGanhos2026Active = useMemo(() => isCampGanhos2026Active(campaigns), [campaigns]);

  const campGanhos2026 = useMemo<CampGanhosResult>(() => {
    if (!campGanhos2026Active) return { ...EMPTY_CAMPGANHOS_RESULT };
    return calcularCampGanhos2026(campaignDailyMetrics, campaigns, tabelaComissoes);
  }, [campGanhos2026Active, campaignDailyMetrics, campaigns, tabelaComissoes]);

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
      const isSupervisorSelection = normalizeText(requestedColaborador?.cargo || '').startsWith('supervisor');

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
      setTeamDailyMetricsByCollaborator({});
      setWeeklyMetrics([]);

      if (targetColab) {
        const isSupervisor = normalizeName(targetColab.cargo || '').startsWith('supervisor');
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
            const equipeMembros = colaboradoresAtualizados.filter(c =>
              normalizeText(c.equipeNome) === normalizeText(targetColab.equipeNome) &&
              c.id !== targetColab.id &&
              getCommissionOverviewRole(c) === 'assessor'
            );
            if (equipeMembros.length > 0) {
              const teamMonthRange = getMonthDateRange(currentStartDate);
              const memberDailyResults = await Promise.all(equipeMembros.map(async membro => {
                const metrics = await fetchDailyMetrics({
                  start: teamMonthRange.start,
                  end: teamMonthRange.end,
                  colaborador: membro.name,
                });
                return { member: membro, metrics };
              }));
              setTeamDailyMetricsByCollaborator(Object.fromEntries(
                memberDailyResults.map(({ member, metrics }) => [normalizeName(member.name), metrics])
              ));
              const allDaily = memberDailyResults.flatMap(result => result.metrics.filter(day =>
                day.date >= currentStartDate && day.date < currentEndDate
              ));
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
        const isSupervisorFocus = normalizeName(userColab.cargo || '').startsWith('supervisor');

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

  const isSupervisorUser = normalizeName(userColab?.cargo || '').startsWith('supervisor');
  const isSpecialUser = userColab ? isSpecialGroupColaborador(userColab) : false;

  const currentRole: 'assessor' | 'supervisor' | 'coordenador' = useMemo(() => {
    if (!userColab) return 'assessor';
    const cargo = normalizeName(userColab.cargo);
    if (cargo.startsWith('supervisor')) return 'supervisor';
    if (cargo === 'coordenador') return 'coordenador';
    return 'assessor';
  }, [userColab]);

  const loadExtratoData = useCallback(async () => {
    if (!userColab || !currentStartDate) return;
    const requestId = ++extratoRequest.current;
    const { start, end } = getMonthDateRange(currentStartDate);
    setExtratoLoading(true);
    try {
      if (currentRole === 'supervisor' || currentRole === 'coordenador') {
        const teamMembers = storeColabs.filter(colaborador => {
          if (normalizeName(colaborador.equipeNome) !== normalizeName(userColab.equipeNome)) return false;
          const cargo = normalizeName(colaborador.cargo);
          return !cargo.startsWith('supervisor') && cargo !== 'coordenador' && cargo !== 'administrativo';
        });
        const memberMetrics = await Promise.all(teamMembers.map(colaborador =>
          fetchDailyMetrics({
            start,
            end,
            colaborador: colaborador.name,
          }).catch(() => [] as any[])
        ));
        if (requestId !== extratoRequest.current) return;
        const byDate = new Map<string, any>();
        memberMetrics.flat().forEach(day => {
          const date = String(day.date || '').slice(0, 10);
          if (!date) return;
          const entry = byDate.get(date) || { date, assinados: 0, ganhos: 0, perdidos: 0, emitidos: 0, protocolados: 0 };
          entry.assinados += Number(day.assinados) || 0;
          entry.ganhos += Number(day.ganhos) || 0;
          entry.perdidos += Number(day.perdidos) || 0;
          entry.emitidos += Number(day.emitidos) || 0;
          entry.protocolados += Number(day.protocolados) || 0;
          byDate.set(date, entry);
        });
        setExtratoDailyMetrics(Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)));
      } else {
        const daily = await fetchDailyMetrics({
          start,
          end,
          colaborador: userColab.name,
        }).catch(() => [] as any[]);
        if (requestId !== extratoRequest.current) return;
        setExtratoDailyMetrics(daily);
      }
    } catch (err) {
      console.error('Erro ao carregar extrato:', err);
      if (requestId === extratoRequest.current) setExtratoDailyMetrics([]);
    } finally {
      if (requestId === extratoRequest.current) setExtratoLoading(false);
    }
  }, [userColab, currentRole, currentStartDate, storeColabs]);

  useEffect(() => {
    if (userColab && currentStartDate) {
      void loadExtratoData();
    }
  }, [loadExtratoData, userColab?.id, currentStartDate]);

  const handleOpenExtrato = useCallback(() => {
    if (!userColab) {
      toast.error('Selecione um colaborador para ver o extrato.');
      return;
    }
    setShowExtrato(true);
    void loadExtratoData();
  }, [userColab, loadExtratoData]);

  useEffect(() => {
    if (!userColab || !currentStartDate) {
      setCampaignDailyMetrics([]);
      return;
    }

    let cancelled = false;
    const loadCampaignMonth = async () => {
      const { start, end } = getMonthDateRange(currentStartDate);
      try {
        if (currentRole === 'supervisor' || currentRole === 'coordenador') {
          const teamMembers = storeColabs.filter(colaborador => {
            if (normalizeName(colaborador.equipeNome) !== normalizeName(userColab.equipeNome)) return false;
            const cargo = normalizeName(colaborador.cargo);
            return !cargo.startsWith('supervisor') && cargo !== 'coordenador' && cargo !== 'administrativo';
          });
          const memberMetrics = await Promise.all(teamMembers.map(colaborador =>
            fetchGanhos({
              start,
              end,
              colaborador: colaborador.name,
              granularity: 'daily',
              demanda: 'atual',
            })
          ));
          const byDate = new Map<string, any>();
          memberMetrics.flat().forEach(row => {
            const date = String(row.periodo || '').slice(0, 10);
            if (!date) return;
            const entry = byDate.get(date) || { date, ganhos: 0 };
            entry.ganhos += Number(row.total) || 0;
            byDate.set(date, entry);
          });
          if (!cancelled) {
            setCampaignDailyMetrics(Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date)));
          }
          return;
        }

        const metrics = await fetchGanhos({
          start,
          end,
          colaborador: userColab.name,
          granularity: 'daily',
          demanda: 'atual',
        });
        const dailyGains = metrics.map(row => ({
          date: String(row.periodo || '').slice(0, 10),
          ganhos: Number(row.total) || 0,
        })).filter(day => day.date);
        if (!cancelled) setCampaignDailyMetrics(dailyGains);
      } catch (err) {
        console.error('Erro ao carregar métricas mensais da campanha:', err);
        if (!cancelled) setCampaignDailyMetrics([]);
      }
    };

    void loadCampaignMonth();
    return () => { cancelled = true; };
  }, [currentStartDate, currentRole, storeColabs, userColab]);

  const nextTierInfo = useMemo<NextTierInfo | null>(() => {
    if (!campGanhos2026.ativo || isSpecialUser) return null;
    return computeNextTierInfo(campaigns, campaignDailyMetrics as any, currentRole, tabelaComissoes);
  }, [campGanhos2026.ativo, isSpecialUser, campaigns, campaignDailyMetrics, currentRole, tabelaComissoes]);

  const campaignProgressRows = useMemo(() => {
    if (!campGanhos2026.ativo || isSpecialUser) return [];

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dayOfWeek = now.getDay();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (dayOfWeek === 0 ? -6 : 1 - dayOfWeek));
    const mondayKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
    const isAssessor = currentRole === 'assessor';
    const periodType = isAssessor ? CAMPGANHOS_DIA_2026 : CAMPGANHOS_SEM_2026_SUPER;
    const monthType = isAssessor ? CAMPGANHOS_MEN_2026 : CAMPGANHOS_MEN_2026_SUPER;
    const periodDays = campaignDailyMetrics.filter(day => {
      const date = String(day.date || '').slice(0, 10);
      return isAssessor ? date === today : date >= mondayKey && date <= today;
    });
    const monthGains = campaignDailyMetrics.reduce((total, day) => total + (Number(day.ganhos) || 0), 0);
    const periodGains = periodDays.reduce((total, day) => total + (Number(day.ganhos) || 0), 0);
    const periodEstimate = isAssessor ? campGanhos2026.estimativa_dia : campGanhos2026.estimativa_semana;
    const monthCommission = isAssessor ? campGanhos2026.comissao_mes_assessor : campGanhos2026.comissao_mes_supervisor;
    const periodBands = extractFaixas(campaigns, periodType, tabelaComissoes, true);
    const monthBands = isAssessor
      ? extractFaixas(campaigns, monthType, tabelaComissoes, true)
      : extractSupervisorMonthlyCampaignBands(campaigns, tabelaComissoes);
    const dailyGoalMinimum = isAssessor ? periodBands[0]?.faixa_min : undefined;
    const daysWithGoalMet = dailyGoalMinimum == null ? null : campaignDailyMetrics.filter(day => {
      const date = String(day.date || '').slice(0, 10);
      return date <= today && (Number(day.ganhos) || 0) >= dailyGoalMinimum;
    }).length;

    return [
      {
        tipo: periodType,
        label: isAssessor ? 'Faixa de meta diária · Campanha Ativa' : 'Faixa de meta semanal · Campanha Ativa',
        gainsLabel: isAssessor ? 'Ganhos hoje' : 'Ganhos na semana',
        gains: periodGains,
        progress: getTierProgress(periodBands, periodGains),
        daysWithGoalMet,
        monthValue: periodEstimate,
        monthValueLabel: isAssessor ? 'Estimativa do valor pago durante o periodo' : 'Estimativa do valor pago durante o periodo',
        color: '#EA8C1D',
      },
      {
        tipo: monthType,
        label: 'Faixa mensal · Campanha Ativa',
        gainsLabel: 'Ganhos no mês',
        gains: monthGains,
        progress: getTierProgress(monthBands, monthGains),
        daysWithGoalMet: null,
        monthValue: monthCommission,
        monthValueLabel: 'Estimativa da comissão da faixa mensal da campanha de ganhos de 2026',
        color: '#2F6FED',
      },
    ];
  }, [campGanhos2026, currentRole, campaigns, campaignDailyMetrics, isSpecialUser, tabelaComissoes]);

  const normalCommissionProgress = useMemo(() => {
    if (!userColab) return null;
    const gains = campaignDailyMetrics.reduce((total, day) => total + (Number(day.ganhos) || 0), 0);
    const isSupervisor = currentRole === 'supervisor';
    const isSR = Boolean(userColab.isSupervisorSR) || calculator.isSupervisorSR(userColab.email);
    const productType = isSupervisor ? (isSR ? 'SUPERVISOR SR' : 'SUPERVISOR') : getFaixaProductType(userColab);
    const bands = tabelaComissoes
      .filter(band => normalizeName(band.tipo) === normalizeName(productType))
      .sort((left, right) => left.faixa_min - right.faixa_min)
      .map(band => ({
        faixa_min: band.faixa_min,
        faixa_max: band.faixa_max,
        valor_comissao: band.valor_comissao,
      }));
    const progress = getTierProgress(bands, gains);
    const goalsCommission = isSupervisor || isSpecialUser
      ? 0
      : calculator.calculateGoalCommission(
          calcularTotalGolsComCampanhas(campaignDailyMetrics as any, activeCampaigns),
          tabelaComissoes,
        );

    return {
      label: isSupervisor ? 'Comissão normal da equipe · mês' : 'Comissão normal · mês',
      tipo: productType,
      gainsLabel: 'Ganhos acumulados no mês',
      progress,
      monthValue: (progress.current?.valor_comissao || 0) + goalsCommission,
      monthValueLabel: 'Comissão normal prevista',
      color: '#16A34A',
    };
  }, [userColab, campaignDailyMetrics, currentRole, tabelaComissoes, isSpecialUser, activeCampaigns]);

  const isOverviewVisible =
    canViewCommissionOverview &&
    !loading &&
    filters.equipe === 'todas' &&
    filters.colaborador === 'todos';

  const commissionData = useMemo(() => {
    if (!userColab) return [];

    const isSpecial = isSpecialGroupColaborador(userColab);
    const isSupervisor = currentRole === 'supervisor';
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
    let comissaoCampGanhos2026 = 0;

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
        totalGols = calculateAssessorGols(userColab, dailyMetrics as any, activeCampaigns);
        comissaoGols = calculator.calculateGoalCommission(totalGols, tabelaComissoes);
        const ganhos = userColab.ganhos || 0;
        const productType = getFaixaProductType(userColab);
        comissaoAssinados = calculator.calculateProductCommission(ganhos, productType, tabelaComissoes);
        totalCommission = comissaoGols + comissaoAssinados;
      }
    }

    if (campGanhos2026.ativo) {
      comissaoCampGanhos2026 = currentRole === 'supervisor' || currentRole === 'coordenador'
        ? campGanhos2026.comissao_mes_supervisor
        : campGanhos2026.comissao_mes_assessor;
      totalCommission += comissaoCampGanhos2026;
    }

    return [{
      id: userColab.id,
      name: userColab.name,
      totalCommission,
      totalGols,
      comissaoAssinados,
      comissaoGols,
      comissaoCampGanhos2026,
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
  }, [filteredColabs, tabelaComissoes, currentUser, filters, storeColabs, dailyMetrics, userColab, campaigns, activeCampaigns, campGanhos2026, currentRole]);

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
      const campaignRange = getMonthDateRange(currentStartDate);
      const campaignParams = { ...campaignRange, granularity: 'daily' as const };
      const [assinadosRows, ganhosRows, campaignAssinadosRows, campaignGanhosRows] = await Promise.all([
        fetchAssinados(params),
        fetchGanhos(params),
        campGanhos2026Active ? fetchAssinados(campaignParams) : Promise.resolve([]),
        campGanhos2026Active
          ? fetchGanhos({ ...campaignParams, demanda: 'atual' })
          : Promise.resolve([]),
      ]);
      if (requestId !== commissionOverviewRequest.current) return;

      const dailyByCollaborator = mapDailyMetricsByCollaborator(assinadosRows, ganhosRows);
      const campaignDailyByCollaborator = mapDailyMetricsByCollaborator(campaignAssinadosRows, campaignGanhosRows);

      const collaboratorsWithMetrics = storeColabs.map(collaborator => {
        const daily = dailyByCollaborator.get(normalizeName(collaborator.name)) || [];
        return {
          ...collaborator,
          assinados: daily.reduce((total, day) => total + day.assinados, 0),
          ganhos: daily.reduce((total, day) => total + day.ganhos, 0),
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
          const isSupervisorSR = Boolean(collaborator.isSupervisorSR) || calculator.isSupervisorSR(collaborator.email);
          let assinados = individualSigned;
          let ganhos = individualGanhos;
          let commission: number | null;

          if (role === 'supervisor') {
            assinados = sumTeamAssinados(collaboratorsWithMetrics, collaborator.equipeNome);
            ganhos = sumTeamGanhos(collaboratorsWithMetrics, collaborator.equipeNome);
            commission = calculator.calculateSupervisorCommission(ganhos, isSupervisorSR, tabelaComissoes);

            if (campGanhos2026.ativo) {
              const teamDailyMap = new Map<string, number>();
              collaboratorsWithMetrics.forEach(m => {
                if (normalizeName(m.equipeNome) !== normalizeName(collaborator.equipeNome)) return;
                const cargo = normalizeText(m.cargo);
                if (cargo.startsWith('supervisor') || cargo === 'coordenador' || cargo === 'administrativo') return;
                const mDaily = campaignDailyByCollaborator.get(normalizeName(m.name)) || [];
                for (const d of mDaily) {
                  teamDailyMap.set(d.date, (teamDailyMap.get(d.date) || 0) + d.ganhos);
                }
              });
              const teamDailyArr = Array.from(teamDailyMap.entries()).map(([date, ganhosV]) => ({ date, ganhos: ganhosV }));
              const teamCamp = calcularCampGanhos2026(teamDailyArr, campaigns, tabelaComissoes);
              if (teamCamp.ativo) commission += teamCamp.comissao_mes_supervisor;
            }
          } else if (role === 'coordenador') {
            assinados = sumTeamAssinados(collaboratorsWithMetrics, collaborator.equipeNome);
            ganhos = sumTeamGanhos(collaboratorsWithMetrics, collaborator.equipeNome);
            commission = null;
          } else {
            commission = calculateAssessorCommission(collaborator, daily as any, tabelaComissoes, activeCampaigns);
            if (campGanhos2026Active) {
              const campaignDaily = campaignDailyByCollaborator.get(normalizeName(collaborator.name)) || [];
              const campRes = calcularCampGanhos2026(campaignDaily as any, campaigns, tabelaComissoes);
              if (campRes.ativo) commission += campRes.comissao_mes_assessor;
            }
          }

          return [{
            id: String(collaborator.id),
            name: collaborator.name,
            team: collaborator.equipeNome,
            role,
            assinados,
            ganhos,
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
  }, [canViewCommissionOverview, currentStartDate, currentEndDate, storeColabs, campaigns, activeCampaigns, tabelaComissoes, campGanhos2026Active]);

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
      let commission: number;
      const campaignRange = getMonthDateRange(currentStartDate);

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

        const memberDailyResults = await Promise.all(
          storeColabs
            .filter(c => getCommissionOverviewRole(c) === 'assessor')
            .filter(c => normalizeName(c.equipeNome) === normalizeName(item.team))
            .map(async (member) => {
              const rows = await fetchGanhos({
                start: campaignRange.start,
                end: campaignRange.end,
                colaborador: member.name,
                granularity: 'daily',
                demanda: 'atual',
              }).catch(() => []);
              const daily = rows.map(r => ({
                date: String(r.periodo || '').slice(0, 10),
                ganhos: Number(r.total) || 0,
              })).filter(d => d.date);
              return [member, daily] as const;
            })
        );

        commission = calculator.calculateSupervisorCommission(ganhos, item.isSupervisorSR, tabelaComissoes);

        if (campGanhos2026Active) {
          const teamDailyMap = new Map<string, number>();
          memberDailyResults.forEach(([, daily]) => {
            for (const d of daily) {
              teamDailyMap.set(d.date, (teamDailyMap.get(d.date) || 0) + (Number(d.ganhos) || 0));
            }
          });
          const teamDailyArr = Array.from(teamDailyMap.entries()).map(([date, ganhosV]) => ({ date, ganhos: ganhosV }));
          const teamCamp = calcularCampGanhos2026(teamDailyArr, campaigns, tabelaComissoes);
          if (teamCamp.ativo) commission += teamCamp.comissao_mes_supervisor;
        }
      } else {
        const daily = await fetchDailyMetrics({
          start: currentStartDate,
          end: currentEndDate,
          colaborador: item.name,
        });
        assinados = daily.reduce((total, day) => total + (Number(day.assinados) || 0), 0);
        ganhos = daily.reduce((total, day) => total + (Number(day.ganhos) || 0), 0);
        commission = calculateAssessorCommission(item.collaborator, daily as any, tabelaComissoes, activeCampaigns);

        if (campGanhos2026Active) {
          const campaignRows = await fetchGanhos({
            start: campaignRange.start,
            end: campaignRange.end,
            colaborador: item.name,
            granularity: 'daily',
            demanda: 'atual',
          });
          const campaignDaily = campaignRows.map(r => ({
            date: String(r.periodo || '').slice(0, 10),
            ganhos: Number(r.total) || 0,
          })).filter(d => d.date);
          const campRes = calcularCampGanhos2026(campaignDaily, campaigns, tabelaComissoes);
          if (campRes.ativo) commission += campRes.comissao_mes_assessor;
        }
      }

      setCommissionOverview(items => items.map(entry => entry.id === item.id
        ? { ...entry, assinados, ganhos, commission }
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
    if (!commissionData.length) return [];

    const data: Array<{
      name: string;
      value: number;
      color: string;
      gainsLabel?: string;
      currentGains?: number;
      hasBands?: boolean;
      gap?: number;
      nextTierMin?: number | null;
      nextTierCommission?: number;
      currentTierMin?: number | null;
      currentTierCommission?: number;
      monthValueLabel?: string;
    }> = [];

    if (normalCommissionProgress) {
      const progress = normalCommissionProgress.progress;
      data.push({
        name: normalCommissionProgress.label,
        value: normalCommissionProgress.monthValue,
        color: normalCommissionProgress.color,
        gainsLabel: normalCommissionProgress.gainsLabel,
        currentGains: progress.currentGains,
        hasBands: progress.hasBands,
        gap: progress.gap,
        nextTierMin: progress.next?.faixa_min ?? null,
        nextTierCommission: progress.next?.valor_comissao,
        currentTierMin: progress.current?.faixa_min ?? null,
        currentTierCommission: progress.current?.valor_comissao,
        monthValueLabel: normalCommissionProgress.monthValueLabel,
      });
    }

    campaignProgressRows.forEach(row => {
      const progress = row.progress;
      data.push({
        name: row.label,
        value: row.monthValue,
        color: row.color,
        gainsLabel: row.gainsLabel,
        currentGains: progress.currentGains,
        hasBands: progress.hasBands,
        gap: progress.gap,
        nextTierMin: progress.next?.faixa_min ?? null,
        nextTierCommission: progress.next?.valor_comissao,
        currentTierMin: progress.current?.faixa_min ?? null,
        currentTierCommission: progress.current?.valor_comissao,
        monthValueLabel: row.monthValueLabel,
      });
    });

    return data;
  }, [commissionData, normalCommissionProgress, campaignProgressRows]);

  const teamMembers = useMemo(() => {
    if (!isSupervisorUser || !userColab) return [];
    return storeColabs.filter(c => normalizeText(c.equipeNome) === normalizeText(userColab.equipeNome) && c.id !== userColab.id);
  }, [isSupervisorUser, userColab, storeColabs]);

  const teamAssessorMembers = useMemo(
    () => teamMembers.filter(member => getCommissionOverviewRole(member) === 'assessor'),
    [teamMembers],
  );

  const teamDailyMetricsForGoals = useMemo(() => {
    const byDate = new Map<string, any>();
    Object.values(teamDailyMetricsByCollaborator).flat().forEach(day => {
      const date = String(day.date || '').slice(0, 10);
      if (!date) return;
      const entry = byDate.get(date) || { date, assinados: 0, ganhos: 0, protocolados: 0 };
      entry.assinados += Number(day.assinados) || 0;
      entry.ganhos += Number(day.ganhos) || 0;
      entry.protocolados += Number(day.protocolados) || 0;
      byDate.set(date, entry);
    });
    return Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date));
  }, [teamDailyMetricsByCollaborator]);

  const teamGoalTargets = useMemo(() => teamAssessorMembers.reduce((totals, member) => ({
    diarioAssinados: totals.diarioAssinados + Number(member.pesoDiarioAssinados ?? member.metaDiarioAssinados ?? 3),
    diarioGanhos: totals.diarioGanhos + Number(member.pesoDiarioGanhos ?? member.metaDiarioGanhos ?? 3),
    semanalAssinados: totals.semanalAssinados + Number(member.pesoSemanalAssinados ?? member.metaSemanalAssinados ?? 15),
    semanalGanhos: totals.semanalGanhos + Number(member.pesoSemanalGanhos ?? member.metaSemanalGanhos ?? 15),
    mensalAssinados: totals.mensalAssinados + Number(member.pesoMensalAssinados ?? member.metaMensalAssinados ?? 60),
    mensalGanhos: totals.mensalGanhos + Number(member.pesoMensalGanhos ?? member.metaMensalGanhos ?? 60),
  }), {
    diarioAssinados: 0,
    diarioGanhos: 0,
    semanalAssinados: 0,
    semanalGanhos: 0,
    mensalAssinados: 0,
    mensalGanhos: 0,
  }), [teamAssessorMembers]);

  const totals = useMemo(() => {
    const comissao = commissionData.reduce((s, i) => s + i.totalCommission, 0);
    return { comissao };
  }, [commissionData]);

  const totalGols = useMemo(() => {
    if (!userColab) return 0;
    if (isSpecialUser) return 0;
    if (!dailyMetrics.length) return 0;
    return calcularTotalGolsComCampanhas(dailyMetrics as any, activeCampaigns);
  }, [userColab, isSpecialUser, dailyMetrics, activeCampaigns]);

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

  const dynamicMetricCard = useMemo(() => {
    if (campGanhos2026.ativo && !isSpecialUser) {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

      if (currentRole === 'assessor') {
        return {
          label: 'Estimativa Dia (Campanha)',
          value: campGanhos2026.detalhes.dias.find(day => day.date === todayKey)?.valor ?? 0,
          icon: TrendingUp,
          color: '#16A34A',
          isCurrency: true as const,
        };
      }
      return {
        label: 'Estimativa Semana (Campanha)',
        value: campGanhos2026.detalhes.semanas.find(week => week.weekKey === getWeekKey(todayKey))?.valor ?? 0,
        icon: TrendingUp,
        color: '#16A34A',
        isCurrency: true as const,
      };
    }
    return {
      label: 'Gols',
      value: totalGols,
      icon: Award,
      color: '#16A34A',
      isInteger: true as const,
    };
  }, [campGanhos2026, isSpecialUser, currentRole, totalGols]);

  const summaryCards = useMemo(() => {
    const cards: Array<{
      label: string;
      value: number;
      icon: React.ElementType;
      color: string;
      isCurrency?: boolean;
      isInteger?: boolean;
      isPercent?: boolean;
    }> = [
      { label: "Comissão Total Estimada (mês)", value: totals.comissao, icon: DollarSign, color: "#2F6FED", isCurrency: true },
      { label: dynamicMetricCard.label, value: dynamicMetricCard.value, icon: dynamicMetricCard.icon, color: dynamicMetricCard.color, isCurrency: (dynamicMetricCard as any).isCurrency, isInteger: (dynamicMetricCard as any).isInteger },
      { label: "Vendas Fechadas", value: rawMetrics.ganhos, icon: FileCheck, color: "#EA8C1D", isInteger: true },
      { label: "Atingimento da meta", value: avgProgress, icon: Target, color: "#8B5CF6", isPercent: true },
    ];
    return cards;
  }, [totals, dynamicMetricCard, rawMetrics.ganhos, avgProgress]);

  const userData = commissionData[0] || null;
  const recebidos = userData?.emitidos || 0;
  const assinados = userData?.assinados || 0;
  const protocolados = userData?.protocolados || 0;
  const ganhos = userData?.ganhos || 0;
  const perdidos = userData?.perdidos || 0;

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
    if (!campGanhos2026.ativo && totalGols > 0 && totalGols < 5) {
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
      const isSupervisorFocus = normalizeName(userColab?.cargo || '').startsWith('supervisor');

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

    return days.map(date => {
      const key = formatKey(date);
      const metricas = metricsMap.get(key) || {};
      return {
        label: formatLabel(date),
        assinados: (metricas as any).assinados || 0,
        ganhos: (metricas as any).ganhos || 0,
      };
    });
  }, [weeklyMetrics]);

  const outrasCampanhasAtivas = useMemo(
    () => activeCampaigns.filter((c: any) => (c.tipo || '').toUpperCase() !== CAMPGANHOS_2026_PARENT),
    [activeCampaigns]
  );

  const { firstDayLabel, lastDayLabel } = useMemo(() => {
    const ref = currentStartDate || new Date().toISOString().slice(0, 10);
    const [y, m] = ref.slice(0, 7).split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const last  = new Date(y, m, 0);
    const fmt = (d: Date) => {
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yy = d.getFullYear();
      return `${dd}/${mm}/${yy}`;
    };
    return { firstDayLabel: fmt(first), lastDayLabel: fmt(last) };
  }, [currentStartDate]);

  return (
    <DashboardLayout title="Painel de Comissões" subtitle="Suas comissões, calculadas com base nos ganhos e nas campanhas ativas">
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
          dailyMetrics={extratoDailyMetrics}
          campaignDailyMetrics={campaignDailyMetrics}
          campaigns={campaigns}
          isSupervisor={currentRole !== 'assessor'}
          campGanhos2026={campGanhos2026}
          loading={extratoLoading}
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
              {campGanhos2026.ativo && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#fff7ed] text-[#EA8C1D] font-medium">
                  CAMPGANHOS_2026 ativa
                </span>
              )}
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
                    <th className="py-2 px-3 font-medium text-right">Estimativa da Comissão</th>
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
                  const displayValue = card.isPercent
                    ? `${card.value.toFixed(1)}%`
                    : card.isCurrency
                      ? displayCurrency(card.value)
                      : formatInt(card.value);
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
                  <h3 className="text-sm font-bold mb-4">Progressão de comissão estimada do Colaborador</h3>
                  {commissionData.length === 0 ? (
                    <div className="text-center text-[#94a3b8] py-8">Nenhum dado disponível.</div>
                  ) : (
                    <div className="flex-1" style={{ minHeight: `${Math.max(220, commissionChartData.length * 56)}px` }}>
                      <ResponsiveContainer width="100%" height={Math.max(220, commissionChartData.length * 56)}>
                        <BarChart data={commissionChartData} layout="vertical" margin={{ top: 5, right: 90, left: 20, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                          <XAxis
                            type="number"
                            domain={[0, 9000]}
                            ticks={[0, 1800, 3600, 5400, 7200, 9000]}
                            tickFormatter={v => hideValues ? "***" : formatCurrency(v)}
                            tick={{ fontSize: 11, fill: "#64748b" }}
                          />
                          <YAxis dataKey="name" type="category" tick={{ fontSize: 11, fill: "#64748b" }} />
                          <Tooltip content={<CustomTooltip hideValues={hideValues} />} />
                          <Bar dataKey="value" name="Comissão" barSize={44} radius={[0, 4, 4, 0]}>
                            {commissionChartData.map(item => <Cell key={item.name} fill={item.color} />)}
                            <LabelList
                              dataKey="value"
                              position="right"
                              formatter={(value: number) => hideValues ? '***' : formatCurrency(value)}
                              style={{ fontSize: 10, fill: '#475569' }}
                            />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  <button
                    onClick={handleOpenExtrato}
                    className="mt-4 w-full py-2 px-4 inline-flex items-center justify-center gap-2 text-xs font-semibold rounded-lg border border-[#2F6FED] text-[#2F6FED] hover:bg-[#eff6ff] transition-colors"
                  >
                    <CalendarDays className="w-4 h-4" />
                    {isSupervisorUser
                      ? 'Ver Extrato de Campanhas e Métricas (mês completo, visão semanal)'
                      : 'Ver Extrato de Campanhas e Métricas (mês completo, visão diária)'}
                  </button>
                </div>

                {((!isSpecialUser && currentRole !== 'coordenador') || campaignProgressRows.length > 0) && (
                  <div className="card p-5 order-1">
                    <h3 className="text-sm font-bold mb-4">Metas vs Realizado</h3>
                    <div className="space-y-5 max-h-[420px] overflow-y-auto pr-2 custom-scrollbar">
                      {commissionData.map((item) => {
                        const goalCollaborators: any[] = isSupervisorUser
                          ? [{
                              id: `team-${userColab?.id || 'goals'}`,
                              name: `Equipe ${userColab?.equipeNome || ''}`.trim(),
                              avatar: userColab?.avatar,
                              pesoDiarioAssinados: teamGoalTargets.diarioAssinados,
                              pesoDiarioGanhos: teamGoalTargets.diarioGanhos,
                              pesoSemanalAssinados: teamGoalTargets.semanalAssinados,
                              pesoSemanalGanhos: teamGoalTargets.semanalGanhos,
                              pesoMensalAssinados: teamGoalTargets.mensalAssinados,
                              pesoMensalGanhos: teamGoalTargets.mensalGanhos,
                            }]
                          : [item.originalColab];

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

                        return (
                          <div key={item.id || item.name}>
                            {goalCollaborators.map((colabOriginal) => {
                              const memberDailyMetrics = isSupervisorUser
                                ? teamDailyMetricsForGoals
                                : extratoDailyMetrics;

                              const metaDiarioAss = Number(colabOriginal?.pesoDiarioAssinados ?? colabOriginal?.metaDiarioAssinados ?? 3);
                              const metaDiarioProt = Number(colabOriginal?.pesoDiarioGanhos ?? colabOriginal?.metaDiarioGanhos ?? 3);
                              const metaSemanalAss = Number(colabOriginal?.pesoSemanalAssinados ?? colabOriginal?.metaSemanalAssinados ?? 15);
                              const metaSemanalProt = Number(colabOriginal?.pesoSemanalGanhos ?? colabOriginal?.metaSemanalGanhos ?? 15);
                              const metaMensalAss = Number(colabOriginal?.pesoMensalAssinados ?? colabOriginal?.metaMensalAssinados ?? 60);
                              const metaMensalProt = Number(colabOriginal?.pesoMensalGanhos ?? colabOriginal?.metaMensalGanhos ?? 60);

                              const dailyDataDiario = memberDailyMetrics.filter(d => d.date && d.date.slice(0, 10) === todayStr);
                              const dailyDataSemanal = memberDailyMetrics.filter(d => d.date && d.date.slice(0, 10) >= mondayStr && d.date.slice(0, 10) <= sundayStr);
                              const dailyDataMensal = memberDailyMetrics.filter(d => d.date && d.date.slice(0, 10) >= monthStartStr && d.date.slice(0, 10) <= monthEndStr);

                              const assinadosDiario = dailyDataDiario.reduce((sum, d) => sum + (Number(d.assinados) || 0), 0);
                              const assinadosSemanal = dailyDataSemanal.reduce((sum, d) => sum + (Number(d.assinados) || 0), 0);
                              const assinadosMensal = dailyDataMensal.reduce((sum, d) => sum + (Number(d.assinados) || 0), 0);

                              const protocoladosDiario = dailyDataDiario.reduce((sum, d) => sum + (Number(d.protocolados) || 0), 0);
                              const protocoladosSemanal = dailyDataSemanal.reduce((sum, d) => sum + (Number(d.protocolados) || 0), 0);
                              const protocoladosMensal = dailyDataMensal.reduce((sum, d) => sum + (Number(d.protocolados) || 0), 0);

                              const periodos = [
                                { label: "Diário (hoje)", metaAss: metaDiarioAss, metaProt: metaDiarioProt, atualAss: assinadosDiario, atualProt: protocoladosDiario, colorAss: "#2F6FED", colorProt: "#16A34A" },
                                { label: "Semanal (semana atual)", metaAss: metaSemanalAss, metaProt: metaSemanalProt, atualAss: assinadosSemanal, atualProt: protocoladosSemanal, colorAss: "#EA8C1D", colorProt: "#16A34A" },
                                { label: "Mensal (mês atual)", metaAss: metaMensalAss, metaProt: metaMensalProt, atualAss: assinadosMensal, atualProt: protocoladosMensal, colorAss: "#8B5CF6", colorProt: "#16A34A" },
                              ];

                              const showPeriodos = !isSpecialGroupColaborador(colabOriginal) && currentRole !== 'coordenador';

                              return (
                                <div key={colabOriginal.id || colabOriginal.name} className="mb-4 last:mb-0">
                                  <div className="flex items-center gap-3 mb-3">
                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-100 to-blue-200 flex items-center justify-center text-xs font-bold">
                                      {colabOriginal.avatar}
                                    </div>
                                    <div>
                                      <span className="font-medium text-[#0f172a] text-sm">{colabOriginal.name}</span>
                                    </div>
                                  </div>

                                  {showPeriodos && periodos.map((p) => {
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
                                          <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">
                                            {formatInt(p.atualAss)}/{formatInt(p.metaAss)}
                                          </span>
                                          <span className="text-[10px] font-medium" style={{ color: p.colorAss }}>
                                            {pctAss.toFixed(0)}%
                                          </span>
                                        </div>
                                        <div className="text-[9px] text-[#94a3b8] ml-14 mb-1">
                                          {faltaAss > 0 ? `Faltam ${formatInt(faltaAss)}` : "Atingido"}
                                        </div>

                                        <div className="flex items-center gap-2 mb-1">
                                          <span className="text-[10px] text-[#64748b] w-12">Ganhos</span>
                                          <div className="flex-1 progress-bar h-2">
                                            <div className="progress-fill" style={{ width: `${pctProt}%`, background: p.colorProt }} />
                                          </div>
                                          <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">
                                            {formatInt(p.atualProt)}/{formatInt(p.metaProt)}
                                          </span>
                                          <span className="text-[10px] font-medium" style={{ color: p.colorProt }}>
                                            {pctProt.toFixed(0)}%
                                          </span>
                                        </div>
                                        <div className="text-[9px] text-[#94a3b8] ml-14 mb-1">
                                          {faltaProt > 0 ? `Faltam ${formatInt(faltaProt)}` : "Atingido"}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })}

                            {campaignProgressRows.map((row) => {
                              const targetMin = row.progress.next?.faixa_min ?? row.progress.current?.faixa_min ?? 0;
                              const faixaValue = row.progress.current?.valor_comissao ?? row.progress.next?.valor_comissao ?? 0;

                              return (
                                <div key={row.tipo} className="mb-3 last:mb-0">
                                  <p className="text-xs font-semibold text-[#475569] mb-1">{row.label}</p>

                                  {row.progress.hasBands ? (
                                    <div>
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[10px] text-[#64748b] w-12">Ganhos</span>
                                        <div className="flex-1 progress-bar h-2">
                                          <div className="progress-fill" style={{ width: `${row.progress.progress}%`, background: row.color }} />
                                        </div>
                                        <span className="text-[10px] font-medium text-[#0f172a] w-16 text-right">
                                          {formatInt(row.progress.currentGains)}/{formatInt(targetMin)}
                                        </span>
                                        <span className="text-[10px] font-medium" style={{ color: row.color }}>
                                          {row.progress.progress.toFixed(0)}%
                                        </span>
                                      </div>

                                      {row.daysWithGoalMet != null && (
                                        <div className="text-[9px] text-[#94a3b8] ml-14 mb-1">
                                          Dias com meta batida: {formatInt(row.daysWithGoalMet)}
                                        </div>
                                      )}

                                      <div className="text-[9px] text-[#94a3b8] ml-14">
                                        {row.progress.current ? 'Faixa atual' : 'Próxima faixa'}: {displayCurrency(faixaValue)}
                                        {' · '}{row.monthValueLabel}: {displayCurrency(row.monthValue)}
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="text-[9px] text-[#94a3b8] ml-14">
                                      Nenhuma faixa configurada para esta campanha.
                                    </div>
                                  )}
                                </div>
                              );
                            })}
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
                      {teamAssessorMembers.length > 0 ? (
                        teamAssessorMembers.map(member => {
                          const isExpanded = expandedTeamMemberId === String(member.id);
                          const metrics = teamDailyMetricsByCollaborator[normalizeName(member.name)] || [];
                          const now = new Date();
                          const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
                          const dayOfWeek = now.getDay();
                          const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (dayOfWeek === 0 ? -6 : 1 - dayOfWeek));
                          const mondayKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
                          const monthStartKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
                          const periods = [
                            { label: 'Diário', start: todayKey, end: todayKey, signedTarget: member.pesoDiarioAssinados ?? member.metaDiarioAssinados ?? 3, gainsTarget: member.pesoDiarioGanhos ?? member.metaDiarioGanhos ?? 3 },
                            { label: 'Semanal', start: mondayKey, end: todayKey, signedTarget: member.pesoSemanalAssinados ?? member.metaSemanalAssinados ?? 15, gainsTarget: member.pesoSemanalGanhos ?? member.metaSemanalGanhos ?? 15 },
                            { label: 'Mensal', start: monthStartKey, end: todayKey, signedTarget: member.pesoMensalAssinados ?? member.metaMensalAssinados ?? 60, gainsTarget: member.pesoMensalGanhos ?? member.metaMensalGanhos ?? 60 },
                          ].map(period => {
                            const periodMetrics = metrics.filter(day => {
                              const date = String(day.date || '').slice(0, 10);
                              return date >= period.start && date <= period.end;
                            });
                            return {
                              ...period,
                              assinados: periodMetrics.reduce((total, day) => total + (Number(day.assinados) || 0), 0),
                              ganhos: periodMetrics.reduce((total, day) => total + (Number(day.ganhos) || 0), 0),
                            };
                          });

                          return (
                            <div key={member.id} className="rounded-lg bg-[#f8fafc]">
                              <button
                                type="button"
                                aria-expanded={isExpanded}
                                onClick={() => setExpandedTeamMemberId(isExpanded ? null : String(member.id))}
                                className="w-full flex items-center justify-between gap-3 text-xs p-2 text-left"
                              >
                                <span className="flex items-center gap-2 min-w-0">
                                  <span className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center font-bold text-[10px] shrink-0">
                                    {member.avatar || member.name.charAt(0).toUpperCase()}
                                  </span>
                                  <span className="font-medium text-[#0f172a] truncate">{member.name}</span>
                                  <ChevronDown className={`w-3 h-3 text-[#64748b] transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                </span>
                                <span className="flex items-center gap-4 shrink-0">
                                  <span>Ass: <b>{formatInt(member.assinados)}</b></span>
                                  <span>Ganhos: <b>{formatInt(member.ganhos)}</b></span>
                                </span>
                              </button>
                              {isExpanded && (
                                <div className="px-3 pb-3 space-y-2">
                                  {periods.map(period => (
                                    <div key={period.label} className="grid grid-cols-[56px_1fr_1fr] gap-2 text-[10px] text-[#475569]">
                                      <span className="font-semibold">{period.label}</span>
                                      <span>Ass.: {formatInt(period.assinados)}/{formatInt(Number(period.signedTarget) || 0)}</span>
                                      <span>Ganhos: {formatInt(period.ganhos)}/{formatInt(Number(period.gainsTarget) || 0)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })
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

              {!isSupervisorUser && !isSpecialUser && currentRole !== 'coordenador' && (
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
                <div className="flex items-center gap-2 mb-4">
                  <Megaphone className="w-4 h-4 text-[#EA8C1D]" />
                  <h3 className="text-sm font-bold text-[#0f172a]">Campanhas ativas no momento</h3>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#fff7ed] text-[#EA8C1D] font-medium">
                    {activeCampaigns.length} campanha(s)
                  </span>
                </div>

                {activeCampaigns.length === 0 ? (
                  <p className="text-xs text-[#94a3b8] bg-[#f8fafc] border border-[#e2e8f0] rounded-lg p-3">
                    Nenhuma campanha ativa no período.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {campGanhos2026.ativo && (
                      <div className="p-3 rounded-lg border border-[#EA8C1D] bg-[#fff7ed]">
                        <div className="flex items-center justify-between mb-1">
                          <p className="font-bold text-[#EA8C1D] text-xs">CAMPGANHOS_2026</p>
                        </div>
                        <div className="text-xs text-[#475569] space-y-0.5 mt-2">
                          {isSupervisorUser || currentRole === 'coordenador' ? (
                            <>
                              <p><b>Estimativa Semana (CAMPGANHOS_SEM_2026_SUPER):</b> Valor pago na semana, nessa campanha cards ganhos que são de demanda reprimida não são incluidos, valide os ganhos realizados fora de demanda reprimida.</p>
                              <p><b>Comissão Mensal (CAMPGANHOS_MEN_2026_SUPER):</b> Valor pago no mês, nessa campanha cards ganhos que são de demanda reprimida não são incluidos, valide os ganhos realizados fora de demanda reprimida e a frequÊncia de atingimento da meta.</p>
                            </>
                          ) : (
                            <>
                              <p><b>Estimativa Dia (CAMPGANHOS_DIA_2026):</b> Valor pago no dia, nessa campanha cards ganhos que são de demanda reprimida não são incluidos, valide com o supervisor os ganhos realizados fora de demanda reprimida e a frequência de atingimento da meta.</p>
                              <p><b>Comissão Mensal (CAMPGANHOS_MEN_2026):</b> Valor pago no mês, nessa campanha cards ganhos que são de demanda reprimida não são incluidos, valide com o supervisor os ganhos realizados fora de demanda reprimida e a frequência de atingimento da meta.</p>
                            </>
                          )}
                          <p className="text-[10px] text-[#94a3b8] mt-1">
                            Total de ganhos no mês: {formatInt(campGanhos2026.ganhos_mes)}
                          </p>
                        </div>
                        <p className="text-xs text-[#475569] space-y-0.5 mt-2">
                          <b>Demanda Reprimida:</b> Qualquer assinado fora do período de {firstDayLabel} até {lastDayLabel}, será considerado como demanda reprimida, e não é contabilizado para a campanha de ganhos.
                        </p>
                      </div>
                    )}

                    {outrasCampanhasAtivas.map((c: any, i: number) => {
                      const tipo = (c.tipo || '').toUpperCase();
                      const produto = c.produto && c.produto !== 'Todos' ? ` · ${c.produto}` : '';
                      return (
                        <div key={`${tipo}-${i}`} className="p-3 rounded-lg border border-[#e2e8f0] bg-[#f8fafc]">
                          <div className="flex items-center justify-between mb-1">
                            <p className="font-bold text-[#0f172a] text-xs">
                              {tipo}
                              <span className="text-[10px] text-[#64748b] font-normal">{produto}</span>
                            </p>
                            <span className="text-[10px] text-[#64748b]">
                              {c.data_publicacao ? new Date(c.data_publicacao).toLocaleDateString('pt-BR') : ''}
                            </span>
                          </div>
                          <p className="text-xs text-[#475569]">
                            {tipo === 'GOLS' && `Multiplica gols por ×${c.multiplicador}`}
                            {tipo === 'ASSINADOS' && `+1 gol a cada ${c.multiplicador || 3} assinados`}
                            {tipo === 'PROGRESSIVA' && `Progressiva: mínimo ${c.multiplicador} assinados`}
                            {!['GOLS', 'ASSINADOS', 'PROGRESSIVA'].includes(tipo) && c.descricao}
                          </p>
                          {c.descricao && ['GOLS', 'ASSINADOS', 'PROGRESSIVA'].includes(tipo) && (
                            <p className="text-[10px] text-[#64748b] mt-1">{c.descricao}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="card p-5 mb-6">
                <h3 className="text-sm font-bold mb-3">Como a estimativa da comissão é calculada</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs text-[#64748b]">
                  <div className="bg-[#f8fafc] rounded-lg p-3">
                    <span className="font-bold text-[#0f172a]">1. Estimativa:</span> Valores apresentados não representam a comissão real que será paga, pois podem haver ajustes de valores e regras especificas
                    dentro das faixas de comissões e campanhas ativas, que precisam ser verificadas adequadamente antes do pagamento da comissão.
                  </div>
                  <div className="bg-[#f8fafc] rounded-lg p-3">
                    <span className="font-bold text-[#0f172a]">2. Estimativa Comissão do colaborador:</span> a comissão é calculada pela faixa de ganhos do produto do colaborador (AUXILIO ACIDENTE, QUINQUENIO, CONCOMITANTE).
                  </div>
                  <div className="bg-[#f8fafc] rounded-lg p-3">
                    <span className="font-bold text-[#0f172a]">3. Estimativa Comissão total:</span> soma da faixa adequada ao colaborador e das campanhas ativas no periodo.
                  </div>
                  <div className="bg-[#f8fafc] rounded-lg p-3">
                    <span className="font-bold text-[#0f172a]">4. Estimativa Campanha ativa:</span> Cada tipo de campanha ativa segue regras e métodos especificos, valide com o seu supervisor caso tenha qualquer duvida.
                  </div>
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