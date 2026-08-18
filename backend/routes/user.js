// backend/routes/user.js
import express from 'express';
import db from '../services/db.js';

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

async function getColaboradorFromSession(req) {
  const email = req.session.userId;
  if (!email) return null;

  const result = await db.query(
    `SELECT nome, email, nome_equipe, cargo, status
     FROM core.view_app_colaboradores
     WHERE email = $1
     LIMIT 1`,
    [email]
  );
  return result.rows[0] || null;
}

router.use(requireAuth);

// ============================================================
// NOVA ROTA: métricas dos assessores (pesos e bônus por mês)
// ============================================================
router.get('/metricas-assessores', async (req, res) => {
  try {
    const { mes, email, colaborador_id } = req.query;
    if (!mes) {
      return res.status(400).json({ success: false, error: 'Parâmetro "mes" (YYYY-MM) é obrigatório' });
    }

    let query = `
      SELECT 
        id_assessor,
        email,
        data_metrica,
        comissao_bonus,
        peso_meta_assinados_diario,
        peso_meta_ganho_diario,
        peso_meta_assinados_semanal,
        peso_meta_ganho_semanal,
        peso_meta_assinados_mensal,
        peso_meta_ganho_mensal,
        meta_gols_assinados,   -- ✅ adicionado
        meta_gols_ganhos       -- ✅ adicionado
      FROM app_comissionamento.view_app_metricas_assessores
      WHERE TO_CHAR(data_metrica::date, 'YYYY-MM') = $1
    `;
    const params = [mes];
    let paramIdx = 2;

    if (email) {
      query += ` AND LOWER(TRIM(email)) = LOWER(TRIM($${paramIdx}))`;
      params.push(email);
      paramIdx++;
    }
    if (colaborador_id) {
      query += ` AND id_assessor::text = $${paramIdx}`;
      params.push(colaborador_id);
      paramIdx++;
    }

    query += ' ORDER BY email';

    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro em /metricas-assessores:', err);
    res.status(500).json({ success: false, error: 'Erro interno' });
  }
});

// GET /api/user/data
router.get('/data', async (req, res) => {
  try {
    const user = await getColaboradorFromSession(req);
    if (!user) {
      return res.status(404).json({ error: 'Colaborador não encontrado' });
    }

    let startDate, endDate;
    if (req.query.start && req.query.end) {
      startDate = req.query.start;
      endDate = req.query.end;
    } else if (req.query.date) {
      startDate = req.query.date;
      endDate = req.query.date;
    } else {
      return res.status(400).json({ error: 'Informe start/end ou date' });
    }

    const query = `
      SELECT
        (SELECT COUNT(*) FROM madm.view_app_emitidos_e_assinados 
         WHERE consultor_responsavel_emissao = $1 AND data_envio BETWEEN $2 AND $3) as emitidos,
        (SELECT COUNT(*) FROM madm.view_app_emitidos_e_assinados 
         WHERE consultor_responsavel_assinatura = $1 AND data_assinatura BETWEEN $2 AND $3) as assinados,
        (SELECT COUNT(*) FROM madm.view_app_kommo_leads 
         WHERE lead_usuario_responsavel = $1 AND data_ganho BETWEEN $2 AND $3 
           AND etapa_lead IN ('PROTOCOLADO', 'AG PROTOCOLO', 'Venda ganha')) as ganhos,
        (SELECT COUNT(*) FROM madm.view_app_kommo_leads 
         WHERE lead_usuario_responsavel = $1 AND data_ganho BETWEEN $2 AND $3 
           AND etapa_lead = 'Venda perdida') as perdidos
    `;
    const result = await db.query(query, [user.nome, startDate, endDate]);
    const data = result.rows[0] || { emitidos: 0, assinados: 0, ganhos: 0, perdidos: 0 };
    res.json(data);
  } catch (err) {
    console.error('Erro em /api/user/data:', err);
    res.status(500).json({ error: 'Erro ao buscar dados do usuário' });
  }
});

// GET /api/user/meta
router.get('/meta', async (req, res) => {
  try {
    let pesoAssinados = 3;
    let pesoGanhos = 3;
    let bonusBase = 150;
    try {
      const globalResult = await db.query(
        `SELECT pesoMetaAssinados, pesoMetaGanhos, valorBonus FROM madm.configuracoes_globais LIMIT 1`
      );
      if (globalResult.rows.length) {
        pesoAssinados = globalResult.rows[0].pesometaassinados;
        pesoGanhos = globalResult.rows[0].pesometaganhos;
        bonusBase = globalResult.rows[0].valorbonus;
      }
    } catch (err) { /* mantém defaults */ }

    const meta = {
      meta_quantidade: pesoAssinados,
      meta_percentual: pesoGanhos,
      bonus_base: bonusBase,
      comissao_percentual_padrao: 5,
      bonus_extra_por_meta: 50,
    };
    res.json(meta);
  } catch (err) {
    console.error('Erro em /api/user/meta:', err);
    res.status(500).json({ error: 'Erro ao buscar meta' });
  }
});

// GET /api/user/team
router.get('/team', async (req, res) => {
  try {
    const user = await getColaboradorFromSession(req);
    if (!user || !user.nome_equipe) {
      return res.status(400).json({ error: 'Usuário não pertence a nenhuma equipe' });
    }

    const result = await db.query(
      `SELECT 
         email as id,
         nome,
         nome_equipe as equipe,
         cargo,
         status,
         NULL as meta_individual,
         NULL as comissao_percentual,
         CURRENT_DATE as ultima_atualizacao
       FROM core.view_app_colaboradores
       WHERE nome_equipe = $1 AND status = 'ativo'`,
      [user.nome_equipe]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Erro em /api/user/team:', err);
    res.status(500).json({ error: 'Erro ao buscar equipe' });
  }
});

// GET /api/user/config
router.get('/config', async (req, res) => {
  try {
    const user = await getColaboradorFromSession(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
    }

    const result = await db.query(
      `SELECT 
         comissao_bonus,
         peso_meta_assinados_diario,
         peso_meta_ganho_diario,
         peso_meta_assinados_semanal,
         peso_meta_ganho_semanal,
         peso_meta_assinados_mensal,
         peso_meta_ganho_mensal,
         meta_gols_assinados,   -- ✅ adicionado
         meta_gols_ganhos       -- ✅ adicionado
       FROM app_comissionamento.view_app_metricas_assessores
       WHERE email = $1`,
      [user.email]
    );

    if (result.rows.length > 0) {
      return res.json({ success: true, ...result.rows[0] });
    } else {
      return res.json({
        success: true,
        comissao_bonus: 0,
        peso_meta_assinados_diario: 3,
        peso_meta_ganho_diario: 3,
        peso_meta_assinados_semanal: 3,
        peso_meta_ganho_semanal: 3,
        peso_meta_assinados_mensal: 10,
        peso_meta_ganho_mensal: 10,
        meta_gols_assinados: 20,   // ✅ valor padrão
        meta_gols_ganhos: 20       // ✅ valor padrão
      });
    }
  } catch (err) {
    console.error('Erro ao obter configurações:', err);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/user/config
router.post('/config', async (req, res) => {
  try {
    const user = await getColaboradorFromSession(req);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Usuário não autenticado' });
    }

    const {
      comissao_bonus,
      peso_meta_assinados_diario,
      peso_meta_ganho_diario,
      peso_meta_assinados_semanal,
      peso_meta_ganho_semanal,
      peso_meta_assinados_mensal,
      peso_meta_ganho_mensal,
      meta_gols_assinados,   // ✅ adicionado
      meta_gols_ganhos       // ✅ adicionado
    } = req.body;

    const campos = [
      comissao_bonus,
      peso_meta_assinados_diario,
      peso_meta_ganho_diario,
      peso_meta_assinados_semanal,
      peso_meta_ganho_semanal,
      peso_meta_assinados_mensal,
      peso_meta_ganho_mensal,
      meta_gols_assinados,   // ✅ adicionado
      meta_gols_ganhos       // ✅ adicionado
    ];

    if (campos.some(v => v === undefined || isNaN(Number(v)) || Number(v) < 0)) {
      return res.status(400).json({
        success: false,
        error: 'Todos os campos devem ser números válidos e não negativos.',
      });
    }

    // UPDATE na tabela original, não na view
    const query = `
      UPDATE app_comissionamento.metricas_assessores
      SET
        comissao_bonus = $1,
        peso_meta_assinados_diario = $2,
        peso_meta_ganho_diario = $3,
        peso_meta_assinados_semanal = $4,
        peso_meta_ganho_semanal = $5,
        peso_meta_assinados_mensal = $6,
        peso_meta_ganho_mensal = $7,
        meta_gols_assinados = $8,   -- ✅ adicionado
        meta_gols_ganhos = $9,      -- ✅ adicionado
        updated_at = NOW()
      WHERE email = $10
      RETURNING id_assessor
    `;

    const values = [
      comissao_bonus,
      peso_meta_assinados_diario,
      peso_meta_ganho_diario,
      peso_meta_assinados_semanal,
      peso_meta_ganho_semanal,
      peso_meta_assinados_mensal,
      peso_meta_ganho_mensal,
      meta_gols_assinados,  
      meta_gols_ganhos,      
      user.email,
    ];

    const result = await db.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Assessor não encontrado' });
    }

    res.json({ success: true, message: 'Configurações atualizadas com sucesso.' });
  } catch (err) {
    console.error('Erro ao salvar configurações:', err);
    res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// POST /api/user/extract (placeholder)
router.post('/extract', async (req, res) => {
  res.json({ success: true, message: 'Extração não armazenada (sem tabela no banco)' });
});

export default router;