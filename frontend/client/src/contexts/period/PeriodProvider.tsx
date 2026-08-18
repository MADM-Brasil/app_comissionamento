// src/contexts/period/PeriodProvider.tsx
import { ReactNode, useState, useMemo } from 'react';
import { Period, PeriodContext } from './PeriodContext';

function getDateRangeForPeriod(
  period: Period,
  customStart?: string,
  customEnd?: string
): { start: string; end: string } {
  // Para Custom, usamos as datas exatamente como o usuário informou (inclusive)
  if (period === 'Custom' && customStart && customEnd) {
    return { start: customStart, end: customEnd };
  }

  const now = new Date();
  let start: Date, end: Date;

  if (period === 'Hoje') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = new Date(start);
  } else if (period === 'Semana') {
    const day = now.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    start = monday;
    end = friday;
  } else {
    // Mês
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0); // último dia do mês
  }

  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [period, setPeriodState] = useState<Period>('Mês');
  const [customStartDate, setCustomStartDate] = useState<string>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  });
  const [customEndDate, setCustomEndDate] = useState<string>(() => {
    const now = new Date();
    // último dia do mês atual
    return new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  });

  const setPeriod = (newPeriod: Period) => {
    console.log('🔁 PeriodProvider.setPeriod:', newPeriod);
    if (newPeriod === 'Custom') {
      setPeriodState('Custom');
    } else {
      const { start, end } = getDateRangeForPeriod(newPeriod);
      console.log('📅 Datas calculadas (inclusivas):', { start, end });
      setCustomStartDate(start);
      setCustomEndDate(end);
      setPeriodState(newPeriod);
    }
  };

  const setCustomDateRange = (start: string, end: string) => {
    console.log('📅 setCustomDateRange:', { start, end });
    // NÃO adianta a data final; mantém exatamente a escolha do usuário
    setCustomStartDate(start);
    setCustomEndDate(end);
    setPeriodState('Custom');
  };

  const { start: currentStartDate, end: currentEndDate } = useMemo(
    () => getDateRangeForPeriod(period, customStartDate, customEndDate),
    [period, customStartDate, customEndDate]
  );

  console.log('📅 Período atual:', { period, currentStartDate, currentEndDate });

  return (
    <PeriodContext.Provider
      value={{
        period,
        setPeriod,
        customStartDate,
        customEndDate,
        setCustomDateRange,
        currentStartDate,
        currentEndDate,
      }}
    >
      {children}
    </PeriodContext.Provider>
  );
}