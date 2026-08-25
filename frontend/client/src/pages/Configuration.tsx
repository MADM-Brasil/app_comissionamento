// src/pages/Configuration.tsx
import React, { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import {
  Search, Filter, Users, Award, FileText, CheckCircle, XCircle,
  Edit2, Save, X, ChevronDown, ChevronUp, Settings, Briefcase, User, Archive,
  CalendarPlus, Calendar, RefreshCw, AlertTriangle, Megaphone,
  Eye, EyeOff, Check, X as XIcon,
} from "lucide-react";
import { useAppStore } from "@/lib/dataStore";
import {
  fetchCollaborators, fetchEquipes, API_BASE
} from "@/lib/api";
import {
  fetchEmitidos, fetchAssinados, fetchGanhos, fetchPerdidos, fetchProtocolados
} from "@/lib/metrics";
import { recalculateHierarchyWeights } from "@/lib/metrics";
import { useAccessControl } from "@/hooks/useAccessControl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { calculator } from "@/lib/calculator";

const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing',
  'Equipe Ariana', 'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda',
  'Equipe Reciclagem',''
];

const isExcludedTeam = (teamName: string) => EXCLUDED_TEAMS.includes(teamName);
type CicloPeriodo = 'diario' | 'semanal' | 'mensal';

const PRODUCT_OPTIONS = ["Todos", "Auxilio Acidente", "Quinquenio", "Concomitante"];

const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

const normalize = (str: string): string =>
  (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ✅ Função para normalizar cargos (remove acentos, minúsculas)
const normalizeRole = (str: string): string =>
  (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ✅ Função para obter a data de hoje no formato YYYY-MM-DD
const getTodayString = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

function formatMonthYear(dateStr: string): string {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '--';
  const [year, month] = dateStr.split('-');
  const months = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const idx = parseInt(month, 10) - 1;
  if (idx < 0 || idx > 11) return '--';
  return `${months[idx]} ${year}`;
}

export default function Configuration() {
  const [, navigate] = useLocation();
  const {
    currentStartDate, currentEndDate, collaborators, globalConfig,
    updateGlobalConfig, setCollaborators, equipeConfigs, setEquipeConfigs,
    loadMetricsForPeriod, hideValues, currentUser,
  } = useAppStore();

  const { getAccessLevel, LEVELS } = useAccessControl();
  const userLevel = getAccessLevel();

  //Determinação de permissões baseada no cargo/nível
  const normalizedCargo = normalizeRole(currentUser?.cargo || '');

  const isSuperAdmin =
    normalizedCargo === 'desenvoldor' ||
    normalizedCargo === 'superadmin' ||
    normalizedCargo === 'ceo' ||
    normalizedCargo === 'diretoria' ||
    userLevel === LEVELS.SUPER_ADMIN;

  const isCoordenador =
    normalizedCargo.includes('coordenador') ||
    normalizedCargo.includes('coordenadora') ||
    userLevel === LEVELS.COORDENADOR;

  const isAdministrativo =
    normalizedCargo.includes('administrativo') ||
    userLevel === LEVELS.ADMINISTRATIVO;

  const isSupervisor =
    normalizedCargo.includes('supervisor') ||
    userLevel === LEVELS.SUPERVISAO;

  const isAssessor = !(isSuperAdmin || isCoordenador || isAdministrativo || isSupervisor);

  // ✅ Acesso à página: todos exceto assessores
  // Enquanto o currentUser não está carregado, permitimos (evita redirecionamento prematuro)
  const canAccessConfig = currentUser ? !isAssessor : true;

  // ✅ Permissão de edição: coordenadores, administrativos e super admins
  const canEditConfig = isSuperAdmin || isCoordenador || isAdministrativo;
  const canEditBonus = canEditConfig;
  const canGenerateNextMonth = isSuperAdmin;

  // ✅ Registro de campanhas: coordenadores, administrativos e super admins (não supervisores)
  const canRegisterCampanha = isSuperAdmin || isCoordenador || isAdministrativo;

  const isAdminOnly = canEditConfig;

  useEffect(() => {
    if (currentUser && !canAccessConfig) {
      navigate("/");
    }
  }, [currentUser, canAccessConfig, navigate]);

  // ========== ESTADOS ==========
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedEquipe, setSelectedEquipe] = useState("Todas");
  const [selectedPeriod, setSelectedPeriod] = useState<CicloPeriodo>('mensal');
  const [periodoTabela, setPeriodoTabela] = useState<CicloPeriodo>('mensal');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    pesoAssinados?: number;
    pesoGanhos?: number;
    metaGolsAssinados?: number;
    metaGolsGanhos?: number;
  }>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState(false);

  const [configTab, setConfigTab] = useState<'global' | 'equipes'>('global');

  const [teamSelected, setTeamSelected] = useState<string>("");
  const [teamPeriod, setTeamPeriod] = useState<CicloPeriodo>('mensal');
  const [teamPesoAssinados, setTeamPesoAssinados] = useState<number>(60);
  const [teamPesoGanhos, setTeamPesoGanhos] = useState<number>(60);
  const [teamMetaGolsAssinados, setTeamMetaGolsAssinados] = useState<number>(20);
  const [teamMetaGolsGanhos, setTeamMetaGolsGanhos] = useState<number>(20);
  const [teamBonus, setTeamBonus] = useState<number>(150);

  const [campanhaCategoria, setCampanhaCategoria] = useState<string>("outros");
  const [campanhaMultiplicador, setCampanhaMultiplicador] = useState<number>(2.0);
  const [campanhaProduto, setCampanhaProduto] = useState<string>("Todos");
  const [campanhaDescricao, setCampanhaDescricao] = useState<string>("");

  const [mostrarCampanhas, setMostrarCampanhas] = useState(false);
  const [campanhasRegistradas, setCampanhasRegistradas] = useState<Array<{
    tipo: string;
    multiplicador: number;
    produto: string;
    data_publicacao: string;
    descricao: string;
    validacao_financeiro: boolean;
  }>>([]);
  const [loadingCampanhas, setLoadingCampanhas] = useState(false);

  // ✅ Estados do filtro de data com padrão na data atual
  const [filterCampanhaDataInicio, setFilterCampanhaDataInicio] = useState(getTodayString());
  const [filterCampanhaDataFim, setFilterCampanhaDataFim] = useState(getTodayString());

  const isAssinados = campanhaCategoria === "Assinados";
  // Quando a categoria muda para Assinados, ajusta o multiplicador para 1 (proporção padrão)
  useEffect(() => {
    if (isAssinados) {
      setCampanhaMultiplicador(1);
    } else {
      // Se for Gols ou outros, mantém 2.0 como padrão (caso esteja em 1)
      if (campanhaMultiplicador === 1) {
        setCampanhaMultiplicador(2.0);
      }
    }
  }, [campanhaCategoria]);

  // ---------- CONTROLE DE MÊS ----------
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  const currentMonthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [selectedMonth, setSelectedMonth] = useState<string>(`${currentMonthPrefix}-01`);
  const [availableMonths, setAvailableMonths] = useState<string[]>([]);
  const [loadingMonths, setLoadingMonths] = useState(false);
  const [monthsError, setMonthsError] = useState(false);

  const selectedMonthPrefix = selectedMonth.substring(0, 7);
  const isCurrentMonth = selectedMonthPrefix === currentMonthPrefix;
  const isPastMonth = selectedMonthPrefix < currentMonthPrefix;
  const isLocked = isPastMonth || (isCurrentMonth && now.getDate() >= 25);

  const nextMonthDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonthStr = nextMonthDate.toISOString().slice(0, 10);
  const isNextMonthGenerated = availableMonths.includes(nextMonthStr);

  const isEditable = canEditConfig && !isLocked;
  const isBonusEditable = canEditBonus && !isLocked;
  const isAllDisabled = !canEditConfig || isLocked;

  const collaboratorsCache = useRef<Map<string, any[]>>(new Map());

  // ========== API MESES ==========
  const refreshMonths = async () => {
    setLoadingMonths(true);
    setMonthsError(false);
    try {
      const res = await fetch(`${API_BASE}/admin/months`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const data = await res.json();
      if (data.success) {
        const months = data.data;
        if (months.length > 0) {
          setAvailableMonths(months);
          if (!months.includes(selectedMonth)) {
            const currentMonthFull = months.find((m: string) => m.startsWith(currentMonthPrefix));
            if (currentMonthFull) setSelectedMonth(currentMonthFull);
            else setSelectedMonth(months[0]);
          }
        } else {
          setAvailableMonths([]);
          toast.warning('Nenhum mês encontrado no banco.');
        }
      }
    } catch (err: any) {
      console.error('Erro ao carregar meses:', err);
      setMonthsError(true);
      toast.error(`Falha ao carregar meses: ${err.message}`);
    } finally {
      setLoadingMonths(false);
    }
  };

  useEffect(() => { refreshMonths(); }, []);
  useEffect(() => { if (!monthsError) refreshMonths(); }, [selectedMonth]);

  // ========== CARREGAMENTO DE COLABORADORES E MÉTRICAS DO MÊS ==========
  const loadCollaboratorsForMonth = async (month: string) => {
    if (!month || !/^\d{4}-\d{2}-\d{2}$/.test(month)) return;

    if (collaboratorsCache.current.has(month)) {
      const cached = collaboratorsCache.current.get(month)!;
      setCollaborators(cached);
      return;
    }

    const mesParam = `?mes=${month.substring(0, 7)}`;
    try {
      const collabs = await fetchCollaborators(mesParam);
      const uniqueMap = new Map();
      collabs.forEach((c: any) => {
        const key = c.id || c.email;
        if (!uniqueMap.has(key)) uniqueMap.set(key, c);
      });
      const uniqueCollabs = Array.from(uniqueMap.values());

      // Normaliza campos de meta de gols
      uniqueCollabs.forEach((c: any) => {
        c.metaGolsAssinados = c.meta_gols_assinados ?? c.metaGolsAssinados ?? 20;
        c.metaGolsGanhos = c.meta_gols_ganhos ?? c.metaGolsGanhos ?? 20;
      });

      // Carrega métricas do mês selecionado
      const start = month;
      const year = parseInt(month.substring(0, 4), 10);
      const monthIdx = parseInt(month.substring(5, 7), 10) - 1;
      const lastDay = new Date(year, monthIdx + 1, 0).getDate();
      const end = `${month.substring(0, 7)}-${String(lastDay).padStart(2, '0')}`;

      // Totais
      const [emitidos, assinados, ganhos, perdidos, protocolados] = await Promise.all([
        fetchEmitidos({ start, end }),
        fetchAssinados({ start, end }),
        fetchGanhos({ start, end }),
        fetchPerdidos({ start, end }),
        fetchProtocolados({ start, end }),
      ]);

      // Dados diários para calcular Gols
      const [dailyAssinados, dailyGanhos] = await Promise.all([
        fetchAssinados({ start, end, granularity: 'daily' }),
        fetchGanhos({ start, end, granularity: 'daily' }),
      ]);

      // Mapa de totais por colaborador
      const metricsMap = new Map<string, { emitidos: number; assinados: number; ganhos: number; perdidos: number; protocolados: number }>();
      const aggregate = (data: any[], key: 'emitidos' | 'assinados' | 'ganhos' | 'perdidos' | 'protocolados') => {
        data.forEach((item: any) => {
          const name = normalize(item.colaborador);
          if (!name) return;
          if (!metricsMap.has(name)) {
            metricsMap.set(name, { emitidos: 0, assinados: 0, ganhos: 0, perdidos: 0, protocolados: 0 });
          }
          const entry = metricsMap.get(name)!;
          entry[key] += Number(item.total) || 0;
        });
      };
      aggregate(emitidos, 'emitidos');
      aggregate(assinados, 'assinados');
      aggregate(ganhos, 'ganhos');
      aggregate(perdidos, 'perdidos');
      aggregate(protocolados, 'protocolados');

      // Mapa de dados diários por colaborador
      const dailyMap = new Map<string, Map<string, { assinados: number; ganhos: number }>>();
      const processDaily = (data: any[], key: 'assinados' | 'ganhos') => {
        data.forEach((item: any) => {
          const name = normalize(item.colaborador);
          const date = (item.periodo || item.data || '').slice(0, 10);
          if (!name || !date) return;
          if (!dailyMap.has(name)) dailyMap.set(name, new Map());
          const dayMap = dailyMap.get(name)!;
          if (!dayMap.has(date)) dayMap.set(date, { assinados: 0, ganhos: 0 });
          dayMap.get(date)![key] += Number(item.total) || 0;
        });
      };
      processDaily(dailyAssinados, 'assinados');
      processDaily(dailyGanhos, 'ganhos');

      // Atualiza colaboradores com métricas e total de gols
      uniqueCollabs.forEach((c: any) => {
        const name = normalize(c.name);
        const metrics = metricsMap.get(name) || { emitidos: 0, assinados: 0, ganhos: 0, perdidos: 0, protocolados: 0 };
        c.emitidos = metrics.emitidos;
        c.assinados = metrics.assinados;
        c.ganhos = metrics.ganhos;
        c.perdidos = metrics.perdidos;
        c.protocolados = metrics.protocolados;

        // Calcula gols diários
        const dailyData = dailyMap.get(name);
        if (dailyData) {
          const dias = Array.from(dailyData.keys()).sort();
          const dailyArray = dias.map(date => ({
            date,
            assinados: dailyData.get(date)!.assinados,
            ganhos: dailyData.get(date)!.ganhos,
          }));
          const golsResult = calculator.calculateDailyGoals(
            dailyArray,
            c.metaGolsAssinados ?? 3,
            c.metaGolsGanhos ?? 3
          );
          c.totalGols = golsResult.totalGols;
        } else {
          c.totalGols = 0;
        }
      });

      collaboratorsCache.current.set(month, uniqueCollabs);
      setCollaborators(uniqueCollabs);
      if (uniqueCollabs.length === 0) toast.warning('Nenhum colaborador encontrado para este mês.');
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    }
  };

  useEffect(() => {
    if (selectedMonth) loadCollaboratorsForMonth(selectedMonth);
  }, [selectedMonth]);

  // ========== CARREGAMENTO DE EQUIPES (uma vez) ==========
  const equipesLoaded = useRef(false);
  useEffect(() => {
    if (equipesLoaded.current) return;
    const loadBaseData = async () => {
      try {
        const equipes = await fetchEquipes();
        setEquipeConfigs(equipes.map((eq: any) => ({
          id: eq.id ? eq.id.toString() : `equipe_${Math.random()}`,
          nome: eq.nome || 'Equipe sem nome',
          pesoAssinados: 3, pesoGanhos: 3,
          pesoequipeAssinados: 0, pesoequipeGanhos: 0, bonus: 150,
          metaGolsAssinados: 20, metaGolsGanhos: 20,
        })));
        equipesLoaded.current = true;
      } catch (error: any) {
        if (error.message?.includes('401')) window.location.href = '/login';
        else toast.error(`Falha ao carregar dados base: ${error.message}`);
      }
    };
    loadBaseData();
  }, [setEquipeConfigs]);

  // ========== LISTAS ==========
  const filteredEquipeConfigs = useMemo(() => equipeConfigs.filter(e => !isExcludedTeam(e.nome)), [equipeConfigs]);
  const equipeNomes = useMemo(() => ["Todas", ...filteredEquipeConfigs.map(e => e.nome)], [filteredEquipeConfigs]);

  useEffect(() => {
    if (filteredEquipeConfigs.length && !teamSelected) {
      setTeamSelected(filteredEquipeConfigs[0].nome);
    }
  }, [filteredEquipeConfigs, teamSelected]);

  useEffect(() => {
    if (!teamSelected) return;
    const equipe = equipeConfigs.find(e => e.nome === teamSelected);
    if (equipe) {
      setTeamPesoAssinados(equipe.pesoAssinados ?? 3);
      setTeamPesoGanhos(equipe.pesoGanhos ?? 3);
      setTeamMetaGolsAssinados((equipe as any).metaGolsAssinados ?? 20);
      setTeamMetaGolsGanhos((equipe as any).metaGolsGanhos ?? 20);
      setTeamBonus(equipe.bonus ?? 150);
    }
  }, [teamSelected, equipeConfigs]);

  const filteredCollaborators = useMemo(() => {
    return collaborators.filter(c => {
      if (isExcludedTeam(c.equipeNome)) return false;
      if (selectedEquipe !== "Todas" && c.equipeNome !== selectedEquipe) return false;
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        return c.name.toLowerCase().includes(term) || (c.email || '').toLowerCase().includes(term);
      }
      return true;
    });
  }, [collaborators, searchTerm, selectedEquipe]);

  const totalStats = {
    totalColaboradores: filteredCollaborators.length,
    ativos: filteredCollaborators.filter(c => c.status === "ativo").length,
  };

  // ========== FUNÇÕES AUXILIARES ==========
  const getPesoForPeriod = (collab: any, periodo: CicloPeriodo) => {
    switch (periodo) {
      case 'diario': 
        return { 
          assinados: Number(collab.pesoDiarioAssinados ?? collab.metaDiarioAssinados ?? 3), 
          ganhos: Number(collab.pesoDiarioGanhos ?? collab.metaDiarioGanhos ?? 3) 
        };
      case 'semanal': 
        return { 
          assinados: Number(collab.pesoSemanalAssinados ?? collab.metaSemanalAssinados ?? 15), 
          ganhos: Number(collab.pesoSemanalGanhos ?? collab.metaSemanalGanhos ?? 15) 
        };
      default: 
        return { 
          assinados: Number(collab.pesoMensalAssinados ?? collab.metaMensalAssinados ?? 60), 
          ganhos: Number(collab.pesoMensalGanhos ?? collab.metaMensalGanhos ?? 60) 
        };
    }
  };

  const getMetaGolsForPeriod = (collab: any) => {
    return {
      assinados: Number(collab.metaGolsAssinados ?? collab.meta_gols_assinados ?? 20),
      ganhos: Number(collab.metaGolsGanhos ?? collab.meta_gols_ganhos ?? 20),
    };
  };

  const toggleExpand = (id: string) => setExpandedId(prev => (prev === id ? null : id));

  const isIndividualEditable = (collab: any) => {
    if (isAdminOnly) return isEditable;
    return isEditable && collab.cargo !== 'Supervisor' && collab.cargo !== 'Coordenador' && collab.cargo !== 'Administrativo';
  };

  // ========== CSRF ==========
  const getCsrfHeaders = async (): Promise<HeadersInit> => {
    let token = localStorage.getItem('csrfToken');
    if (!token || token === 'null' || token === 'undefined') {
      try {
        const res = await fetch(`${API_BASE}/csrf-token`, { credentials: 'include' });
        const data = await res.json();
        if (data.csrfToken && data.csrfToken !== 'disabled') {
          token = data.csrfToken;
          if (token) localStorage.setItem('csrfToken', token);
        } else {
          token = null;
        }
      } catch (err) {
        console.error('Não foi possível obter token CSRF:', err);
        token = null;
      }
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token && typeof token === 'string') {
      headers['x-csrf-token'] = token;
    }
    return headers;
  };

  // ========== SALVAMENTOS ==========
  const saveGlobalConfig = async () => {
    if (!isEditable) return;
    try {
      let pesoAssinados = 60, pesoGanhos = 60;
      if (selectedPeriod === 'diario') {
        pesoAssinados = Number(globalConfig.pesoDiarioAssinados);
        pesoGanhos = Number(globalConfig.pesoDiarioGanhos);
      } else if (selectedPeriod === 'semanal') {
        pesoAssinados = Number(globalConfig.pesoSemanalAssinados);
        pesoGanhos = Number(globalConfig.pesoSemanalGanhos);
      } else {
        pesoAssinados = Number(globalConfig.pesoMensalAssinados);
        pesoGanhos = Number(globalConfig.pesoMensalGanhos);
      }
      const body = {
        periodo: selectedPeriod,
        peso_assinados: pesoAssinados,
        peso_ganhos: pesoGanhos,
        meta_gols_assinados: 20,
        meta_gols_ganhos: 20,
        bonus: Number(globalConfig.valorBonus),
        data_metrica: selectedMonth,
      };
      const headers = await getCsrfHeaders();
      const res = await fetch(`${API_BASE}/admin/update-all-assessors-metrics`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Metas ${selectedPeriod} globais aplicadas!`);
        collaboratorsCache.current.delete(selectedMonth);
        await loadCollaboratorsForMonth(selectedMonth);
      } else toast.error(data.error || 'Erro ao salvar');
    } catch { toast.error('Erro de conexão'); }
  };

  const saveTeamMetrics = async () => {
    if (!teamSelected || !isEditable) return;
    const body = {
      equipe: teamSelected.trim(),
      periodo: teamPeriod,
      peso_assinados: Number(teamPesoAssinados),
      peso_ganhos: Number(teamPesoGanhos),
      meta_gols_assinados: Number(teamMetaGolsAssinados),
      meta_gols_ganhos: Number(teamMetaGolsGanhos),
      bonus: Number(teamBonus),
      data_metrica: selectedMonth,
    };
    try {
      const headers = await getCsrfHeaders();
      const res = await fetch(`${API_BASE}/admin/update-team-metrics`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        credentials: "include",
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Metas ${teamPeriod} da equipe ${teamSelected} atualizadas!`);
        collaboratorsCache.current.delete(selectedMonth);
        await loadCollaboratorsForMonth(selectedMonth);
      } else toast.error(data.error || "Erro ao salvar");
    } catch (err) {
      console.error("Erro ao salvar metas da equipe:", err);
      toast.error("Erro de conexão");
    }
  };

  const saveRow = async (id: string) => {
    const collab = collaborators.find(c => c.id === id);
    if (!collab || !isEditable) return;
    setSavingId(id);

    const payload: any = {
      email: collab.email || collab.id,
      data_metrica: selectedMonth,
    };

    if (periodoTabela === 'diario') {
      if (editForm.pesoAssinados !== undefined) payload.meta_diario_assinados = Number(editForm.pesoAssinados);
      if (editForm.pesoGanhos !== undefined) payload.meta_diario_ganhos = Number(editForm.pesoGanhos);
    } else if (periodoTabela === 'semanal') {
      if (editForm.pesoAssinados !== undefined) payload.meta_semanal_assinados = Number(editForm.pesoAssinados);
      if (editForm.pesoGanhos !== undefined) payload.meta_semanal_ganhos = Number(editForm.pesoGanhos);
    } else {
      if (editForm.pesoAssinados !== undefined) payload.meta_mensal_assinados = Number(editForm.pesoAssinados);
      if (editForm.pesoGanhos !== undefined) payload.meta_mensal_ganhos = Number(editForm.pesoGanhos);
    }

    if (editForm.metaGolsAssinados !== undefined) payload.meta_gols_assinados = Number(editForm.metaGolsAssinados);
    if (editForm.metaGolsGanhos !== undefined) payload.meta_gols_ganhos = Number(editForm.metaGolsGanhos);

    console.log('📤 [saveRow] Payload:', payload);

    try {
      const headers = await getCsrfHeaders();
      const res = await fetch(`${API_BASE}/admin/update-assessor-metrics`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Dados de ${collab.name} atualizados!`);
        collaboratorsCache.current.delete(selectedMonth);
        await loadCollaboratorsForMonth(selectedMonth);
      } else {
        toast.error(data.error || 'Erro ao salvar');
        console.error('❌ Erro do backend:', data);
      }
    } catch (err) {
      console.error(err);
      toast.error('Erro de conexão com o servidor');
    } finally {
      setSavingId(null);
      setEditingId(null);
      setEditForm({});
    }
  };

  const startEditRow = (collab: any) => {
    if (!isIndividualEditable(collab)) return;
    const peso = getPesoForPeriod(collab, periodoTabela);
    const metaGols = getMetaGolsForPeriod(collab);
    setEditingId(collab.id);
    setEditForm({
      pesoAssinados: peso.assinados,
      pesoGanhos: peso.ganhos,
      metaGolsAssinados: metaGols.assinados,
      metaGolsGanhos: metaGols.ganhos,
    });
  };

  const cancelEditRow = () => {
    setEditingId(null);
    setEditForm({});
  };

  const generateNextMonth = async () => {
    try {
      const headers = await getCsrfHeaders();
      const res = await fetch(`${API_BASE}/admin/generate-next-month`, {
        method: 'POST',
        headers,
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        await refreshMonths();
        setSelectedMonth(nextMonthStr);
      } else toast.error(data.error || 'Erro ao gerar próximo mês');
    } catch { toast.error('Erro de conexão'); }
  };

  const handleRecalculateHierarchy = async () => {
    if (!isAdminOnly) return;
    setRecalculating(true);
    try {
      const result = await recalculateHierarchyWeights();
      toast.success(result.message || 'Hierarquia recalculada com sucesso!');
      collaboratorsCache.current.delete(selectedMonth);
      await loadCollaboratorsForMonth(selectedMonth);
    } catch (err: any) {
      toast.error(err.message || 'Erro ao recalcular hierarquia');
    } finally {
      setRecalculating(false);
    }
  };

  // ========== CAMPANHA COMERCIAL ==========
  const loadCampanhas = async () => {
    setLoadingCampanhas(true);
    try {
      const mes = selectedMonth.substring(0, 7);
      const res = await fetch(`${API_BASE}/campanhas?mes=${mes}`, { credentials: 'include' });
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        setCampanhasRegistradas(data.data.map((c: any) => ({
          tipo: c.tipo,
          multiplicador: Number(c.multiplicador),
          produto: c.produto || 'Todos',
          data_publicacao: c.data_publicacao,
          descricao: c.descricao,
          validacao_financeiro: Boolean(c.validacao_financeiro),
        })));
      } else if (!res.ok) {
        throw new Error(data.error || 'Erro ao carregar campanhas');
      }
    } catch (err: any) {
      toast.error(`Falha ao carregar campanhas: ${err.message}`);
    } finally {
      setLoadingCampanhas(false);
    }
  };

  useEffect(() => {
    if (selectedMonth) {
      loadCampanhas();
    }
  }, [selectedMonth]);

  const handleRegistrarCampanha = async () => {
    try {
      const headers = await getCsrfHeaders();
      const body = {
        tipo: campanhaCategoria,
        multiplicador: campanhaMultiplicador,
        produto: campanhaProduto,
        data_publicacao: new Date().toISOString().slice(0, 10),
        descricao: campanhaDescricao || 'Sem descrição',
      };

      const res = await fetch(`${API_BASE}/campanhas`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        toast.success('Campanha registrada com sucesso!');
        setCampanhaDescricao('');
        await loadCampanhas();
      } else {
        throw new Error(data.error || 'Erro ao registrar campanha');
      }
    } catch (err: any) {
      toast.error(`Falha ao registrar: ${err.message}`);
    }
  };

  const handleAprovarCampanha = async (camp: any) => {
    if (!isSuperAdmin) {
      toast.error('Apenas super administradores podem aprovar campanhas.');
      return;
    }
    try {
      const headers = await getCsrfHeaders();
      const res = await fetch(`${API_BASE}/campanhas/validacao`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          tipo: camp.tipo,
          data_publicacao: camp.data_publicacao,
          produto: camp.produto,
          validacao_financeiro: true,
        }),
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        toast.success('Campanha aprovada!');
        await loadCampanhas();
      } else {
        throw new Error(data.error || 'Erro ao aprovar');
      }
    } catch (err: any) {
      toast.error(`Falha ao aprovar: ${err.message}`);
    }
  };

  const handleRejeitarCampanha = async (camp: any) => {
    if (!isSuperAdmin) {
      toast.error('Apenas super administradores podem rejeitar campanhas.');
      return;
    }
    try {
      const headers = await getCsrfHeaders();
      const res = await fetch(`${API_BASE}/campanhas/validacao`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          tipo: camp.tipo,
          data_publicacao: camp.data_publicacao,
          produto: camp.produto,
          validacao_financeiro: false,
        }),
        credentials: 'include',
      });
      const data = await res.json();
      if (data.success) {
        toast.info('Campanha rejeitada.');
        await loadCampanhas();
      } else {
        throw new Error(data.error || 'Erro ao rejeitar');
      }
    } catch (err: any) {
      toast.error(`Falha ao rejeitar: ${err.message}`);
    }
  };

  // ✅ Filtro de campanhas por data
  const filteredCampanhas = useMemo(() => {
    return campanhasRegistradas.filter(camp => {
      if (filterCampanhaDataInicio && camp.data_publicacao < filterCampanhaDataInicio) return false;
      if (filterCampanhaDataFim && camp.data_publicacao > filterCampanhaDataFim) return false;
      return true;
    });
  }, [campanhasRegistradas, filterCampanhaDataInicio, filterCampanhaDataFim]);

  // ========== RENDER ==========
  return (
    <DashboardLayout title="Configurações" subtitle="Gerencie metas e pesos do sistema">
      <div className="space-y-6">
        {/* AVISO DE BLOQUEIO + BOTÃO GERAR PRÓXIMO MÊS */}
        {isLocked && (
          <div className="alert-banner warning">
            <CalendarPlus className="w-5 h-5 text-[#EA8C1D] mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-bold text-[#0f172a]">Período de fechamento</p>
              <p className="text-xs text-[#64748b] mt-1">
                {isPastMonth
                  ? 'Este mês já foi encerrado e não pode ser alterado.'
                  : `De 25/${now.getMonth() + 1} até ${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}/${now.getMonth() + 1} as alterações estão bloqueadas.`}
              </p>
            </div>
            <div className="flex-shrink-0">
              {canGenerateNextMonth && (
                <button onClick={generateNextMonth}
                  disabled={isNextMonthGenerated}
                  className={cn("px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 transition-colors",
                    isNextMonthGenerated ? "bg-gray-200 text-gray-500 cursor-not-allowed" : "bg-[#16A34A] text-white hover:bg-[#16A34A]/90")}
                  aria-label={isNextMonthGenerated ? "Próximo mês já foi gerado" : "Gerar registros do próximo mês"}
                >
                  <CalendarPlus className="w-4 h-4" />
                  {isNextMonthGenerated ? "Próximo mês já gerado" : "Gerar próximo mês"}
                </button>
              )}
            </div>
          </div>
        )}

        {/* SELETOR DE MÊS */}
        <div className="card flex items-center gap-4 p-4">
          <Calendar className="w-5 h-5 text-[#2F6FED]" />
          <label htmlFor="monthSelect" className="text-sm font-semibold text-[#0f172a]">Mês de referência:</label>
          <select id="monthSelect" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-[#e2e8f0] bg-white focus:outline-none focus:ring-2 focus:ring-[#2F6FED]/20"
            aria-label="Selecione o mês de referência">
            {availableMonths.length > 0
              ? availableMonths.map(m => <option key={m} value={m}>{formatMonthYear(m)}</option>)
              : <option value={`${currentMonthPrefix}-01`}>{formatMonthYear(`${currentMonthPrefix}-01`)}</option>}
          </select>
          <button onClick={refreshMonths} disabled={loadingMonths}
            className="p-2 text-[#64748b] hover:text-[#2F6FED] transition-colors"
            aria-label="Atualizar lista de meses">
            <RefreshCw className={cn("w-4 h-4", loadingMonths && "animate-spin")} />
          </button>
          {monthsError && (
            <div className="flex items-center gap-1 text-xs text-red-600">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Erro ao carregar meses</span>
            </div>
          )}
          {isLocked && <span className="badge warning">Bloqueado</span>}
        </div>

        {/* CARD: REGISTRAR CAMPANHA COMERCIAL (coordenador, administrativo e super admin) */}
        {canRegisterCampanha && (
          <div className="card">
            <div className="px-5 py-3 border-b border-[#e2e8f0] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Megaphone className="w-4 h-4 text-[#EA8C1D]" />
                <h3 className="text-sm font-bold text-[#0f172a]">Registrar Campanha Comercial</h3>
              </div>
              <button
                onClick={() => setMostrarCampanhas(!mostrarCampanhas)}
                className="flex items-center gap-1 text-xs font-medium text-[#64748b] hover:text-[#0f172a] transition-colors"
              >
                {mostrarCampanhas ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                {mostrarCampanhas ? "Ocultar campanhas" : "Ver campanhas registradas"}
                <span className="ml-1 bg-[#f1f5f9] px-1.5 py-0.5 rounded-full text-[10px]">
                  {campanhasRegistradas.length}
                </span>
              </button>
            </div>

            <div className="p-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="campanhaCategoria" className="block text-xs font-medium text-[#64748b] mb-1">
                    Categoria
                  </label>
                  <select
                    id="campanhaCategoria"
                    value={campanhaCategoria}
                    onChange={(e) => setCampanhaCategoria(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-[#e2e8f0] bg-white focus:outline-none focus:ring-2 focus:ring-[#2F6FED]/20"
                  >
                    <option value="outros">Outros</option>
                    <option value="Gols">Gols</option>
                    <option value="Assinados">Assinados</option>
                  </select>
                </div>
                <div>
  <label htmlFor="campanhaMultiplicador" className="block text-xs font-medium text-[#64748b] mb-1">
    {isAssinados ? "Proporção (assinados por gol)" : "Multiplicador (1.5 – 2.0)"}
  </label>
  {isAssinados ? (
    <input
      id="campanhaMultiplicador"
      type="number"
      min={1}
      max={5}
      step={1}
      value={campanhaMultiplicador}
      onChange={(e) => {
        const val = parseInt(e.target.value) || 1;
        setCampanhaMultiplicador(Math.min(5, Math.max(1, val)));
      }}
      className="w-full px-3 py-2 text-sm rounded-lg border border-[#e2e8f0] bg-white focus:outline-none focus:ring-2 focus:ring-[#2F6FED]/20"
    />
  ) : (
    <input
      id="campanhaMultiplicador"
      type="number"
      min={1.5}
      max={2.0}
      step={0.1}
      value={campanhaMultiplicador}
      onChange={(e) => setCampanhaMultiplicador(parseFloat(e.target.value) || 1.5)}
      className="w-full px-3 py-2 text-sm rounded-lg border border-[#e2e8f0] bg-white focus:outline-none focus:ring-2 focus:ring-[#2F6FED]/20"
    />
  )}
</div>
                <div>
                  <label htmlFor="campanhaProduto" className="block text-xs font-medium text-[#64748b] mb-1">
                    Produto
                  </label>
                  <select
                    id="campanhaProduto"
                    value={campanhaProduto}
                    onChange={(e) => setCampanhaProduto(e.target.value)}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-[#e2e8f0] bg-white focus:outline-none focus:ring-2 focus:ring-[#2F6FED]/20"
                  >
                    {PRODUCT_OPTIONS.map((prod) => (
                      <option key={prod} value={prod}>{prod}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mt-4">
                <label htmlFor="campanhaDescricao" className="block text-xs font-medium text-[#64748b] mb-1">
                  Descrição
                </label>
                <textarea
                  id="campanhaDescricao"
                  value={campanhaDescricao}
                  onChange={(e) => setCampanhaDescricao(e.target.value)}
                  rows={3}
                  placeholder="Detalhes da campanha comercial..."
                  className="w-full px-3 py-2 text-sm rounded-lg border border-[#e2e8f0] bg-white focus:outline-none focus:ring-2 focus:ring-[#2F6FED]/20"
                />
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  onClick={handleRegistrarCampanha}
                  className="px-5 py-2 rounded-lg text-sm font-semibold bg-[#EA8C1D] text-white hover:bg-[#EA8C1D]/90 flex items-center gap-2"
                >
                  <Megaphone className="w-4 h-4" />
                  Registrar Campanha
                </button>
              </div>
            </div>

            {/* Lista de campanhas */}
            {mostrarCampanhas && (
              <div className="px-4 pb-4 border-t border-[#e2e8f0] pt-4">
                <div className="flex flex-wrap items-center justify-between mb-3 gap-2">
                  <span className="text-xs font-medium text-[#64748b]">
                    {filteredCampanhas.length} campanha(s) registrada(s)
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={filterCampanhaDataInicio}
                      onChange={(e) => setFilterCampanhaDataInicio(e.target.value)}
                      className="px-2 py-1 text-xs rounded-lg border border-[#e2e8f0] bg-white"
                      title="Data inicial"
                    />
                    <span className="text-xs text-[#64748b]">até</span>
                    <input
                      type="date"
                      value={filterCampanhaDataFim}
                      onChange={(e) => setFilterCampanhaDataFim(e.target.value)}
                      className="px-2 py-1 text-xs rounded-lg border border-[#e2e8f0] bg-white"
                      title="Data final"
                    />
                    <button
                      onClick={() => {
                        setFilterCampanhaDataInicio(getTodayString());
                        setFilterCampanhaDataFim(getTodayString());
                      }}
                      className="text-xs text-[#2F6FED] hover:underline"
                      title="Voltar para data atual"
                    >
                      Hoje
                    </button>
                  </div>
                  {loadingCampanhas && <span className="text-xs text-[#94a3b8]">Carregando...</span>}
                </div>

                {filteredCampanhas.length === 0 ? (
                  <div className="text-center py-6 text-sm text-[#94a3b8]">
                    Nenhuma campanha encontrada no período selecionado.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="simple-table">
                      <thead>
                        <tr>
                          <th className="text-left">Data</th>
                          <th className="text-left">Categoria</th>
                          <th className="text-center">Multiplicador</th>
                          <th className="text-left">Produto</th>
                          <th className="text-left">Descrição</th>
                          <th className="text-center">Aprovada</th>
                          <th className="text-center">Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredCampanhas.map((camp) => {
                          const chave = `${camp.tipo}-${camp.data_publicacao}-${camp.produto}`;
                          return (
                            <tr key={chave}>
                              <td className="text-xs text-[#64748b]">
                                {new Date(camp.data_publicacao).toLocaleDateString('pt-BR')}
                              </td>
                              <td className="text-xs font-medium">{camp.tipo}</td>
                              <td className="text-center text-xs font-bold">
                                {camp.tipo === "Assinados" ? (
                                  `${camp.multiplicador}x (1 gol a cada ${camp.multiplicador} assinados)`
                                ) : (
                                  `${camp.multiplicador.toFixed(1)}x`
                                )}
                              </td>
                              <td className="text-xs">{camp.produto}</td>
                              <td className="text-xs max-w-[150px] truncate" title={camp.descricao}>
                                {camp.descricao}
                              </td>
                              <td className="text-center">
                                {camp.validacao_financeiro ? (
                                  <span className="inline-flex items-center gap-1 text-[#16A34A] bg-[#dcfce7] px-2 py-0.5 rounded-full text-[10px] font-medium">
                                    <Check className="w-3 h-3" /> Aprovada
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-[#DC2626] bg-[#fee2e2] px-2 py-0.5 rounded-full text-[10px] font-medium">
                                    <XIcon className="w-3 h-3" /> Pendente
                                  </span>
                                )}
                              </td>
                              <td className="text-center">
                                {isSuperAdmin ? (
                                  <div className="flex items-center justify-center gap-1">
                                    <button
                                      onClick={() => handleAprovarCampanha(camp)}
                                      disabled={camp.validacao_financeiro}
                                      className={cn(
                                        "p-1 rounded transition-colors",
                                        camp.validacao_financeiro
                                          ? "text-gray-300 cursor-not-allowed"
                                          : "text-[#16A34A] hover:bg-green-50"
                                      )}
                                      title={camp.validacao_financeiro ? "Já aprovada" : "Aprovar campanha"}
                                    >
                                      <Check className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => handleRejeitarCampanha(camp)}
                                      disabled={!camp.validacao_financeiro}
                                      className={cn(
                                        "p-1 rounded transition-colors",
                                        !camp.validacao_financeiro
                                          ? "text-gray-300 cursor-not-allowed"
                                          : "text-[#DC2626] hover:bg-red-50"
                                      )}
                                      title={!camp.validacao_financeiro ? "Já rejeitada" : "Rejeitar campanha"}
                                    >
                                      <XIcon className="w-4 h-4" />
                                    </button>
                                  </div>
                                ) : (
                                  <span className="text-xs text-gray-400">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* CARD: CONFIGURAÇÕES DE METAS */}
        <div className="card">
          <div className="px-5 py-3 border-b border-[#e2e8f0] flex items-center gap-2">
            <Settings className="w-4 h-4 text-[#2F6FED]" />
            <h3 className="text-sm font-bold text-[#0f172a]">Configurações de Metas</h3>
          </div>
          <div className="p-4">
            <div className="flex gap-1 bg-[#f8fafc] p-0.5 rounded-lg mb-4 w-fit">
              <button
                onClick={() => setConfigTab('global')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  configTab === 'global'
                    ? "bg-white text-[#0f172a] shadow-sm"
                    : "text-[#64748b] hover:text-[#0f172a]"
                )}
              >
                Globais
              </button>
              <button
                onClick={() => setConfigTab('equipes')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  configTab === 'equipes'
                    ? "bg-white text-[#0f172a] shadow-sm"
                    : "text-[#64748b] hover:text-[#0f172a]"
                )}
              >
                Equipes
              </button>
            </div>

            {configTab === 'global' && (
              <div className="flex flex-wrap items-end gap-4">
                <div className="bg-[#f8fafc] rounded-lg p-2">
                  <span className="block text-xs font-medium text-[#64748b] mb-1">Período</span>
                  <div className="flex gap-2">
                    {(['diario','semanal','mensal'] as CicloPeriodo[]).map(p => (
                      <button key={p} onClick={() => setSelectedPeriod(p)}
                        className={cn("filter-pill", selectedPeriod === p && "active")}>
                        {p === 'diario' ? 'Diário' : p === 'semanal' ? 'Semanal' : 'Mensal'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-[#f8fafc] rounded-lg p-2">
                  <label className="block text-xs font-medium text-[#64748b] mb-1">Peso Assinados</label>
                  <input type="number" min="1"
                    value={selectedPeriod === 'diario' ? globalConfig.pesoDiarioAssinados : selectedPeriod === 'semanal' ? globalConfig.pesoSemanalAssinados : globalConfig.pesoMensalAssinados}
                    onChange={(e) => {
                      const v = parseInt(e.target.value) || 1;
                      if (selectedPeriod === 'diario') updateGlobalConfig({ pesoDiarioAssinados: v });
                      else if (selectedPeriod === 'semanal') updateGlobalConfig({ pesoSemanalAssinados: v });
                      else updateGlobalConfig({ pesoMensalAssinados: v });
                    }}
                    disabled={isAllDisabled}
                    className="w-20 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50" />
                </div>

                <div className="bg-[#f8fafc] rounded-lg p-2">
                  <label className="block text-xs font-medium text-[#64748b] mb-1">Peso Ganhos</label>
                  <input type="number" min="1"
                    value={selectedPeriod === 'diario' ? globalConfig.pesoDiarioGanhos : selectedPeriod === 'semanal' ? globalConfig.pesoSemanalGanhos : globalConfig.pesoMensalGanhos}
                    onChange={(e) => {
                      const v = parseInt(e.target.value) || 1;
                      if (selectedPeriod === 'diario') updateGlobalConfig({ pesoDiarioGanhos: v });
                      else if (selectedPeriod === 'semanal') updateGlobalConfig({ pesoSemanalGanhos: v });
                      else updateGlobalConfig({ pesoMensalGanhos: v });
                    }}
                    disabled={isAllDisabled}
                    className="w-20 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50" />
                </div>

                <div className="bg-[#f8fafc] rounded-lg p-2">
                  <label className="block text-xs font-medium text-[#64748b] mb-1">Bônus por Gol (R$)</label>
                  <input type="number" min="1"
                    value={globalConfig.valorBonus}
                    onChange={(e) => updateGlobalConfig({ valorBonus: parseInt(e.target.value) || 1 })}
                    disabled={!isBonusEditable}
                    className="w-20 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50" />
                </div>

                <div>
                  <button onClick={saveGlobalConfig} disabled={!isEditable}
                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#2F6FED] text-white hover:bg-[#2F6FED]/90 disabled:opacity-50 flex items-center gap-1.5">
                    <Save className="w-3.5 h-3.5" /> Aplicar para todos
                  </button>
                </div>
              </div>
            )}

            {configTab === 'equipes' && (
              <div>
                {filteredEquipeConfigs.length > 0 ? (
                  <div className="flex flex-wrap items-end gap-4">
                    <div className="bg-[#f8fafc] rounded-lg p-2">
                      <label htmlFor="teamSelect" className="block text-xs font-medium text-[#64748b] mb-1">Equipe</label>
                      <select id="teamSelect" value={teamSelected} onChange={(e) => setTeamSelected(e.target.value)}
                        className="px-3 py-2 text-sm rounded-lg border border-[#e2e8f0] bg-white" aria-label="Selecionar equipe">
                        {filteredEquipeConfigs.map(eq => <option key={eq.id} value={eq.nome}>{eq.nome}</option>)}
                      </select>
                    </div>
                    <div className="bg-[#f8fafc] rounded-lg p-2">
                      <span className="block text-xs font-medium text-[#64748b] mb-1">Período</span>
                      <div className="flex gap-2">
                        {(['diario','semanal','mensal'] as CicloPeriodo[]).map(p => (
                          <button key={p} onClick={() => setTeamPeriod(p)}
                            className={cn("filter-pill", teamPeriod === p && "active")}>
                            {p === 'diario' ? 'Diário' : p === 'semanal' ? 'Semanal' : 'Mensal'}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="bg-[#f8fafc] rounded-lg p-2">
                      <label className="block text-xs font-medium text-[#64748b] mb-1">Peso Assin.</label>
                      <input type="number" min="1" value={teamPesoAssinados}
                        onChange={(e) => setTeamPesoAssinados(parseInt(e.target.value) || 1)}
                        disabled={isAllDisabled}
                        className="w-20 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50" />
                    </div>
                    <div className="bg-[#f8fafc] rounded-lg p-2">
                      <label className="block text-xs font-medium text-[#64748b] mb-1">Peso Ganhos</label>
                      <input type="number" min="1" value={teamPesoGanhos}
                        onChange={(e) => setTeamPesoGanhos(parseInt(e.target.value) || 0)}
                        disabled={isAllDisabled}
                        className="w-20 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50" />
                    </div>
                    <div className="bg-[#f8fafc] rounded-lg p-2">
                      <label className="block text-xs font-medium text-[#64748b] mb-1">Meta Gols (Assinados)</label>
                      <input type="number" min="1" value={teamMetaGolsAssinados}
                        onChange={(e) => setTeamMetaGolsAssinados(parseInt(e.target.value) || 1)}
                        disabled={isAllDisabled}
                        className="w-20 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50" />
                    </div>
                    <div className="bg-[#f8fafc] rounded-lg p-2">
                      <label className="block text-xs font-medium text-[#64748b] mb-1">Meta Gols (Ganhos)</label>
                      <input type="number" min="1" value={teamMetaGolsGanhos}
                        onChange={(e) => setTeamMetaGolsGanhos(parseInt(e.target.value) || 1)}
                        disabled={isAllDisabled}
                        className="w-20 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50" />
                    </div>
                    <div className="bg-[#f8fafc] rounded-lg p-2">
                      <label className="block text-xs font-medium text-[#64748b] mb-1">Bônus (R$)</label>
                      <input type="number" min="1" value={teamBonus}
                        onChange={(e) => setTeamBonus(parseInt(e.target.value) || 1)}
                        disabled={!isBonusEditable}
                        className="w-20 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50" />
                    </div>
                    <div>
                      <button onClick={saveTeamMetrics} disabled={!isEditable}
                        className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#2F6FED] text-white hover:bg-[#2F6FED]/90 disabled:opacity-50 flex items-center gap-1.5">
                        <Save className="w-3.5 h-3.5" /> Salvar
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[#64748b]">Nenhuma equipe disponível.</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* VISÃO GERAL */}
        <div className="grid grid-cols-2 gap-4">
          <div className="card p-4 text-center">
            <Users className="w-5 h-5 text-[#2F6FED] mx-auto mb-1" />
            <div className="kpi-value text-[#0f172a]">{formatInt(totalStats.totalColaboradores)}</div>
            <div className="text-xs text-[#64748b]">Colaboradores</div>
          </div>
          <div className="card p-4 text-center">
            <Award className="w-5 h-5 text-[#16A34A] mx-auto mb-1" />
            <div className="kpi-value text-[#16A34A]">{formatInt(filteredEquipeConfigs.length)}</div>
            <div className="text-xs text-[#64748b]">Equipes</div>
          </div>
        </div>

        {/* FILTROS E PESQUISA */}
        <div className="card p-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#94a3b8]" />
              <input type="text" placeholder="Buscar por nome ou e-mail..." value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-8 pr-2 py-1.5 text-xs rounded-lg border border-[#e2e8f0] focus:outline-none focus:ring-2 focus:ring-[#2F6FED]/20"
                aria-label="Buscar colaborador" />
            </div>
            <div className="flex items-center gap-2">
              <Filter className="w-3.5 h-3.5 text-[#94a3b8]" />
              <select id="equipeFilter" value={selectedEquipe} onChange={(e) => setSelectedEquipe(e.target.value)}
                className="px-2 py-1.5 text-xs rounded-lg border border-[#e2e8f0] bg-white">
                {equipeNomes.map(eq => <option key={eq}>{eq}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* TABELA DE METAS POR COLABORADOR */}
        <div className="card">
          <div className="px-5 py-3 border-b border-[#e2e8f0] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-[#2F6FED]" />
              <h3 className="text-sm font-bold text-[#0f172a]">Metas por Colaborador</h3>
            </div>
            <div className="flex items-center gap-1 bg-[#f8fafc] p-0.5 rounded-lg">
              {(['diario', 'semanal', 'mensal'] as CicloPeriodo[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriodoTabela(p)}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded-md transition-colors",
                    periodoTabela === p
                      ? "bg-white text-[#0f172a] shadow-sm"
                      : "text-[#64748b] hover:text-[#0f172a]"
                  )}
                >
                  {p === 'diario' ? 'Diário' : p === 'semanal' ? 'Semanal' : 'Mensal'}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Colaborador</th>
                  <th>Equipe</th>
                  <th className="text-center">Peso Metas (A/G)</th>
                  <th className="text-center">Meta Gols (A/G)</th>
                  <th className="text-center">Gols</th>
                  <th className="text-center">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredCollaborators.map((collab) => {
                  const isEditing = editingId === collab.id;
                  const isExpanded = expandedId === collab.id;
                  const peso = getPesoForPeriod(collab, periodoTabela);
                  const metaGols = getMetaGolsForPeriod(collab);
                  const totalGols = Number((collab as any).totalGols || 0);
                  const individualEditable = isIndividualEditable(collab);
                  return (
                    <React.Fragment key={collab.id}>
                      <tr>
                        <td>
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-[#f1f5f9] flex items-center justify-center text-xs font-bold text-[#64748b]">{collab.avatar}</div>
                            <div>
                              <div className="text-xs font-medium text-[#0f172a]">{collab.name}</div>
                              <div className="text-[10px] text-[#94a3b8]">{collab.email}</div>
                            </div>
                          </div>
                        </td>
                        <td><span className="badge info">{collab.equipeNome}</span></td>
                        <td className="text-center">
                          {isEditing ? (
                            <div className="flex items-center justify-center gap-1">
                              <input type="number" min="1" value={editForm.pesoAssinados ?? peso.assinados}
                                onChange={(e) => setEditForm(prev => ({ ...prev, pesoAssinados: parseInt(e.target.value) || 1 }))}
                                className="w-12 text-center text-xs px-1 py-0.5 rounded border border-[#e2e8f0]" />
                              <span className="text-xs">/</span>
                              <input type="number" min="1" value={editForm.pesoGanhos ?? peso.ganhos}
                                onChange={(e) => setEditForm(prev => ({ ...prev, pesoGanhos: parseInt(e.target.value) || 1 }))}
                                className="w-12 text-center text-xs px-1 py-0.5 rounded border border-[#e2e8f0]" />
                            </div>
                          ) : (
                            <span className="text-xs font-medium">{formatInt(peso.assinados)}/{formatInt(peso.ganhos)}</span>
                          )}
                        </td>
                        <td className="text-center">
                          {isEditing ? (
                            <div className="flex items-center justify-center gap-1">
                              <input type="number" min="1" value={editForm.metaGolsAssinados ?? metaGols.assinados}
                                onChange={(e) => setEditForm(prev => ({ ...prev, metaGolsAssinados: parseInt(e.target.value) || 1 }))}
                                className="w-12 text-center text-xs px-1 py-0.5 rounded border border-[#e2e8f0]" />
                              <span className="text-xs">/</span>
                              <input type="number" min="1" value={editForm.metaGolsGanhos ?? metaGols.ganhos}
                                onChange={(e) => setEditForm(prev => ({ ...prev, metaGolsGanhos: parseInt(e.target.value) || 1 }))}
                                className="w-12 text-center text-xs px-1 py-0.5 rounded border border-[#e2e8f0]" />
                            </div>
                          ) : (
                            <span className="text-xs font-medium">{formatInt(metaGols.assinados)}/{formatInt(metaGols.ganhos)}</span>
                          )}
                        </td>
                        <td className="text-center font-bold text-[#0f172a]">{formatInt(totalGols)}</td>
                        <td className="text-center">
                          <div className="flex items-center justify-center gap-1">
                            {isEditing ? (
                              <>
                                <button onClick={() => saveRow(collab.id)} disabled={!individualEditable || savingId === collab.id}
                                  className="p-0.5 rounded hover:bg-green-50 disabled:opacity-50" title="Salvar alterações">
                                  <Save className="w-3.5 h-3.5 text-[#16A34A]" />
                                </button>
                                <button onClick={cancelEditRow} className="p-0.5 rounded hover:bg-red-50" title="Cancelar">
                                  <X className="w-3.5 h-3.5 text-[#DC2626]" />
                                </button>
                              </>
                            ) : (
                              <button onClick={() => startEditRow(collab)} disabled={!individualEditable}
                                className="p-0.5 rounded hover:bg-[#f1f5f9] disabled:opacity-50" title="Editar linha">
                                <Edit2 className="w-3.5 h-3.5 text-[#64748b]" />
                              </button>
                            )}
                            <button onClick={() => toggleExpand(collab.id)} className="p-0.5 rounded hover:bg-[#f1f5f9]" title="Expandir">
                              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-[#f8fafc]">
                          <td colSpan={6} className="px-4 py-2">
                            <div className="grid grid-cols-5 gap-2 text-center">
                              <div className="bg-white rounded p-2">
                                <FileText className="w-3 h-3 text-[#2F6FED] mx-auto mb-0.5" />
                                <div className="text-xs font-bold text-[#2F6FED]">{formatInt(collab.emitidos)}</div>
                                <div className="text-[9px] text-[#94a3b8]">Emitidos</div>
                              </div>
                              <div className="bg-white rounded p-2">
                                <CheckCircle className="w-3 h-3 text-[#16A34A] mx-auto mb-0.5" />
                                <div className="text-xs font-bold text-[#16A34A]">{formatInt(collab.assinados)}</div>
                                <div className="text-[9px] text-[#94a3b8]">Assinados</div>
                              </div>
                              <div className="bg-white rounded p-2">
                                <Archive className="w-3 h-3 text-[#8B5CF6] mx-auto mb-0.5" />
                                <div className="text-xs font-bold text-[#8B5CF6]">{formatInt(collab.protocolados || 0)}</div>
                                <div className="text-[9px] text-[#94a3b8]">Protocolados</div>
                              </div>
                              <div className="bg-white rounded p-2">
                                <Award className="w-3 h-3 text-[#EA8C1D] mx-auto mb-0.5" />
                                <div className="text-xs font-bold text-[#EA8C1D]">{formatInt(collab.ganhos)}</div>
                                <div className="text-[9px] text-[#94a3b8]">Ganhos</div>
                              </div>
                              <div className="bg-white rounded p-2">
                                <XCircle className="w-3 h-3 text-[#DC2626] mx-auto mb-0.5" />
                                <div className="text-xs font-bold text-[#DC2626]">{formatInt(collab.perdidos)}</div>
                                <div className="text-[9px] text-[#94a3b8]">Perdidos</div>
                              </div>
                            </div>
                          </td>
                        </tr> 
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filteredCollaborators.length === 0 && (
            <div className="text-center py-8">
              <Users className="w-8 h-8 text-[#cbd5e1] mx-auto mb-2" />
              <p className="text-xs text-[#94a3b8]">Nenhum colaborador encontrado</p>
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}