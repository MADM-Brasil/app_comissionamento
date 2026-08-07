// src/lib/diagnostico.ts

// ─── Tipos de domínio integrados ────────────────────────────────
export type FaixaVolume = 'alto' | 'medio_alto' | 'medio_baixo' | 'baixo';

export type NivelConversaoRelativo = 'alta' | 'baixa';

export interface PaceProjecao {
  paceAtual: number;
  paceEsperado: number;
  projecao: number;
  gap: number;
}

export interface DiagnosticoInsumo {
  colaborador: string;
  equipe: string;
  classificacaoOperacional: string;
  mediaPorDia: number;
  assinados: number;
  recebidos: number;
  conversaoAssinadosProtocoladosPct: number;
}

export interface DiagnosticoColaborador {
  colaborador: string;
  equipe: string;
  canal: string;
  mediaPorDia: number;
  conversaoAssinadosProtocoladosPct: number;
  faixaVolume: FaixaVolume;
  nivelConversao: NivelConversaoRelativo | null;
  incluirNoGraficoDispersao: boolean;
  acaoRecomendada: string;
  zeroProducao: boolean;
}

export interface ColaboradorOperacional {
  colaborador: string;
  equipe: string;
  classificacaoOperacional: string;
  mediaPorDia: number;
  recebidos: number;
  emitidos: number;
  assinados: number;
  protocolados: number;
  conversaoGeralPct: number;
  conversaoAssinadosProtocoladosPct: number;
  metaAssinadosMes: number;
  metaAssinadosAtual: number;
  atingAssinadosPct: number;
  gapAssinadosAtual: number;
  gapAssinadosMes: number;
  vendaGanha: number;
  vendaGanhaJudit: number;
  metaProtocolados: number;
  protocoladosJudit: number;
  ganhosProtocoladosPct: number;
  atingProtocoladosPct: number;
  vendaPerdida: number;
  ligacoes: number;
  tabulacoesProdutivas: number;
  tabulacoesImprodutivas: number;
  conversaoLigacoesPct: number;
  tmaSeg: number;
  assinadosJudit: number;
  conversaoJuditPct: number;
}

export interface DivergenciaMeta {
  somaMetasIndividuais: number;
  metaOficial: number;
  divergencia: number;
  divergenciaPct: number;
}

// ─── Motor de diagnóstico (metodologia Leonardo/Sales Ops) ──────
export function classificarFaixaVolume(mediaPorDia: number): FaixaVolume {
  if (mediaPorDia >= 1.9) return 'alto';
  if (mediaPorDia >= 1.5) return 'medio_alto';
  if (mediaPorDia >= 0.8) return 'medio_baixo';
  return 'baixo';
}

export function calcularBenchmarkConversaoPorCanal(
  colaboradores: DiagnosticoInsumo[],
): Record<string, number> {
  const porCanal = new Map<string, number[]>();
  for (const c of colaboradores) {
    if (c.assinados <= 0) continue;
    const lista = porCanal.get(c.classificacaoOperacional) ?? [];
    lista.push(c.conversaoAssinadosProtocoladosPct);
    porCanal.set(c.classificacaoOperacional, lista);
  }

  const benchmark: Record<string, number> = {};
  for (const [canal, valores] of porCanal) {
    benchmark[canal] = mediana(valores);
  }
  return benchmark;
}

function mediana(valores: number[]): number {
  if (valores.length === 0) return 0;
  const ordenado = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  return ordenado.length % 2 === 0
    ? (ordenado[meio - 1] + ordenado[meio]) / 2
    : ordenado[meio];
}

function acaoPorFaixa(
  faixa: FaixaVolume,
  nivelConversao: NivelConversaoRelativo | null,
): string {
  if (faixa === 'baixo')
    return 'Checar histórico dos últimos meses (tendência, não conversão pontual)';
  if (faixa === 'medio_baixo')
    return 'Entender cenário individual — não decidir só pelo número';
  if (faixa === 'medio_alto')
    return nivelConversao === 'baixa'
      ? 'Melhorar conversão assinado → protocolado'
      : 'Entregar mais leads';
  return nivelConversao === 'baixa'
    ? 'Ajustar conversão (perde ritmo do assinado ao protocolo)'
    : 'Manter e escalar ainda mais leads';
}

export function diagnosticarColaborador(
  colaborador: DiagnosticoInsumo,
  benchmarkPorCanal: Record<string, number>,
): DiagnosticoColaborador {
  const faixaVolume = classificarFaixaVolume(colaborador.mediaPorDia);
  const incluirNoGraficoDispersao = faixaVolume !== 'baixo';

  let nivelConversao: NivelConversaoRelativo | null = null;
  if (incluirNoGraficoDispersao) {
    const benchmark =
      benchmarkPorCanal[colaborador.classificacaoOperacional] ?? 0;
    nivelConversao =
      colaborador.conversaoAssinadosProtocoladosPct >= benchmark
        ? 'alta'
        : 'baixa';
  }

  return {
    colaborador: colaborador.colaborador,
    equipe: colaborador.equipe,
    canal: colaborador.classificacaoOperacional,
    mediaPorDia: colaborador.mediaPorDia,
    conversaoAssinadosProtocoladosPct:
      colaborador.conversaoAssinadosProtocoladosPct,
    faixaVolume,
    nivelConversao,
    incluirNoGraficoDispersao,
    acaoRecomendada: acaoPorFaixa(faixaVolume, nivelConversao),
    zeroProducao: colaborador.assinados === 0 && colaborador.recebidos > 0,
  };
}

export function diagnosticarEquipe(
  colaboradores: DiagnosticoInsumo[],
): DiagnosticoColaborador[] {
  const benchmark = calcularBenchmarkConversaoPorCanal(colaboradores);
  return colaboradores.map((c) => diagnosticarColaborador(c, benchmark));
}

export function colaboradoresComZeroProducao<
  T extends Pick<DiagnosticoInsumo, 'assinados' | 'recebidos'>,
>(colaboradores: T[]): T[] {
  return colaboradores.filter(
    (c) => c.assinados === 0 && c.recebidos > 0,
  );
}

export function calcularPaceProjecao(
  realizado: number,
  meta: number,
  diasUteisDecorridos: number,
  diasUteisTotais: number,
): PaceProjecao {
  const paceAtual =
    diasUteisDecorridos > 0 ? realizado / diasUteisDecorridos : 0;
  const paceEsperado =
    diasUteisTotais > 0 ? meta / diasUteisTotais : 0;
  const projecao = paceAtual * diasUteisTotais;
  const gap = projecao - meta;

  return { paceAtual, paceEsperado, projecao, gap };
}

export function verificarDivergenciaMeta(
  colaboradores: ColaboradorOperacional[],
  metaOficial: number,
): DivergenciaMeta {
  const somaMetasIndividuais = colaboradores.reduce(
    (acc, c) => acc + c.metaAssinadosMes,
    0,
  );
  const divergencia = somaMetasIndividuais - metaOficial;
  const divergenciaPct =
    metaOficial > 0 ? (divergencia / metaOficial) * 100 : 0;

  return {
    somaMetasIndividuais,
    metaOficial,
    divergencia,
    divergenciaPct,
  };
}