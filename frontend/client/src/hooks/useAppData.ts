// src/hooks/useAppData.ts
import { useAppStore } from "@/lib/dataStore";
import { useCallback, useEffect, useRef } from "react";

export function useAppData() {
  const {
    collaborators,
    equipeConfigs,
    currentUser,
    rawMetrics,
    ranking,
    loadCollaboratorsAndMetrics,
    loadRawMetrics,
    loadWeeklyPerformanceData,
  } = useAppStore();

  const initialLoadDone = useRef(false);

  const refresh = useCallback(async () => {
    await Promise.all([
      loadCollaboratorsAndMetrics(),
      loadRawMetrics(),
      loadWeeklyPerformanceData(),
    ]);
  }, [loadCollaboratorsAndMetrics, loadRawMetrics, loadWeeklyPerformanceData]);

  // Carregamento inicial único
  useEffect(() => {
    if (!initialLoadDone.current && currentUser) {
      refresh();
      initialLoadDone.current = true;
    }
  }, [currentUser, refresh]);

  return {
    collaborators,
    equipeConfigs,
    currentUser,
    rawMetrics,
    ranking,
    refresh,
    isLoaded: initialLoadDone.current,
  };
}