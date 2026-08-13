// backend/routes/colaboradores.js
import express from 'express';
import db from '../services/db.js';

const router = express.Router();

// Lista de e‑mails dos Supervisores SR (configure aqui)
const SUPERVISORES_SR_EMAILS = [
  'felipe.uzuelli@madmbrasil.com.br',
];

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

function getCurrentPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

function parseMesToDataMetrica(mesParam) {
  if (!mesParam) return getCurrentPeriod();
  if (/^\d{4}-\d{2}$/.test(mesParam)) {
    return `${mesParam}-01`;
  }
  return mesParam;
}

// Mapeamento de cargo para produto (usado no retorno)
function mapGrupoToProduto(cargo, classificacaoOperacional) {
  if (classificacaoOperacional && classificacaoOperacional.toLowerCase() === 'judit') {
    return 'Judit';
  }
  const mapping = {
    'Elite': 'Auxilio Acidente',
    'Quinquenio': 'Quinquenio',
    'Quinquênio ': 'Quinquenio',
    'Concomitante': 'Concomitante',
  };
  return mapping[cargo] || '';
}

const EXCLUDED_TEAMS = [
  'Equipe SAC', 'Sales Ops', 'Equipe', 'Equipe Lucilene', 'Equipe SDR','Equipe Camila',
  'Equipe Erica', 'Equipe Lucas', 'Equipe Irene', 'Equipe Maria Eduarda', 'SalesOps',
  'Equipe Murilo Balsalobre', 'Comercial', 'Backoffice', 'CEO', 'Prontuário','BackOffice',
  'Equipe Leonardo Cardoso', 'Equipe Julia', 'Equipe Leticia', 'Dr. Felipe Marx','Administrativo',
  'Equipe Thales','Financeiro'
];

function normalize(str) {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ============================================================
// GET /api/collaborators
// ============================================================
router.get('/collaborators', requireAuth, async (req, res) => {
  const mesParam = req.query.mes;
  const dataMetrica = parseMesToDataMetrica(mesParam);
  console.log(`📅 Buscando colaboradores para data_metrica: ${dataMetrica}`);

  try {
    const query = `
      SELECT 
        COALESCE(c.email, m.email) AS email,
        COALESCE(c.nome, m.email) AS nome,
        c.nome_equipe,
        c.cargo,
        c.status,
        m.classificacao_operacional,
        m.data_metrica
      FROM app_comissionamento.view_app_metricas_assessores m
      LEFT JOIN core.view_app_colaboradores c
        ON LOWER(TRIM(c.email)) = LOWER(TRIM(m.email))
      WHERE m.data_metrica::date = $1::date
        AND (c.nome_equipe IS NULL OR TRIM(c.nome_equipe) != '')
        AND (c.status IS NULL OR LOWER(c.status) != 'desativado')
        AND (c.cargo IS NULL OR LOWER(c.cargo) != 'desativado')
        AND (m.classificacao_operacional IS NOT NULL AND TRIM(m.classificacao_operacional) != '')
    `;
    const result = await db.query(query, [dataMetrica]);
    const colabsArray = result.rows;

    if (colabsArray.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const metricas = await db.query(`
      SELECT email, data_metrica,
             COALESCE(peso_meta_assinados_diario, 3)   AS meta_diario_assinados,
             COALESCE(peso_meta_ganho_diario, 3)       AS meta_diario_ganhos,
             COALESCE(peso_meta_assinados_semanal, 3)  AS meta_semanal_assinados,
             COALESCE(peso_meta_ganho_semanal, 3)      AS meta_semanal_ganhos,
             COALESCE(peso_meta_assinados_mensal, 10)  AS meta_mensal_assinados,
             COALESCE(peso_meta_ganho_mensal, 10)      AS meta_mensal_ganhos,
             COALESCE(comissao_bonus, 0)               AS bonus_comissao,
             COALESCE(meta_gols_assinados, 0)          AS meta_gols_assinados,
             COALESCE(meta_gols_ganhos, 0)             AS meta_gols_ganhos
      FROM app_comissionamento.view_app_metricas_assessores
      WHERE data_metrica::date = $1::date
    `, [dataMetrica]);

    const metricsByEmail = new Map();
    for (const m of metricas.rows) {
      metricsByEmail.set(normalize(m.email), m);
    }

    const colaboradores = colabsArray.map(colab => {
      const emailNormalizado = normalize(colab.email);
      const metrica = metricsByEmail.get(emailNormalizado);

      const isJudit = colab.classificacao_operacional && colab.classificacao_operacional.toLowerCase() === 'judit';
      const canal = isJudit ? 'Judit' : 'Discadora';
      const produto = isJudit ? 'Judit' : mapGrupoToProduto(colab.cargo, colab.classificacao_operacional);

      // Verifica se o e‑mail está na lista de Supervisores SR
      const isSupervisorSR = SUPERVISORES_SR_EMAILS.includes(colab.email);

      return {
        id: colab.email,
        name: colab.nome || colab.email,
        email: colab.email,
        equipeId: '',
        equipeNome: colab.nome_equipe || '',
        grupo: colab.cargo || '',
        cargo: colab.cargo || '',
        status: colab.status || 'ativo',
        periodo: colab.periodo || dataMetrica,
        avatar: (colab.nome || '?').charAt(0).toUpperCase(),
        emitidos: 0,
        assinados: 0,
        protocolados: 0,
        ganhos: 0,
        perdidos: 0,
        metaDiarioAssinados: metrica ? Number(metrica.meta_diario_assinados) : 3,
        metaDiarioGanhos: metrica ? Number(metrica.meta_diario_ganhos) : 3,
        metaSemanalAssinados: metrica ? Number(metrica.meta_semanal_assinados) : 15,
        metaSemanalGanhos: metrica ? Number(metrica.meta_semanal_ganhos) : 15,
        metaMensalAssinados: metrica ? Number(metrica.meta_mensal_assinados) : 60,
        metaMensalGanhos: metrica ? Number(metrica.meta_mensal_ganhos) : 60,
        metaGolsAssinados: metrica ? Number(metrica.meta_gols_assinados) : 3,
        metaGolsGanhos: metrica ? Number(metrica.meta_gols_ganhos) : 3,
        comissao: metrica ? Number(metrica.bonus_comissao) : 0,
        bonusComissao: metrica ? Number(metrica.bonus_comissao) : 0,
        metaAssinados: 3,
        metaGanhos: 3,
        bonusPorCiclo: 0,
        bonusRecebido: 0,
        produto,
        classificacaoOperacional: colab.classificacao_operacional || '',
        canal,
        isSupervisorSR,
      };
    });

    console.log(`✅ Retornando ${colaboradores.length} colaboradores.`);
    res.json({ success: true, data: colaboradores });
  } catch (err) {
    console.error('❌ Erro ao buscar colaboradores:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET /api/equipes
// ============================================================
router.get('/equipes', requireAuth, async (req, res) => {
  const mesParam = req.query.mes;
  const dataMetrica = parseMesToDataMetrica(mesParam);
  try {
    const result = await db.query(
      `SELECT DISTINCT COALESCE(c.nome_equipe, 'Sem Equipe') AS nome
       FROM app_comissionamento.view_app_metricas_assessores m
       LEFT JOIN core.view_app_colaboradores c
         ON LOWER(TRIM(c.email)) = LOWER(TRIM(m.email))
       WHERE m.data_metrica::date = $1::date
         AND (c.nome_equipe IS NULL OR TRIM(c.nome_equipe) != '')
         AND (c.status IS NULL OR LOWER(c.status) != 'desativado')
         AND (c.cargo IS NULL OR LOWER(c.cargo) != 'desativado')`,
      [dataMetrica]
    );

    const equipes = result.rows
      .map(r => ({ id: r.nome, nome: r.nome }))
      .filter(eq => !EXCLUDED_TEAMS.includes(eq.nome) && eq.nome !== 'Sem Equipe')
      .sort((a, b) => a.nome.localeCompare(b.nome));

    res.json({ success: true, data: equipes });
  } catch (err) {
    console.error('❌ Erro ao buscar equipes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// IMPORTANTE: export default no final
// ============================================================
export default router;