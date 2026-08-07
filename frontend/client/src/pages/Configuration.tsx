// src/pages/Configuration.tsx
import React, { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import {
  Search, Filter, Users, Award, FileText, CheckCircle, XCircle,
  Edit2, Save, X, ChevronDown, ChevronUp, Settings, Briefcase, User, Archive,
  CalendarPlus, Calendar, RefreshCw, AlertTriangle,
} from "lucide-react";
import { useAppStore, formatCurrency } from "@/lib/dataStore";
import { fetchCollaborators, fetchEquipes, API_BASE } from "@/lib/api";
import { recalculateHierarchyWeights } from "@/lib/metrics";
import { useAccessControl } from "@/hooks/useAccessControl";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing',
  'Equipe Ariana', 'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda', 'Equipe Reciclagem'
];

const isExcludedTeam = (teamName: string) => EXCLUDED_TEAMS.includes(teamName);
type CicloPeriodo = 'diario' | 'semanal' | 'mensal';

const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

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
    loadMetricsForPeriod,
  } = useAppStore();

  const { hasPermission, getAccessLevel, LEVELS, currentUser } = useAccessControl();
  const userLevel = getAccessLevel();

  useEffect(() => {
    if (!hasPermission("canAccessConfiguration")) {
      navigate("/");
    }
  }, [hasPermission, navigate]);

  const canEditConfiguration = hasPermission("canEditConfiguration");
  const canEditBonus = hasPermission("canEditBonus");
  const canGenerateNextMonth = hasPermission("canGenerateNextMonth");
  const isAdminOnly = userLevel === LEVELS.ADMINISTRATIVO;

  // ========== ESTADOS ==========
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedEquipe, setSelectedEquipe] = useState("Todas");
  const [selectedPeriod, setSelectedPeriod] = useState<CicloPeriodo>('mensal');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ assinados?: number; ganhos?: number }>({});
  const [editingBonusId, setEditingBonusId] = useState<string | null>(null);
  const [editBonusValue, setEditBonusValue] = useState<number>(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState(false);

  const [teamSelected, setTeamSelected] = useState<string>("");
  const [teamPeriod, setTeamPeriod] = useState<CicloPeriodo>('mensal');
  const [teamAssinados, setTeamAssinados] = useState<number>(60);
  const [teamGanhos, setTeamGanhos] = useState<number>(60);
  const [teamBonus, setTeamBonus] = useState<number>(150);

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

  const isEditable = canEditConfiguration && !isLocked;
  const isBonusEditable = canEditBonus && !isLocked;
  const isAllDisabled = !canEditConfiguration || isLocked;

  // ========== CACHE DE COLABORADORES POR MÊS ==========
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

  // ========== CARREGAMENTO DE COLABORADORES (COM CACHE) ==========
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
  useEffect(() => { if (filteredEquipeConfigs.length && !teamSelected) setTeamSelected(filteredEquipeConfigs[0].nome); }, [filteredEquipeConfigs, teamSelected]);

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
  const getCycleMetaForPeriod = (collab: any, periodo: CicloPeriodo) => {
    switch (periodo) {
      case 'diario': return { assinados: Number(collab.metaDiarioAssinados) ?? 3, ganhos: Number(collab.metaDiarioGanhos) ?? 3 };
      case 'semanal': return { assinados: Number(collab.metaSemanalAssinados) ?? 15, ganhos: Number(collab.metaSemanalGanhos) ?? 15 };
      default: return { assinados: Number(collab.metaMensalAssinados) ?? 60, ganhos: Number(collab.metaMensalGanhos) ?? 60 };
    }
  };
  const getCiclosCompletos = (collab: any, periodo: CicloPeriodo) => {
    const meta = getCycleMetaForPeriod(collab, periodo);
    const assinados = Number(collab.assinados) || 0;
    const ganhos = Number(collab.ganhos) || 0;
    if (meta.assinados === 0 || meta.ganhos === 0) return 0;
    return Math.floor(Math.min(assinados / meta.assinados, ganhos / meta.ganhos));
  };
  const getBonusPorCiclo = (collab: any) => {
    if (collab.bonusComissao !== undefined && collab.bonusComissao !== null && Number(collab.bonusComissao) > 0) {
      return Number(collab.bonusComissao);
    }
    const equipeConfig = filteredEquipeConfigs.find(e => e.nome === collab.equipeNome);
    return equipeConfig?.bonus || Number(globalConfig.valorBonus);
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
      peso_assinados: Number(teamAssinados),
      peso_ganhos: Number(teamGanhos),
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

  const saveEdit = async (id: string) => {
    if (editForm.assinados === undefined || editForm.ganhos === undefined || !isEditable) return;
    const collab = collaborators.find(c => c.id === id);
    if (!collab) return;
    setSavingId(id);
    
    const payload = {
      email: collab.email || collab.id,
      data_metrica: selectedMonth,
      meta_diario_assinados: selectedPeriod === 'diario' ? Number(editForm.assinados) : undefined,
      meta_diario_ganhos: selectedPeriod === 'diario' ? Number(editForm.ganhos) : undefined,
      meta_semanal_assinados: selectedPeriod === 'semanal' ? Number(editForm.assinados) : undefined,
      meta_semanal_ganhos: selectedPeriod === 'semanal' ? Number(editForm.ganhos) : undefined,
      meta_mensal_assinados: selectedPeriod === 'mensal' ? Number(editForm.assinados) : undefined,
      meta_mensal_ganhos: selectedPeriod === 'mensal' ? Number(editForm.ganhos) : undefined,
      comissao_bonus: Number(collab.bonusComissao) || 0,
    };
    
    console.log('📤 [saveEdit] Payload enviado:', payload);
    
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
        toast.success(`Meta ${selectedPeriod} de ${collab.name} atualizada!`);
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

  const saveBonusEdit = async (id: string) => {
    if (!isBonusEditable) return;
    const collab = collaborators.find(c => c.id === id);
    if (!collab) return;
    setSavingId(id);
    
    const payload = {
      email: collab.email || collab.id,
      data_metrica: selectedMonth,
      comissao_bonus: Number(editBonusValue),
    };
    
    console.log('📤 [saveBonusEdit] Payload enviado:', payload);
    
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
        toast.success(`Bônus de ${collab.name} atualizado para ${formatCurrency(editBonusValue)}`);
        collaboratorsCache.current.delete(selectedMonth);
        await loadCollaboratorsForMonth(selectedMonth);
      } else {
        toast.error(data.error || 'Erro ao salvar bônus');
        console.error('❌ Erro do backend:', data);
      }
    } catch (err) {
      console.error(err);
      toast.error('Erro de conexão');
    } finally {
      setSavingId(null);
      setEditingBonusId(null);
      setEditBonusValue(0);
    }
  };

  const startEdit = (collab: any) => {
    if (!isIndividualEditable(collab)) return;
    const meta = getCycleMetaForPeriod(collab, selectedPeriod);
    setEditingId(collab.id);
    setEditForm({ assinados: meta.assinados, ganhos: meta.ganhos });
  };
  const startEditBonus = (collab: any) => {
    if (!isBonusEditable) return;
    setEditingBonusId(collab.id);
    setEditBonusValue(collab.bonusComissao || getBonusPorCiclo(collab));
  };
  const cancelEdit = () => { setEditingId(null); setEditForm({}); };
  const cancelEditBonus = () => { setEditingBonusId(null); setEditBonusValue(0); };

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

  // ========== RENDER ==========
  return (
    <DashboardLayout title="Configurações" subtitle="Gerencie metas e bônus do sistema">
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

        {/* CONFIGURAÇÕES GLOBAIS */}
        <div className="card">
          <div className="px-5 py-3 border-b border-[#e2e8f0]">
            <div className="flex items-center gap-2">
              <Settings className="w-4 h-4 text-[#2F6FED]" />
              <h3 className="text-sm font-bold text-[#0f172a]">Configurações Globais</h3>
            </div>
          </div>
          <div className="p-4 space-y-4">
            <div>
              <span className="text-xs font-medium text-[#64748b]">Aplicar para o período:</span>
              <div className="flex gap-2 mt-1">
                {(['diario','semanal','mensal'] as CicloPeriodo[]).map(p => (
                  <button key={p} onClick={() => setSelectedPeriod(p)}
                    className={cn("filter-pill", selectedPeriod === p && "active")}>
                    {p === 'diario' ? 'Diário' : p === 'semanal' ? 'Semanal' : 'Mensal'}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-[#f8fafc] rounded-lg p-3">
                <label htmlFor="globalPesoAssinados" className="block text-xs font-medium text-[#64748b] mb-1">Peso de Assinados</label>
                <input id="globalPesoAssinados" type="number" min="1"
                  value={selectedPeriod === 'diario' ? globalConfig.pesoDiarioAssinados : selectedPeriod === 'semanal' ? globalConfig.pesoSemanalAssinados : globalConfig.pesoMensalAssinados}
                  onChange={(e) => {
                    const v = parseInt(e.target.value) || 1;
                    if (selectedPeriod === 'diario') updateGlobalConfig({ pesoDiarioAssinados: v });
                    else if (selectedPeriod === 'semanal') updateGlobalConfig({ pesoSemanalAssinados: v });
                    else updateGlobalConfig({ pesoMensalAssinados: v });
                  }}
                  disabled={isAllDisabled}
                  className="w-24 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50"
                  aria-label="Peso de assinados" />
              </div>
              <div className="bg-[#f8fafc] rounded-lg p-3">
                <label htmlFor="globalPesoGanhos" className="block text-xs font-medium text-[#64748b] mb-1">Peso de Ganhos</label>
                <input id="globalPesoGanhos" type="number" min="1"
                  value={selectedPeriod === 'diario' ? globalConfig.pesoDiarioGanhos : selectedPeriod === 'semanal' ? globalConfig.pesoSemanalGanhos : globalConfig.pesoMensalGanhos}
                  onChange={(e) => {
                    const v = parseInt(e.target.value) || 1;
                    if (selectedPeriod === 'diario') updateGlobalConfig({ pesoDiarioGanhos: v });
                    else if (selectedPeriod === 'semanal') updateGlobalConfig({ pesoSemanalGanhos: v });
                    else updateGlobalConfig({ pesoMensalGanhos: v });
                  }}
                  disabled={isAllDisabled}
                  className="w-24 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50"
                  aria-label="Peso de ganhos" />
              </div>
              <div className="bg-[#f8fafc] rounded-lg p-3">
                <label htmlFor="globalBonus" className="block text-xs font-medium text-[#64748b] mb-1">Bônus por Ciclo (R$)</label>
                <input id="globalBonus" type="number" min="1"
                  value={globalConfig.valorBonus}
                  onChange={(e) => updateGlobalConfig({ valorBonus: parseInt(e.target.value) || 1 })}
                  disabled={!isBonusEditable}
                  className="w-24 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50"
                  aria-label="Valor do bônus por ciclo" />
              </div>
            </div>
            <div className="flex justify-end">
              <button onClick={saveGlobalConfig} disabled={!isEditable}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#2F6FED] text-white hover:bg-[#2F6FED]/90 disabled:opacity-50 flex items-center gap-1.5">
                <Save className="w-3.5 h-3.5" /> Aplicar a todos
              </button>
            </div>
          </div>
        </div>

        {/* METAS POR EQUIPE */}
        {filteredEquipeConfigs.length > 0 && (
          <div className="card">
            <div className="px-5 py-3 border-b border-[#e2e8f0]">
              <div className="flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-[#16A34A]" />
                <h3 className="text-sm font-bold text-[#0f172a]">Metas por Equipe</h3>
              </div>
            </div>
            <div className="p-4">
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
                  <label htmlFor="teamAssinados" className="block text-xs font-medium text-[#64748b] mb-1">Peso Assinados</label>
                  <input id="teamAssinados" type="number" min="1" value={teamAssinados}
                    onChange={(e) => setTeamAssinados(parseInt(e.target.value) || 1)}
                    disabled={isAllDisabled}
                    className="w-24 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50"
                    aria-label="Peso assinados equipe" />
                </div>
                <div className="bg-[#f8fafc] rounded-lg p-2">
                  <label htmlFor="teamGanhos" className="block text-xs font-medium text-[#64748b] mb-1">Peso Ganhos</label>
                  <input id="teamGanhos" type="number" min="1" value={teamGanhos}
                    onChange={(e) => setTeamGanhos(parseInt(e.target.value) || 0)}
                    disabled={isAllDisabled}
                    className="w-24 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50"
                    aria-label="Peso ganhos equipe" />
                </div>
                <div className="bg-[#f8fafc] rounded-lg p-2">
                  <label htmlFor="teamBonus" className="block text-xs font-medium text-[#64748b] mb-1">Bônus (R$)</label>
                  <input id="teamBonus" type="number" min="1" value={teamBonus}
                    onChange={(e) => setTeamBonus(parseInt(e.target.value) || 1)}
                    disabled={!isBonusEditable}
                    className="w-24 text-sm px-2 py-1.5 rounded-lg border border-[#e2e8f0] text-center disabled:opacity-50"
                    aria-label="Bônus equipe" />
                </div>
                <div>
                  <button onClick={saveTeamMetrics} disabled={!isEditable}
                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#2F6FED] text-white hover:bg-[#2F6FED]/90 disabled:opacity-50 flex items-center gap-1.5">
                    <Save className="w-3.5 h-3.5" /> Salvar
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

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

        {/* SELETOR DE PERÍODO */}
        <div className="card p-3 flex items-center gap-3">
          <span className="text-xs font-medium text-[#64748b]">Exibir metas para:</span>
          <div className="flex gap-2">
            {(['diario','semanal','mensal'] as CicloPeriodo[]).map(p => (
              <button key={p} onClick={() => setSelectedPeriod(p)}
                className={cn("filter-pill", selectedPeriod === p && "active")}>
                {p === 'diario' ? 'Diário' : p === 'semanal' ? 'Semanal' : 'Mensal'}
              </button>
            ))}
          </div>
        </div>

        {/* TABELA DE METAS POR COLABORADOR */}
        <div className="card">
          <div className="px-5 py-3 border-b border-[#e2e8f0] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-[#2F6FED]" />
              <h3 className="text-sm font-bold text-[#0f172a]">Metas por Colaborador</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Colaborador</th>
                  <th>Equipe</th>
                  <th className="text-center">Meta (A/G) {selectedPeriod === 'diario' ? '(diário)' : selectedPeriod === 'semanal' ? '(semanal)' : '(mensal)'}</th>
                  <th className="text-center">Gols</th>
                  <th className="text-center">Bônus Ciclo</th>
                  <th className="text-center">Bônus Estimado</th>
                  <th className="text-center">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredCollaborators.map((collab) => {
                  const isEditing = editingId === collab.id;
                  const isEditingBonus = editingBonusId === collab.id;
                  const isExpanded = expandedId === collab.id;
                  const currentMeta = getCycleMetaForPeriod(collab, selectedPeriod);
                  const ciclosCompletos = getCiclosCompletos(collab, selectedPeriod);
                  const bonusPorCiclo = getBonusPorCiclo(collab);
                  const bonusEstimado = ciclosCompletos * bonusPorCiclo;
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
                              <input type="number" min="1" value={editForm.assinados ?? currentMeta.assinados}
                                onChange={(e) => setEditForm(prev => ({ ...prev, assinados: parseInt(e.target.value) || 1 }))}
                                className="w-12 text-center text-xs px-1 py-0.5 rounded border border-[#e2e8f0]" aria-label="Meta de assinados" />
                              <span className="text-xs">/</span>
                              <input type="number" min="1" value={editForm.ganhos ?? currentMeta.ganhos}
                                onChange={(e) => setEditForm(prev => ({ ...prev, ganhos: parseInt(e.target.value) || 1 }))}
                                className="w-12 text-center text-xs px-1 py-0.5 rounded border border-[#e2e8f0]" aria-label="Meta de ganhos" />
                            </div>
                          ) : (
                            <div className="flex flex-col items-center">
                              <span className="text-xs font-medium">{formatInt(currentMeta.assinados)}/{formatInt(currentMeta.ganhos)}</span>
                              <div className="progress-bar w-12 mt-0.5">
                                <div className="progress-fill" style={{ width: `${Math.min((collab.assinados / currentMeta.assinados) * 100, 100)}%` }} />
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="text-center font-bold text-[#0f172a]">{formatInt(ciclosCompletos)}</td>
                        <td className="text-center">
                          {isEditingBonus ? (
                            <div className="flex items-center justify-center gap-1">
                              <input type="number" min="1" value={editBonusValue} onChange={(e) => setEditBonusValue(parseInt(e.target.value) || 1)}
                                className="w-20 text-center text-xs px-1 py-0.5 rounded border border-[#e2e8f0]" aria-label="Novo valor do bônus" />
                              <button onClick={() => saveBonusEdit(collab.id)} disabled={savingId === collab.id}
                                className="p-0.5 rounded hover:bg-green-50" aria-label="Salvar novo bônus">
                                <Save className="w-3.5 h-3.5 text-[#16A34A]" />
                              </button>
                              <button onClick={cancelEditBonus} className="p-0.5 rounded hover:bg-red-50" aria-label="Cancelar">
                                <X className="w-3.5 h-3.5 text-[#DC2626]" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-center gap-1">
                              <span className="text-sm font-bold text-[#16A34A]">{formatCurrency(bonusPorCiclo)}</span>
                              {isBonusEditable && (
                                <button onClick={() => startEditBonus(collab)} className="p-0.5 rounded hover:bg-[#f1f5f9]" aria-label="Editar bônus">
                                  <Edit2 className="w-3 h-3 text-[#64748b]" />
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="text-center font-bold text-[#16A34A]">{formatCurrency(bonusEstimado)}</td>
                        <td className="text-center">
                          <div className="flex items-center justify-center gap-1">
                            {isEditing ? (
                              <>
                                <button onClick={() => saveEdit(collab.id)} disabled={!individualEditable || savingId === collab.id}
                                  className="p-0.5 rounded hover:bg-green-50 disabled:opacity-50" aria-label="Salvar edição">
                                  <Save className="w-3.5 h-3.5 text-[#16A34A]" />
                                </button>
                                <button onClick={cancelEdit} className="p-0.5 rounded hover:bg-red-50" aria-label="Cancelar">
                                  <X className="w-3.5 h-3.5 text-[#DC2626]" />
                                </button>
                              </>
                            ) : (
                              <button onClick={() => startEdit(collab)} disabled={!individualEditable}
                                className="p-0.5 rounded hover:bg-[#f1f5f9] disabled:opacity-50"
                                aria-label={individualEditable ? `Editar meta de ${collab.name}` : "Metas automáticas"}>
                                <Edit2 className="w-3.5 h-3.5 text-[#64748b]" />
                              </button>
                            )}
                            <button onClick={() => toggleExpand(collab.id)} className="p-0.5 rounded hover:bg-[#f1f5f9]" aria-label={isExpanded ? "Recolher detalhes" : "Expandir detalhes"}>
                              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr className="bg-[#f8fafc]">
                          <td colSpan={7} className="px-4 py-2">
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