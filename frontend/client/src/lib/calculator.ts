// src/lib/calculator.ts

// ========== Tipos auxiliares (legados mantidos) ==========
export interface CalculatorConfig {
  pesoGanhos: number;
  pesoAssinados: number;
  bonusBase: number;
  comissaoPercentualPadrao: number;
  bonusExtraPorMeta: number;
}

export interface TeamMember {
  id?: string | number;
  nome?: string;
  ganhos?: number;
  assinados?: number;
  meta_individual?: number;
  meta_percentual?: number;
  comissao_percentual?: number;
}

export interface MemberDetail {
  id?: string | number;
  nome?: string;
  bateuMeta: boolean;
  bonus: number;
}

export interface TeamBonusResult {
  totalBonus: number;
  members: MemberDetail[];
  teamBonus?: number;
}

export interface RankedMember extends TeamMember {
  score: number;
  bateuMeta: boolean;
  comissao: number;
  bonus: number;
  ranking?: number;
}

export interface PeriodCommissionConfig {
  pesoAssinados: number;
  pesoGanhos: number;
  bonusPorCiclo: number;
}

export interface PeriodCommissionResult {
  metasBatidas: number;
  comissao: number;
  pesoAssinados: number;
  pesoGanhos: number;
  bonus: number;
}

// ========== NOVOS TIPOS PARA O MODELO DE COMISSÕES ==========
export interface TabelaComissaoItem {
  tipo: string;
  valor_comissao: number;
  faixa_min: number;
  faixa_max: number;
  data_atualizacao: string;
}

export interface DailyData {
  date: string;
  assinados: number;
  ganhos: number;
}

export interface DailyGols {
  date: string;
  gols: number;           // antes era "gol: boolean"
}

export interface GoalCommissionResult {
  goalCommission: number;
  productCommission: number;
  totalCommission: number;
  totalGols: number;
}

export interface GapResult {
  currentFaixa: TabelaComissaoItem | null;
  nextFaixa: TabelaComissaoItem;
  gap: number;
  nextValue: number;
}

// ========== Classe Calculator ==========
export class Calculator {
  config: CalculatorConfig;
  supervisorSREmails: Set<string>;

  constructor() {
    this.config = {
      pesoGanhos: 60,
      pesoAssinados: 60,
      bonusBase: 10.0,
      comissaoPercentualPadrao: 5,
      bonusExtraPorMeta: 50.0,
    };
    this.supervisorSREmails = new Set();
  }

  // ========== CONFIGURAÇÃO DE SUPERVISORES SR ==========
  setSupervisorSREmails(emails: string[]): void {
    this.supervisorSREmails = new Set(emails.map(e => e.trim().toLowerCase()));
  }

  isSupervisorSR(email: string): boolean {
    return this.supervisorSREmails.has((email || '').trim().toLowerCase());
  }

  // ========== CÁLCULO DE GOLS DIÁRIOS (AGORA COM MÚLTIPLOS GOLS POR DIA) ==========
  /**
   * Calcula gols diários de um assessor.
   * Agora contabiliza quantos múltiplos das metas foram atingidos por dia.
   *
   * @param dailyData - Array de { date, assinados, ganhos }
   * @param metaGolsAssinados
   * @param metaGolsGanhos
   * @returns { totalGols: number, dailyGols: Array<{ date, gols: number }> }
   */
  calculateDailyGoals(
    dailyData: DailyData[],
    metaGolsAssinados: number,
    metaGolsGanhos: number
  ): { totalGols: number; dailyGols: DailyGols[] } {
    let totalGols = 0;
    const dailyGols = dailyData.map(day => {
      const assinados = day.assinados || 0;
      const ganhos = day.ganhos || 0;

      // Quantos gols? Mínimo entre (assinados / metaAss) e (ganhos / metaGan)
      const golsNoDia = Math.min(
        Math.floor(assinados / metaGolsAssinados),
        Math.floor(ganhos / metaGolsGanhos)
      );
      totalGols += golsNoDia;
      return { date: day.date, gols: golsNoDia };
    });
    return { totalGols, dailyGols };
  }

  // ========== TABELA DE FAIXAS ==========
  getFaixa(
    tabelaComissoes: TabelaComissaoItem[],
    tipo: string,
    valor: number
  ): TabelaComissaoItem | null {
    const faixas = tabelaComissoes.filter(f => f.tipo === tipo);
    for (const faixa of faixas) {
      if (valor >= faixa.faixa_min && valor <= faixa.faixa_max) {
        return faixa;
      }
    }
    return null;
  }

  getNextFaixa(
    tabelaComissoes: TabelaComissaoItem[],
    tipo: string,
    valor: number
  ): { faixa: TabelaComissaoItem; gap: number } | null {
    const faixas = tabelaComissoes
      .filter(f => f.tipo === tipo)
      .sort((a, b) => a.faixa_min - b.faixa_min);
    const next = faixas.find(f => f.faixa_min > valor);
    if (!next) return null;
    return { faixa: next, gap: next.faixa_min - valor };
  }

  // ========== CÁLCULO DE COMISSÕES ==========
  calculateGoalCommission(totalGols: number, tabelaComissoes: TabelaComissaoItem[]): number {
    const faixa = this.getFaixa(tabelaComissoes, 'GOL', totalGols);
    return faixa ? faixa.valor_comissao : 0;
  }

  calculateProductCommission(
    totalAssinados: number,
    productType: string,
    tabelaComissoes: TabelaComissaoItem[]
  ): number {
    const tipo = productType.toUpperCase();
    const faixa = this.getFaixa(tabelaComissoes, tipo, totalAssinados);
    return faixa ? faixa.valor_comissao : 0;
  }

  calculateQuinquenioCommission(
    totalAssinados: number,
    tabelaComissoes: TabelaComissaoItem[]
  ): number {
    const faixa = this.getFaixa(tabelaComissoes, 'QUINQUENIO', totalAssinados);
    return faixa ? faixa.valor_comissao : 0;
  }

  calculateSupervisorCommission(
    totalAssinadosEquipe: number,
    isSR: boolean,
    tabelaComissoes: TabelaComissaoItem[]
  ): number {
    const tipo = isSR ? 'SUPERVISOR SR' : 'SUPERVISOR';
    const faixa = this.getFaixa(tabelaComissoes, tipo, totalAssinadosEquipe);
    return faixa ? faixa.valor_comissao : 0;
  }

  calculateTotalCommission(
    dailyData: DailyData[],
    metaGolsAssinados: number,
    metaGolsGanhos: number,
    totalAssinados: number,
    productType: string,
    tabelaComissoes: TabelaComissaoItem[]
  ): GoalCommissionResult {
    const { totalGols } = this.calculateDailyGoals(dailyData, metaGolsAssinados, metaGolsGanhos);
    const goalCommission = this.calculateGoalCommission(totalGols, tabelaComissoes);
    const productCommission = this.calculateProductCommission(totalAssinados, productType, tabelaComissoes);
    return {
      goalCommission,
      productCommission,
      totalCommission: goalCommission + productCommission,
      totalGols,
    };
  }

  // ========== GAPS (PRÓXIMA FAIXA) ==========
  calculateGoalGap(totalGols: number, tabelaComissoes: TabelaComissaoItem[]): GapResult | null {
    const current = this.getFaixa(tabelaComissoes, 'GOL', totalGols);
    const next = this.getNextFaixa(tabelaComissoes, 'GOL', totalGols);
    if (!next) return null;
    return {
      currentFaixa: current,
      nextFaixa: next.faixa,
      gap: next.gap,
      nextValue: next.faixa.faixa_min,
    };
  }

  calculateProductGap(
    totalAssinados: number,
    productType: string,
    tabelaComissoes: TabelaComissaoItem[]
  ): GapResult | null {
    const tipo = productType.toUpperCase();
    const current = this.getFaixa(tabelaComissoes, tipo, totalAssinados);
    const next = this.getNextFaixa(tabelaComissoes, tipo, totalAssinados);
    if (!next) return null;
    return {
      currentFaixa: current,
      nextFaixa: next.faixa,
      gap: next.gap,
      nextValue: next.faixa.faixa_min,
    };
  }

  calculateQuinquenioGap(
    totalAssinados: number,
    tabelaComissoes: TabelaComissaoItem[]
  ): GapResult | null {
    return this.calculateProductGap(totalAssinados, 'QUINQUENIO', tabelaComissoes);
  }

  calculateSupervisorGap(
    totalAssinadosEquipe: number,
    isSR: boolean,
    tabelaComissoes: TabelaComissaoItem[]
  ): GapResult | null {
    const tipo = isSR ? 'SUPERVISOR SR' : 'SUPERVISOR';
    const current = this.getFaixa(tabelaComissoes, tipo, totalAssinadosEquipe);
    const next = this.getNextFaixa(tabelaComissoes, tipo, totalAssinadosEquipe);
    if (!next) return null;
    return {
      currentFaixa: current,
      nextFaixa: next.faixa,
      gap: next.gap,
      nextValue: next.faixa.faixa_min,
    };
  }

  // ========== MÉTODOS LEGADOS (mantidos para compatibilidade) ==========
  checkGoal(
    ganhos: number,
    assinados: number,
    metaQuantidade: number = 10,
    metaPercentual: number = 70
  ): boolean {
    const score = ganhos * 1 + assinados * 1;
    const required = metaQuantidade * 1;
    const atingiuQuantidade = score >= required;
    let atingiuPercentual = true;
    if (assinados > 0) {
      atingiuPercentual = (assinados / (ganhos + assinados)) * 100 >= metaPercentual;
    }
    return atingiuQuantidade && atingiuPercentual;
  }

  calculateProgress(ganhos: number, metaQuantidade: number = 10): number {
    if (metaQuantidade <= 0) return 0;
    return Math.min(100, Math.max(0, (ganhos / metaQuantidade) * 100));
  }

  calculateRemainingToGoal(ganhos: number, metaQuantidade: number = 10): number {
    return Math.max(0, metaQuantidade - ganhos);
  }

  calculateBonus(
    metasBatidas: number,
    ganhos: number,
    metaQuantidade: number = 10,
    metaExtra: boolean = false
  ): number {
    return 0; // Placeholder
  }

  calculateCommission(
    assinados: number,
    percentualComissao: number | null = null,
    valorPorAssinado: number = 100
  ): number {
    return 0; // Placeholder
  }

  calculateTotalScore(ganhos: number, assinados: number): number {
    return ganhos + assinados;
  }

  calculateSuccessRate(ganhos: number, assinados: number): number {
    const total = ganhos + assinados;
    if (total === 0) return 0;
    return (assinados / total) * 100;
  }

  calculateTeamBonus(
    teamMembers: TeamMember[],
    metaEquipe: number | null = null
  ): TeamBonusResult {
    return { totalBonus: 0, members: [] };
  }

  calculateRanking(members: TeamMember[]): RankedMember[] {
    return members.map((member, index) => ({
      ...member,
      score: 0,
      bateuMeta: false,
      comissao: 0,
      bonus: 0,
      ranking: index + 1,
    }));
  }

  calculateProjection(
    ganhosAtuais: number,
    assinadosAtuais: number,
    diasRestantes: number,
    metaQuantidade: number = 10
  ) {
    return {
      ganhosProjetados: ganhosAtuais,
      assinadosProjetados: assinadosAtuais,
      projecaoMeta: false,
      ganhosNecessariosPorDia: 0,
    };
  }

  updateConfig(newConfig: Partial<CalculatorConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  getConfig(): CalculatorConfig {
    return { ...this.config };
  }

  // ========== MÉTODOS DE CICLO (compatibilidade) ==========
  calculateCycleCommission(
    assinados: number,
    ganhos: number,
    weightAssinados: number,
    weightGanhos: number,
    bonusValue: number
  ): number {
    if (weightAssinados <= 0) return 0;
    if (weightGanhos <= 0) {
      const metasBatidas = Math.floor(assinados / weightAssinados);
      return metasBatidas * bonusValue;
    }
    const metasBatidas = Math.floor(
      Math.min(assinados / weightAssinados, ganhos / weightGanhos)
    );
    return metasBatidas * bonusValue;
  }

  calculateMetasBatidas(
    assinados: number,
    ganhos: number,
    weightAssinados: number,
    weightGanhos: number
  ): number {
    if (weightAssinados <= 0) return 0;
    if (weightGanhos <= 0) {
      return Math.floor(assinados / weightAssinados);
    }
    return Math.floor(Math.min(assinados / weightAssinados, ganhos / weightGanhos));
  }

  calculatePeriodCommission(
    assinados: number,
    ganhos: number,
    config: PeriodCommissionConfig
  ): PeriodCommissionResult {
    const { pesoAssinados, pesoGanhos, bonusPorCiclo } = config;
    const metasBatidas = this.calculateMetasBatidas(
      assinados,
      ganhos,
      pesoAssinados,
      pesoGanhos
    );
    const comissao = metasBatidas * bonusPorCiclo;
    return {
      metasBatidas,
      comissao,
      pesoAssinados,
      pesoGanhos,
      bonus: bonusPorCiclo,
    };
  }

  calculateTotalCommissionForPeriods(
    assinados: number,
    ganhos: number,
    periodsConfig: PeriodCommissionConfig[]
  ): { totalComissao: number; detalhes: PeriodCommissionResult[] } {
    let totalComissao = 0;
    const detalhes: PeriodCommissionResult[] = [];
    for (const config of periodsConfig) {
      const result = this.calculatePeriodCommission(assinados, ganhos, config);
      totalComissao += result.comissao;
      detalhes.push(result);
    }
    return { totalComissao, detalhes };
  }
}

// Instância única para uso em toda aplicação
export const calculator = new Calculator();