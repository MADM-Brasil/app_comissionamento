// backend/routes/metrics.js
// ─────────────────────────────────────────────────────────────────────────────
// Rotas de métricas com cache-first + stale-while-revalidate.
//
// Estratégia:
//   • SQL é executado dentro de um `loader` puro (função sem efeitos).
//   • cacheFirst(key, loader, opts) deduplica N requests simultâneos em 1 query
//     (via singleflight) e serve stale em <5ms quando o cache expira.
//   • Filtros fuzzy (applyColaboradorFilter, filterByNomesEquipe) são aplicados
//     APÓS o cache — 1 entrada serve todos os usuários, cada um filtra o seu.
//   • A cache key inclui TUDO que está no WHERE SQL. Colaborador NÃO entra
//     porque é filtro em JS.
//
// ⚠️ SAFRA vs PRODUÇÃO (/assinados, /ganhos e /protocolados)
// ─────────────────────────────────────────────────────────────────────────────
//   • mode=producao (default) → filtra por coluna de data do evento
//   • mode=safra              → INNER JOIN em core.deals e filtra por created_at
//   mode ENTRA NA CACHE KEY. Safra e produção têm caches SEPARADOS.
//
// Compatibilidade com o frontend: 100% — mesmas URLs, mesmos payloads.
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import db from '../services/bd/db.js';
import { cacheFirst } from '../services/bd/cacheFirst.js';
import {
  metricCacheKey,
  resolveNomesPorEquipe,
  loadEmitidos,
  loadAssinados,
  loadProtocolados,
  loadGanhos,
  loadPerdidos,
  loadLeadsRecebidosGran,
  loadLeadsRecebidosAgg,
  loadLigacoes,
  loadLigacoesTabulacoes,
  loadLigacoesProdutivas,
  loadLeadsStages,
  loadLeadsStagesCatalog,
  loadWeekly,
  loadAssinadosDiarioPorEquipe,
  loadAssinadosDiarioColaborador,
  loadDemanda,
} from '../services/bd/metricsLoaders.js';

const router = express.Router();

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

async function getColaboradorNomeFromId(colaboradorId) {
  return null;
}

async function resolveColaboradorNome(req) {
  if (req.query.colaborador) return req.query.colaborador;
  if (req.query.colaboradorId) {
    const nome = await getColaboradorNomeFromId(req.query.colaboradorId);
    if (nome) return nome;
  }
  return null;
}

function normalize(str) {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function applyColaboradorFilter(rows, colaboradorNome, keyCandidates = ['colaborador', 'agent_name']) {
  if (!colaboradorNome) return rows;
  const normFilter = normalize(colaboradorNome);
  const filterTokens = normFilter.split(/\s+/).filter(Boolean);

  const exact = rows.filter(row => {
    for (const key of keyCandidates) {
      const raw = row[key];
      if (!raw) continue;
      if (normalize(raw) === normFilter) return true;
    }
    return false;
  });
  if (exact.length > 0) return exact;

  return rows.filter(row => {
    for (const key of keyCandidates) {
      const raw = row[key];
      if (!raw) continue;
      const rowTokens = new Set(normalize(raw).split(/\s+/).filter(Boolean));
      if (filterTokens.every(token => rowTokens.has(token))) return true;
    }
    return false;
  });
}

function filterByNomesEquipe(rows, nomesEquipe, keyCandidates = ['colaborador', 'agent_name']) {
  if (!Array.isArray(nomesEquipe) || nomesEquipe.length === 0) return [];
  const normNomes = nomesEquipe.map(n => ({
    full: normalize(n),
    tokens: normalize(n).split(/\s+/).filter(Boolean),
  }));
  return rows.filter(row => {
    for (const key of keyCandidates) {
      const raw = row[key];
      if (!raw) continue;
      const normRow = normalize(raw);
      const rowTokens = new Set(normRow.split(/\s+/).filter(Boolean));
      for (const nome of normNomes) {
        if (nome.full === normRow) return true;
        if (nome.tokens.every(t => rowTokens.has(t))) return true;
      }
    }
    return false;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// TTL adaptativo
// ─────────────────────────────────────────────────────────────────────────────
// Período que inclui hoje → dados mudam → cache curto
// Período 100% passado → imutável → cache longo
// ═════════════════════════════════════════════════════════════════════════════

function ttlForPeriod(start, end) {
  const hoje = new Date().toISOString().slice(0, 10);
  const incluiHoje = end && end > hoje;
  return incluiHoje
    ? { ttlMs: 90_000, staleMs: 600_000 }     // 1.5min / 10min
    : { ttlMs: 900_000, staleMs: 3_600_000 }; // 15min / 1h
}

// ═════════════════════════════════════════════════════════════════════════════
// Validação do mode (safra vs produção)
// ─────────────────────────────────────────────────────────────────────────────
// Retorna o mode normalizado ou null se inválido.
// ─────────────────────────────────────────────────────────────────────────────

function normalizeMode(rawMode) {
  const mode = String(rawMode || 'producao').toLowerCase();
  if (!['producao', 'safra'].includes(mode)) return null;
  return mode;
}

// ═════════════════════════════════════════════════════════════════════════════
// ROTAS
// ═════════════════════════════════════════════════════════════════════════════

// ─── EMITIDOS ────────────────────────────────────────────────────────────────
router.get('/emitidos', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);

    const key = metricCacheKey('emitidos', { start, end, equipe, produto, granularity });
    const rows = await cacheFirst(
      key,
      () => loadEmitidos({ start, end, equipe, produto, granularity }),
      ttlForPeriod(start, end)
    );

    res.json({ success: true, data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']) });
  } catch (err) {
    console.error('Erro em /emitidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ASSINADOS — safra vs produção
// ─────────────────────────────────────────────────────────────────────────────
// Query params:
//   • start, end (obrigatórios)
//   • equipe, produto, granularity (opcionais)
//   • mode = 'producao' (default) | 'safra'
//     - producao → filtra por data_assinatura (evento ocorreu no período)
//     - safra    → INNER JOIN core.deals e filtra por created_at
// ─────────────────────────────────────────────────────────────────────────────
router.get('/assinados', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity, mode } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const modeNorm = normalizeMode(mode);
    if (!modeNorm) {
      return res.status(400).json({ success: false, error: "mode deve ser 'producao' ou 'safra'" });
    }

    const colaboradorNome = await resolveColaboradorNome(req);

    // mode entra na cache key → safra e produção têm caches separadas
    const key = metricCacheKey('assinados', { start, end, equipe, produto, granularity, mode: modeNorm });
    const rows = await cacheFirst(
      key,
      () => loadAssinados({ start, end, equipe, produto, granularity, mode: modeNorm }),
      ttlForPeriod(start, end)
    );

    res.json({
      success: true,
      mode: modeNorm,
      data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']),
    });
  } catch (err) {
    console.error('Erro em /assinados:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ASSINADOS DIÁRIO POR EQUIPE ─────────────────────────────────────────────
// (não usa mode — alimenta gráficos diários sem seletor safra/produção)
router.get('/assinados-diario-por-equipe', requireAuth, async (req, res) => {
  try {
    const { inicio, fim, equipe } = req.query;
    if (!inicio || !fim) return res.status(400).json({ success: false, error: 'inicio e fim obrigatórios' });

    const key = `assinados-diario-eq:${inicio}:${fim}:${equipe || 'todas'}`;
    const rows = await cacheFirst(
      key,
      () => loadAssinadosDiarioPorEquipe({ inicio, fim, equipe }),
      { ttlMs: 180_000, staleMs: 900_000 }
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /assinados-diario-por-equipe:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ASSINADOS DIÁRIO POR COLABORADOR ────────────────────────────────────────
// (não usa mode — alimenta gráficos diários sem seletor safra/produção)
router.get('/assinados-diario-colaborador', requireAuth, async (req, res) => {
  try {
    const { inicio, fim } = req.query;
    if (!inicio || !fim) return res.status(400).json({ success: false, error: 'inicio e fim obrigatórios' });

    const key = `assinados-diario-col:${inicio}:${fim}`;
    const rows = await cacheFirst(
      key,
      () => loadAssinadosDiarioColaborador({ inicio, fim }),
      { ttlMs: 180_000, staleMs: 900_000 }
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /assinados-diario-colaborador:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PROTOCOLADOS — safra vs produção
// ─────────────────────────────────────────────────────────────────────────────
// Query params:
//   • start, end (obrigatórios)
//   • equipe, produto, granularity (opcionais)
//   • mode = 'producao' (default) | 'safra'
//     - producao → filtra por data_ganho da view (quando o evento ocorreu)
//     - safra    → INNER JOIN em core.deals e filtra por created_at
// ─────────────────────────────────────────────────────────────────────────────
router.get('/protocolados', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity, mode } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const modeNorm = normalizeMode(mode);
    if (!modeNorm) {
      return res.status(400).json({ success: false, error: "mode deve ser 'producao' ou 'safra'" });
    }

    const colaboradorNome = await resolveColaboradorNome(req);

    const key = metricCacheKey('protocolados', { start, end, equipe, produto, granularity, mode: modeNorm });
    const rows = await cacheFirst(
      key,
      () => loadProtocolados({ start, end, equipe, produto, granularity, mode: modeNorm }),
      ttlForPeriod(start, end)
    );

    res.json({
      success: true,
      mode: modeNorm,
      data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']),
    });
  } catch (err) {
    console.error('Erro em /protocolados:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GANHOS — safra vs produção
// ─────────────────────────────────────────────────────────────────────────────
// Query params:
//   • start, end (obrigatórios)
//   • equipe, produto, granularity, demanda (opcionais)
//   • mode = 'producao' (default) | 'safra'
//     - producao → filtra por data_ganho da view
//     - safra    → INNER JOIN em core.deals e filtra por created_at
//   • demanda = 'atual' → filtra deals assinados no mês corrente
// ─────────────────────────────────────────────────────────────────────────────
router.get('/ganhos', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity, demanda, mode } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const modeNorm = normalizeMode(mode);
    if (!modeNorm) {
      return res.status(400).json({ success: false, error: "mode deve ser 'producao' ou 'safra'" });
    }

    const colaboradorNome = await resolveColaboradorNome(req);

    const key = metricCacheKey('ganhos', { start, end, equipe, produto, granularity, demanda, mode: modeNorm });
    const rows = await cacheFirst(
      key,
      () => loadGanhos({ start, end, equipe, produto, granularity, demanda, mode: modeNorm }),
      ttlForPeriod(start, end)
    );

    res.json({
      success: true,
      mode: modeNorm,
      data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']),
    });
  } catch (err) {
    console.error('Erro em /ganhos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PERDIDOS ────────────────────────────────────────────────────────────────
router.get('/perdidos', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);

    const key = metricCacheKey('perdidos', { start, end, equipe, produto, granularity });
    const rows = await cacheFirst(
      key,
      () => loadPerdidos({ start, end, equipe, produto, granularity }),
      ttlForPeriod(start, end)
    );

    res.json({ success: true, data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']) });
  } catch (err) {
    console.error('Erro em /perdidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LEADS RECEBIDOS — dois modos (série temporal vs agregado)
// ─────────────────────────────────────────────────────────────────────────────
// Com granularity (daily|weekly|monthly) → série temporal
// Sem granularity → agregado por colaborador (Home, Visão Geral)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/leads-recebidos', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);

    // MODO 1 — SÉRIE TEMPORAL
    if (granularity) {
      const key = `leads-recebidos:gran:${start}:${end}:${equipe || 'todas'}:${produto || 'Todos'}:${granularity}`;
      const rows = await cacheFirst(
        key,
        () => loadLeadsRecebidosGran({ start, end, equipe, produto, granularity }),
        { ttlMs: 90_000, staleMs: 600_000 }
      );
      return res.json({
        success: true,
        data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']),
      });
    }

    // MODO 2 — AGREGADO POR COLABORADOR
    const key = `leads-recebidos:agg:${start}:${end}:${equipe || 'todas'}:${produto || 'Todos'}`;
    const rows = await cacheFirst(
      key,
      () => loadLeadsRecebidosAgg({ start, end, equipe, produto }),
      { ttlMs: 180_000, staleMs: 1_200_000 }
    );
    return res.json({
      success: true,
      data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']),
    });
  } catch (err) {
    console.error('Erro em /leads-recebidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LIGAÇÕES
// ─────────────────────────────────────────────────────────────────────────────
// A query é cacheada SEM filtro de equipe/colaborador.
// Filtros de equipe e colaborador são aplicados em JS pós-cache.
// `resolveNomesPorEquipe` é cacheado internamente (1h) — sem SELECT * por request.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/ligacoes', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, colaborador, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const key = `ligacoes:${start}:${end}:${granularity || 'none'}`;
    let rows = await cacheFirst(
      key,
      () => loadLigacoes({ start, end, granularity }),
      { ttlMs: 300_000, staleMs: 1_800_000 }
    );

    if (equipe && equipe !== 'todas') {
      const nomesEquipe = await resolveNomesPorEquipe(equipe);
      rows = filterByNomesEquipe(rows, nomesEquipe, ['colaborador', 'agent_name']);
    }
    rows = applyColaboradorFilter(rows, colaborador, ['colaborador', 'agent_name']);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /ligacoes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/ligacoes/tabulacoes', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, colaborador, categoria } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const key = `ligacoes-tab:${start}:${end}:${categoria || ''}`;
    let filtered = await cacheFirst(
      key,
      () => loadLigacoesTabulacoes({ start, end, categoria }),
      { ttlMs: 300_000, staleMs: 1_800_000 }
    );

    if (equipe && equipe !== 'todas') {
      const nomesEquipe = await resolveNomesPorEquipe(equipe);
      filtered = filterByNomesEquipe(filtered, nomesEquipe, ['colaborador', 'agent_name']);
    }
    filtered = applyColaboradorFilter(filtered, colaborador, ['colaborador', 'agent_name']);

    const agg = new Map();
    filtered.forEach(row => {
      const k = row.tabulacao;
      agg.set(k, (agg.get(k) || 0) + (Number(row.total) || 0));
    });
    const data = Array.from(agg.entries())
      .map(([tabulacao, total]) => ({ tabulacao, total }))
      .sort((a, b) => b.total - a.total || a.tabulacao.localeCompare(b.tabulacao));

    res.json({ success: true, data });
  } catch (err) {
    console.error('Erro em /ligacoes/tabulacoes:', err);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

router.get('/ligacoes-produtivas', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, colaborador } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const key = `ligacoes-prod:${start}:${end}:${equipe || 'todas'}:${colaborador || ''}`;
    const rows = await cacheFirst(
      key,
      () => loadLigacoesProdutivas({ start, end, equipe, colaborador }),
      { ttlMs: 300_000, staleMs: 1_800_000 }
    );

    res.json({ success: true, total: Number(rows[0]?.total) || 0 });
  } catch (err) {
    console.error('Erro em /ligacoes-produtivas:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LEADS POR ETAPA
// ─────────────────────────────────────────────────────────────────────────────
// Mesma correção de timezone e is_deleted aplicada em /leads-recebidos,
// para manter o total consistente entre as telas.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/leads/stages', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);

    const key = `leads-stages:${start}:${end}:${equipe || 'todas'}:${produto || 'Todos'}`;
    const rows = await cacheFirst(
      key,
      () => loadLeadsStages({ start, end, equipe, produto }),
      { ttlMs: 180_000, staleMs: 900_000 }
    );

    res.json({ success: true, data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']) });
  } catch (err) {
    console.error('Erro em /leads/stages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/leads/stages/catalog', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const key = `leads-stages-catalog:${start}:${end}`;
    const rows = await cacheFirst(
      key,
      () => loadLeadsStagesCatalog({ start, end }),
      { ttlMs: 600_000, staleMs: 3_600_000 }
    );

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /leads/stages/catalog:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PERFORMANCE SEMANAL ─────────────────────────────────────────────────────
router.get('/weekly', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const key = `weekly:${start}:${end}`;
    try {
      const rows = await cacheFirst(
        key,
        () => loadWeekly({ start, end }),
        { ttlMs: 300_000, staleMs: 1_800_000 }
      );
      return res.json({ success: true, data: rows });
    } catch (innerErr) {
      // Fallback gracioso: se a query falhar, devolve mock (comportamento original)
      console.error('Erro em /weekly (fallback mock):', innerErr.message);
      const mock = [
        { semana: '2026-05-04', vendas: 0, meta: 5 },
        { semana: '2026-05-11', vendas: 0, meta: 5 },
        { semana: '2026-05-18', vendas: 0, meta: 5 },
        { semana: '2026-05-25', vendas: 0, meta: 5 },
      ];
      return res.json({ success: true, data: mock });
    }
  } catch (err) {
    console.error('Erro em /weekly:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMANDA ATUAL / REPRIMIDA / RESUMO
// ─────────────────────────────────────────────────────────────────────────────
// As 3 rotas compartilham o MESMO dataset cacheado internamente por
// loadDemanda(tipo, equipe, produto). Ou seja: /demanda-atual e /demanda-resumo
// chamam loadDemanda({ tipo: 'atual' }) → 1 query serve as duas.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/demanda-atual', requireAuth, async (req, res) => {
  try {
    const { equipe, produto } = req.query;
    const colaboradorNome = await resolveColaboradorNome(req);

    const rows = await loadDemanda({ tipo: 'atual', equipe, produto });
    const filtered = applyColaboradorFilter(rows, colaboradorNome, ['colaborador']);

    res.json({ success: true, total: filtered.length, data: filtered });
  } catch (err) {
    console.error('Erro em /demanda-atual:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/demanda-reprimida', requireAuth, async (req, res) => {
  try {
    const { equipe, produto } = req.query;
    const colaboradorNome = await resolveColaboradorNome(req);

    const rows = await loadDemanda({ tipo: 'reprimida', equipe, produto });
    const filtered = applyColaboradorFilter(rows, colaboradorNome, ['colaborador']);

    res.json({ success: true, total: filtered.length, data: filtered });
  } catch (err) {
    console.error('Erro em /demanda-reprimida:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/demanda-resumo', requireAuth, async (req, res) => {
  try {
    const { equipe, produto } = req.query;
    const colaboradorNome = await resolveColaboradorNome(req);

    const [atualRows, reprimidaRows] = await Promise.all([
      loadDemanda({ tipo: 'atual', equipe, produto }),
      loadDemanda({ tipo: 'reprimida', equipe, produto }),
    ]);

    const agg = (rows) => {
      const map = new Map();
      for (const r of rows) {
        const k = `${r.colaborador}||${r.equipe || ''}`;
        const cur = map.get(k) || { colaborador: r.colaborador, equipe: r.equipe || '', total: 0 };
        cur.total += 1;
        map.set(k, cur);
      }
      return Array.from(map.values());
    };

    const atual = applyColaboradorFilter(agg(atualRows), colaboradorNome, ['colaborador']);
    const reprimida = applyColaboradorFilter(agg(reprimidaRows), colaboradorNome, ['colaborador']);

    res.json({
      success: true,
      data: {
        atual,
        reprimida,
        totalAtual: atual.reduce((s, x) => s + x.total, 0),
        totalReprimida: reprimida.reduce((s, x) => s + x.total, 0),
      },
    });
  } catch (err) {
    console.error('Erro em /demanda-resumo:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;