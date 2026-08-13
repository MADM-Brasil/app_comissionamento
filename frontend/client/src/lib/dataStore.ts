// src/lib/dataStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { formatCurrency as formatCurrencyUtil, formatPercent as formatPercentUtil } from './utils';
import {
  fetchEmitidos,
  fetchAssinados, 
  fetchProtocolados,
  fetchGanhos, 
  fetchPerdidos,
  fetchLeadsRecebidos,
  fetchWeeklyPerformance,
  fetchCollaborators,
  fetchEquipes, 
  API_BASE,
} from './api';
import { calculator } from './calculator';

// ============================================================
// TIPOS ATUALIZADOS – id agora é string (e-mail) 
// ============================================================
export interface KpiItem { value: number; target: number; unit: string; label: string; }
export interface KpiData { comissaoMes: KpiItem; vendasFechadas: KpiItem; protocolados: KpiItem; taxaConversao: KpiItem; }
export interface EquipeConfig { id: string; nome: string; pesoAssinados: number; pesoGanhos: number; pesoequipeAssinados: number; pesoequipeGanhos: number; bonus: number; }
export interface Collaborator {
  id: string;
  name: string;
  email: string;
  equipeId: string;
  equipeNome: string;
  avatar: string;
  emitidos: number;
  assinados: number;
  protocolados: number;
  ganhos: number;
  perdidos: number;
  metaAssinados: number;
  metaGanhos: number;
  bonusPorCiclo: number;
  bonusRecebido: number;
  status: "ativo" | "inativo";
  produto: string;
  cargo: string;
  grupo?: string;
  metaDiarioAssinados?: number;
  metaDiarioGanhos?: number;
  metaSemanalAssinados?: number;
  metaSemanalGanhos?: number;
  metaMensalAssinados?: number;
  metaMensalGanhos?: number;
  metaGolsAssinados?: number;
  metaGolsGanhos?: number;
  isSupervisorSR?: boolean;
  comissao?: number;
  bonusComissao?: number;
  pesoDiarioAssinados: number;
  pesoDiarioGanhos: number;
  pesoSemanalAssinados: number;
  pesoSemanalGanhos: number;
  pesoMensalAssinados: number;
  pesoMensalGanhos: number;
  totalGols?: number;
  classificacaoOperacional: string; 
  canal: string;                    
}
export interface GlobalConfig {
  pesoMetaAssinados: number; pesoMetaGanhos: number; pesoMetaequipeAssinados: number; pesoMetaequipeGanhos: number;
  valorBonus: number; metaDiaria: number; metaSemanal: number; metaMensal: number;
  metaLeadsDiaria: number; metaLeadsSemanal: number; metaLeadsMensal: number;
  pesoDiarioAssinados: number; pesoDiarioGanhos: number; pesoSemanalAssinados: number; pesoSemanalGanhos: number;
  pesoMensalAssinados: number; pesoMensalGanhos: number;
}
export interface DailyData {
  id: string;
  colaboradorId: string;
  date: string;
  emitidos: number;
  assinados: number;
  ganhos: number;
  perdidos: number;
}
export interface Meta3x3 { assinados: number; ganhos: number; metaBatida: number; valorPorMeta: number; totalGanho: number; pesoMetaAssinados: number; pesoMetaGanhos: number; pesoMetaequipeAssinados: number; pesoMetaequipeGanhos: number; produto: string; metaDiaria: number; metaSemanal: number; metaMensal: number; }
export interface BonusData { active: boolean; label: string; description: string; threshold: number; current: number; bonusValue: number; }
export interface WeeklyPerformance { day: string; vendas: number; meta: number; }
export interface DailyProduction { date: string; vendas: number; leads: number; }
export interface User {
  id: string;
  e_mail: string;
  nome: string;
  email: string;
  equipe: string;
  cargo: string;
  status: string;
  periodo?: string;
  avatar?: string;
  role?: string;
  rank?: number;
  totalRanking?: number;
}
export interface RankingItem { position: number; name: string; emitidos: number; assinados: number; ganhos: number; avatar: string; trend: 'up' | 'down' | 'same'; isCurrentUser?: boolean; }
export interface CommissionItem { id: number; colaboradorId: string; cliente: string; produto: string; valor: number; status: 'pago' | 'pendente' | 'processando'; data: string; comissao: number; }
export interface CommissionSummary { totalAcumulado: number; pendente: number; pago: number; processando: number; mediaVenda: number; }
export interface FunnelStage { stage: string; count: number; color: string; icon: string; description: string; }
export interface ConversionRate { stage: string; value: number; }
export interface RadarMetric { metric: string; value: number; }
export interface ProductivityData { semana: string; taxa: number; vendas: number; }
export interface StatsCard { label: string; value: string; unit: string; trend: string; up: boolean; color: string; bg: string; icon: string; }
export interface Notification { id: number; type: 'warning' | 'danger' | 'success' | 'info' | 'orientacao'; title: string; message: string; action: string; time: string; read: boolean; images?: string[]; }
export interface InsightCard { icon: string; title: string; description: string; action: string; color: string; bg: string; urgency: string; urgencyColor: string; }
export type Period = 'Hoje' | 'Semana' | 'Mês' | 'Custom';
export interface RawMetrics { emitidos: number; assinados: number; protocolados: number; ganhos: number; perdidos: number; }
export interface TabelaComissaoItem {
  tipo: string;
  valor_comissao: number;
  faixa_min: number;
  faixa_max: number;
  data_atualizacao: string;
}
// NOVO: Interface para campanhas
export interface Campaign {
  tipo: string;
  multiplicador: number;
  produto: string;
  data_publicacao: string;
  descricao: string;
  validacao_financeiro: boolean;
}

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================
function normalizeGroup(cargo: string | undefined): string {
  return (cargo || '').trim().toLowerCase();
}

function applyHierarchyTotals(collaborators: Collaborator[]): Collaborator[] {
  if (!collaborators.length) return collaborators;
  const updated = collaborators.map(c => ({ ...c }));
  const supervisors = updated.filter(c => normalizeGroup(c.cargo) === 'supervisor');
  const coordAdmins = updated.filter(c =>
    ['coordenador', 'administrativo'].includes(normalizeGroup(c.cargo))
  );
  const sumMetrics = (list: Collaborator[]) => ({
    emitidos: list.reduce((s, c) => s + (c.emitidos || 0), 0),
    assinados: list.reduce((s, c) => s + (c.assinados || 0), 0),
    protocolados: list.reduce((s, c) => s + (c.protocolados || 0), 0),
    ganhos: list.reduce((s, c) => s + (c.ganhos || 0), 0),
    perdidos: list.reduce((s, c) => s + (c.perdidos || 0), 0),
  });
  for (const sup of supervisors) {
    const team = updated.filter(
      c => c.equipeNome === sup.equipeNome && c.id !== sup.id && normalizeGroup(c.cargo) !== 'supervisor'
    );
    const sums = sumMetrics(team);
    sup.emitidos = sums.emitidos;
    sup.assinados = sums.assinados;
    sup.protocolados = sums.protocolados;
    sup.ganhos = sums.ganhos;
    sup.perdidos = sums.perdidos;
  }
  if (supervisors.length > 0) {
    const supersSums = sumMetrics(supervisors);
    for (const coord of coordAdmins) {
      coord.emitidos = supersSums.emitidos;
      coord.assinados = supersSums.assinados;
      coord.protocolados = supersSums.protocolados;
      coord.ganhos = supersSums.ganhos;
      coord.perdidos = supersSums.perdidos;
    }
  }
  return updated;
}

function getDateRangeFromPeriod(period: Period, customStart?: string, customEnd?: string): { start: string; end: string } {
  if (period === 'Custom' && customStart && customEnd) {
    const endDate = new Date(customEnd); endDate.setDate(endDate.getDate() + 1);
    return { start: customStart, end: endDate.toISOString().slice(0, 10) };
  }
  const now = new Date(); let start: Date, end: Date;
  if (period === 'Hoje') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else if (period === 'Semana') {
    const day = now.getDay(); const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
    start = monday; end = new Date(monday); end.setDate(monday.getDate() + 7);
  } else {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

// ============================================================
// ESTADOS INICIAIS
// ============================================================
const initialKpiData: KpiData = {
  comissaoMes: { value: 0, target: 0, unit: 'R$', label: 'Comissão do Mês' },
  vendasFechadas: { value: 0, target: 0, unit: '', label: 'Vendas Fechadas' },
  protocolados: { value: 0, target: 0, unit: '', label: 'Protocolados' },
  taxaConversao: { value: 0, target: 0, unit: '%', label: 'Taxa de Conversão' },
};
const initialBonusData: BonusData = { active: false, label: '', description: '', threshold: 0, current: 0, bonusValue: 0 };
const initialWeeklyPerformance: WeeklyPerformance[] = [
  { day: 'Seg', vendas: 0, meta: 0 }, { day: 'Ter', vendas: 0, meta: 0 }, { day: 'Qua', vendas: 0, meta: 0 },
  { day: 'Qui', vendas: 0, meta: 0 }, { day: 'Sex', vendas: 0, meta: 0 }, { day: 'Sáb', vendas: 0, meta: 0 }, { day: 'Dom', vendas: 0, meta: 0 },
];
const initialEquipeConfigs: EquipeConfig[] = [];
const initialCollaborators: Collaborator[] = [];
const initialGlobalConfig: GlobalConfig = {
  pesoMetaAssinados: 60, pesoMetaGanhos: 60, pesoMetaequipeAssinados: 0, pesoMetaequipeGanhos: 0,
  valorBonus: 100, metaDiaria: 3, metaSemanal: 15, metaMensal: 60,
  metaLeadsDiaria: 20, metaLeadsSemanal: 100, metaLeadsMensal: 400,
  pesoDiarioAssinados: 3, pesoDiarioGanhos: 3, pesoSemanalAssinados: 15, pesoSemanalGanhos: 15,
  pesoMensalAssinados: 60, pesoMensalGanhos: 60,
};
const initialDailyData: DailyData[] = [];
const initialDailyProduction: DailyProduction[] = [];
const initialRanking: RankingItem[] = [];
const initialMeta3x3: Meta3x3 = {
  assinados: 0, ganhos: 0, metaBatida: 0, valorPorMeta: 0, totalGanho: 0,
  pesoMetaAssinados: 0, pesoMetaGanhos: 0, pesoMetaequipeAssinados: 0, pesoMetaequipeGanhos: 0,
  produto: '', metaDiaria: 3, metaSemanal: 15, metaMensal: 60,
};
const initialCommissions: CommissionItem[] = [];
const initialCommissionSummary: CommissionSummary = { totalAcumulado: 0, pendente: 0, pago: 0, processando: 0, mediaVenda: 0 };
const initialFunnelData: FunnelStage[] = [
  { stage: "Leads", count: 0, color: "#09175b", icon: "Users", description: "Total de leads recebidos" },
  { stage: "Ligações", count: 0, color: "#3b82f6", icon: "Phone", description: "Primeiro contato por telefone" },
  { stage: "Assinados", count: 0, color: "#045b5b", icon: "FileText", description: "Contrato assinado" },
  { stage: "Protocolados", count: 0, color: "#34a853", icon: "Archive", description: "Processo protocolado" },
  { stage: "Perdidos", count: 0, color: "#ef4444", icon: "XCircle", description: "Leads descartados" },
];
const initialConversionByStage: ConversionRate[] = [
  { stage: "Leads → Ligações", value: 0 }, { stage: "Ligações → Assinados", value: 0 }, { stage: "Assinados → Protocolados", value: 0 },
];
const initialRadarData: RadarMetric[] = [
  { metric: "Conversão", value: 0 }, { metric: "Assinados", value: 0 }, { metric: "Volume", value: 0 },
  { metric: "Qualidade", value: 0 }, { metric: "Retenção", value: 0 }, { metric: "Protocolo", value: 0 },
];
const initialProductivityData: ProductivityData[] = [
  { semana: "Sem 1", taxa: 0, vendas: 0 }, { semana: "Sem 2", taxa: 0, vendas: 0 },
  { semana: "Sem 3", taxa: 0, vendas: 0 }, { semana: "Sem 4", taxa: 0, vendas: 0 },
];
const initialStatsCards: StatsCard[] = [
  { label: "Média Diária", value: "0", unit: "vendas/dia", trend: "+0%", up: true, color: "#09175b", bg: "#eff6ff", icon: "Activity" },
  { label: "Melhor Dia", value: "0", unit: "vendas", trend: "Sem dados", up: true, color: "#34a853", bg: "#f0fdf4", icon: "TrendingUp" },
  { label: "Taxa de Conversão", value: "0%", unit: "leads → vendas", trend: "0% vs semana", up: true, color: "#f59e0b", bg: "#fffbeb", icon: "Target" },
  { label: "Produtividade", value: "0", unit: "score geral", trend: "0 pts vs mês", up: true, color: "#045b5b", bg: "#f0fdfa", icon: "Zap" },
];
const initialNotifications: Notification[] = [];
const initialInsightCards: InsightCard[] = [];
const initialRawMetrics: RawMetrics = { emitidos: 0, assinados: 0, protocolados: 0, ganhos: 0, perdidos: 0 };
const initialTabelaComissoes: TabelaComissaoItem[] = [];
const initialCampaigns: Campaign[] = [];

// ============================================================
// INTERFACE DA STORE
// ============================================================
interface AppStore {
  currentUser: User | null;
  kpiData: KpiData; bonusData: BonusData; weeklyPerformance: WeeklyPerformance[]; dailyProduction: DailyProduction[];
  ranking: RankingItem[]; meta3x3: Meta3x3; goalProgress: number; goal3x3Progress: number;
  goal3x3AssinadosProgress: number; goal3x3GanhosProgress: number; commissions: CommissionItem[]; commissionSummary: CommissionSummary;
  funnelData: FunnelStage[]; conversionByStage: ConversionRate[]; radarData: RadarMetric[]; productivityData: ProductivityData[];
  statsCards: StatsCard[]; notifications: Notification[]; insightCards: InsightCard[]; collaborators: Collaborator[];
  globalConfig: GlobalConfig; dailyData: DailyData[]; equipeConfigs: EquipeConfig[];
  period: Period; customStartDate: string; customEndDate: string; currentStartDate: string; currentEndDate: string;
  rawMetrics: RawMetrics;
  hideValues: boolean;  
  toggleHideValues: () => void;
  tabelaComissoes: TabelaComissaoItem[];
  loadTabelaComissoes: () => Promise<void>;
  campaigns: Campaign[];
  loadCampaigns: (mes?: string) => Promise<void>;

  resetStore: () => void;
  setKpiData: (data: KpiData) => void; setBonusData: (data: BonusData) => void; setWeeklyPerformance: (data: WeeklyPerformance[]) => void;
  setDailyProduction: (data: DailyProduction[]) => void; setRanking: (data: RankingItem[]) => void; setMeta3x3: (data: Meta3x3) => void;
  updateGoalProgress: () => void; updateGoal3x3Progress: () => void;
  setCommissions: (data: CommissionItem[]) => void; setCommissionSummary: (data: CommissionSummary) => void;
  setFunnelData: (data: FunnelStage[]) => void; setConversionByStage: (data: ConversionRate[]) => void;
  setRadarData: (data: RadarMetric[]) => void; setProductivityData: (data: ProductivityData[]) => void;
  setStatsCards: (data: StatsCard[]) => void; setNotifications: (data: Notification[]) => void;
  addNotification: (notification: Notification) => void; setInsightCards: (data: InsightCard[]) => void;
  markNotificationRead: (id: number) => void; markAllNotificationsRead: () => void; getUnreadCount: () => number;
  setCollaborators: (data: Collaborator[]) => void; setGlobalConfig: (data: GlobalConfig) => void; setDailyData: (data: DailyData[]) => void;
  addDailyData: (data: DailyData) => void; updateDailyData: (colaboradorId: string, date: string, tipo: string, quantidade: number) => void;
  updateCollaboratorMeta: (id: string, metaAssinados: number, metaGanhos: number) => void;
  updateCollaboratorBonus: (id: string, bonusPorCiclo: number) => void;
  updateCollaboratorCycleMeta: (id: string, periodo: 'diario' | 'semanal' | 'mensal', assinados: number, ganhos: number) => void;
  updateGlobalConfig: (config: Partial<GlobalConfig>) => void;
  setCurrentUser: (user: User | null) => void;
  setEquipeConfigs: (data: EquipeConfig[]) => void; updateEquipeConfig: (equipeId: string, config: Partial<EquipeConfig>) => void;
  getEquipeConfigByNome: (nome: string) => EquipeConfig | undefined; getEquipeConfigById: (id: string) => EquipeConfig | undefined;
  getCollaboratorById: (id: string) => Collaborator | undefined;
  getCollaboratorTotals: (colaboradorId: string) => { emitidos: number; assinados: number; ganhos: number; perdidos: number };
  getCollaboratorDailyByDate: (colaboradorId: string, date: string) => DailyData | undefined;
  getCurrentUserData: () => Collaborator | undefined;
  getEquipeBonusForCollaborator: (colaborador: Collaborator) => number;
  getEquipePesoAssinadosForCollaborator: (colaborador: Collaborator) => number;
  getEquipePesoGanhosForCollaborator: (colaborador: Collaborator) => number;
  updateCollaboratorTotals: (colaboradorId: string) => void;
  setPeriod: (period: Period) => void; setCustomDateRange: (start: string, end: string) => void; updateCurrentDates: () => void;
  loadCollaborators: () => Promise<void>; loadEquipeConfigs: () => Promise<void>;
  loadCollaboratorsAndMetrics: (equipeNome?: string, colaboradorNome?: string, colaboradorId?: string | number, produto?: string) => Promise<void>;
  loadMetricsForPeriod: (params?: { equipeNome?: string; colaboradorNome?: string; colaboradorId?: string | number; produto?: string }) => Promise<void>;
  loadWeeklyPerformanceData: () => Promise<void>;
  loadLeadsByStage: (equipeNome?: string, colaboradorNome?: string, produto?: string) => Promise<{ colaborador: string; etapa_lead: string; total: number }[]>;
  updateKpiFromMetrics: () => void;
  updateCollaboratorWeights: (id: string, weights: Partial<Pick<Collaborator, 'pesoDiarioAssinados' | 'pesoDiarioGanhos' | 'pesoSemanalAssinados' | 'pesoSemanalGanhos' | 'pesoMensalAssinados' | 'pesoMensalGanhos' | 'bonusPorCiclo'>>) => void;
  recalculateHierarchyWeights: () => Promise<void>;
  getCollaboratorsWithHierarchy: () => Collaborator[];
  loadRawMetrics: (params?: { equipeNome?: string; colaboradorNome?: string; colaboradorId?: string | number; produto?: string }) => Promise<void>;
  updateKpiFromRawMetrics: () => void;
}

// ============================================================
// CRIAÇÃO DA STORE
// ============================================================
export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      currentUser: null,
      kpiData: initialKpiData,
      bonusData: initialBonusData,
      weeklyPerformance: initialWeeklyPerformance,
      dailyProduction: initialDailyProduction,
      ranking: initialRanking,
      meta3x3: initialMeta3x3,
      goalProgress: 0,
      goal3x3Progress: 0,
      goal3x3AssinadosProgress: 0,
      goal3x3GanhosProgress: 0,
      commissions: initialCommissions,
      commissionSummary: initialCommissionSummary,
      funnelData: initialFunnelData,
      conversionByStage: initialConversionByStage,
      radarData: initialRadarData,
      productivityData: initialProductivityData,
      statsCards: initialStatsCards,
      notifications: initialNotifications,
      insightCards: initialInsightCards,
      collaborators: initialCollaborators,
      globalConfig: initialGlobalConfig,
      dailyData: initialDailyData,
      equipeConfigs: initialEquipeConfigs,
      period: 'Mês',
      customStartDate: (() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10); })(),
      customEndDate: (() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10); })(),
      currentStartDate: '',
      currentEndDate: '',
      rawMetrics: initialRawMetrics,
      hideValues: true,
      toggleHideValues: () => set((state) => ({ hideValues: !state.hideValues })),
      tabelaComissoes: initialTabelaComissoes,
      campaigns: initialCampaigns,

      // ========== PERÍODO ==========
      setPeriod: (period) => {
        if (period !== 'Custom') {
          const { start, end } = getDateRangeFromPeriod(period);
          set({ period, customStartDate: start, customEndDate: end });
        } else set({ period });
        get().updateCurrentDates();
      },
      setCustomDateRange: (start, end) => {
        const endNext = new Date(end); endNext.setDate(endNext.getDate());
        set({ customStartDate: start, customEndDate: endNext.toISOString().slice(0, 10), period: 'Custom' });
        get().updateCurrentDates();
      },
      updateCurrentDates: () => {
        const { period, customStartDate, customEndDate } = get();
        const { start, end } = getDateRangeFromPeriod(period, customStartDate, customEndDate);
        set({ currentStartDate: start, currentEndDate: end });
      },

      // ========== RESET ==========
      resetStore: () => set({
        currentUser: null,
        kpiData: initialKpiData,
        bonusData: initialBonusData,
        weeklyPerformance: initialWeeklyPerformance,
        dailyProduction: initialDailyProduction,
        ranking: initialRanking,
        meta3x3: initialMeta3x3,
        goalProgress: 0,
        goal3x3Progress: 0,
        goal3x3AssinadosProgress: 0,
        goal3x3GanhosProgress: 0,
        commissions: initialCommissions,
        commissionSummary: initialCommissionSummary,
        funnelData: initialFunnelData,
        conversionByStage: initialConversionByStage,
        radarData: initialRadarData,
        productivityData: initialProductivityData,
        statsCards: initialStatsCards,
        notifications: initialNotifications,
        insightCards: initialInsightCards,
        collaborators: initialCollaborators,
        globalConfig: initialGlobalConfig,
        dailyData: initialDailyData,
        equipeConfigs: initialEquipeConfigs,
        period: 'Mês',
        customStartDate: (() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10); })(),
        customEndDate: (() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10); })(),
        currentStartDate: '',
        currentEndDate: '',
        rawMetrics: initialRawMetrics,
        hideValues: true,
        tabelaComissoes: initialTabelaComissoes,
        campaigns: initialCampaigns,
      }),

      // ========== SETTERS BÁSICOS ==========
      setKpiData: (data) => set({ kpiData: data }),
      setBonusData: (data) => set({ bonusData: data }),
      setWeeklyPerformance: (data) => set({ weeklyPerformance: data }),
      setDailyProduction: (data) => set({ dailyProduction: data }),
      setCollaborators: (data) => set({ collaborators: data }),
      setGlobalConfig: (data) => set({ globalConfig: data }),
      setRanking: (data) => set({ ranking: data }),
      setDailyData: (data) => set({ dailyData: data }),

      setCurrentUser: (user) => {
        if (!user) {
          set({ currentUser: null });
          return;
        }
        const normalized: User = {
          id: user.id || user.email || '',
          e_mail: user.e_mail || '',
          nome: user.nome || '',
          email: user.email || user.e_mail || '',
          equipe: user.equipe || '',
          cargo: user.cargo || user.cargo || '',
          status: user.status || '',
          periodo: user.periodo || '',
          avatar: user.avatar,
          role: user.role || user.cargo,
          rank: user.rank,
          totalRanking: user.totalRanking,
        };
        set({ currentUser: normalized });
      },

      setEquipeConfigs: (data) => set({ equipeConfigs: data }),
      updateEquipeConfig: (equipeId, config) => set((state) => ({
        equipeConfigs: state.equipeConfigs.map(e => e.id === equipeId ? { ...e, ...config } : e)
      })),
      getEquipeConfigByNome: (nome) => get().equipeConfigs.find(e => e.nome === nome),
      getEquipeConfigById: (id) => get().equipeConfigs.find(e => e.id === id),

      addDailyData: (data) => set((state) => ({ dailyData: [...state.dailyData, data] })),

      updateDailyData: (colaboradorId, date, tipo, quantidade) => {
        const id = `${colaboradorId}-${date}`;
        const existing = get().dailyData.find(d => d.id === id);
        if (existing) {
          set((state) => ({ dailyData: state.dailyData.map(d => d.id === id ? { ...d, [tipo]: (d[tipo as keyof DailyData] as number) + quantidade } : d) }));
        } else {
          const newData: DailyData = { id, colaboradorId, date, emitidos: 0, assinados: 0, ganhos: 0, perdidos: 0, [tipo]: quantidade };
          set((state) => ({ dailyData: [...state.dailyData, newData] }));
        }
        get().updateCollaboratorTotals(colaboradorId);
      },

      updateCollaboratorTotals: (colaboradorId) => {
        const userDailyData = get().dailyData.filter(d => d.colaboradorId === colaboradorId);
        const totals = userDailyData.reduce((acc, day) => ({
          emitidos: acc.emitidos + day.emitidos,
          assinados: acc.assinados + day.assinados,
          ganhos: acc.ganhos + day.ganhos,
          perdidos: acc.perdidos + day.perdidos,
        }), { emitidos: 0, assinados: 0, ganhos: 0, perdidos: 0 });
        set((state) => ({ collaborators: state.collaborators.map(c => c.id === colaboradorId ? { ...c, ...totals } : c) }));
      },

      setMeta3x3: (data) => {
        const totalGanho = data.ganhos * data.valorPorMeta;
        const metaBatida = Math.floor(Math.min(data.assinados / data.pesoMetaAssinados, data.ganhos / data.pesoMetaGanhos));
        const updatedData = { ...data, totalGanho, metaBatida };
        const progressAssinados = (updatedData.assinados / updatedData.pesoMetaAssinados) * 100;
        const progressGanhos = (updatedData.ganhos / updatedData.pesoMetaGanhos) * 100;
        const progressTotal = Math.min(progressAssinados, progressGanhos);
        set({ meta3x3: updatedData, goal3x3AssinadosProgress: Math.min(progressAssinados, 100), goal3x3GanhosProgress: Math.min(progressGanhos, 100), goal3x3Progress: Math.min(progressTotal, 100) });
      },
      updateGoalProgress: () => {
        const { kpiData } = get();
        set({ goalProgress: Math.min((kpiData.comissaoMes.value / kpiData.comissaoMes.target) * 100, 100) });
      },
      updateGoal3x3Progress: () => {
        const { meta3x3 } = get();
        const pA = (meta3x3.assinados / meta3x3.pesoMetaAssinados) * 100, pG = (meta3x3.ganhos / meta3x3.pesoMetaGanhos) * 100;
        set({ goal3x3AssinadosProgress: Math.min(pA, 100), goal3x3GanhosProgress: Math.min(pG, 100), goal3x3Progress: Math.min(pA, pG) });
      },
      updateCollaboratorMeta: (id, metaAssinados, metaGanhos) => set((state) => ({
        collaborators: state.collaborators.map(c => c.id === id ? { ...c, metaAssinados, metaGanhos } : c)
      })),
      updateCollaboratorBonus: (id, bonusPorCiclo) => set((state) => ({
        collaborators: state.collaborators.map(c => c.id === id ? { ...c, bonusPorCiclo } : c)
      })),
      updateCollaboratorCycleMeta: (id, periodo, assinados, ganhos) => set((state) => ({
        collaborators: state.collaborators.map(c => c.id === id ? {
          ...c,
          [periodo === 'diario' ? 'metaDiarioAssinados' : periodo === 'semanal' ? 'metaSemanalAssinados' : 'metaMensalAssinados']: assinados,
          [periodo === 'diario' ? 'metaDiarioGanhos' : periodo === 'semanal' ? 'metaSemanalGanhos' : 'metaMensalGanhos']: ganhos,
        } : c)
      })),
      updateGlobalConfig: (config) => set((state) => ({ globalConfig: { ...state.globalConfig, ...config } })),
      getEquipeBonusForCollaborator: (colaborador) => {
        const equipeConfig = get().equipeConfigs.find(e => e.nome === colaborador.equipeNome);
        return equipeConfig?.bonus || get().globalConfig.valorBonus;
      },
      getEquipePesoAssinadosForCollaborator: (colaborador) => {
        const equipeConfig = get().equipeConfigs.find(e => e.nome === colaborador.equipeNome);
        return equipeConfig?.pesoAssinados || get().globalConfig.pesoMetaAssinados;
      },
      getEquipePesoGanhosForCollaborator: (colaborador) => {
        const equipeConfig = get().equipeConfigs.find(e => e.nome === colaborador.equipeNome);
        return equipeConfig?.pesoGanhos || get().globalConfig.pesoMetaGanhos;
      },
      getCollaboratorById: (id) => get().collaborators.find(c => c.id === id),
      getCollaboratorTotals: (colaboradorId) => {
        const c = get().collaborators.find(x => x.id === colaboradorId);
        return c ? { emitidos: c.emitidos, assinados: c.assinados, ganhos: c.ganhos, perdidos: c.perdidos } : { emitidos: 0, assinados: 0, ganhos: 0, perdidos: 0 };
      },
      getCollaboratorDailyByDate: (colaboradorId, date) => get().dailyData.find(d => d.id === `${colaboradorId}-${date}`),
      getCurrentUserData: () => {
        const userEmail = get().currentUser?.email;
        return userEmail ? get().collaborators.find(c => c.email === userEmail || c.id === userEmail) : undefined;
      },
      addNotification: (notification) => set((state) => ({ notifications: [notification, ...state.notifications] })),
      markNotificationRead: (id) => set((state) => ({ notifications: state.notifications.map(n => n.id === id ? { ...n, read: true } : n) })),
      markAllNotificationsRead: () => set((state) => ({ notifications: state.notifications.map(n => ({ ...n, read: true })) })),
      getUnreadCount: () => get().notifications.filter(n => !n.read).length,
      setCommissions: (data) => set({ commissions: data }),
      setCommissionSummary: (data) => set({ commissionSummary: data }),
      setFunnelData: (data) => set({ funnelData: data }),
      setConversionByStage: (data) => set({ conversionByStage: data }),
      setRadarData: (data) => set({ radarData: data }),
      setProductivityData: (data) => set({ productivityData: data }),
      setStatsCards: (data) => set({ statsCards: data }),
      setNotifications: (data) => set({ notifications: data }),
      setInsightCards: (data) => set({ insightCards: data }),

      // ========== CARREGAMENTOS ==========
      loadTabelaComissoes: async () => {
        try {
          const res = await fetch(`${API_BASE}/tabela-comissoes`, { credentials: 'include' });
          if (!res.ok) throw new Error('Erro ao carregar tabela de comissões');
          const data = await res.json();
          if (data.success && Array.isArray(data.data)) {
            set({ tabelaComissoes: data.data.map((item: any) => ({
              tipo: item.tipo,
              valor_comissao: Number(item.valor_comissao) || 0,
              faixa_min: Number(item.faixa_min) || 0,
              faixa_max: Number(item.faixa_max) || 0,
              data_atualizacao: item.data_atualizacao || '',
            }))});
          }
        } catch (err) {
          console.error('Erro ao carregar tabela de comissões:', err);
        }
      },

      loadCampaigns: async (mes) => {
        try {
          const url = new URL(`${API_BASE}/campanhas`, window.location.origin);
          if (mes) url.searchParams.append('mes', mes);
          const res = await fetch(url.toString(), { credentials: 'include' });
          if (!res.ok) throw new Error('Erro ao carregar campanhas');
          const data = await res.json();
          if (data.success) {
            set({ campaigns: data.data });
          }
        } catch (err) {
          console.error('Erro ao carregar campanhas:', err);
        }
      },

      loadCollaborators: async () => {
        try {
          console.log('🔄 [loadCollaborators] Iniciando...');
          const collabs: any[] = await fetchCollaborators();
          console.log('📦 [loadCollaborators] Resposta da API:', collabs?.length, 'itens');

          if (!collabs || collabs.length === 0) {
            console.warn('⚠️ [loadCollaborators] Nenhum colaborador retornado pela API');
            set({ collaborators: [] });
            return;
          }

          const baseCollaborators: Collaborator[] = collabs.map((c: any) => ({
            id: c.id || c.email,
            name: c.name,
            email: c.email,
            equipeId: c.equipeId ?? '',
            equipeNome: c.equipeNome || '',
            avatar: c.avatar || (c.name || '?').charAt(0).toUpperCase(),
            emitidos: 0,
            assinados: 0,
            protocolados: 0,
            ganhos: 0,
            perdidos: 0,
            metaAssinados: c.metaAssinados || 3,
            metaGanhos: c.metaGanhos || 3,
            bonusPorCiclo: c.bonusPorCiclo || 100,
            bonusRecebido: c.bonusRecebido || 0,
            status: (c.status || 'ativo').toLowerCase() as "ativo" | "inativo",
            produto: c.produto || '',
            cargo: c.cargo || c.grupo || '',
            grupo: c.grupo || c.cargo || '',
            metaDiarioAssinados: c.metaDiarioAssinados ?? 3,
            metaDiarioGanhos: c.metaDiarioGanhos ?? 3,
            metaSemanalAssinados: c.metaSemanalAssinados ?? 15,
            metaSemanalGanhos: c.metaSemanalGanhos ?? 15,
            metaMensalAssinados: c.metaMensalAssinados ?? 60,
            metaMensalGanhos: c.metaMensalGanhos ?? 60,
            metaGolsAssinados: c.metaGolsAssinados ?? 0,
            metaGolsGanhos: c.metaGolsGanhos ?? 0,
            isSupervisorSR: c.isSupervisorSR ?? false,
            comissao: c.comissao ?? 0,
            bonusComissao: c.bonusComissao ?? 0,
            pesoDiarioAssinados: c.pesoDiarioAssinados ?? 3,
            pesoDiarioGanhos: c.pesoDiarioGanhos ?? 3,
            pesoSemanalAssinados: c.pesoSemanalAssinados ?? 15,
            pesoSemanalGanhos: c.pesoSemanalGanhos ?? 15,
            pesoMensalAssinados: c.pesoMensalAssinados ?? 60,
            pesoMensalGanhos: c.pesoMensalGanhos ?? 60,
            classificacaoOperacional: c.classificacaoOperacional || c.classificacao_operacional || '',
            canal: c.canal || (c.classificacaoOperacional || c.classificacao_operacional || '').toLowerCase() === 'judit' ? 'Judit' : 'Discadora',
          }));

          console.log('✅ [loadCollaborators] Mapeados:', baseCollaborators.length);

          // Tentar carregar métricas do mês atual para pesos e bônus
          const mesRef = get().currentStartDate?.substring(0, 7) || new Date().toISOString().slice(0, 7);
          try {
            const res = await fetch(`${API_BASE}/metricas-assessores?mes=${mesRef}`, { credentials: 'include' });
            if (res.ok) {
              const data = await res.json();
              if (data.success && Array.isArray(data.data)) {
                const metricsMap = new Map<string, any>();
                data.data.forEach((item: any) => {
                  const key = (item.email || '').trim().toLowerCase();
                  if (key) metricsMap.set(key, item);
                });

                for (const colab of baseCollaborators) {
                  const key = (colab.email || '').trim().toLowerCase();
                  const metrics = metricsMap.get(key);
                  if (metrics) {
                    colab.bonusPorCiclo = metrics.comissao_bonus ?? colab.bonusPorCiclo;
                    colab.bonusComissao = metrics.comissao_bonus ?? colab.bonusComissao;
                    colab.pesoDiarioAssinados = metrics.peso_meta_assinados_diario ?? colab.pesoDiarioAssinados;
                    colab.pesoDiarioGanhos = metrics.peso_meta_ganho_diario ?? colab.pesoDiarioGanhos;
                    colab.pesoSemanalAssinados = metrics.peso_meta_assinados_semanal ?? colab.pesoSemanalAssinados;
                    colab.pesoSemanalGanhos = metrics.peso_meta_ganho_semanal ?? colab.pesoSemanalGanhos;
                    colab.pesoMensalAssinados = metrics.peso_meta_assinados_mensal ?? colab.pesoMensalAssinados;
                    colab.pesoMensalGanhos = metrics.peso_meta_ganho_mensal ?? colab.pesoMensalGanhos;
                    colab.metaGolsAssinados = metrics.meta_gols_assinados ?? colab.metaGolsAssinados;   
                    colab.metaGolsGanhos = metrics.meta_gols_ganhos ?? colab.metaGolsGanhos;
                  }
                }
              }
            }
          } catch (err) {
            console.error('Falha ao carregar metricas_assessores:', err);
          }

          set({ collaborators: baseCollaborators });

          // Sincronizar Supervisores SR com o Calculator
          const srEmails = baseCollaborators
            .filter(c => c.isSupervisorSR)
            .map(c => c.email);
          calculator.setSupervisorSREmails(srEmails);

          console.log('💾 [loadCollaborators] Estado atualizado com sucesso');
        } catch (err) {
          console.error('❌ [loadCollaborators] Erro:', err);
        }
      },

      loadEquipeConfigs: async () => {
        try {
          const equipes: any[] = await fetchEquipes();
          set({ equipeConfigs: equipes.map((eq: any) => ({ id: eq.id?.toString() || eq.nome, nome: eq.nome || 'Equipe sem nome', pesoAssinados: 3, pesoGanhos: 3, pesoequipeAssinados: 0, pesoequipeGanhos: 0, bonus: 100 })) });
        } catch (err) { console.error('Erro ao carregar configurações de equipe:', err); }
      },

      loadCollaboratorsAndMetrics: async (equipeNome, colaboradorNome, colaboradorId, produto) => {
        if (get().collaborators.length === 0) { await get().loadCollaborators(); await get().loadEquipeConfigs(); }
        await get().loadTabelaComissoes();
        // NOVO: carrega campanhas do mês atual
        const mesAtual = get().currentStartDate?.substring(0, 7);
        if (mesAtual) await get().loadCampaigns(mesAtual);
        await get().loadMetricsForPeriod({ equipeNome, colaboradorNome, colaboradorId, produto });
        await get().loadWeeklyPerformanceData();
      },

      loadMetricsForPeriod: async (params = {}) => {
        try {
          const { currentStartDate, currentEndDate, collaborators } = get();
          if (!currentStartDate || !currentEndDate) { get().updateCurrentDates(); }
          const start = get().currentStartDate;
          const end = get().currentEndDate;
          if (!start || !end) return;
          if (collaborators.length === 0) await get().loadCollaborators();

          const { equipeNome, colaboradorNome, colaboradorId, produto } = params;
          const apiParams = { start, end, equipe: equipeNome, colaborador: colaboradorNome, colaboradorId, produto };
          const [emitidos, assinados, protocolados, ganhos, perdidos] = await Promise.all([
            fetchEmitidos(apiParams),
            fetchAssinados(apiParams),
            fetchProtocolados(apiParams),
            fetchGanhos(apiParams),
            fetchPerdidos(apiParams),
          ]);

          const normalize = (str: string): string => (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const mapToNum = (arr: any[], key: string) => {
            const m = new Map<string, number>();
            arr.forEach((e: any) => {
              const raw = e[key];
              if (raw) m.set(normalize(raw), (m.get(normalize(raw)) || 0) + (Number(e.total) || 0));
            });
            return m;
          };
          const eMap = mapToNum(emitidos, 'colaborador');
          const aMap = mapToNum(assinados, 'colaborador');
          const pMap = mapToNum(protocolados, 'colaborador');
          const gMap = mapToNum(ganhos, 'colaborador');
          const peMap = mapToNum(perdidos, 'colaborador');

          let updated = get().collaborators.map(c => ({
            ...c,
            emitidos: eMap.get(normalize(c.name)) ?? 0,
            assinados: aMap.get(normalize(c.name)) ?? 0,
            protocolados: pMap.get(normalize(c.name)) ?? 0,
            ganhos: gMap.get(normalize(c.name)) ?? 0,
            perdidos: peMap.get(normalize(c.name)) ?? 0,
          }));

          updated.forEach(c => {
            if (c.cargo === 'Quinquenio' || c.cargo === 'Concomitante') {
              c.ganhos = 0;
            }
          });

          const hierarchical = applyHierarchyTotals(updated);
          set({ collaborators: hierarchical });
          get().updateKpiFromMetrics();

          const sumTotal = (data: any[]) => data.reduce((acc, item) => acc + (Number(item.total) || 0), 0);
          const rawMetrics = {
            emitidos: sumTotal(emitidos),
            assinados: sumTotal(assinados),
            protocolados: sumTotal(protocolados),
            ganhos: sumTotal(ganhos),
            perdidos: sumTotal(perdidos),
          };
          set({ rawMetrics });

          const leadsData = await fetchLeadsRecebidos(apiParams);
          const leadsByDate = new Map<string, number>();
          leadsData.forEach((l: any) => leadsByDate.set(l.data, (leadsByDate.get(l.data) || 0) + l.total));
          const dailyProd: DailyProduction[] = Array.from(leadsByDate.entries()).map(([date, leads]) => ({ date, vendas: 0, leads }));
          if (dailyProd.length) set({ dailyProduction: dailyProd.sort((a, b) => a.date.localeCompare(b.date)) });
        } catch (err) {
          console.error('Erro ao carregar métricas:', err);
        }
      },

      loadRawMetrics: async (params = {}) => {
        try {
          const { currentStartDate, currentEndDate } = get();
          if (!currentStartDate || !currentEndDate) {
            get().updateCurrentDates();
          }
          const start = get().currentStartDate;
          const end = get().currentEndDate;
          if (!start || !end) return;

          const { equipeNome, colaboradorNome, colaboradorId, produto } = params;
          const apiParams = { start, end, equipe: equipeNome, colaborador: colaboradorNome, colaboradorId, produto };

          const [emitidos, assinados, protocolados, ganhos, perdidos] = await Promise.all([
            fetchEmitidos(apiParams),
            fetchAssinados(apiParams),
            fetchProtocolados(apiParams),
            fetchGanhos(apiParams),
            fetchPerdidos(apiParams),
          ]);

          const sumTotal = (data: any[]) => data.reduce((acc, item) => acc + (Number(item.total) || 0), 0);
          const rawMetrics = {
            emitidos: sumTotal(emitidos),
            assinados: sumTotal(assinados),
            protocolados: sumTotal(protocolados),
            ganhos: sumTotal(ganhos),
            perdidos: sumTotal(perdidos),
          };
          set({ rawMetrics });
        } catch (err) {
          console.error('❌ [loadRawMetrics] Erro:', err);
        }
      },

      updateKpiFromMetrics: () => {
        const { collaborators, globalConfig } = get();
        const totalGanhos = collaborators.reduce((s, c) => s + (Number(c.ganhos) || 0), 0);
        const totalProt = collaborators.reduce((s, c) => s + (Number(c.protocolados) || 0), 0);
        const totalAss = collaborators.reduce((s, c) => s + (Number(c.assinados) || 0), 0);
        const totalEmi = collaborators.reduce((s, c) => s + (Number(c.emitidos) || 0), 0);
        const taxa = totalEmi > 0 ? (totalAss / totalEmi) * 100 : 0;
        const metaBatida = Math.floor(Math.min(totalAss / (globalConfig.pesoMetaAssinados || 3), totalGanhos / (globalConfig.pesoMetaGanhos || 3)));
        const comissao = metaBatida * (globalConfig.valorBonus || 100);
        set((s) => ({
          kpiData: {
            ...s.kpiData,
            comissaoMes: { ...s.kpiData.comissaoMes, value: comissao },
            vendasFechadas: { ...s.kpiData.vendasFechadas, value: totalGanhos, target: globalConfig.metaMensal || 200 },
            protocolados: { ...s.kpiData.protocolados, value: totalProt },
            taxaConversao: { ...s.kpiData.taxaConversao, value: taxa },
          },
        }));
      },

      updateKpiFromRawMetrics: () => {
        const { rawMetrics, globalConfig } = get();
        const totalAss = rawMetrics.assinados;
        const totalGan = rawMetrics.ganhos;
        const totalProt = rawMetrics.protocolados;
        const totalEmi = rawMetrics.emitidos;
        const taxa = totalEmi > 0 ? (totalAss / totalEmi) * 100 : 0;
        const metaBatida = Math.floor(Math.min(totalAss / (globalConfig.pesoMetaAssinados || 3), totalGan / (globalConfig.pesoMetaGanhos || 3)));
        const comissao = metaBatida * (globalConfig.valorBonus || 100);
        set((s) => ({
          kpiData: {
            ...s.kpiData,
            comissaoMes: { ...s.kpiData.comissaoMes, value: comissao },
            vendasFechadas: { ...s.kpiData.vendasFechadas, value: totalGan, target: globalConfig.metaMensal || 200 },
            protocolados: { ...s.kpiData.protocolados, value: totalProt },
            taxaConversao: { ...s.kpiData.taxaConversao, value: taxa },
          },
        }));
      },

      loadWeeklyPerformanceData: async () => {
        try {
          const { currentStartDate, currentEndDate } = get();
          if (!currentStartDate || !currentEndDate) return;
          const raw = await fetchWeeklyPerformance({ start: currentStartDate, end: currentEndDate });
          set({ weeklyPerformance: raw.map((item: any) => ({ day: item.semana ? new Date(item.semana).toLocaleDateString('pt-BR', { weekday: 'short' }) : '', vendas: item.vendas, meta: item.meta || 5 })) });
        } catch { /* mock */ }
      },

      loadLeadsByStage: async (equipeNome, colaboradorNome, produto) => {
        try {
          const { currentStartDate, currentEndDate } = get();
          if (!currentStartDate || !currentEndDate) return [];
          const params = new URLSearchParams({ start: currentStartDate, end: currentEndDate });
          if (colaboradorNome) params.append('colaborador', colaboradorNome);
          if (equipeNome) params.append('equipeNome', equipeNome);
          if (produto && produto !== 'Todos') params.append('produto', produto);
          const res = await fetch(`${API_BASE}/metrics/leads/stages?${params}`, { credentials: 'include' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Erro ao carregar leads por etapa');
          return data.data.map((item: any) => ({ ...item, total: Number(item.total) || 0 }));
        } catch { return []; }
      },

      updateCollaboratorWeights: (id, weights) => {
        set((state) => ({
          collaborators: state.collaborators.map(c => c.id === id ? { ...c, ...weights } : c)
        }));
      },

      recalculateHierarchyWeights: async () => {
        const { collaborators, updateCollaboratorWeights } = get();
        const supervisors = collaborators.filter(c => normalizeGroup(c.cargo) === 'supervisor');
        const coordAdmins = collaborators.filter(c => normalizeGroup(c.cargo) === 'coordenador' || normalizeGroup(c.cargo) === 'administrativo');

        const sumWeights = (list: Collaborator[], periodo: 'diario' | 'semanal' | 'mensal') => {
          const pesoAssinadosKey = `peso${periodo.charAt(0).toUpperCase() + periodo.slice(1)}Assinados` as keyof Collaborator;
          const pesoGanhosKey = `peso${periodo.charAt(0).toUpperCase() + periodo.slice(1)}Ganhos` as keyof Collaborator;
          return {
            pesoAssinados: list.reduce((s, c) => s + (c[pesoAssinadosKey] as number || 0), 0),
            pesoGanhos: list.reduce((s, c) => s + (c[pesoGanhosKey] as number || 0), 0),
          };
        };

        for (const sup of supervisors) {
          const team = collaborators.filter(c => c.equipeNome === sup.equipeNome && c.status === 'ativo');
          const diario = sumWeights(team, 'diario');
          const semanal = sumWeights(team, 'semanal');
          const mensal = sumWeights(team, 'mensal');
          const bonusTotal = team.reduce((s, c) => s + (c.bonusPorCiclo || 0), 0);
          updateCollaboratorWeights(sup.id, {
            pesoDiarioAssinados: diario.pesoAssinados,
            pesoDiarioGanhos: diario.pesoGanhos,
            pesoSemanalAssinados: semanal.pesoAssinados,
            pesoSemanalGanhos: semanal.pesoGanhos,
            pesoMensalAssinados: mensal.pesoAssinados,
            pesoMensalGanhos: mensal.pesoGanhos,
            bonusPorCiclo: bonusTotal,
          });
        }

        const allActive = collaborators.filter(c => c.status === 'ativo');
        const diarioGlobal = sumWeights(allActive, 'diario');
        const semanalGlobal = sumWeights(allActive, 'semanal');
        const mensalGlobal = sumWeights(allActive, 'mensal');
        const bonusGlobal = allActive.reduce((s, c) => s + (c.bonusPorCiclo || 0), 0);
        for (const coord of coordAdmins) {
          updateCollaboratorWeights(coord.id, {
            pesoDiarioAssinados: diarioGlobal.pesoAssinados,
            pesoDiarioGanhos: diarioGlobal.pesoGanhos,
            pesoSemanalAssinados: semanalGlobal.pesoAssinados,
            pesoSemanalGanhos: semanalGlobal.pesoGanhos,
            pesoMensalAssinados: mensalGlobal.pesoAssinados,
            pesoMensalGanhos: mensalGlobal.pesoGanhos,
            bonusPorCiclo: bonusGlobal,
          });
        }
      },

      getCollaboratorsWithHierarchy: () => {
        return applyHierarchyTotals(get().collaborators);
      },
    }),
    {
      name: 'madm-storage',
      partialize: (state) => ({
        equipeConfigs: state.equipeConfigs,
        globalConfig: state.globalConfig,
        period: state.period,
        customStartDate: state.customStartDate,
        customEndDate: state.customEndDate,
      }),
    }
  )
);

setTimeout(() => { useAppStore.getState().updateCurrentDates(); }, 0);

export const formatCurrency = formatCurrencyUtil;
export const formatPercent = formatPercentUtil;