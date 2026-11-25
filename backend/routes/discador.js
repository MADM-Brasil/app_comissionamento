// backend/routes/discador.js
import express from 'express';
import { loadDiscadorResultado } from '../services/bd/metricsLoaders.js';

const router = express.Router();

// ── Validação de período (YYYY-MM-DD) ────────────────────────────────────────
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parsePeriod(req, res) {
  const start = String(req.query.start || '').trim();
  const end   = String(req.query.end   || '').trim();
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    res.status(400).json({
      error: 'start e end são obrigatórios no formato YYYY-MM-DD.',
    });
    return null;
  }
  if (start > end) {
    res.status(400).json({ error: 'start deve ser ≤ end.' });
    return null;
  }
  return { start, end };
}

/**
 * GET /api/discador/resultado?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Retorna uma linha por (agent × campaign), com contagens do discador e
 * assinaturas cruzadas por telefone. Filtros de equipe/colaborador/unidade
 * são aplicados client-side pelo frontend (o cache é por período).
 */
router.get('/resultado', async (req, res) => {
  const period = parsePeriod(req, res);
  if (!period) return;

  try {
    // loadDiscadorResultado já usa cacheFirst com esta MESMA key.
    // Envolver de novo em cacheFirst aqui fazia a requisição esperar por
    // ela mesma (trava) e a página nunca recebia os dados.
    const rows = await loadDiscadorResultado(period);
    res.json(rows);
  } catch (err) {
    console.error('[discador/resultado]', err);
    res.status(500).json({
      error: err?.message || 'Falha ao executar a consulta do discador.',
    });
  }
});

export default router;