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
  }) => void;
  showColaboradorFilter?: boolean;
  className?: string;
  initialEquipe?: string;
  initialColaborador?: string;
  initialProduto?: string;
  onRefresh?: () => Promise<void>;
}

const normalize = (str: string): string => (str || '').trim().toLowerCase();

// Normalização agressiva — mesma usada em Suporte.tsx / Equipe.tsx.
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
  'Equipe Lucas Magno','Equipe SP01'
];

const isExcludedTeam = (teamName: string): boolean => {
  if (!teamName) return false;
  const n = normalize(teamName);
  return EXCLUDED_TEAMS.some((t) => normalize(t) === n);
};

// =====================================================================
// PRODUTO — espelha backend/config/teamProducts.js
// ---------------------------------------------------------------------
// Nomes internos (usados pelo HubSpot) → rótulos visíveis na UI.
// A regra do frontend aceita os rótulos como valor selecionado para
// manter compatibilidade com o resto do app (Visao_geral).
// =====================================================================
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

// Fallback local — espelha o que está em backend/config/teamProducts.js.
// Mantém o funcionamento mesmo quando o usuário não pode acessar
// /suporte/escopo (ex.: Assessor).
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

// Opções gerais exibidas quando NENHUMA equipe específica está selecionada.
// Os valores são os rótulos visíveis (compatível com o filtro do Visao_geral).
const GENERAL_PRODUCT_OPTIONS = ["Todos", "Auxilio Acidente", "Quinquenio", "Concomitante", "Fator K", "BPC/LOAS", "Isenção de IR Aposentadoria"];

// Equipes reservadas — mesma regra da página de Suporte.
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
      };
    }
  } catch { /* ignore */ }
  return { equipe: "todas", colaborador: "todos", produto: "Todos", searchTerm: "" };
}

export default function FilterBar({
  onFilterChange,
  showColaboradorFilter = true,
  className,
  initialEquipe = "todas",
  initialColaborador = "todos",
  initialProduto = "Todos",
  onRefresh,
}: FilterBarProps) {
  const { collaborators, equipeConfigs, setCollaborators, setEquipeConfigs } = useAppStore();
  const { currentUser, getAccessLevel, LEVELS } = useAccessControl();

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

  const userLevel = getAccessLevel();
  const isAssessor = userLevel === LEVELS.ASSESSOR;
  const isSupervisor = userLevel === LEVELS.SUPERVISAO;
  const isCoordenador = userLevel === LEVELS.COORDENADOR;

  // Quem pode chamar /suporte/escopo (backend exige supervisor+).
  const canFetchEscopo = userLevel >= LEVELS.SUPERVISAO;

  // Unidade do usuário (aceita unidade_id ou unidadeId).
  const userUnidadeRaw = (currentUser as any)?.unidade_id
    ?? (currentUser as any)?.unidadeId
    ?? null;
  const userUnidade = userUnidadeRaw != null ? Number(userUnidadeRaw) : null;

  // ============================================================
  // EQUIPE DO USUÁRIO
  // ============================================================
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

  // Regra da Equipe Tatiane — supervisor unidade 1 fora dela não vê a Tatiane.
  const deveOcultarEquipesReservadas = isSupervisor
    && userUnidade === 1
    && !!userTeam
    && !isEquipeTravadaDestino(userTeam);

  // ============================================================
  // ESCOPO (whitelist do Coordenador + produtos para todos que podem ver)
  // ------------------------------------------------------------
  // O backend devolve, para supervisor+:
  //   - equipes e assessores da própria unidade (usado pelo Coordenador)
  //   - produtos.porEquipe (usado aqui e no Suporte)
  // ============================================================
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

  // ============================================================
  // CONFIGURAÇÃO DE PRODUTO DA EQUIPE SELECIONADA
  // ------------------------------------------------------------
  // - Equipe específica com config: usa allowChange/options/default.
  // - Sem equipe específica ("todas") ou sem config: null → cai nas
  //   opções gerais.
  // ============================================================
  const produtoConfigEquipeAtual = useMemo(
    () => findProdutoConfig(escopoData?.produtosPorEquipe, selectedEquipe),
    [escopoData, selectedEquipe]
  );

  // ============================================================
  // SINCRONIZA E-MAIL DO COLABORADOR SELECIONADO NA STORE
  // ============================================================
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

  // ============================================================
  // CARREGA EQUIPES (FALLBACK)
  // ============================================================
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

  // ============================================================
  // CARREGA COLABORADORES (FALLBACK)
  // ============================================================
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

  // ============================================================
  // APLICA RESTRIÇÕES DE ACESSO (UMA ÚNICA VEZ)
  // ============================================================
  useEffect(() => {
    if (!isReady) return;
    if (hasAppliedRestrictions) return;

    if (!currentUser) {
      setHasAppliedRestrictions(true);
      return;
    }

    console.log('🔒 FilterBar: aplicando restrições de acesso para', currentUser.cargo);

    if (isAssessor) {
      if (userTeam) setSelectedEquipe(userTeam);
      if (currentUser.nome) setSelectedColaborador(currentUser.nome);
    } else if (isSupervisor) {
      if (userTeam) setSelectedEquipe(userTeam);
      setSelectedColaborador("todos");
    } else {
      setSelectedEquipe(initialStored.equipe);
      setSelectedColaborador(initialStored.colaborador);
      setSelectedProduto(initialStored.produto);
      setSearchTerm(initialStored.searchTerm);
    }
    setHasAppliedRestrictions(true);
  }, [isReady, currentUser, isAssessor, isSupervisor, hasAppliedRestrictions, userTeam, initialStored]);

  // ============================================================
  // SINCRONIZAÇÃO FORÇADA: assessor/supervisor sempre na sua equipe
  // ============================================================
  useEffect(() => {
    if (!currentUser) return;
    if (!isAssessor && !isSupervisor) return;
    if (userTeam && selectedEquipe !== userTeam) {
      setSelectedEquipe(userTeam);
    }
  }, [currentUser, isAssessor, isSupervisor, userTeam, selectedEquipe]);

  // ============================================================
  // COORDENADOR: revalida os valores persistidos contra o escopo
  // ============================================================
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

  // ============================================================
  // SINCRONIA EQUIPE ⇄ PRODUTO (mesma lógica do Suporte)
  // ------------------------------------------------------------
  //   - Equipe com allowChange=false → força default mascarado.
  //   - Equipe com allowChange=true  → se o valor atual não está nas
  //     opções, cai no default mascarado.
  //   - Sem equipe selecionada → sem override.
  // ============================================================
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

  // ============================================================
  // LISTA DE EQUIPES DISPONÍVEIS
  // ============================================================
  const equipesDisponiveis = useMemo(() => {
    let nomes = equipeConfigs.map((eq) => eq.nome).filter((nome) => !isExcludedTeam(nome));

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
    isAssessor,
    isSupervisor,
    isCoordenador,
    currentUser,
    userTeam,
    escopoData,
    deveOcultarEquipesReservadas,
  ]);

  // ============================================================
  // COLABORADORES FILTRADOS (para o dropdown)
  // ============================================================
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
  ]);

  const colaboradoresParaSelect = useMemo(() => {
    if (selectedColaborador === "todos") return filteredColaboradores;
    const exists = filteredColaboradores.some(c => c.name === selectedColaborador);
    if (exists) return filteredColaboradores;
    const selected = collaborators.find(c => c.name === selectedColaborador);
    if (!selected) return filteredColaboradores;
    return [selected, ...filteredColaboradores];
  }, [filteredColaboradores, selectedColaborador, collaborators]);

  // ============================================================
  // NOTIFICA O PAI
  // ============================================================
  const onFilterChangeRef = useRef(onFilterChange);
  useEffect(() => {
    onFilterChangeRef.current = onFilterChange;
  }, [onFilterChange]);

  const notifyParent = (
    equipe: string,
    colaborador: string,
    produto: string,
    _search?: string
  ) => {
    if (!isReady || !hasAppliedRestrictions) return;

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

    onFilterChangeRef.current({
      equipe: finalEquipe,
      colaborador: finalColaborador,
      colaboradorId,
      produto,
    });
  };

  // ============================================================
  // PERSISTÊNCIA
  // ============================================================
  useEffect(() => {
    const state: StoredFilters = {
      equipe: selectedEquipe,
      colaborador: selectedColaborador,
      produto: selectedProduto,
      searchTerm,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [selectedEquipe, selectedColaborador, selectedProduto, searchTerm]);

  // ============================================================
  // NOTIFICA O PAI APÓS READY + RESTRIÇÕES
  // ============================================================
  const initialNotifyDone = useRef(false);
  useEffect(() => {
    if (!isReady || !hasAppliedRestrictions) return;
    if (initialNotifyDone.current) return;
    initialNotifyDone.current = true;
    notifyParent(selectedEquipe, selectedColaborador, selectedProduto, searchTerm);
  }, [isReady, hasAppliedRestrictions, selectedEquipe, selectedColaborador, selectedProduto, searchTerm]);

  // ============================================================
  // HANDLERS
  // ============================================================
  const handleEquipeChange = (novaEquipe: string) => {
    setSelectedEquipe(novaEquipe);

    // ---- Sync do produto com a nova equipe (mesma lógica do Suporte) ----
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
      // Se voltou para "todas" e o valor atual não está nas opções gerais,
      // reseta para "Todos".
      if (!GENERAL_PRODUCT_OPTIONS.includes(selectedProduto)) {
        produtoFinal = 'Todos';
      }
    }

    if (produtoFinal !== selectedProduto) {
      setSelectedProduto(produtoFinal);
    }

    // ---- Reset do colaborador se ele não pertence à nova equipe ----
    let nextColaborador = selectedColaborador;
    if (selectedColaborador !== "todos" && novaEquipe !== "todas") {
      const stillInTeam = collaborators.some(
        (c) => c.name === selectedColaborador && normalize(c.equipeNome) === normalize(novaEquipe)
      );
      if (!stillInTeam) {
        nextColaborador = "todos";
        setSelectedColaborador("todos");
        if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
      }
    }

    notifyParent(novaEquipe, nextColaborador, produtoFinal);
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

    notifyParent(selectedEquipe, novoColaborador, selectedProduto);
  };

  const handleProdutoChange = (novoProduto: string) => {
    setSelectedProduto(novoProduto);
    notifyParent(selectedEquipe, selectedColaborador, novoProduto);
  };

  const handleSearchChange = (novoTermo: string) => {
    setSearchTerm(novoTermo);
    if (!isReady || !hasAppliedRestrictions) return;

    let finalEquipe = selectedEquipe;
    let finalColaborador = selectedColaborador;
    if (currentUser && isAssessor) {
      finalEquipe = userTeam || "todas";
      finalColaborador = currentUser.nome || "todos";
    } else if (currentUser && isSupervisor) {
      finalEquipe = userTeam || "todas";
    }
    const colaboradorId =
      finalColaborador !== "todos"
        ? collaborators.find((c) => c.name === finalColaborador)?.id
        : undefined;

    onFilterChangeRef.current({
      equipe: finalEquipe,
      colaborador: finalColaborador,
      colaboradorId,
      produto: selectedProduto,
    });
  };

  const clearFilters = () => {
    if (!isReady) return;
    if (isAssessor && currentUser) {
      setSelectedProduto("Todos");
      notifyParent(selectedEquipe, selectedColaborador, "Todos");
    } else if (isSupervisor && currentUser) {
      setSelectedColaborador("todos");
      setSearchTerm("");
      setSelectedProduto("Todos");
      if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
      notifyParent(selectedEquipe, "todos", "Todos");
    } else {
      setSelectedEquipe("todas");
      setSelectedColaborador("todos");
      setSearchTerm("");
      setSelectedProduto("Todos");
      if (setSelectedCollaboratorEmail) setSelectedCollaboratorEmail(null);
      notifyParent("todas", "todos", "Todos");
    }
  };

  const handleRefresh = async () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
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
      searchTerm !== "" ||
      selectedProduto !== "Todos"
    );
  }, [isReady, isAssessor, isSupervisor, selectedEquipe, selectedColaborador, searchTerm, selectedProduto]);

  const isEquipeDisabled = isAssessor || isSupervisor || loadingEquipes || !isReady;
  const isColaboradorDisabled = isAssessor || loadingCollaborators || !isReady;
  const isProdutoDisabled =
    isAssessor ||
    (!!produtoConfigEquipeAtual && !produtoConfigEquipeAtual.allowChange);

  // ============================================================
  // RENDER: LOADING
  // ------------------------------------------------------------
  // Bloqueia enquanto o escopo do Supervisor/Coordenador estiver
  // carregando (evita mostrar filtros errados por um frame).
  // ============================================================
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

  // ============================================================
  // RENDER: ERRO
  // ============================================================
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

  // ============================================================
  // RENDER PRINCIPAL
  // ============================================================
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
          {/* Select Equipe */}
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

          {/* Select Colaborador */}
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

          {/* Select Produto — segue a mesma regra do Suporte */}
          <div className="flex-1">
            <label htmlFor="filterProduto" className="block text-[10px] font-medium text-gray-500 mb-1 flex items-center gap-1">
              <Package className="w-3 h-3" /> Produto
            </label>

            {produtoConfigEquipeAtual && !produtoConfigEquipeAtual.allowChange ? (
              // Equipe trava o produto no próprio default → readOnly (como no Suporte).
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
              // Equipe permite alternar → select apenas com as opções permitidas.
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
              // Sem equipe específica (ou equipe sem config) → opções gerais.
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
          </div>

          {/* Botão Limpar */}
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

        {/* Botão e indicador de atualização */}
        {onRefresh && (
          <div className="flex items-center justify-end gap-2 mb-2">
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
              disabled={refreshing}
              className="ml-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#09175b] text-white hover:bg-[#09175b]/90 disabled:opacity-50 transition-colors"
              aria-label="Atualizar dados manualmente"
              title="Clique para recarregar os dados mantendo os filtros atuais"
            >
              <RefreshCw className={cn("w-3.5 h-3.5 inline mr-1", refreshing && "animate-spin")} />
              Atualizar Dados
            </button>
          </div>
        )}
      </div>
    </div>
  );
}