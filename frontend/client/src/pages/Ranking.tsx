// src/pages/Ranking.tsx
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { useAppStore } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import { getAccessLevel, LEVELS } from "@/lib/accessControl";
import {
  Trophy, Star, Crown, Medal,
  FileText, CheckCircle, Award, Users, User, Package, Briefcase, Loader2, RefreshCw, TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchCollaborators,
  fetchEmitidos,
  fetchAssinados,
  fetchProtocolados,
  fetchGanhos,
  fetchPerdidos,
  API_BASE,
} from "@/lib/api";
import madm_dashboard_growth from "@/components/img/madm-dashboard-growth.png";

const RANKING_BG = madm_dashboard_growth;

// ============================================================
// CONFIGURAÇÃO DE PESOS
// ============================================================
const WEIGHTS: Record<SortMetric, number> = {
  ganhos: 4,
  assinados: 3,
  protocolados: 1,
  emitidos: 2,
};

// ============================================================
// CONSTANTES DE EXCLUSÃO
// ============================================================
const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing','Departamento Comercial',
  'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda',
  'Equipe Reciclagem','','Equipe','Equipe Camila','Sales Ops','Equipe Elizandra','Equipe Bruno Abreu',
  'Equipe Lucas Magno','Equipe SP1','Equipe Marcia','Equipe Lucilene','backoffice'
];

const EXCLUDED_CARGOS = [
  "desativado","assistente","analista juridico","gestor de projetos","analista",
  "analista de discadora","supervisor","coordenador","salesops","ceo",
  "analista de crm","desenvolvedor","diretora","analista de dados","desenvolvedor make",
];

// Equipes reservadas — mesma regra da página de Suporte/Equipe/Visão Geral.
const EQUIPES_TRAVADAS_DESTINO = ['equipe tatiane'];

type RankingType = "colaborador" | "equipe";
type SortMetric = "emitidos" | "assinados" | "protocolados" | "ganhos";

interface RankingItem {
  position: number;
  name: string;
  emitidos: number;
  assinados: number;
  protocolados: number;
  ganhos: number;
  score: number;
  avatar: string;
  trend: "up" | "down" | "same";
  isCurrentUser?: boolean;
  equipe?: string;
  id?: string;
}

interface TeamRankingItem {
  position: number;
  name: string;
  emitidos: number;
  assinados: number;
  protocolados: number;
  ganhos: number;
  score: number;
  avatar: string;
  trend: "up" | "down" | "same";
  membersCount: number;
}

const normalize = (str: string): string =>
  (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const normalizeKey = (str: string | undefined | null): string =>
  String(str || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

function isEquipeTravadaDestino(nome: string | undefined | null): boolean {
  const n = normalizeKey(nome);
  return EQUIPES_TRAVADAS_DESTINO.includes(n);
}

const isExcludedTeam = (teamName: string) => EXCLUDED_TEAMS.includes(teamName);
const isExcludedCargo = (cargo: string) =>
  EXCLUDED_CARGOS.some(g => normalize(g) === normalize(cargo));

const isDesativado = (c: any) => {
  const cargo = normalize(c.cargo);
  const equipe = normalize(c.equipeNome);
  return cargo === 'desativado' || equipe.includes('desativado');
};

// ============================================================
// CORREÇÃO — comparação robusta colaborador ↔ usuário logado
// ------------------------------------------------------------
//  Após o login, o `currentUser.id` pode vir num formato
//  diferente do `colaborador.id`. Comparar por e-mail
//  (case-insensitive) resolve o bug de "VOCÊ" não aparecer no
//  ranking / dados próprios zerados no primeiro acesso.
// ============================================================
function isSameColaborator(colab: any, user: any): boolean {
  if (!colab || !user) return false;
  const colabEmail = String(colab.email || "").toLowerCase().trim();
  const userEmail = String(user.email || "").toLowerCase().trim();
  if (colabEmail && userEmail && colabEmail === userEmail) return true;
  const colabId = colab.id;
  const userId = user.id;
  if (colabId == null || userId == null) return false;
  return String(colabId) === String(userId);
}

const teamToProductMapping: Record<string, string> = {
  "Equipe Concomitante": "Concomitante",
  "Equipe Tatiane": "Quinquenio",
  "Equipe Quinquênio": "Quinquenio",
};

function RankBadge({ position }: { position: number }) {
  if (position === 1) {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg, #ffcc00, #f5a623)" }}>
        <Crown className="w-4 h-4 text-white" />
      </div>
    );
  }
  if (position === 2) {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg, #e2e8f0, #cbd5e1)" }}>
        <Medal className="w-4 h-4 text-[#475569]" />
      </div>
    );
  }
  if (position === 3) {
    return (
      <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "linear-gradient(135deg, #d97706, #b45309)" }}>
        <Medal className="w-4 h-4 text-white" />
      </div>
    );
  }
  return (
    <div className="w-8 h-8 rounded-full flex items-center justify-center bg-[#f1f5f9]">
      <span className="text-xs font-bold text-[#64748b]">#{position}</span>
    </div>
  );
}

function calculateWeightedScore(
  item: { ganhos: number; assinados: number; protocolados: number; emitidos: number },
  activeMetrics: SortMetric[]
): number {
  let score = 0;
  for (const metric of activeMetrics) {
    const weight = WEIGHTS[metric] || 0;
    const value = item[metric] || 0;
    score += value * weight;
  }
  return score;
}

function compareByScore(
  a: { ganhos: number; assinados: number; protocolados: number; emitidos: number; score: number },
  b: { ganhos: number; assinados: number; protocolados: number; emitidos: number; score: number },
  activeMetrics: SortMetric[]
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.ganhos !== b.ganhos) return b.ganhos - a.ganhos;
  if (a.assinados !== b.assinados) return b.assinados - a.assinados;
  if (a.protocolados !== b.protocolados) return b.protocolados - a.protocolados;
  if (a.emitidos !== b.emitidos) return b.emitidos - a.emitidos;
  return 0;
}

const formatInt = (num: number) => num?.toLocaleString('pt-BR') ?? '0';

// Ranking de colaboradores exibe até 20. Ranking de equipes exibe até 5.
const MAX_DISPLAY_ITEMS = {
  colaborador: 20,
  equipe: 5,
} as const;

export default function Ranking() {
  const {
    currentStartDate,
    currentEndDate,
    equipeConfigs,
    currentUser,
  } = useAppStore();

  const { currentUser: accessUser } = useAccessControl();
  const userLevel = getAccessLevel(accessUser?.cargo, accessUser?.status);
  const isAssessor = userLevel === LEVELS.ASSESSOR;
  const isSupervisor = userLevel === LEVELS.SUPERVISAO;
  const isCoordenador = userLevel === LEVELS.COORDENADOR;

  // Unidade do usuário — aceita unidade_id ou unidadeId.
  const userUnidadeRaw = (accessUser as any)?.unidade_id
    ?? (accessUser as any)?.unidadeId
    ?? null;
  const userUnidade = userUnidadeRaw != null ? Number(userUnidadeRaw) : null;

  const userTeam = useMemo(() => {
    if (!accessUser) return '';
    const direct = (accessUser as any)?.equipe
      || (accessUser as any)?.equipeNome
      || (accessUser as any)?.nome_equipe
      || '';
    return String(direct).trim();
  }, [accessUser]);

  const [allCollaborators, setAllCollaborators] = useState<any[]>([]);
  const [metricsData, setMetricsData] = useState<Record<string, { emitidos: number; assinados: number; protocolados: number; ganhos: number; perdidos: number }>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rankingType, setRankingType] = useState<RankingType>("colaborador");
  const [activeSortMetrics, setActiveSortMetrics] = useState<SortMetric[]>([
    "ganhos", "assinados", "protocolados", "emitidos"
  ]);
  const [selectedProduct, setSelectedProduct] = useState<string>("Todos");
  const [selectedTeam, setSelectedTeam] = useState<string>("todas");

  // ============================================================
  //  ESCOPO DO COORDENADOR (whitelist via /suporte/escopo)
  // ============================================================
  const [coordenadorEscopo, setCoordenadorEscopo] = useState<{
    equipes: Set<string>;
    colaboradores: Set<string>;
  } | null>(null);
  const [coordenadorEscopoLoading, setCoordenadorEscopoLoading] = useState(false);

  useEffect(() => {
    if (!isCoordenador || !accessUser) {
      setCoordenadorEscopo(null);
      return;
    }
    let mounted = true;
    (async () => {
      setCoordenadorEscopoLoading(true);
      try {
        const res = await fetch(`${API_BASE}/suporte/escopo`, { credentials: "include" });
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
        setCoordenadorEscopo({ equipes, colaboradores });
      } catch (err: any) {
        console.error("[Ranking] Falha ao carregar escopo do Coordenador:", err?.message);
        if (mounted) setCoordenadorEscopo({ equipes: new Set(), colaboradores: new Set() });
      } finally {
        if (mounted) setCoordenadorEscopoLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [isCoordenador, accessUser]);

  const initialLoadDone = useRef(false);
  const lastDatesRef = useRef({ start: currentStartDate, end: currentEndDate });
  const lastFiltersRef = useRef({ product: selectedProduct, team: selectedTeam, type: rankingType });
  const timeoutIdRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  const lastFetchTime = useRef<number>(0);
  const CACHE_TTL = 60000;

  // ========== FUNÇÃO PARA CARREGAR DADOS (com cache) ==========
  const loadAllData = useCallback(async (showRefreshing = false) => {
    const datesChanged =
      currentStartDate !== lastDatesRef.current.start ||
      currentEndDate !== lastDatesRef.current.end;
    const filtersChanged =
      selectedProduct !== lastFiltersRef.current.product ||
      selectedTeam !== lastFiltersRef.current.team ||
      rankingType !== lastFiltersRef.current.type;

    if (!showRefreshing && initialLoadDone.current && !datesChanged && !filtersChanged) return;

    if (showRefreshing) setRefreshing(true);
    try {
      const now = Date.now();
      const shouldFetch = (now - lastFetchTime.current) > CACHE_TTL ||
                          datesChanged || filtersChanged || allCollaborators.length === 0 || showRefreshing;

      if (shouldFetch) {
        const collabs = await fetchCollaborators();
        if (!collabs || collabs.length === 0) {
          setAllCollaborators([]);
          setMetricsData({});
          return;
        }

        if (!currentStartDate || !currentEndDate) {
          setAllCollaborators(collabs);
          setMetricsData({});
          return;
        }

        const endInclusive = new Date(currentEndDate + "T23:59:59");
        const endExclusive = new Date(endInclusive);
        endExclusive.setDate(endExclusive.getDate() + 1);
        const endParam = endExclusive.toISOString().slice(0, 10);
        const params = { start: currentStartDate, end: endParam };

        const [emitidos, assinados, protocolados, ganhos, perdidos] = await Promise.all([
          fetchEmitidos(params),
          fetchAssinados(params),
          fetchProtocolados(params),
          fetchGanhos(params),
          fetchPerdidos(params),
        ]);

        const metricsMap: Record<string, { emitidos: number; assinados: number; protocolados: number; ganhos: number; perdidos: number }> = {};
        const aggregate = (data: any[], key: keyof typeof metricsMap[string]) => {
          data.forEach((item: any) => {
            const name = item.colaborador;
            if (!name) return;
            if (!metricsMap[name]) {
              metricsMap[name] = { emitidos: 0, assinados: 0, protocolados: 0, ganhos: 0, perdidos: 0 };
            }
            metricsMap[name][key] += Number(item.total) || 0;
          });
        };
        aggregate(emitidos, 'emitidos');
        aggregate(assinados, 'assinados');
        aggregate(protocolados, 'protocolados');
        aggregate(ganhos, 'ganhos');
        aggregate(perdidos, 'perdidos');

        setAllCollaborators(collabs);
        setMetricsData(metricsMap);
        lastFetchTime.current = Date.now();
      }

      lastDatesRef.current = { start: currentStartDate, end: currentEndDate };
      lastFiltersRef.current = { product: selectedProduct, team: selectedTeam, type: rankingType };
      initialLoadDone.current = true;
    } catch (err) {
      console.error('Erro ao carregar dados do ranking:', err);
    } finally {
      if (showRefreshing && isMountedRef.current) setRefreshing(false);
      setLoading(false);
    }
  }, [currentStartDate, currentEndDate, selectedProduct, selectedTeam, rankingType, allCollaborators.length]);

  // ========== CARREGAMENTO INICIAL ==========
  useEffect(() => {
    isMountedRef.current = true;
    if (!currentStartDate || !currentEndDate) {
      setLoading(false);
      return;
    }

    if (initialLoadDone.current) {
      setLoading(false);
      return;
    }

    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    timeoutIdRef.current = setTimeout(() => {
      if (isMountedRef.current && loading) {
        console.warn("⏱️ Ranking: timeout de segurança forçando fim do loading");
        setLoading(false);
      }
    }, 15000);

    setLoading(true);
    loadAllData(false).finally(() => {
      if (isMountedRef.current) {
        setLoading(false);
        if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
      }
    });

    return () => {
      isMountedRef.current = false;
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
    };
  }, [currentStartDate, currentEndDate, loadAllData, loading]);

  // ========== FILTROS ==========
  const productToGroup: Record<string, string | string[] | undefined> = {
    Todos: undefined,
    "Auxilio Acidente": "Elite",
    Quinquenio: ["Quinquenio", "Quinquênio"],
    Concomitante: "Concomitante",
  };
  const productOptions = ["Todos", "Auxilio Acidente", "Quinquenio", "Concomitante"];

  const equipeOptions = useMemo(() => {
    let equipeNomes = equipeConfigs
      .map((eq) => eq.nome)
      .filter((nome) => !isExcludedTeam(nome));

    // Coordenador: apenas equipes da própria unidade.
    if (isCoordenador) {
      if (!coordenadorEscopo) equipeNomes = [];
      else equipeNomes = equipeNomes.filter((nome) => coordenadorEscopo.equipes.has(normalize(nome)));
    }

    // Regra da Tatiane: supervisor unidade 1 fora da Tatiane não vê a Tatiane.
    const ocultarEquipesReservadas = isSupervisor
      && userUnidade === 1
      && !!userTeam
      && !isEquipeTravadaDestino(userTeam);
    if (ocultarEquipesReservadas) {
      equipeNomes = equipeNomes.filter((nome) => !isEquipeTravadaDestino(nome));
    }

    // Supervisor: travado na própria equipe.
    if (isSupervisor && userTeam) {
      equipeNomes = equipeNomes.filter((nome) => normalize(nome) === normalize(userTeam));
    }

    return ["todas", ...equipeNomes];
  }, [equipeConfigs, isCoordenador, coordenadorEscopo, isSupervisor, userUnidade, userTeam]);

  useEffect(() => {
    if (selectedTeam === "todas") return;
    if (teamToProductMapping[selectedTeam]) {
      const mappedProduct = teamToProductMapping[selectedTeam];
      if (selectedProduct !== mappedProduct && selectedProduct !== "Todos")
        setSelectedProduct(mappedProduct);
    } else {
      if (selectedProduct !== "Auxilio Acidente" && selectedProduct !== "Todos")
        setSelectedProduct("Auxilio Acidente");
    }
  }, [selectedTeam]);

  // ============================================================
  //  COLABORADORES ELEGÍVEIS (com restrição de unidade)
  // ============================================================
  const rankingCollaborators = useMemo(() => {
    let filtered = allCollaborators.filter(c => {
      if (isDesativado(c)) return false;
      if (isExcludedCargo(c.cargo)) return false;
      if (isExcludedTeam(c.equipeNome)) return false;
      return true;
    });

    // Coordenador: whitelist de e-mails da própria unidade.
    if (isCoordenador) {
      if (!coordenadorEscopo) return [];
      filtered = filtered.filter(c => coordenadorEscopo.colaboradores.has(normalize(c.email)));
    }

    // Regra da Tatiane: ocultar para supervisor de unidade 1 fora dela.
    const ocultarEquipesReservadas = isSupervisor
      && userUnidade === 1
      && !!userTeam
      && !isEquipeTravadaDestino(userTeam);
    if (ocultarEquipesReservadas) {
      filtered = filtered.filter(c => !isEquipeTravadaDestino(c.equipeNome));
    }

    // Assessor: apenas ele mesmo.
    if (isAssessor && accessUser?.email) {
      filtered = filtered.filter(c => normalize(c.email) === normalize(accessUser.email));
    }

    // Supervisor: apenas a própria equipe.
    if (isSupervisor && userTeam) {
      filtered = filtered.filter(c => normalize(c.equipeNome) === normalize(userTeam));
    }

    // Filtro por produto.
    if (selectedProduct !== "Todos") {
      const group = productToGroup[selectedProduct];
      if (group) {
        if (Array.isArray(group)) {
          filtered = filtered.filter(c => group.includes(c.cargo));
        } else {
          filtered = filtered.filter(c => c.cargo === group);
        }
      }
    }

    // Filtro por equipe (só para ranking individual; equipe já está no próprio eixo).
    if (rankingType === "colaborador" && selectedTeam !== "todas") {
      filtered = filtered.filter(c => c.equipeNome === selectedTeam);
    }

    return filtered;
  }, [
    allCollaborators,
    selectedProduct,
    rankingType,
    selectedTeam,
    isAssessor,
    isSupervisor,
    isCoordenador,
    coordenadorEscopo,
    userUnidade,
    userTeam,
    accessUser,
  ]);

  // ========== RANKING INDIVIDUAL ==========
  const individualRanking = useMemo(() => {
    let items: RankingItem[] = rankingCollaborators.map((colab) => {
      const metrics = metricsData[colab.name] || { emitidos: 0, assinados: 0, protocolados: 0, ganhos: 0, perdidos: 0 };
      const base = {
        id: colab.id,
        name: colab.name,
        emitidos: metrics.emitidos || 0,
        assinados: metrics.assinados || 0,
        protocolados: metrics.protocolados || 0,
        ganhos: metrics.ganhos || 0,
        avatar: colab.avatar || colab.name.charAt(0).toUpperCase(),
        trend: "same" as const,
        // ⚠️ Correção: usa `isSameColaborator` (email/id) em vez de
        // comparar `colab.id === currentUser?.id || colab.name === currentUser?.nome`.
        // Garante que "VOCÊ" apareça desde o primeiro acesso pós-login.
        isCurrentUser: isSameColaborator(colab, currentUser),
        equipe: colab.equipeNome,
      };
      const score = calculateWeightedScore(base, activeSortMetrics);
      return { ...base, score, position: 0 };
    });
    items.sort((a, b) => compareByScore(a, b, activeSortMetrics));
    return items.map((item, idx) => ({ ...item, position: idx + 1 }));
  }, [rankingCollaborators, metricsData, currentUser, activeSortMetrics]);

  // ========== RANKING DE EQUIPES ==========
  const teamRanking = useMemo(() => {
    const teamsMap = new Map<
      string,
      { emitidos: number; assinados: number; protocolados: number; ganhos: number; members: string[] }
    >();
    rankingCollaborators.forEach((collab) => {
      const equipe = collab.equipeNome;
      if (!equipe || isExcludedTeam(equipe)) return;
      if (!teamsMap.has(equipe)) {
        teamsMap.set(equipe, { emitidos: 0, assinados: 0, protocolados: 0, ganhos: 0, members: [] });
      }
      const team = teamsMap.get(equipe)!;
      const metrics = metricsData[collab.name] || { emitidos: 0, assinados: 0, protocolados: 0, ganhos: 0, perdidos: 0 };
      team.emitidos += metrics.emitidos || 0;
      team.assinados += metrics.assinados || 0;
      team.protocolados += metrics.protocolados || 0;
      team.ganhos += metrics.ganhos || 0;
      team.members.push(collab.name);
    });
    let teamItems: TeamRankingItem[] = Array.from(teamsMap.entries()).map(([name, data]) => {
      const base = {
        name,
        emitidos: data.emitidos,
        assinados: data.assinados,
        protocolados: data.protocolados,
        ganhos: data.ganhos,
        avatar: name.charAt(0).toUpperCase(),
        trend: "same" as const,
        membersCount: data.members.length,
      };
      const score = calculateWeightedScore(base, activeSortMetrics);
      return { ...base, score, position: 0 };
    });
    teamItems.sort((a, b) => compareByScore(a, b, activeSortMetrics));
    return teamItems.map((item, idx) => ({ ...item, position: idx + 1 }));
  }, [rankingCollaborators, metricsData, activeSortMetrics]);

  const fullRanking = rankingType === "colaborador" ? individualRanking : teamRanking;

  const maxDisplayItems = MAX_DISPLAY_ITEMS[rankingType];
  const displayRanking = fullRanking.slice(0, maxDisplayItems);
  const top3 = fullRanking.slice(0, 3);

  const myIndividualRank = useMemo(
    () => individualRanking.find((item) => item.isCurrentUser),
    [individualRanking]
  );
  const myTeamRank = useMemo(() => {
    if (rankingType !== "equipe" || !currentUser?.equipe) return null;
    const userTeamNorm = normalize(currentUser.equipe);
    return teamRanking.find((team) => normalize(team.name) === userTeamNorm);
  }, [rankingType, teamRanking, currentUser]);

  // ⚠️ Correção: usa `isSameColaborator` para garantir que, após o
  // login, os números próprios (`myEmitidos`, `myAssinados`, etc.)
  // sejam preenchidos mesmo que o id venha em formato diferente.
  const currentUserData = allCollaborators.find(c => isSameColaborator(c, currentUser));

  const myEmitidos = metricsData[currentUserData?.name]?.emitidos || 0;
  const myAssinados = metricsData[currentUserData?.name]?.assinados || 0;
  const myProtocolados = metricsData[currentUserData?.name]?.protocolados || 0;
  const myGanhos = metricsData[currentUserData?.name]?.ganhos || 0;

  const getAvatar = (item: any) =>
    rankingType === "colaborador" ? item.avatar || item.name.charAt(0) : item.avatar;
  const getPodiumStyle = (position: number) => {
    if (position === 1) return { background: "linear-gradient(135deg, #ffcc00, #f59e0b)", color: "white", boxShadow: "0 0 0 4px rgba(241, 207, 14, 0.3)" };
    if (position === 2) return { background: "linear-gradient(135deg, #e2e8f0, #cbd5e1)", color: "#475569" };
    return { background: "linear-gradient(135deg, #d97706, #b45309)", color: "white" };
  };

  const toggleSortMetric = (metric: SortMetric) => {
    setActiveSortMetrics((prev) => {
      if (prev.includes(metric)) {
        const newArr = prev.filter((m) => m !== metric);
        return newArr.length === 0 ? ["ganhos"] : newArr;
      } else {
        return [...prev, metric];
      }
    });
  };

  const metricLabels: Record<SortMetric, string> = {
    emitidos: "Emitidos",
    assinados: "Assinados",
    protocolados: "Protocolados",
    ganhos: "Ganhos",
  };

  // Bloqueio de render enquanto o escopo do Coordenador ainda carrega.
  if ((loading && allCollaborators.length === 0) || (isCoordenador && coordenadorEscopoLoading)) {
    return (
      <DashboardLayout title="Ranking" subtitle="Carregando dados...">
        <div className="flex items-center justify-center h-64">
          <div className="text-center text-[#64748b]">
            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2" />
            <p>Carregando ranking...</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  if (fullRanking.length === 0 && !loading && allCollaborators.length > 0) {
    return (
      <DashboardLayout title="Ranking" subtitle="Nenhum dado encontrado">
        <div className="flex items-center justify-center h-64">
          <div className="text-center text-[#64748b]">
            <p>Nenhum colaborador elegível para o ranking com os filtros atuais.</p>
            <p className="text-sm">Verifique se os dados do período foram carregados ou ajuste os filtros.</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout
      title="Ranking de Vendedores"
      subtitle="Veja quem são os melhores vendedores do mês e acompanhe sua posição!"
    >
      {/* Banner */}
      <div
        className="relative rounded-2xl overflow-hidden mb-6 animate-fade-in-up"
        style={{ backgroundImage: `url(${RANKING_BG})`, backgroundSize: "cover", backgroundPosition: "center", minHeight: "180px" }}
      >
        <div className="absolute inset-0 rounded-2xl" style={{ background: "rgba(15, 23, 42, 0.7)" }} />
        <div className="relative z-10 p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Trophy className="w-5 h-5 text-[#ffcc00]" />
              <span className="text-[#ffcc00] text-sm font-bold uppercase tracking-wide">Ranking do Mês</span>
            </div>
            {rankingType === "colaborador" ? (
              myIndividualRank ? (
                <>
                  <h2 className="text-white text-2xl font-black mb-1">
                    Você está em #{myIndividualRank.position} lugar
                  </h2>
                  <p className="text-white/70 text-sm">
                    {myIndividualRank.position > 1
                      ? `Subam ${myIndividualRank.position - 1} ${myIndividualRank.position - 1 === 1 ? "posição" : "posições"} para liderar!`
                      : "Parabéns! Você é o líder do ranking!"}
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-white text-2xl font-black mb-1">Top 3 do Mês</h2>
                  <p className="text-white/70 text-sm">
                    Você não está no ranking. Veja os líderes abaixo.
                  </p>
                </>
              )
            ) : (
              myTeamRank ? (
                <>
                  <h2 className="text-white text-2xl font-black mb-1">
                    Sua equipe está em #{myTeamRank.position} lugar
                  </h2>
                  <p className="text-white/70 text-sm">
                    {myTeamRank.position > 1
                      ? `Subam ${myTeamRank.position - 1} ${myTeamRank.position - 1 === 1 ? "posição" : "posições"} para liderar!`
                      : "Parabéns! Sua equipe lidera o ranking!"}
                  </p>
                </>
              ) : (
                <>
                  <h2 className="text-white text-2xl font-black mb-1">Top 3 Equipes</h2>
                  <p className="text-white/70 text-sm">
                    Sua equipe ainda não está no ranking. Conheça as líderes abaixo.
                  </p>
                </>
              )
            )}
          </div>
          <div className="text-right">
            <div className="flex items-center gap-3 justify-end mb-1">
              <div className="flex items-center gap-1">
                <FileText className="w-3 h-3 text-[#ffcc00]" />
                <span className="text-white/60 text-[10px]">Emitidos</span>
                <span className="text-white font-bold text-sm">{myEmitidos}</span>
              </div>
              <div className="flex items-center gap-1">
                <CheckCircle className="w-3 h-3 text-[#ffcc00]" />
                <span className="text-white/60 text-[10px]">Assinados</span>
                <span className="text-white font-bold text-sm">{myAssinados}</span>
              </div>
              <div className="flex items-center gap-1">
                <Award className="w-3 h-3 text-[#ffcc00]" />
                <span className="text-white/60 text-[10px]">Protocolados</span>
                <span className="text-white font-bold text-sm">{myProtocolados}</span>
              </div>
              <div className="flex items-center gap-1">
                <TrendingUp className="w-3 h-3 text-[#ffcc00]" />
                <span className="text-white/60 text-[10px]">Ganhos</span>
                <span className="text-white font-bold text-sm">{Math.round(myGanhos)}</span>
              </div>
            </div>
            <div className="text-white/50 text-[10px]">Total no período</div>
          </div>
        </div>
      </div>

      {/* Filtros e botão Atualizar */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 bg-[#f1f5f9] rounded-lg p-1">
            <button
              onClick={() => setRankingType("colaborador")}
              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all", rankingType === "colaborador" ? "bg-white text-[#2F6FED] shadow-sm" : "text-[#64748b] hover:text-[#0f172a]")}
            >
              <User className="w-3.5 h-3.5" /> Colaborador
            </button>
            <button
              onClick={() => setRankingType("equipe")}
              className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition-all", rankingType === "equipe" ? "bg-white text-[#2F6FED] shadow-sm" : "text-[#64748b] hover:text-[#0f172a]")}
            >
              <Users className="w-3.5 h-3.5" /> Equipe
            </button>
          </div>

          <div className="flex items-center gap-2 bg-[#f1f5f9] rounded-lg p-1 flex-wrap">
            {(["ganhos", "assinados", "protocolados", "emitidos"] as SortMetric[]).map((metric) => (
              <label key={metric} className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeSortMetrics.includes(metric)}
                  onChange={() => toggleSortMetric(metric)}
                  className="w-3.5 h-3.5 accent-[#2F6FED]"
                />
                <span className="text-[#0f172a]">{metricLabels[metric]}</span>
                <span className="text-[10px] text-[#94a3b8] font-normal">(peso {WEIGHTS[metric]})</span>
              </label>
            ))}
          </div>

          <div className="flex items-center gap-2 bg-[#f1f5f9] rounded-lg p-1">
            <Package className="w-3.5 h-3.5 text-[#64748b]" aria-hidden="true" />
            <select
              value={selectedProduct}
              onChange={(e) => setSelectedProduct(e.target.value)}
              className="bg-transparent text-xs font-semibold text-[#0f172a] focus:outline-none"
              aria-label="Filtrar ranking por produto"
            >
              {productOptions.map((prod) => (<option key={prod} value={prod}>{prod}</option>))}
            </select>
          </div>

          {rankingType === "colaborador" && (
            <div className="flex items-center gap-2 bg-[#f1f5f9] rounded-lg p-1">
              <Briefcase className="w-3.5 h-3.5 text-[#64748b]" aria-hidden="true" />
              <select
                value={selectedTeam}
                onChange={(e) => setSelectedTeam(e.target.value)}
                className="bg-transparent text-xs font-semibold text-[#0f172a] focus:outline-none"
                aria-label="Filtrar ranking por equipe"
                disabled={isSupervisor && equipeOptions.length <= 2}
              >
                {equipeOptions.map((equipe) => (<option key={equipe} value={equipe}>{equipe === "todas" ? "Todas as equipes" : equipe}</option>))}
              </select>
            </div>
          )}
        </div>

        {/* Botão Atualizar + Timestamp */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#94a3b8]">Atualizado {new Date().toLocaleTimeString()}</span>
          <button onClick={() => loadAllData(true)} disabled={refreshing}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[#2F6FED] text-white hover:bg-[#2F6FED]/90 disabled:opacity-50 transition-colors">
            <RefreshCw className={cn("w-3.5 h-3.5 inline mr-1", refreshing && "animate-spin")} /> Atualizar Dados
          </button>
        </div>
      </div>

      {/* Top 3 (pódio) */}
      {top3.length >= 3 && (
        <div className="card p-6 mb-6 animate-fade-in-up">
          <div className="flex items-center gap-2 mb-6">
            <Star className="w-4 h-4 text-[#16A34A] fill-[#16A34A]" />
            <h3 className="text-sm font-bold text-[#0f172a]">Top 3 — {rankingType === "colaborador" ? "Melhores Vendedores" : "Melhores Equipes"}</h3>
          </div>
          <div className="flex items-end justify-center gap-4">
            {top3[1] && (
              <div className="flex flex-col items-center flex-1 max-w-36">
                <div className="w-14 h-14 rounded-full flex items-center justify-center text-sm font-bold mb-2" style={{ background: "linear-gradient(135deg, #e2e8f0, #cbd5e1)", color: "#475569" }}>{getAvatar(top3[1])}</div>
                <div className="text-xs font-bold text-[#0f172a] text-center mb-1">{top3[1].name}</div>
                <div className="w-full rounded-t-xl flex flex-col items-center justify-end py-4" style={{ background: "linear-gradient(180deg, #e2e8f0, #cbd5e1)", height: "80px" }}><span className="text-2xl font-black text-[#475569]">2</span></div>
              </div>
            )}
            {top3[0] && (
              <div className="flex flex-col items-center flex-1 max-w-36">
                <div className="relative mb-2"><div className="w-16 h-16 rounded-full flex items-center justify-center text-sm font-bold" style={getPodiumStyle(1)}>{getAvatar(top3[0])}</div><div className="absolute -top-2 -right-1 w-6 h-6 rounded-full flex items-center justify-center" style={{ background: "#ffcc00" }}><Crown className="w-3.5 h-3.5 text-white" /></div></div>
                <div className="text-xs font-bold text-[#0f172a] text-center mb-1">{top3[0].name}</div>
                <div className="w-full rounded-t-xl flex flex-col items-center justify-end py-4" style={{ background: "linear-gradient(180deg, #ffcc00, #f59e0b)", height: "110px" }}><span className="text-3xl font-black text-white">1</span></div>
              </div>
            )}
            {top3[2] && (
              <div className="flex flex-col items-center flex-1 max-w-36">
                <div className="w-14 h-14 rounded-full flex items-center justify-center text-sm font-bold mb-2" style={{ background: "linear-gradient(135deg, #d97706, #b45309)", color: "white" }}>{getAvatar(top3[2])}</div>
                <div className="text-xs font-bold text-[#0f172a] text-center mb-1">{top3[2].name}</div>
                <div className="w-full rounded-t-xl flex flex-col items-center justify-end py-4" style={{ background: "linear-gradient(180deg, #d97706, #b45309)", height: "65px" }}><span className="text-xl font-black text-white">3</span></div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tabela — Top 20 para colaboradores, Top 5 para equipes */}
      <div className="card animate-fade-in-up">
        <div className="p-5 border-b border-[#e2e8f0]">
          <h3 className="text-sm font-bold text-[#0f172a]">
            Top {Math.min(displayRanking.length, maxDisplayItems)} — {rankingType === "colaborador" ? "Melhores Colaboradores" : "Melhores Equipes"}
          </h3>
          <p className="text-xs text-[#64748b] mt-1">
            {displayRanking.length} {rankingType === "colaborador" ? "consultores" : "equipes"} exibidos (de {fullRanking.length} no total)
            <span className="ml-2 text-[#2F6FED] font-medium">• Ordenado por Pontuação Ponderada</span>
          </p>
        </div>

        <div className="overflow-x-auto">
          <div className="px-5 py-2 border-b border-[#e2e8f0] hidden md:grid" style={{ gridTemplateColumns: "60px 56px minmax(180px, 1fr) 90px 90px 90px 90px 90px", gap: "0.75rem" }}>
            <div className="text-[10px] font-semibold text-[#94a3b8] uppercase tracking-wider text-center">Pos</div>
            <div></div>
            <div className="text-[10px] font-semibold text-[#94a3b8] uppercase tracking-wider">Nome</div>
            <div className="text-[10px] font-semibold text-[#94a3b8] uppercase tracking-wider text-center">Emitidos</div>
            <div className="text-[10px] font-semibold text-[#94a3b8] uppercase tracking-wider text-center">Assinados</div>
            <div className="text-[10px] font-semibold text-[#94a3b8] uppercase tracking-wider text-center">Protocolados</div>
            <div className="text-[10px] font-semibold text-[#94a3b8] uppercase tracking-wider text-center">Ganhos</div>
            <div className="text-[10px] font-semibold text-[#94a3b8] uppercase tracking-wider text-center">Score</div>
          </div>

          <div className="divide-y divide-[#f1f5f9]">
            {displayRanking.map((person) => {
              const isTop3 = person.position <= 3;
              const isMe = rankingType === "colaborador" && (person as RankingItem).isCurrentUser;
              const isCurrentUserTeam = rankingType === "equipe" && currentUser && person.name === currentUser.equipe;
              const highlight = isMe || isCurrentUserTeam;
              return (
                <div
                  key={person.position}
                  className={cn("flex flex-col md:grid items-center px-5 py-4 transition-colors", highlight ? "bg-[#eff6ff]" : "hover:bg-[#f8fafc]")}
                  style={{ gridTemplateColumns: "60px 56px minmax(180px, 1fr) 90px 90px 90px 90px 90px", gap: "0.75rem", ...(highlight ? { borderLeft: "3px solid #2F6FED" } : {}) }}
                >
                  <div><RankBadge position={person.position} /></div>
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0" style={isTop3 ? getPodiumStyle(person.position) : highlight ? { background: "#2F6FED", color: "white" } : { background: "#f1f5f9", color: "#64748b" }}>{getAvatar(person)}</div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn("text-sm font-semibold truncate", highlight ? "text-[#2F6FED]" : "text-[#0f172a]")}>{person.name}</span>
                      {highlight && rankingType === "colaborador" && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#2F6FED] text-white">VOCÊ</span>}
                      {highlight && rankingType === "equipe" && currentUser && person.name === currentUser.equipe && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[#2F6FED] text-white">SUA EQUIPE</span>}
                      {isTop3 && <Star className="w-3 h-3 text-[#16A34A] fill-[#16A34A] flex-shrink-0" />}
                      {rankingType === "equipe" && "membersCount" in person && <span className="text-[10px] text-[#94a3b8] ml-1">({(person as TeamRankingItem).membersCount} membros)</span>}
                    </div>
                  </div>
                  <div className="text-center text-sm font-bold text-[#0f172a] whitespace-nowrap">{person.emitidos}</div>
                  <div className="text-center text-sm font-bold text-[#16A34A] whitespace-nowrap">{person.assinados}</div>
                  <div className="text-center text-sm font-bold text-[#8B5CF6] whitespace-nowrap">{person.protocolados}</div>
                  <div className="text-center text-sm font-bold text-[#EA8C1D] whitespace-nowrap">{Math.round(person.ganhos)}</div>
                  <div className="text-center text-sm font-bold text-[#2F6FED] whitespace-nowrap">{person.score.toFixed(1)}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-[#e2e8f0] text-center">
          <p className="text-xs text-[#94a3b8]">
            Exibindo os {maxDisplayItems} melhores de {fullRanking.length} {rankingType === "colaborador" ? "consultores" : "equipes"}.
            {fullRanking.length > maxDisplayItems && " Para ver a lista completa, ajuste os filtros."}
            <br />
            Pontuação = Σ (valor da métrica × peso). Pesos atuais: {activeSortMetrics.map(m => `${metricLabels[m]} (${WEIGHTS[m]})`).join(' + ')}
            {activeSortMetrics.length === 0 && " (nenhuma métrica selecionada)"}
            <br />
            {selectedProduct !== "Todos" && ` • Produto: ${selectedProduct}`}
            {rankingType === "colaborador" && selectedTeam !== "todas" && ` • Equipe: ${selectedTeam}`}
          </p>
        </div>
      </div>
    </DashboardLayout>
  );
}