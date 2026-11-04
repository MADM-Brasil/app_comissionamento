import express from 'express';
import db from '../services/db.js';

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

router.get('/nao-tabuladas', requireAuth, async (req, res) => {
  const { start, end, equipe, colaborador } = req.query;
  if (!isValidDate(start) || !isValidDate(end) || end < start) {
    return res.status(400).json({
      success: false,
      error: 'start e end são obrigatórios e devem ser datas válidas no formato YYYY-MM-DD; end deve ser igual ou posterior a start.',
    });
  }
  if (equipe != null && typeof equipe !== 'string') {
    return res.status(400).json({ success: false, error: 'equipe deve ser texto.' });
  }
  if (colaborador != null && typeof colaborador !== 'string') {
    return res.status(400).json({ success: false, error: 'colaborador deve ser texto.' });
  }

  const params = [start, end];
  const filters = [];

  if (equipe && equipe !== 'todas') {
    params.push(equipe);
    filters.push(`LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${params.length}))`);
  }
  if (colaborador && colaborador !== 'todos') {
    params.push(colaborador);
    filters.push(`LOWER(TRIM(c.nome)) = LOWER(TRIM($${params.length}))`);
  }
  const selectionFilter = filters.length ? `AND ${filters.join(' AND ')}` : '';

  try {
    const result = await db.query(
      `SELECT
         COALESCE(NULLIF(TRIM(c.nome), ''), '(SEM NOME)') AS agente,
         COALESCE(NULLIF(TRIM(c.nome_equipe), ''), '(SEM EQUIPE)') AS supervisor,
         COUNT(*)::int AS total_nao_tabuladas
       FROM madm.view_base_olos_temp b
       INNER JOIN core.colaboradores c ON c.nome = b.agent_name
       WHERE b.qualification_name = 'Nao tabulada - tempo excedido'
         AND b.call_date >= $1::date
         AND b.call_date < $2::date + 1
         ${selectionFilter}
       GROUP BY c.nome, c.nome_equipe
       ORDER BY total_nao_tabuladas DESC, agente`,
      params,
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Erro em /tabulacoes/nao-tabuladas:', error);
    res.status(500).json({ success: false, error: 'Erro ao carregar tabulações.' });
  }
});

export default router;
