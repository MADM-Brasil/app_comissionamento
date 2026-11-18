// src/components/FilterBar.tsx
import { useState, useEffect, useMemo, useRef } from "react";
import { Filter, Users, Briefcase, Search, X, Package, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { useAppStore } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import { cn } from "@/lib/utils";
import { fetchCollaborators, fetchEquipes, API_BASE } from "@/lib/api";

interface FilterBarProps {
  onFilterChange: (filters: {
    equipe: string;
    colaborador: string;
    colaboradorId?: string | number;
    produto: string;
    unidadeId?: number;
  }) => void;
  showColaboradorFilter?: boolean;
  showProdutoFilter?: boolean;
  showUnitFilter?: boolean;
  className?: string;
  initialEquipe?: string;
  initialColaborador?: string;
  initialProduto?: string;
  onRefresh?: () => Promise<void>;
}

const normalize = (str: string): string => (str || '').trim().toLowerCase();

const normalizeKey = (str: string): string =>
  String(str || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing','Departamento Comercial',
  'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda',
  'Equipe Reciclagem','','Equipe','Equipe Camila','Sales Ops','Equipe Elizandra','Equipe Bruno Abreu',
  'Equipe Lucas Magno','Equipe SP1','Equipe Marcia','Equipe Lucilene','backoffice','Equipe Debora','Equipe Curitiba',
  'Equipe Gabriela Toledo','Equipe SP01', 'Equipe Adriele','Equipe Elizandra', 'Equipe Debora', 'Equipe Toledo'
];

const isExcludedTeam = (teamName: string): boolean => {
  if (!teamName) return false;
  const n = normalize(teamName);
  return EXCLUDED_TEAMS.some((t) => normalize(t) === n);
};

const PRODUCT = Object.freeze({
  QUINQUENIO:       'quinquenio',
  AUXILIO_ACIDENTE: 'auxilio_acidente',
  FATOR_K:          'Fator K',
  CONCOMITANTE:     'Concomitante',
  BPC_LOAS:         'BPC/LOAS',
  ISENCAO_IR:       'Isenção de IR Aposentadoria',
});

const PRODUCT_LABELS: Record<string, string> = {
  [PRODUCT.QUINQUENIO]:       'Quinquenio',
  [PRODUCT.AUXILIO_ACIDENTE]: 'Auxilio Acidente',
  [PRODUCT.FATOR_K]:          'Fator K',
  [PRODUCT.CONCOMITANTE]:     'Concomitante',
  [PRODUCT.BPC_LOAS]:         'BPC/LOAS',
  [PRODUCT.ISENCAO_IR]:       'Isenção de IR Aposentadoria'
};

function maskProduct(value?: string | null): string {
  if (!value) return '';
  const key = String(value);
  if (PRODUCT_LABELS[key]) return PRODUCT_LABELS[key];
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

interface ProdutoConfig {
  default: string;
  options: string[];
  allowChange: boolean;
}

const FALLBACK_PRODUTO_DEFAULT = PRODUCT.AUXILIO_ACIDENTE;

const FALLBACK_PRODUTOS_POR_EQUIPE: Record<string, ProdutoConfig> = {
  [normalizeKey('Equipe Tatiane')]: {
    default: PRODUCT.QUINQUENIO,
    options: [PRODUCT.QUINQUENIO, PRODUCT.CONCOMITANTE],
    allowChange: true,
  },
  [normalizeKey('Equipe Leticia Mathias')]: {
    default: PRODUCT.ISENCAO_IR,
    options: [PRODUCT.ISENCAO_IR],
    allowChange: true,
  },
};

function findProdutoConfig(
  mapa: Record<string, ProdutoConfig> | undefined,
  equipe: string,
): ProdutoConfig | null {
  if (!equipe) return null;
  const key = normalizeKey(equipe);
  if (mapa) {
    for (const [k, v] of Object.entries(mapa)) {
      if (normalizeKey(k) === key) {
        return {
          default: v.default,
          options: Array.isArray(v.options) ? [...v.options] : [v.default],
          allowChange: Boolean(v.allowChange),
        };
      }
    }
  }
  const hit = FALLBACK_PRODUTOS_POR_EQUIPE[key];
  return hit ? { ...hit, options: [...hit.options] } : null;
}

const GENERAL_PRODUCT_OPTIONS = ["Todos", "Auxilio Acidente", "Quinquenio", "Concomitante", "Fator K", "BPC/LOAS", "Isenção de IR Aposentadoria"];

const EQUIPES_TRAVADAS_DESTINO = ['equipe tatiane','equipe leticia mathias'];

function isEquipeTravadaDestino(nome: string): boolean {
  const n = normalizeKey(nome);
  return EQUIPES_TRAVADAS_DESTINO.includes(n);
}

const STORAGE_KEY = "madm_filterBar_state_v1";

interface StoredFilters {
  equipe: string;
  colaborador: string;
  produto: string;
  searchTerm: string;
  unidadeId?: number;
}

function getStoredFilters(): StoredFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        equipe: parsed.equipe || "todas",
        colaborador: parsed.colaborador || "todos",
        produto: parsed.produto || "Todos",
        searchTerm: parsed.searchTerm || "",
        unidadeId:
          parsed.unidadeId != null && Number.isInteger(Number(parsed.unidadeId))
            ? Number(parsed.unidadeId)
            : undefined,
      };
    }
  } catch { /* ignore */ }
  return { equipe: "todas", colaborador: "todos", produto: "Todos", searchTerm: "" };
}

export default function FilterBar({
  onFilterChange,
  showColaboradorFilter = true,
  showProdutoFilter = true,
  showUnitFilter = true,
  className,
  initialEquipe = "todas",
  initialColaborador = "todos",
  initialProduto = "Todos",
  onRefresh,
}: FilterBarProps) {
  const { collaborators, equipeConfigs, setCollaborators, setEquipeConfigs } = useAppStore();
  const { currentUser, getAccessLevel, getEffectiveAccessLevel, LEVELS } = useAccessControl();

  const setSelectedCollaboratorEmail = useAppStore((state) => (state as any).setSelectedCollaboratorEmail);

  const [initialStored] = useState<StoredFilters>(getStoredFilters);

  const [selectedEquipe, setSelectedEquipe] = useState(initialStored.equipe);
  const [selectedColaborador, setSelectedColaborador] = useState(initialStored.colaborador);
  const [selectedProduto, setSelectedProduto] = useState(initialStored.produto);
  const [searchTerm, setSearchTerm] = useState(initialStored.searchTerm);
  const [loadingEquipes, setLoadingEquipes] = useState(false);
  const [loadingCollaborators, setLoadingCollaborators] = useState(false);
  const [colabError, setColabError] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [hasAppliedRestrictions, setHasAppliedRestrictions] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");

  // ─── Aplicação diferida de filtros ──────────────────────────────────────
  // Estado local (selects) muda livremente. O pai só é notificado quando o
  // usuário clica em "Atualizar Dados". Assim evitamos reloads a cada clique.
  const initialNotifyDoneRef = useRef(false);
  const lastAppliedSignatureRef = useRef<string | null>(null);

  const computeSignature = (
    eq: string,
    colab: string,
    prod: string,
    unit: number | "todas",
  ) => JSON.stringify([eq, colab, prod, unit]); // searchTerm fica de fora — não vai ao backend

  const currentSignature = computeSignature(
    selectedEquipe,
    selectedColaborador,
    selectedProduto,
    selectedUnitForSignature(selectedEquipe), // placeholder — substituído abaixo
  );

  function selectedUnitForSignature(_eq: string): number | "todas" {
    // apenas para evitar TDZ — será recomputado logo abaixo
    return "todas";
  }

  const userLevel = getEffectiveAccessLevel();
  const isAssessor = userLevel === LEVELS.ASSESSOR;
  const isSupervisor = userLevel === LEVELS.SUPERVISAO;
  const isCoordenador = userLevel === LEVELS.COORDENADOR;

  const canFetchEscopo = userLevel >= LEVELS.SUPERVISAO;

  const userUnidadeRaw = (currentUser as any)?.unidade_id
    ?? (currentUser as any)?.unidadeId
    ?? null;
  const userUnidade = userUnidadeRaw != null ? Number(userUnidadeRaw) : null;
  const isUnitRestricted = userLevel < LEVELS.ADMINISTRATIVO && userUnidade !== 4;
  const initialUnit = isUnitRestricted
    ? userUnidade ?? "todas"
    : initialStored.unidadeId ?? "todas";
  const [selectedUnit, setSelectedUnit] = useState<number | "todas">(initialUnit);

  // Recalcula a signature já com `selectedUnit` disponível
  const realCurrentSignature = computeSignature(
    selectedEquipe,
    selectedColaborador,
    selectedProduto,
    selectedUnit,
  );

  const hasPendingChanges =
    isReady &&
    lastAppliedSignatureRef.current !== null &&
    lastAppliedSignatureRef.current !== realCurrentSignature;

  const userTeam = useMemo(() => {
    if (!currentUser) return '';
    const direct = (currentUser.equipe || (currentUser as any).equipeNome || (currentUser as any).nome_equipe || '').trim();
    if (direct) return direct;
    if (collaborators.length > 0) {
      const colab = collaborators.find(c => c.id === currentUser.id || c.email === currentUser.email);
      if (colab && colab.equipeNome) return colab.equipeNome.trim();
    }
    return '';
  }, [currentUser, collaborators]);

  const deveOcultarEquipesReservadas = isSupervisor
    && userUnidade === 1
    && !!userTeam
    && !isEquipeTravadaDestino(userTeam);

  const [escopoData, setEscopoData] = useState<{
    equipes: Set<string>;
    colaboradores: Set<string>;
    produtosPorEquipe: Record<string, ProdutoConfig>;
    produtoDefault: string;
  } | null>(null);
  const [escopoLoading, setEscopoLoading] = useState(false);

  useEffect(() => {
    if (!canFetchEscopo || !currentUser) {
      setEscopoData(null);
      return;
    }
    let mounted = true;
    (async () => {
      setEscopoLoading(true);
      try {
        const res = await fetch(`${API_BASE}/suporte/escopo`, { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!mounted) return;
        if (!res.ok || !data?.success) {
          throw new Error(data?.error || `Erro HTTP ${res.status}`);
        }
        const equipes = new Set<string>(
          (data.data?.equipes || []).map((e: string) => normalize(e))
        );
        const colaboradores = new Set<string>(
          (data.data?.assessores || []).map((a: any) => normalize(a.email))
        );
        const produtosPorEquipe: Record<string, ProdutoConfig> =
          data.data?.produtos?.porEquipe || {};
        const produtoDefault = data.data?.produtos?.default || FALLBACK_PRODUTO_DEFAULT;
        setEscopoData({ equipes, colaboradores, produtosPorEquipe, produtoDefault });
      } catch (err: any) {
        console.error('[FilterBar] Falha ao carregar escopo:', err?.message);
        if (mounted) {
          setEscopoData({
            equipes: new Set(),
            colaboradores: new Set(),
            produtosPorEquipe: {},
            produtoDefault: FALLBACK_PRODUTO_DEFAULT,
          });
        }
      } finally {
        if (mounted) setEscopoLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [canFetchEscopo, currentUser]);

  const produtoConfigEquipeAtual = useMemo(
    () => findProdutoConfig(escopoData?.produtosPorEquipe, selectedEquipe),
    [escopoData, selectedEquipe]
  );

  useEffect(() => {
    if (!isReady) return;
    if (selectedColaborador !== "todos") {
      const selected = collaborators.find(c => c.name === selectedColaborador);
      if (selected && setSelectedCollaboratorEmail) {
        setSelectedCollaboratorEmail(selected.email);
      } else if (setSelectedCollaboratorEmail) {
        setSelectedCollaboratorEmail(null);
      }
    } else {
      if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
    }
  }, [selectedColaborador, collaborators, isReady, setSelectedCollaboratorEmail]);

  useEffect(() => {
    if (isReady) {
      setLastUpdated(new Date().toLocaleTimeString());
    }
  }, [isReady]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!isReady) {
        console.warn('⏱️ FilterBar: timeout de segurança forçando ready');
        setIsReady(true);
      }
    }, 8000);
    return () => clearTimeout(timeout);
  }, [isReady]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (equipeConfigs.length > 0) return;
      setLoadingEquipes(true);
      try {
        const equipes = await fetchEquipes();
        if (mounted) {
          setEquipeConfigs(
            equipes.map((eq: any) => ({
              id: eq.id?.toString() || `equipe_${Math.random()}`,
              nome: eq.nome,
              pesoAssinados: 3,
              pesoGanhos: 3,
              pesoequipeAssinados: 0,
              pesoequipeGanhos: 0,
              bonus: 150,
            }))
          );
        }
      } catch (_) { /* ignore */ } finally {
        if (mounted) setLoadingEquipes(false);
      }
    };
    load();
    return () => { mounted = false; };
  }, [equipeConfigs.length, setEquipeConfigs]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      if (collaborators.length > 0) {
        if (mounted) {
          setIsReady(true);
          setLoadingCollaborators(false);
        }
        return;
      }
      setLoadingCollaborators(true);
      setColabError(null);
      try {
        const collabs = await fetchCollaborators();
        if (mounted) {
          setCollaborators(collabs);
          setIsReady(true);
        }
      } catch (err: any) {
        console.error('Erro ao carregar colaboradores:', err);
        if (mounted) {
          setColabError(err.message || "Falha ao carregar colaboradores");
          setIsReady(true);
        }
      } finally {
        if (mounted) setLoadingCollaborators(false);
      }
    };
    load();
    return () => { mounted = false; };
  }, [collaborators.length, setCollaborators]);

  // ─── useEffect de restrições ────────────────────────────────────────────
  // Aplica restrições uma vez. Para admin/superior, NÃO reseta selectedProduto
  // (já vem inicializado com initialStored.produto).
  useEffect(() => {
    if (!isReady) return;
    if (hasAppliedRestrictions) return;

    if (!currentUser) {
      setHasAppliedRestrictions(true);
      return;
    }

    console.log('🔒 FilterBar: aplicando restrições de acesso para', currentUser.cargo, '— selectedProduto atual:', selectedProduto);

    if (isAssessor) {
      if (userTeam) setSelectedEquipe(userTeam);
      if (currentUser.nome) setSelectedColaborador(currentUser.nome);
    } else if (isSupervisor) {
      if (userTeam) setSelectedEquipe(userTeam);
      setSelectedColaborador("todos");
    } else {
      // Admin/superior: preserva selectedProduto (não reseta)
      setSelectedEquipe(initialStored.equipe);
      setSelectedColaborador(initialStored.colaborador);
      setSearchTerm(initialStored.searchTerm);
    }
    setHasAppliedRestrictions(true);
  }, [isReady, currentUser, isAssessor, isSupervisor, hasAppliedRestrictions, userTeam, initialStored, selectedProduto]);

  useEffect(() => {
    if (!currentUser) return;
    if (!isAssessor && !isSupervisor) return;
    if (userTeam && selectedEquipe !== userTeam) {
      setSelectedEquipe(userTeam);
    }
  }, [currentUser, isAssessor, isSupervisor, userTeam, selectedEquipe]);

  useEffect(() => {
    if (!showUnitFilter || !isUnitRestricted) return;
    if (userUnidade == null) {
      if (selectedUnit !== "todas") setSelectedUnit("todas");
      return;
    }
    if (selectedUnit !== userUnidade) {
      setSelectedUnit(userUnidade);
      setSelectedEquipe("todas");
      setSelectedColaborador("todos");
    }
  }, [showUnitFilter, isUnitRestricted, userUnidade, selectedUnit]);

  useEffect(() => {
    if (!showUnitFilter || !isReady || selectedColaborador === "todos") return;
    const selected = collaborators.find((c) => c.name === selectedColaborador);
    if (!selected || (selectedUnit !== "todas" && selected.unidadeId !== selectedUnit)) {
      setSelectedColaborador("todos");
      if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
    }
  }, [
    showUnitFilter,
    isReady,
    selectedColaborador,
    selectedUnit,
    collaborators,
    setSelectedCollaboratorEmail,
  ]);

  useEffect(() => {
    if (!isCoordenador || !escopoData) return;

    if (selectedEquipe !== 'todas'
        && !escopoData.equipes.has(normalize(selectedEquipe))) {
      setSelectedEquipe('todas');
      setSelectedColaborador('todos');
      if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
      return;
    }

    if (selectedColaborador !== 'todos') {
      const colab = collaborators.find(c => c.name === selectedColaborador);
      if (!colab || !escopoData.colaboradores.has(normalize(colab.email))) {
        setSelectedColaborador('todos');
        if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
      }
    }
  }, [isCoordenador, escopoData, selectedEquipe, selectedColaborador, collaborators, setSelectedCollaboratorEmail]);

  // Sync equipe ⇄ produto: só roda quando equipe é específica.
  useEffect(() => {
    if (!isReady || !hasAppliedRestrictions) return;
    if (!selectedEquipe || selectedEquipe === 'todas') return;

    const config = findProdutoConfig(escopoData?.produtosPorEquipe, selectedEquipe);
    if (!config) return;

    if (!config.allowChange) {
      const defMasked = maskProduct(config.default);
      if (selectedProduto !== defMasked) {
        setSelectedProduto(defMasked);
      }
      return;
    }

    const allowedMasked = config.options.map(maskProduct);
    if (!allowedMasked.includes(selectedProduto)) {
      setSelectedProduto(maskProduct(config.default));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEquipe, escopoData, isReady, hasAppliedRestrictions]);

  // ─── Apply inicial (uma única vez, depois das restrições) ──────────────
  // Debounce de 100ms para deixar os effects de sincronização (produto,
  // userTeam, unidade) assentarem antes de notificar o pai.
  useEffect(() => {
    if (!isReady || !hasAppliedRestrictions) return;
    if (initialNotifyDoneRef.current) return;

    const timer = setTimeout(() => {
      if (initialNotifyDoneRef.current) return;
      initialNotifyDoneRef.current = true;

      lastAppliedSignatureRef.current = computeSignature(
        selectedEquipe,
        selectedColaborador,
        selectedProduto,
        selectedUnit,
      );

      console.log("[FilterBar] apply inicial → notifyParent", {
        selectedEquipe,
        selectedColaborador,
        selectedProduto,
        selectedUnit,
      });

      notifyParent(selectedEquipe, selectedColaborador, selectedProduto, searchTerm);
    }, 100);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isReady,
    hasAppliedRestrictions,
    selectedEquipe,
    selectedColaborador,
    selectedProduto,
    selectedUnit,
  ]);

  const equipesDisponiveis = useMemo(() => {
    let nomes = equipeConfigs.map((eq) => eq.nome).filter((nome) => !isExcludedTeam(nome));

    if (showUnitFilter && selectedUnit !== "todas") {
      const unitTeams = new Set(
        collaborators
          .filter((collaborator) => collaborator.unidadeId === selectedUnit)
          .map((collaborator) => normalize(collaborator.equipeNome)),
      );
      nomes = nomes.filter((nome) => unitTeams.has(normalize(nome)));
    }

    if (isCoordenador) {
      if (!escopoData) {
        nomes = [];
      } else {
        nomes = nomes.filter((nome) => escopoData.equipes.has(normalize(nome)));
      }
    }

    if (deveOcultarEquipesReservadas) {
      nomes = nomes.filter((nome) => !isEquipeTravadaDestino(nome));
    }

    if ((isAssessor || isSupervisor) && currentUser) {
      nomes = nomes.filter((nome) => normalize(nome) === normalize(userTeam));
    }

    return ["todas", ...nomes];
  }, [
    equipeConfigs,
    collaborators,
    showUnitFilter,
    selectedUnit,
    isAssessor,
    isSupervisor,
    isCoordenador,
    currentUser,
    userTeam,
    escopoData,
    deveOcultarEquipesReservadas,
  ]);

  const filteredColaboradores = useMemo(() => {
    if (!isReady || !collaborators.length) return [];
    let filtered = [...collaborators];
    filtered = filtered.filter((c) => !isExcludedTeam(c.equipeNome));
    filtered = filtered.filter((c) => normalize(c.cargo) !== 'administrativo');

    if (isCoordenador) {
      if (!escopoData) {
        filtered = [];
      } else {
        filtered = filtered.filter((c) =>
          escopoData.colaboradores.has(normalize(c.email))
        );
      }
    }

    if (showUnitFilter && selectedUnit !== "todas") {
      filtered = filtered.filter((c) => c.unidadeId === selectedUnit);
    }

    if (deveOcultarEquipesReservadas) {
      filtered = filtered.filter((c) => !isEquipeTravadaDestino(c.equipeNome));
    }

    let effectiveEquipe = selectedEquipe;
    if ((isAssessor || isSupervisor) && currentUser) {
      effectiveEquipe = userTeam;
    }

    if (effectiveEquipe && effectiveEquipe !== "todas") {
      filtered = filtered.filter((c) => normalize(c.equipeNome) === normalize(effectiveEquipe));
    }

    if (isAssessor && currentUser) {
      filtered = filtered.filter((c) => c.email === currentUser.email);
    }

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (c) => c.name?.toLowerCase().includes(term) || c.email?.toLowerCase().includes(term)
      );
    }
    return filtered;
  }, [
    collaborators,
    selectedEquipe,
    isAssessor,
    isSupervisor,
    isCoordenador,
    currentUser,
    searchTerm,
    isReady,
    userTeam,
    escopoData,
    deveOcultarEquipesReservadas,
    showUnitFilter,
    selectedUnit,
  ]);

  const colaboradoresParaSelect = useMemo(() => {
    if (selectedColaborador === "todos") return filteredColaboradores;
    const exists = filteredColaboradores.some(c => c.name === selectedColaborador);
    if (exists) return filteredColaboradores;
    const selected = collaborators.find(c => c.name === selectedColaborador);
    if (!selected) return filteredColaboradores;
    if (showUnitFilter && selectedUnit !== "todas" && selected.unidadeId !== selectedUnit) {
      return filteredColaboradores;
    }
    return [selected, ...filteredColaboradores];
  }, [filteredColaboradores, selectedColaborador, collaborators, showUnitFilter, selectedUnit]);

  // ─── onFilterChangeRef para evitar stale closure ────────────────────────
  const onFilterChangeRef = useRef(onFilterChange);
  useEffect(() => {
    onFilterChangeRef.current = onFilterChange;
  }, [onFilterChange]);

  // ─── notifyParent ───────────────────────────────────────────────────────
  // Chamado APENAS pelo apply inicial (1x) e pelo botão "Atualizar Dados".
  const notifyParent = (
    equipe: string,
    colaborador: string,
    produto: string,
    _search?: string,
    unidadeId: number | "todas" = selectedUnit,
  ) => {
    if (!isReady) {
      console.warn("[FilterBar] notifyParent BLOQUEADO (isReady=false)", { equipe, colaborador, produto });
      return;
    }

    let finalEquipe = equipe;
    let finalColaborador = colaborador;

    if (currentUser && isAssessor) {
      finalEquipe = userTeam || "todas";
      finalColaborador = currentUser.nome || "todos";
    } else if (currentUser && isSupervisor) {
      finalEquipe = userTeam || "todas";
      finalColaborador = colaborador;
    }

    const colaboradorId =
      finalColaborador !== "todos"
        ? collaborators.find((c) => c.name === finalColaborador)?.id
        : undefined;

    console.log("[FilterBar] notifyParent:", {
      equipe: finalEquipe,
      colaborador: finalColaborador,
      produto,
      unidadeId: unidadeId === "todas" ? undefined : unidadeId,
      hasAppliedRestrictions,
      isReady,
    });

    onFilterChangeRef.current({
      equipe: finalEquipe,
      colaborador: finalColaborador,
      colaboradorId,
      produto,
      unidadeId: unidadeId === "todas" ? undefined : unidadeId,
    });
  };

  useEffect(() => {
    const state: StoredFilters = {
      equipe: selectedEquipe,
      colaborador: selectedColaborador,
      produto: selectedProduto,
      searchTerm,
      unidadeId: selectedUnit === "todas" ? undefined : selectedUnit,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [selectedEquipe, selectedColaborador, selectedProduto, searchTerm, selectedUnit]);

  // ─── Handlers (mudam SOMENTE estado local; não notificam o pai) ─────────

  const handleEquipeChange = (novaEquipe: string) => {
    setSelectedEquipe(novaEquipe);

    const newConfig = findProdutoConfig(escopoData?.produtosPorEquipe, novaEquipe);
    let produtoFinal = selectedProduto;

    if (newConfig) {
      if (!newConfig.allowChange) {
        produtoFinal = maskProduct(newConfig.default);
      } else {
        const allowedMasked = newConfig.options.map(maskProduct);
        if (!allowedMasked.includes(selectedProduto)) {
          produtoFinal = maskProduct(newConfig.default);
        }
      }
    } else if (novaEquipe === 'todas') {
      if (!GENERAL_PRODUCT_OPTIONS.includes(selectedProduto)) {
        produtoFinal = 'Todos';
      }
    }

    if (produtoFinal !== selectedProduto) {
      setSelectedProduto(produtoFinal);
    }

    if (selectedColaborador !== "todos" && novaEquipe !== "todas") {
      const stillInTeam = collaborators.some(
        (c) => c.name === selectedColaborador && normalize(c.equipeNome) === normalize(novaEquipe)
      );
      if (!stillInTeam) {
        setSelectedColaborador("todos");
        if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
      }
    }
    // ❌ notifyParent removido — aplica só no botão "Atualizar Dados"
  };

  const handleUnitChange = (value: string) => {
    const unidadeId = value === "todas" ? "todas" : Number(value);
    setSelectedUnit(unidadeId);
    setSelectedEquipe("todas");
    setSelectedColaborador("todos");
    if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
    // ❌ notifyParent removido
  };

  const handleColaboradorChange = (novoColaborador: string) => {
    setSelectedColaborador(novoColaborador);

    if (novoColaborador !== "todos") {
      const selected = collaborators.find(c => c.name === novoColaborador);
      if (selected && setSelectedCollaboratorEmail) {
        setSelectedCollaboratorEmail(selected.email);
      } else if (setSelectedCollaboratorEmail) {
        setSelectedCollaboratorEmail(null);
      }
    } else {
      if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
    }
    // ❌ notifyParent removido
  };

  const handleProdutoChange = (novoProduto: string) => {
    console.log("[FilterBar] handleProdutoChange:", {
      novoProduto,
      equipe: selectedEquipe,
      colaborador: selectedColaborador,
      produtoAnterior: selectedProduto,
    });
    setSelectedProduto(novoProduto);
    // ❌ notifyParent removido
  };

  const handleSearchChange = (novoTermo: string) => {
    setSearchTerm(novoTermo);
    // ❌ Bloco inteiro de onFilterChangeRef.current removido —
    // busca só filtra o dropdown localmente.
  };

  const clearFilters = () => {
    if (!isReady) return;
    if (isAssessor && currentUser) {
      setSelectedProduto("Todos");
    } else if (isSupervisor && currentUser) {
      setSelectedColaborador("todos");
      setSearchTerm("");
      setSelectedProduto("Todos");
      if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
    } else {
      setSelectedEquipe("todas");
      setSelectedColaborador("todos");
      setSelectedUnit(isUnitRestricted && userUnidade != null ? userUnidade : "todas");
      setSearchTerm("");
      setSelectedProduto("Todos");
      if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
    }
    // ❌ notifyParent removido — aplica só no botão "Atualizar Dados"
  };

  // ─── handleRefresh: ÚNICO ponto que aplica filtros ao pai ──────────────
  const handleRefresh = async () => {
    if (refreshing || !isReady) return;
    setRefreshing(true);
    try {
      // 1) Marca a signature como aplicada — impede o "apply inicial" de
      //    disparar caso o usuário clique antes do debounce.
      initialNotifyDoneRef.current = true;
      lastAppliedSignatureRef.current = computeSignature(
        selectedEquipe,
        selectedColaborador,
        selectedProduto,
        selectedUnit,
      );

      console.log("[FilterBar] Atualizar Dados → aplicar filtros", {
        selectedEquipe,
        selectedColaborador,
        selectedProduto,
        selectedUnit,
      });

      notifyParent(selectedEquipe, selectedColaborador, selectedProduto, searchTerm);

      // 2) Força bypass de cache no pai (se ele fornecer `onRefresh`).
      //    setTimeout(0) garante que o React já comitou o novo `filters`
      //    no pai antes de chamar `onRefresh()` — senão `onRefresh` usaria
      //    a closure antiga (com filtros velhos).
      if (onRefresh) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await onRefresh();
      }
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (error) {
      console.error("Erro ao atualizar dados:", error);
    } finally {
      setRefreshing(false);
    }
  };

  const hasActiveFilters = useMemo(() => {
    if (!isReady) return false;
    if (isAssessor) return selectedProduto !== "Todos";
    if (isSupervisor)
      return selectedColaborador !== "todos" || searchTerm !== "" || selectedProduto !== "Todos";
    return (
      selectedEquipe !== "todas" ||
      selectedColaborador !== "todos" ||
      (showUnitFilter && selectedUnit !== "todas") ||
      searchTerm !== "" ||
      selectedProduto !== "Todos"
    );
  }, [isReady, isAssessor, isSupervisor, selectedEquipe, selectedColaborador, searchTerm, selectedProduto, showUnitFilter, selectedUnit]);

  const isEquipeDisabled = isAssessor || isSupervisor || loadingEquipes || !isReady;
  const isColaboradorDisabled = isAssessor || loadingCollaborators || !isReady;
  const isUnitDisabled =
    loadingCollaborators || !isReady || (isUnitRestricted && userUnidade == null);
  const unitOptions = useMemo(() => {
    const units = new Set(
      collaborators
        .map((collaborator) => collaborator.unidadeId)
        .filter((id): id is number => id != null),
    );
    if (userUnidade != null) units.add(userUnidade);
    return Array.from(units)
      .filter((id) => !isUnitRestricted || id === userUnidade)
      .sort((a, b) => a - b);
  }, [collaborators, userUnidade, isUnitRestricted]);
  const isProdutoDisabled =
    isAssessor ||
    (!!produtoConfigEquipeAtual && !produtoConfigEquipeAtual.allowChange);

  if (
    !isReady ||
    loadingEquipes ||
    loadingCollaborators ||
    (canFetchEscopo && escopoLoading)
  ) {
    return (
      <div className={cn("bg-white rounded-xl border border-gray-100 shadow-sm p-4", className)}>
        <div className="flex items-center justify-center gap-2 text-gray-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-xs">Carregando filtros...</span>
        </div>
      </div>
    );
  }

  if (colabError) {
    return (
      <div className={cn("bg-white rounded-xl border border-red-200 shadow-sm p-4", className)}>
        <div className="flex items-center gap-2 text-red-600 text-xs">
          <AlertCircle className="w-4 h-4" />
          <span>Erro ao carregar colaboradores: {colabError}</span>
          <button
            onClick={() => window.location.reload()}
            className="ml-auto px-2 py-1 bg-red-100 rounded text-red-700 hover:bg-red-200"
            aria-label="Recarregar a página"
            title="Recarregar a página"
          >
            Recarregar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("bg-white rounded-xl border border-gray-100 shadow-sm p-4", className)}>
      <div className="flex flex-col gap-4">
        {collaborators.length > 5 && !isAssessor && showColaboradorFilter && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="Buscar colaborador por nome ou e-mail..."
              value={searchTerm}
              onChange={(e) => handleSearchChange(e.target.value)}
              disabled={isAssessor}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#09175b]/20"
              aria-label="Buscar colaborador por nome ou e-mail"
              title="Digite o nome ou e-mail do colaborador"
            />
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3">
          {showUnitFilter && (
            <div className="flex-1">
              <label htmlFor="filterUnidade" className="block text-[10px] font-medium text-gray-500 mb-1 flex items-center gap-1">
                <Users className="w-3 h-3" /> Unidade
              </label>
              <select
                id="filterUnidade"
                value={
                  selectedUnit === "todas" ||
                  collaborators.some((collaborator) => collaborator.unidadeId === selectedUnit)
                    ? selectedUnit
                    : isUnitRestricted && userUnidade != null
                      ? userUnidade
                      : "todas"
                }
                onChange={(e) => handleUnitChange(e.target.value)}
                disabled={isUnitDisabled}
                className={cn(
                  "w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#09175b]/20",
                  isUnitDisabled && "bg-gray-100 cursor-not-allowed",
                )}
                aria-label="Filtrar por unidade"
                title="Selecione uma unidade para filtrar os dados de seus colaboradores"
              >
                {!isUnitRestricted && <option value="todas">Todas as unidades</option>}
                {isUnitRestricted && userUnidade == null && (
                  <option value="todas">Unidade não definida</option>
                )}
                {unitOptions.map((id) => (
                    <option key={id} value={id}>
                      {id === 1 ? "Osasco" : id === 2 ? "Ribeirão Preto" : id === 3 ? "Curitiba" : id === 4 ? "HO" : `Unidade ${id}`}
                    </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex-1">
            <label htmlFor="filterEquipe" className="block text-[10px] font-medium text-gray-500 mb-1 flex items-center gap-1">
              <Briefcase className="w-3 h-3" /> Equipe
            </label>
            <select
              id="filterEquipe"
              value={selectedEquipe}
              onChange={(e) => handleEquipeChange(e.target.value)}
              disabled={isEquipeDisabled}
              className={cn(
                "w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#09175b]/20",
                isEquipeDisabled && "bg-gray-100 cursor-not-allowed"
              )}
              aria-label="Filtrar por equipe"
              title="Selecione uma equipe para filtrar os dados"
            >
              {equipesDisponiveis.map((equipe) => (
                <option key={equipe} value={equipe}>
                  {equipe === "todas" ? "Todas as equipes" : equipe}
                </option>
              ))}
            </select>
          </div>

          {showColaboradorFilter && (
            <div className="flex-1">
              <label htmlFor="filterColaborador" className="block text-[10px] font-medium text-gray-500 mb-1 flex items-center gap-1">
                <Users className="w-3 h-3" /> Colaborador
              </label>
              <select
                id="filterColaborador"
                key={colaboradoresParaSelect.length}
                value={selectedColaborador}
                onChange={(e) => handleColaboradorChange(e.target.value)}
                disabled={isColaboradorDisabled}
                className={cn(
                  "w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#09175b]/20",
                  isColaboradorDisabled && "bg-gray-100 cursor-not-allowed"
                )}
                aria-label="Filtrar por colaborador"
                title="Selecione um colaborador para filtrar os dados"
              >
                <option value="todos">Todos os colaboradores</option>
                {colaboradoresParaSelect.length === 0 && (
                  <option disabled>Nenhum colaborador disponível</option>
                )}
                {colaboradoresParaSelect.map((colab) => (
                  <option key={colab.id} value={colab.name}>
                    {colab.name}
                    {!isAssessor && !isSupervisor && selectedEquipe === "todas"
                      ? ` (${colab.equipeNome || "Sem equipe"})`
                      : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showProdutoFilter && <div className="flex-1">
            <label htmlFor="filterProduto" className="block text-[10px] font-medium text-gray-500 mb-1 flex items-center gap-1">
              <Package className="w-3 h-3" /> Produto
            </label>

            {produtoConfigEquipeAtual && !produtoConfigEquipeAtual.allowChange ? (
              <input
                id="filterProduto"
                type="text"
                value={maskProduct(produtoConfigEquipeAtual.default)}
                readOnly
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-gray-100 text-slate-500 cursor-not-allowed"
                aria-label="Produto definido pela equipe"
                title="O produto é definido automaticamente pela equipe selecionada."
              />
            ) : produtoConfigEquipeAtual && produtoConfigEquipeAtual.allowChange ? (
              <select
                id="filterProduto"
                value={selectedProduto}
                onChange={(e) => handleProdutoChange(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#09175b]/20"
                aria-label="Filtrar por produto"
                title="Selecione um produto para filtrar os dados"
              >
                {produtoConfigEquipeAtual.options.map((opt) => {
                  const masked = maskProduct(opt);
                  return <option key={masked} value={masked}>{masked}</option>;
                })}
              </select>
            ) : (
              <select
                id="filterProduto"
                value={selectedProduto}
                onChange={(e) => handleProdutoChange(e.target.value)}
                disabled={isProdutoDisabled}
                className={cn(
                  "w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-[#09175b]/20",
                  isProdutoDisabled && "bg-gray-100 cursor-not-allowed"
                )}
                aria-label="Filtrar por produto"
                title="Selecione um produto para filtrar os dados"
              >
                {GENERAL_PRODUCT_OPTIONS.map((prod) => (
                  <option key={prod} value={prod}>{prod}</option>
                ))}
              </select>
            )}
          </div>}

          {hasActiveFilters && (
            <div className="flex items-end">
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 px-3 py-2 text-xs font-medium text-gray-500 hover:text-red-500 transition-colors rounded-lg hover:bg-red-50"
                aria-label="Limpar todos os filtros"
                title="Remover todos os filtros aplicados"
              >
                <X className="w-3.5 h-3.5" /> Limpar
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 mb-2 flex-wrap">
          {refreshing && (
            <div className="flex items-center gap-1.5 text-xs text-gray-500 animate-pulse">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Atualizando dados...</span>
            </div>
          )}
          <span className="text-[10px] text-gray-400">
            Atualizado {lastUpdated || new Date().toLocaleTimeString()}
          </span>
          <button
            onClick={handleRefresh}
            disabled={refreshing || !isReady}
            className={cn(
              "ml-2 px-3 py-1.5 text-xs font-medium rounded-lg text-white transition-colors disabled:opacity-50",
              hasPendingChanges
                ? "bg-amber-600 hover:bg-amber-700"
                : "bg-[#09175b] hover:bg-[#09175b]/90",
            )}
            aria-label="Atualizar dados manualmente"
            title={
              hasPendingChanges
                ? "Aplicar os filtros selecionados e recarregar"
                : "Recarregar os dados mantendo os filtros atuais"
            }
          >
            <RefreshCw className={cn("w-3.5 h-3.5 inline mr-1", refreshing && "animate-spin")} />
            {hasPendingChanges ? "Atualizar Dados *" : "Atualizar Dados"}
          </button>
        </div>
      </div>
    </div>
  );
}