export interface PeriodoCalendario {
  inicio: string;
  fim: string;
}

export function contarDiasUteis(periodo: { inicio: string; fim: string }): number {
  if (!periodo?.inicio || !periodo?.fim) return 0;

  const inicio = new Date(periodo.inicio);
  const fim = new Date(periodo.fim);
  let dias = 0;

  const cursor = new Date(inicio);
  while (cursor <= fim) {
    const dia = cursor.getDay();
    if (dia !== 0 && dia !== 6) dias += 1;
    cursor.setDate(cursor.getDate() + 1);
  }

  return dias;
}

export function getPeriodoMesDoCalendario(dataReferencia: string): PeriodoCalendario {
  const data = new Date(dataReferencia);
  const inicio = new Date(data.getFullYear(), data.getMonth(), 1);
  const fim = new Date(data.getFullYear(), data.getMonth() + 1, 0);

  return {
    inicio: inicio.toISOString().slice(0, 10),
    fim: fim.toISOString().slice(0, 10),
  };
}
