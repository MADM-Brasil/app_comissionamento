// src/components/FilterBar.tsx
import { useState, useEffect, useMemo, useRef } from "react";
import { Filter, Users, Briefcase, Search, X, Package, Loader2, AlertCircle, RefreshCw } from "lucide-react";
import { useAppStore } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import { cn } from "@/lib/utils";
import { fetchCollaborators, fetchEquipes } from "@/lib/api";

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

const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing',
  'Equipe Ariana', 'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda',
  'Equipe Reciclagem','','Equipe','Equipe Camila','Sales Ops'
];

const isExcludedTeam = (teamName: string): boolean => {
  if (!teamName) return false;
  const n = normalize(teamName);
  return EXCLUDED_TEAMS.some((t) => normalize(t) === n);
};

const TEAM_TO_PRODUCT: Record<string, string> = {
  "Equipe Concomitante": "Concomitante",
  "Equipe Tatiane": "Quinquenio",
  "Equipe Quinquênio": "Quinquenio",
};

const PRODUCT_OPTIONS = ["Todos", "Auxilio Acidente", "Quinquenio", "Concomitante"];

const STORAGE_KEY = "madm_filterBar_state_v1";

function getStoredFilters(): { equipe: string; colaborador: string; produto: string; searchTerm: string } {
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
  } catch (e) { /* ignore */ }
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

  // Inicializa estados com valores persistidos (uma única vez)
  const [initialStored] = useState(getStoredFilters);

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

  // Obtém a equipe do usuário com fallback para o registro em collaborators
  const userTeam = useMemo(() => {
    if (!currentUser) return '';
    // 1. Tenta os campos diretos do currentUser
    const direct = (currentUser.equipe || (currentUser as any).equipeNome || (currentUser as any).nome_equipe || '').trim();
    if (direct) return direct;
    // 2. Fallback: busca nos colaboradores carregados
    if (collaborators.length > 0) {
      const colab = collaborators.find(c => c.id === currentUser.id || c.email === currentUser.email);
      if (colab && colab.equipeNome) return colab.equipeNome.trim();
    }
    return '';
  }, [currentUser, collaborators]);

  // Atualiza a hora quando os dados ficam prontos
  useEffect(() => {
    if (isReady) {
      setLastUpdated(new Date().toLocaleTimeString());
    }
  }, [isReady]);

  // Timeout de segurança
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (!isReady) {
        console.warn('⏱️ FilterBar: timeout de segurança forçando ready');
        setIsReady(true);
      }
    }, 8000);
    return () => clearTimeout(timeout);
  }, [isReady]);

  // Carrega equipes (fallback)
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

  // Carrega colaboradores (fallback)
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

  // Aplica restrições de acesso (uma única vez)
  useEffect(() => {
    if (!currentUser) return;
    if (hasAppliedRestrictions) return;

    console.log('🔒 FilterBar: aplicando restrições de acesso para', currentUser.cargo);

    if (isAssessor) {
      if (userTeam) setSelectedEquipe(userTeam);
      if (currentUser.nome) setSelectedColaborador(currentUser.nome);
    } else if (isSupervisor) {
      if (userTeam) setSelectedEquipe(userTeam);
      setSelectedColaborador("todos");
    } else {
      // Administrador: mantém valores persistidos
      setSelectedEquipe(initialStored.equipe);
      setSelectedColaborador(initialStored.colaborador);
      setSelectedProduto(initialStored.produto);
      setSearchTerm(initialStored.searchTerm);
    }
    setHasAppliedRestrictions(true);
  }, [currentUser, isAssessor, isSupervisor, hasAppliedRestrictions, userTeam, initialStored]);

  // Efeito de sincronização forçada: garante que a equipe do supervisor/assessor fique sempre correta
  useEffect(() => {
    if (!currentUser) return;
    if (!isAssessor && !isSupervisor) return;
    if (userTeam && selectedEquipe !== userTeam) {
      setSelectedEquipe(userTeam);
    }
  }, [currentUser, isAssessor, isSupervisor, userTeam, selectedEquipe]);

  // Sincronia equipe ⇄ produto
  useEffect(() => {
    if (selectedEquipe && TEAM_TO_PRODUCT[selectedEquipe]) {
      const mapped = TEAM_TO_PRODUCT[selectedEquipe];
      if (selectedProduto !== mapped) setSelectedProduto(mapped);
    }
  }, [selectedEquipe]);

  // Lista de equipes disponíveis
  const equipesDisponiveis = useMemo(() => {
    let nomes = equipeConfigs.map((eq) => eq.nome).filter((nome) => !isExcludedTeam(nome));
    if ((isAssessor || isSupervisor) && currentUser) {
      nomes = nomes.filter((nome) => normalize(nome) === normalize(userTeam));
    }
    return ["todas", ...nomes];
  }, [equipeConfigs, isAssessor, isSupervisor, currentUser, userTeam]);

  // Colaboradores filtrados
  const filteredColaboradores = useMemo(() => {
    if (!isReady || !collaborators.length) return [];
    let filtered = [...collaborators];
    filtered = filtered.filter((c) => !isExcludedTeam(c.equipeNome));
    filtered = filtered.filter((c) => normalize(c.cargo) !== 'administrativo');

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
  }, [collaborators, selectedEquipe, isAssessor, isSupervisor, currentUser, searchTerm, isReady, userTeam]);

  // Notifica o pai imediatamente
  const onFilterChangeRef = useRef(onFilterChange);
  useEffect(() => {
    onFilterChangeRef.current = onFilterChange;
  }, [onFilterChange]);

  const notifyParent = (
    equipe: string,
    colaborador: string,
    produto: string,
    search?: string
  ) => {
    if (!isReady || !hasAppliedRestrictions || !currentUser) return;

    let finalEquipe = equipe;
    let finalColaborador = colaborador;
    if (isAssessor && currentUser) {
      finalEquipe = userTeam || "todas";
      finalColaborador = currentUser.nome || "todos";
    } else if (isSupervisor && currentUser) {
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

  // Persistência no localStorage
  useEffect(() => {
    const state = {
      equipe: selectedEquipe,
      colaborador: selectedColaborador,
      produto: selectedProduto,
      searchTerm,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [selectedEquipe, selectedColaborador, selectedProduto, searchTerm]);

  // Notifica o pai após ready + restrições
  const initialNotifyDone = useRef(false);
  useEffect(() => {
    if (isReady && hasAppliedRestrictions && !initialNotifyDone.current) {
      initialNotifyDone.current = true;
      notifyParent(selectedEquipe, selectedColaborador, selectedProduto, searchTerm);
    }
  }, [isReady, hasAppliedRestrictions, selectedEquipe, selectedColaborador, selectedProduto, searchTerm]);

  // Handlers de mudança
  const handleEquipeChange = (novaEquipe: string) => {
    setSelectedEquipe(novaEquipe);
    const produtoMapeado = TEAM_TO_PRODUCT[novaEquipe] || selectedProduto;
    if (TEAM_TO_PRODUCT[novaEquipe]) {
      setSelectedProduto(produtoMapeado);
    }
    notifyParent(novaEquipe, selectedColaborador, produtoMapeado);
  };

  const handleColaboradorChange = (novoColaborador: string) => {
    setSelectedColaborador(novoColaborador);
    notifyParent(selectedEquipe, novoColaborador, selectedProduto);
  };

  const handleProdutoChange = (novoProduto: string) => {
    setSelectedProduto(novoProduto);
    notifyParent(selectedEquipe, selectedColaborador, novoProduto);
  };

  const handleSearchChange = (novoTermo: string) => {
    setSearchTerm(novoTermo);
    if (!isReady || !hasAppliedRestrictions || !currentUser) return;
    let finalEquipe = selectedEquipe;
    let finalColaborador = selectedColaborador;
    if (isAssessor && currentUser) {
      finalEquipe = userTeam || "todas";
      finalColaborador = currentUser.nome || "todos";
    } else if (isSupervisor && currentUser) {
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
      notifyParent(selectedEquipe, "todos", "Todos");
    } else {
      setSelectedEquipe("todas");
      setSelectedColaborador("todos");
      setSearchTerm("");
      setSelectedProduto("Todos");
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
  const isProdutoDisabled = !!selectedEquipe && TEAM_TO_PRODUCT[selectedEquipe] !== undefined;

  // Render
  if (!isReady || loadingEquipes || loadingCollaborators) {
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
                key={filteredColaboradores.length}
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
                {filteredColaboradores.length === 0 && (
                  <option disabled>Nenhum colaborador disponível</option>
                )}
                {filteredColaboradores.map((colab) => (
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

          {/* Select Produto */}
          <div className="flex-1">
            <label htmlFor="filterProduto" className="block text-[10px] font-medium text-gray-500 mb-1 flex items-center gap-1">
              <Package className="w-3 h-3" /> Produto
            </label>
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
              {PRODUCT_OPTIONS.map((prod) => (
                <option key={prod} value={prod}>{prod}</option>
              ))}
            </select>
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