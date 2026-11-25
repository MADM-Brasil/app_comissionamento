
import express from 'express';
import db from '../services/bd/db.js';
import {
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
    const { start, end, equipe, produto, granularity, mode } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const modeNorm = normalizeMode(mode);
    if (!modeNorm) {
      return res.status(400).json({ success: false, error: "mode deve ser 'producao' ou 'safra'" });
    }

    const colaboradorNome = await resolveColaboradorNome(req);

    const rows = await loadEmitidos({ start, end, equipe, produto, granularity, mode: modeNorm });

    res.json({
      success: true,
      mode: modeNorm,
      data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']),
    });
  } catch (err) {
    console.error('Erro em /emitidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ASSINADOS ───────────────────────────────────────────────────────────────
router.get('/assinados', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity, mode } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const modeNorm = normalizeMode(mode);
    if (!modeNorm) {
      return res.status(400).json({ success: false, error: "mode deve ser 'producao' ou 'safra'" });
    }

    const colaboradorNome = await resolveColaboradorNome(req);

    const rows = await loadAssinados({ start, end, equipe, produto, granularity, mode: modeNorm });

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
router.get('/assinados-diario-por-equipe', requireAuth, async (req, res) => {
  try {
    const { inicio, fim, equipe } = req.query;
    if (!inicio || !fim) return res.status(400).json({ success: false, error: 'inicio e fim obrigatórios' });

    const rows = await loadAssinadosDiarioPorEquipe({ inicio, fim, equipe });

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /assinados-diario-por-equipe:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ASSINADOS DIÁRIO POR COLABORADOR ────────────────────────────────────────
router.get('/assinados-diario-colaborador', requireAuth, async (req, res) => {
  try {
    const { inicio, fim } = req.query;
    if (!inicio || !fim) return res.status(400).json({ success: false, error: 'inicio e fim obrigatórios' });

    const rows = await loadAssinadosDiarioColaborador({ inicio, fim });

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /assinados-diario-colaborador:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── PROTOCOLADOS ────────────────────────────────────────────────────────────
router.get('/protocolados', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity, mode } = req.query;
    console.log('[PROTOCOLADOS] Recebido:', { start, end, mode });
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const modeNorm = normalizeMode(mode);
    if (!modeNorm) {
      return res.status(400).json({ success: false, error: "mode deve ser 'producao' ou 'safra'" });
    }

    const colaboradorNome = await resolveColaboradorNome(req);

    const rows = await loadProtocolados({ start, end, equipe, produto, granularity, mode: modeNorm });

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

// ─── GANHOS ──────────────────────────────────────────────────────────────────
router.get('/ganhos', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity, demanda, mode } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const modeNorm = normalizeMode(mode);
    if (!modeNorm) {
      return res.status(400).json({ success: false, error: "mode deve ser 'producao' ou 'safra'" });
    }

    const colaboradorNome = await resolveColaboradorNome(req);

    const rows = await loadGanhos({ start, end, equipe, produto, granularity, demanda, mode: modeNorm });

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

    const rows = await loadPerdidos({ start, end, equipe, produto, granularity });

    res.json({ success: true, data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']) });
  } catch (err) {
    console.error('Erro em /perdidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LEADS RECEBIDOS ─────────────────────────────────────────────────────────
router.get('/leads-recebidos', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);

    if (granularity) {
      const rows = await loadLeadsRecebidosGran({ start, end, equipe, produto, granularity });
      return res.json({
        success: true,
        data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']),
      });
    }

    const rows = await loadLeadsRecebidosAgg({ start, end, equipe, produto });
    return res.json({
      success: true,
      data: applyColaboradorFilter(rows, colaboradorNome, ['colaborador']),
    });
  } catch (err) {
    console.error('Erro em /leads-recebidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LIGAÇÕES ────────────────────────────────────────────────────────────────
router.get('/ligacoes', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, colaborador, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    let rows = await loadLigacoes({ start, end, granularity });

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

    let filtered = await loadLigacoesTabulacoes({ start, end, categoria });

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

    const rows = await loadLigacoesProdutivas({ start, end, equipe, colaborador });

    res.json({ success: true, total: Number(rows[0]?.total) || 0 });
  } catch (err) {
    console.error('Erro em /ligacoes-produtivas:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── LEADS POR ETAPA ─────────────────────────────────────────────────────────
router.get('/leads/stages', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);

    const rows = await loadLeadsStages({ start, end, equipe, produto });

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

    const rows = await loadLeadsStagesCatalog({ start, end });

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

    try {
      const rows = await loadWeekly({ start, end });
      return res.json({ success: true, data: rows });
    } catch (innerErr) {
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

// ─── DEMANDA ─────────────────────────────────────────────────────────────────
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