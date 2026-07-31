// src/lib/metricsHelper.ts
import { useAppStore, Collaborator } from './dataStore';
import { getAccessLevel, LEVELS } from './accessControl';

type Periodo = 'diario' | 'semanal' | 'mensal';

function capitalize(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Retorna os pesos efetivos e o bônus para um determinado período,
 * considerando o nível do usuário logado (assessor, supervisor, coordenador/admin).
 * Agora usa o campo 'cargo' para determinar o nível de acesso.
 */
export function getEffectiveWeights(
  currentUser: any,
  targetCollaborator: Collaborator | null,
  period: Periodo
): { pesoAssinados: number; pesoGanhos: number; bonus: number } {
  try {
    const level = getAccessLevel(currentUser?.cargo);  // ← ajustado para 'cargo'
    const { collaborators, globalConfig } = useAppStore.getState();

    if (!collaborators || collaborators.length === 0) {
      // valores padrão atualizados: 3/15/60
      switch (period) {
        case 'diario': return { pesoAssinados: 3, pesoGanhos: 3, bonus: 150 };
        case 'semanal': return { pesoAssinados: 15, pesoGanhos: 15, bonus: 150 };
        case 'mensal': return { pesoAssinados: 60, pesoGanhos: 60, bonus: 150 };
      }
    }

    // COORDENADOR / ADMINISTRATIVO -> soma de todos os ativos
    if (level >= LEVELS.COORDENADOR) {
      const ativos = collaborators.filter(c => c.status === 'ativo');
      const pesoAssinados = ativos.reduce(
        (sum, c) => sum + (c[`peso${capitalize(period)}Assinados` as keyof Collaborator] as number || 0),
        0
      );
      const pesoGanhos = ativos.reduce(
        (sum, c) => sum + (c[`peso${capitalize(period)}Ganhos` as keyof Collaborator] as number || 0),
        0
      );
      const bonus = ativos.reduce((sum, c) => sum + (c.bonusPorCiclo || 0), 0);
      return { pesoAssinados: pesoAssinados || 1, pesoGanhos: pesoGanhos || 1, bonus: bonus || 150 };
    }

    // SUPERVISOR -> soma da sua equipe (campo 'equipe' mantido do User normalizado)
    if (level === LEVELS.SUPERVISAO && currentUser?.equipe) {
      const equipe = collaborators.filter(
        c => c.equipeNome === currentUser.equipe && c.status === 'ativo'
      );
      const pesoAssinados = equipe.reduce(
        (sum, c) => sum + (c[`peso${capitalize(period)}Assinados` as keyof Collaborator] as number || 0),
        0
      );
      const pesoGanhos = equipe.reduce(
        (sum, c) => sum + (c[`peso${capitalize(period)}Ganhos` as keyof Collaborator] as number || 0),
        0
      );
      const bonus = equipe.reduce((sum, c) => sum + (c.bonusPorCiclo || 0), 0);
      return { pesoAssinados: pesoAssinados || 1, pesoGanhos: pesoGanhos || 1, bonus: bonus || 150 };
    }

    // ASSESSOR (ou fallback) -> usa os próprios pesos do colaborador
    const col = targetCollaborator || collaborators.find(c => c.id === currentUser?.id);
    if (!col) {
      switch (period) {
        case 'diario': return { pesoAssinados: 3, pesoGanhos: 3, bonus: 150 };
        case 'semanal': return { pesoAssinados: 15, pesoGanhos: 15, bonus: 150 };
        case 'mensal': return { pesoAssinados: 60, pesoGanhos: 60, bonus: 150 };
      }
    }

    let pesoAssinados = 0, pesoGanhos = 0;
    switch (period) {
      case 'diario':
        pesoAssinados = col.pesoDiarioAssinados ?? 3;
        pesoGanhos = col.pesoDiarioGanhos ?? 3;
        break;
      case 'semanal':
        pesoAssinados = col.pesoSemanalAssinados ?? 15;
        pesoGanhos = col.pesoSemanalGanhos ?? 15;
        break;
      case 'mensal':
        pesoAssinados = col.pesoMensalAssinados ?? 60;
        pesoGanhos = col.pesoMensalGanhos ?? 60;
        break;
    }
    return {
      pesoAssinados: pesoAssinados || 1,
      pesoGanhos: pesoGanhos || 1,
      bonus: col.bonusPorCiclo || 150,
    };
  } catch (error) {
    console.error('Erro em getEffectiveWeights:', error);
    return { pesoAssinados: 3, pesoGanhos: 3, bonus: 150 };
  }
}

/**
 * Calcula quantas metas foram batidas em um período com base nos totais e pesos.
 */
export function calculateMetasBatidas(
  assinados: number,
  ganhos: number,
  pesoAssinados: number,
  pesoGanhos: number
): number {
  if (pesoAssinados <= 0) return 0;
  if (pesoGanhos <= 0) {
    return Math.floor(assinados / pesoAssinados);
  }
  return Math.floor(Math.min(assinados / pesoAssinados, ganhos / pesoGanhos));
}

/**
 * Calcula a comissão para um colaborador em um período específico.
 */
export function calculateCommissionForPeriod(
  col: Collaborator,
  totals: { assinados: number; ganhos: number },
  period: Periodo,
  currentUser: any
): { metasBatidas: number; comissao: number; pesoAssinados: number; pesoGanhos: number; bonus: number } {
  const { pesoAssinados, pesoGanhos, bonus } = getEffectiveWeights(currentUser, col, period);
  const metasBatidas = calculateMetasBatidas(totals.assinados, totals.ganhos, pesoAssinados, pesoGanhos);
  const comissao = metasBatidas * bonus;
  return { metasBatidas, comissao, pesoAssinados, pesoGanhos, bonus };
}

/**
 * Calcula a comissão total (soma diário + semanal + mensal) para um colaborador.
 */
export function calculateTotalCommission(
  col: Collaborator,
  totals: { assinados: number; ganhos: number },
  currentUser: any
): { totalComissao: number; detalhes: Record<Periodo, ReturnType<typeof calculateCommissionForPeriod>> } {
  const periods: Periodo[] = ['diario', 'semanal', 'mensal'];
  let totalComissao = 0;
  const detalhes = {} as Record<Periodo, ReturnType<typeof calculateCommissionForPeriod>>;
  for (const period of periods) {
    const result = calculateCommissionForPeriod(col, totals, period, currentUser);
    detalhes[period] = result;
    totalComissao += result.comissao;
  }
  return { totalComissao, detalhes };
}

/**
 * Retorna a meta (peso) de assinados e ganhos para um colaborador em um período,
 * respeitando a hierarquia do usuário logado.
 */
export function getGoalForCollaborator(
  col: Collaborator | null,
  period: Periodo,
  currentUser: any
): { metaAssinados: number; metaGanhos: number } {
  const { pesoAssinados, pesoGanhos } = getEffectiveWeights(currentUser, col, period);
  return { metaAssinados: pesoAssinados, metaGanhos: pesoGanhos };
}

/**
 * Função de compatibilidade para obter a meta (peso) de um colaborador em um determinado
 * período e tipo (assinados ou ganhos).
 */
export function getCollaboratorMeta(
  collaborator: Collaborator | null,
  period: 'diario' | 'semanal' | 'mensal',
  type: 'assinados' | 'ganhos'
): number {
  if (!collaborator) {
    return type === 'assinados' ? 3 : 3;
  }
  let peso = 0;
  switch (period) {
    case 'diario':
      peso = type === 'assinados' ? collaborator.pesoDiarioAssinados : collaborator.pesoDiarioGanhos;
      break;
    case 'semanal':
      peso = type === 'assinados' ? collaborator.pesoSemanalAssinados : collaborator.pesoSemanalGanhos;
      break;
    case 'mensal':
      peso = type === 'assinados' ? collaborator.pesoMensalAssinados : collaborator.pesoMensalGanhos;
      break;
  }
  return peso || (type === 'assinados' ? 3 : 3);
}