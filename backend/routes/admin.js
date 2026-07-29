// backend/routes/admin.js
import express from 'express';
import db from '../services/db.js';
import { body, validationResult } from 'express-validator';

const router = express.Router();

// Middleware de autenticação (inline, atualizado para a sessão atual)
function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

router.use(requireAuth);

console.log('✅ Rotas de admin carregadas (incluindo /months)');

// ============================================================
// POST /api/admin/update-assessor-metrics (Individual)
// ============================================================
router.post('/update-assessor-metrics', [
  body('email').notEmpty().withMessage('email é obrigatório'),
  body('data_metrica').notEmpty().withMessage('data_metrica é obrigatória'),
  body('meta_diario_assinados').optional().isNumeric(),
  body('meta_diario_ganhos').optional().isNumeric(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const {
      email,
      data_metrica,
      meta_diario_assinados,
      meta_diario_ganhos,
      meta_semanal_assinados,
      meta_semanal_ganhos,
      meta_mensal_assinados,
      meta_mensal_ganhos,
      comissao_bonus,
    } = req.body;

    if (!email || !data_metrica) {
      return res.status(400).json({ success: false, error: 'email e data_metrica são obrigatórios' });
    }

    // UPDATE permanece na tabela original
    const updateQuery = `
      UPDATE app_comissionamento.metricas_assessores
      SET
        peso_meta_assinados_diario = COALESCE($1, peso_meta_assinados_diario),
        peso_meta_ganho_diario = COALESCE($2, peso_meta_ganho_diario),
        peso_meta_assinados_semanal = COALESCE($3, peso_meta_assinados_semanal),
        peso_meta_ganho_semanal = COALESCE($4, peso_meta_ganho_semanal),
        peso_meta_assinados_mensal = COALESCE($5, peso_meta_assinados_mensal),
        peso_meta_ganho_mensal = COALESCE($6, peso_meta_ganho_mensal),
        comissao_bonus = COALESCE($7, comissao_bonus),
        updated_at = NOW()
      WHERE email = $8
        AND data_metrica::date = $9::date
      RETURNING id_assessor
    `;

    const values = [
      meta_diario_assinados ?? null,
      meta_diario_ganhos ?? null,
      meta_semanal_assinados ?? null,
      meta_semanal_ganhos ?? null,
      meta_mensal_assinados ?? null,
      meta_mensal_ganhos ?? null,
      comissao_bonus ?? null,
      email,
      data_metrica,
    ];

    const result = await db.query(updateQuery, values);

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: `Assessor com e-mail ${email} não encontrado para a data ${data_metrica}`,
      });
    }

    res.json({ success: true, message: 'Métricas atualizadas com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar métricas do assessor:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// POST /api/admin/update-all-assessors-metrics (Global)
// ============================================================
router.post('/update-all-assessors-metrics', async (req, res) => {
  try {
    const { periodo, peso_assinados, peso_ganhos, bonus, data_metrica } = req.body;

    if (!periodo || !['diario','semanal','mensal'].includes(periodo)) {
      return res.status(400).json({ success: false, error: 'Período inválido' });
    }
    if (peso_assinados == null || peso_ganhos == null || !data_metrica) {
      return res.status(400).json({ success: false, error: 'Pesos e data_metrica são obrigatórios' });
    }

    const colunaAssinados = `peso_meta_assinados_${periodo}`;
    const colunaGanhos = `peso_meta_ganho_${periodo}`;

    const setClauses = [
      `${colunaAssinados} = $1`,
      `${colunaGanhos} = $2`,
    ];
    const params = [peso_assinados, peso_ganhos];

    if (bonus !== undefined && bonus !== null) {
      setClauses.push('comissao_bonus = $3');
      params.push(Number(bonus));
    }

    setClauses.push('updated_at = NOW()');

    const dataMetricaIndex = params.length + 1;
    params.push(data_metrica);

    // UPDATE global usa a tabela original
    await db.query(
      `UPDATE app_comissionamento.metricas_assessores
       SET ${setClauses.join(', ')}
       WHERE data_metrica::date = $${dataMetricaIndex}::date`,
      params
    );

    res.json({ success: true, message: `Metas ${periodo} globais aplicadas a todos para ${data_metrica}.` });
  } catch (err) {
    console.error('Erro ao atualizar metas globais:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// POST /api/admin/update-team-metrics (Equipe)
// ============================================================
router.post('/update-team-metrics', async (req, res) => {
  try {
    const { equipe, periodo, peso_assinados, peso_ganhos, bonus, data_metrica } = req.body;

    console.log('🔍 [update-team-metrics] Dados recebidos:', { equipe, periodo, peso_assinados, peso_ganhos, bonus, data_metrica });

    if (!equipe || !periodo || !['diario','semanal','mensal'].includes(periodo) || !data_metrica) {
      return res.status(400).json({ success: false, error: 'Equipe, período e data_metrica são obrigatórios' });
    }

    const colunaAssinados = `peso_meta_assinados_${periodo}`;
    const colunaGanhos = `peso_meta_ganho_${periodo}`;

    const setClauses = [
      `${colunaAssinados} = $1`,
      `${colunaGanhos} = $2`,
    ];
    const params = [peso_assinados, peso_ganhos];

    if (bonus !== undefined && bonus !== null) {
      setClauses.push('comissao_bonus = $3');
      params.push(Number(bonus));
    }

    setClauses.push('updated_at = NOW()');

    const dataMetricaIndex = params.length + 1;
    const equipeIndex = dataMetricaIndex + 1;

    // UPDATE por equipe: alvo é a tabela original, mas o JOIN usa a view de colaboradores para obter equipe
    const query = `
      UPDATE app_comissionamento.metricas_assessores a
      SET ${setClauses.join(', ')}
      FROM core.view_app_colaboradores c
      WHERE a.email = c.email
        AND a.data_metrica::date = $${dataMetricaIndex}::date
        AND c.nome_equipe = $${equipeIndex}
    `;

    console.log('🔍 [update-team-metrics] Query:', query);
    console.log('🔍 [update-team-metrics] Parâmetros:', [...params, data_metrica, equipe]);

    const result = await db.query(query, [...params, data_metrica, equipe]);

    console.log(`✅ [update-team-metrics] ${result.rowCount} linhas afetadas`);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Nenhum assessor encontrado para esta equipe e data.' });
    }

    res.json({ success: true, message: `Metas ${periodo} da equipe ${equipe} atualizadas para ${data_metrica}.` });
  } catch (err) {
    console.error('Erro ao atualizar metas da equipe:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// GET /api/admin/global-metrics (LEITURA – usa VIEW)
// ============================================================
router.get('/global-metrics', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT 
         COALESCE(peso_meta_assinados_diario, 3) AS peso_diario_assinados,
         COALESCE(peso_meta_ganho_diario, 3) AS peso_diario_ganhos,
         COALESCE(peso_meta_assinados_semanal, 3) AS peso_semanal_assinados,
         COALESCE(peso_meta_ganho_semanal, 3) AS peso_semanal_ganhos,
         COALESCE(peso_meta_assinados_mensal, 10) AS peso_mensal_assinados,
         COALESCE(peso_meta_ganho_mensal, 10) AS peso_mensal_ganhos,
         COALESCE(comissao_bonus, 150) AS bonus
       FROM app_comissionamento.view_app_metricas_assessores
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          peso_diario_assinados: 3,
          peso_diario_ganhos: 3,
          peso_semanal_assinados: 3,
          peso_semanal_ganhos: 3,
          peso_mensal_assinados: 10,
          peso_mensal_ganhos: 10,
          bonus: 150,
        }
      });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Erro ao obter métricas globais:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// GET /api/admin/equipe-metrics?nome=EquipeX (LEITURA – usa VIEW)
// ============================================================
router.get('/equipe-metrics', async (req, res) => {
  const { nome } = req.query;
  if (!nome) return res.status(400).json({ success: false, error: 'Nome da equipe obrigatório' });

  try {
    const result = await db.query(
      `SELECT 
         COALESCE(a.peso_meta_assinados_diario, 3) AS peso_diario_assinados,
         COALESCE(a.peso_meta_ganho_diario, 3) AS peso_diario_ganhos,
         COALESCE(a.peso_meta_assinados_semanal, 3) AS peso_semanal_assinados,
         COALESCE(a.peso_meta_ganho_semanal, 3) AS peso_semanal_ganhos,
         COALESCE(a.peso_meta_assinados_mensal, 10) AS peso_mensal_assinados,
         COALESCE(a.peso_meta_ganho_mensal, 10) AS peso_mensal_ganhos,
         COALESCE(a.comissao_bonus, 150) AS bonus
       FROM app_comissionamento.view_app_metricas_assessores a
       INNER JOIN core.view_app_colaboradores c ON a.email = c.email
       WHERE c.nome_equipe = $1
       LIMIT 1`,
      [nome]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          peso_diario_assinados: 3,
          peso_diario_ganhos: 3,
          peso_semanal_assinados: 3,
          peso_semanal_ganhos: 3,
          peso_mensal_assinados: 10,
          peso_mensal_ganhos: 10,
          bonus: 150,
        }
      });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Erro ao obter métricas da equipe:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// GET /api/admin/months (LEITURA – usa VIEW)
// ============================================================
router.get('/months', async (req, res) => {
  console.log('📅 Rota /api/admin/months foi chamada. Sessão:', req.session.isAuthenticated);
  try {
    const result = await db.query(
      `SELECT DISTINCT data_metrica 
       FROM app_comissionamento.view_app_metricas_assessores 
       ORDER BY data_metrica DESC`
    );
    const months = result.rows.map(r => {
      const d = new Date(r.data_metrica);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    });
    console.log('📅 Meses encontrados no banco:', months);
    res.json({ success: true, data: months });
  } catch (err) {
    console.error('Erro ao listar meses:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// ============================================================
// POST /api/admin/generate-next-month (ESCRITA na tabela original)
// ============================================================
router.post('/generate-next-month', async (req, res) => {
  try {
    const hoje = new Date();
    const ano = hoje.getFullYear();
    const mes = hoje.getMonth(); // 0-indexed
    const primeiroProximoMes = new Date(ano, mes + 1, 1);
    const dataMetrica = primeiroProximoMes.toISOString().slice(0, 10);

    // Verifica se já existem registros (pode usar a view para consulta, mas aqui é só verificação)
    const check = await db.query(
      `SELECT COUNT(*) as total FROM app_comissionamento.metricas_assessores WHERE data_metrica::date = $1::date`,
      [dataMetrica]
    );
    if (parseInt(check.rows[0].total) > 0) {
      return res.status(409).json({ success: false, error: 'Registros para o próximo mês já existem.' });
    }

    // Inserção na tabela original, selecionando do último mês existente
    await db.query(`
      INSERT INTO app_comissionamento.metricas_assessores (
        id_assessor,
        email,
        senha_colaborador_hash,
        comissao_bonus,
        peso_meta_assinados_diario,
        peso_meta_ganho_diario,
        peso_meta_assinados_semanal,
        peso_meta_ganho_semanal,
        peso_meta_assinados_mensal,
        peso_meta_ganho_mensal,
        data_metrica,
        updated_at
      )
      SELECT 
        id_assessor,
        email,
        senha_colaborador_hash,
        comissao_bonus,
        peso_meta_assinados_diario,
        peso_meta_ganho_diario,
        peso_meta_assinados_semanal,
        peso_meta_ganho_semanal,
        peso_meta_assinados_mensal,
        peso_meta_ganho_mensal,
        $1::date,
        NOW()
      FROM app_comissionamento.view_app_metricas_assessores
      WHERE data_metrica::date = (SELECT MAX(data_metrica::date) FROM app_comissionamento.view_app_metricas_assessores)
    `, [dataMetrica]);

    res.json({ success: true, message: `Registros para ${dataMetrica} criados com sucesso.` });
  } catch (err) {
    console.error('Erro ao gerar próximo mês:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

export default router;