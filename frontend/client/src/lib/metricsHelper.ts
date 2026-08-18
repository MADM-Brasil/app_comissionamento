// src/lib/metricsHelper.ts
import { calculator } from './calculator'; // ajuste o caminho se necessário
import { useAppStore, Collaborator, TabelaComissaoItem } from './dataStore';

/**
 * Retorna a tabela de comissões completa, carregada na store.
 */
export function getTabelaComissoes(): TabelaComissaoItem[] {
  return useAppStore.getState().tabelaComissoes;
}

/**
 * Verifica se um colaborador é Supervisor SR.
 * Utiliza a lista de e‑mails definida no Calculator.
 * Alternativamente, pode usar o campo isSupervisorSR do colaborador (se já mapeado).
 */
export function isSupervisorSR(col: Collaborator): boolean {
  // Se o campo isSupervisorSR já foi populado pela API, use-o diretamente:
  if (col.isSupervisorSR !== undefined) return col.isSupervisorSR;
  // Caso contrário, usa a lista do Calculator (se configurada)
  return calculator.isSupervisorSR(col.email);
}

/**
 * Calcula a comissão de um ASSESSOR com base nos dados diários e no total de assinados.
 *
 * @param dailyData - Array de objetos { date: string, assinados: number, ganhos: number }
 * @param metaGolsAssinados - Meta diária de assinados para fazer um gol
 * @param metaGolsGanhos - Meta diária de ganhos para fazer um gol
 * @param totalAssinados - Total de assinados no período
 * @param productType - Tipo de produto (ex: 'AUXILIO ACIDENTE', 'QUINQUENIO', etc.)
 * @param tabelaComissoes - Tabela de faixas (se omitida, busca da store)
 * @returns Objeto com goalCommission, productCommission, totalCommission, totalGols
 */
export function calculateAssessorCommission(
  dailyData: { date: string; assinados: number; ganhos: number }[],
  metaGolsAssinados: number,
  metaGolsGanhos: number,
  totalAssinados: number,
  productType: string,
  tabelaComissoes?: TabelaComissaoItem[]
) {
  const faixas = tabelaComissoes || getTabelaComissoes();
  return calculator.calculateTotalCommission(
    dailyData,
    metaGolsAssinados,
    metaGolsGanhos,
    totalAssinados,
    productType,
    faixas
  );
}

/**
 * Calcula a comissão para colaboradores QUINQUENIO (apenas assinados).
 */
export function calculateQuinquenioCommission(
  totalAssinados: number,
  tabelaComissoes?: TabelaComissaoItem[]
): number {
  const faixas = tabelaComissoes || getTabelaComissoes();
  return calculator.calculateQuinquenioCommission(totalAssinados, faixas);
}

/**
 * Calcula a comissão para SUPERVISORES e SUPERVISORES SR.
 *
 * @param totalAssinadosEquipe - Soma dos assinados da equipe no período
 * @param isSR - Se é Supervisor SR
 * @param tabelaComissoes - Tabela de faixas (opcional)
 */
export function calculateSupervisorCommission(
  totalAssinadosEquipe: number,
  isSR: boolean,
  tabelaComissoes?: TabelaComissaoItem[]
): number {
  const faixas = tabelaComissoes || getTabelaComissoes();
  return calculator.calculateSupervisorCommission(totalAssinadosEquipe, isSR, faixas);
}

// ----------- GAPS (quanto falta para a próxima faixa) -----------
export function getGoalGap(
  totalGols: number,
  tabelaComissoes?: TabelaComissaoItem[]
) {
  const faixas = tabelaComissoes || getTabelaComissoes();
  return calculator.calculateGoalGap(totalGols, faixas);
}

export function getProductGap(
  totalAssinados: number,
  productType: string,
  tabelaComissoes?: TabelaComissaoItem[]
) {
  const faixas = tabelaComissoes || getTabelaComissoes();
  return calculator.calculateProductGap(totalAssinados, productType, faixas);
}

export function getQuinquenioGap(
  totalAssinados: number,
  tabelaComissoes?: TabelaComissaoItem[]
) {
  const faixas = tabelaComissoes || getTabelaComissoes();
  return calculator.calculateQuinquenioGap(totalAssinados, faixas);
}

export function getSupervisorGap(
  totalAssinadosEquipe: number,
  isSR: boolean,
  tabelaComissoes?: TabelaComissaoItem[]
) {
  const faixas = tabelaComissoes || getTabelaComissoes();
  return calculator.calculateSupervisorGap(totalAssinadosEquipe, isSR, faixas);
}

// ----------- Funções de compatibilidade (podem ser removidas futuramente) -----------
/** @deprecated Use calculateAssessorCommission ou outras novas funções */
export function getEffectiveWeights() {
  console.warn('getEffectiveWeights está obsoleto no novo modelo de comissões.');
  return { pesoAssinados: 0, pesoGanhos: 0, bonus: 0 };
}

/** @deprecated */
export function calculateMetasBatidas() {
  console.warn('calculateMetasBatidas está obsoleto.');
  return 0;
}

/** @deprecated */
export function calculateCommissionForPeriod() {
  console.warn('calculateCommissionForPeriod está obsoleto.');
  return { metasBatidas: 0, comissao: 0, pesoAssinados: 0, pesoGanhos: 0, bonus: 0 };
}

/** @deprecated Use calculateAssessorCommission */
export function calculateTotalCommission() {
  console.warn('calculateTotalCommission antigo está obsoleto.');
  return { totalComissao: 0, detalhes: {} };
}

/** @deprecated */
export function getGoalForCollaborator() {
  console.warn('getGoalForCollaborator está obsoleto.');
  return { metaAssinados: 0, metaGanhos: 0 };
}

/** @deprecated */
export function getCollaboratorMeta() {
  console.warn('getCollaboratorMeta está obsoleto.');
  return 0;
}