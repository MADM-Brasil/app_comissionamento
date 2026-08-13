// backend/routes/tabela-comissoes.js
import express from 'express';
import db from '../services/db.js';

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

// GET /api/tabela-comissoes
router.get('/', requireAuth, async (req, res) => {
  try {
    const query = `
      SELECT tipo, valor_comissao, faixa_min, faixa_max, data_atualizacao
      FROM app_comissionamento.vw_tabela_comissoes
      ORDER BY tipo, faixa_min
    `;
    const result = await db.query(query);
    
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro ao buscar tabela de comissões:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;