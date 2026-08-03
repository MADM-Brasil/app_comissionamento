// backend/routes/colaboradores.js
import express from 'express';
import db from '../services/db.js';

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

/**
 * Retorna o primeiro dia do mês atual no formato YYYY-MM-DD.
 */
function getCurrentPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

/**
 * Converte um parâmetro de mês (YYYY-MM) para data métrica (YYYY-MM-DD).
 * Se já for uma data completa, mantém.
 */
function parseMesToDataMetrica(mesParam) {
  if (!mesParam) return getCurrentPeriod();
  if (/^\d{4}-\d{2}$/.test(mesParam)) {
    return `${mesParam}-01`;
  }
  return mesParam; // já deve estar no formato YYYY-MM-DD
}

// Mapeamento de cargo para produto (usado no retorno)
function mapGrupoToProduto(cargo) {
  const mapping = {
    'Elite': 'Auxilio Acidente',
    'Quinquenio': 'Quinquenio',
    'Quinquênio ': 'Quinquenio',
    'Concomitante': 'Concomitante',
  };
  return mapping[cargo] || '';
}

// Equipes que não devem ser retornadas na listagem de equipes
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
    // Buscar colaboradores filtrando por data_metrica (ex: '2026-08-01')
    const todosColabs = await db.query(`
      SELECT c.email, c.nome, c.nome_equipe, c.cargo, c.status, c.periodo
      FROM core.view_app_colaboradores c
      INNER JOIN app_comissionamento.view_app_metricas_assessores m
        ON LOWER(TRIM(c.email)) = LOWER(TRIM(m.email))
      WHERE m.data_metrica::date = $1::date
        AND c.nome_equipe IS NOT NULL AND TRIM(c.nome_equipe) != ''
        AND LOWER(c.status) != 'desativado'
        AND LOWER(c.cargo) != 'desativado'
    `, [dataMetrica]);
    const colabsArray = todosColabs.rows;

    if (colabsArray.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Buscar métricas do mês para popular pesos e bônus
    const metricas = await db.query(`
      SELECT email, data_metrica,
             COALESCE(peso_meta_assinados_diario, 3)   AS meta_diario_assinados,
             COALESCE(peso_meta_ganho_diario, 3)       AS meta_diario_ganhos,
             COALESCE(peso_meta_assinados_semanal, 3)  AS meta_semanal_assinados,
             COALESCE(peso_meta_ganho_semanal, 3)      AS meta_semanal_ganhos,
             COALESCE(peso_meta_assinados_mensal, 10)  AS meta_mensal_assinados,
             COALESCE(peso_meta_ganho_mensal, 10)      AS meta_mensal_ganhos,
             COALESCE(comissao_bonus, 0)               AS bonus_comissao
      FROM app_comissionamento.view_app_metricas_assessores
      WHERE data_metrica::date = $1::date
    `, [dataMetrica]);

    // Mapeia métricas por email normalizado
    const metricsByEmail = new Map();
    for (const m of metricas.rows) {
      metricsByEmail.set(normalize(m.email), m);
    }

    // Montar resposta no formato esperado pelo front-end
    const colaboradores = colabsArray.map(colab => {
      const emailNormalizado = normalize(colab.email);
      const metrica = metricsByEmail.get(emailNormalizado);

      return {
        id: colab.email,                               // identificador único é o e-mail
        name: colab.nome,
        email: colab.email,
        equipeId: '',                                  // a view não fornece id_equipe
        equipeNome: colab.nome_equipe,
        grupo: colab.cargo || '',                      // compatibilidade
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
        comissao: metrica ? Number(metrica.bonus_comissao) : 0,
        bonusComissao: metrica ? Number(metrica.bonus_comissao) : 0,
        metaAssinados: 3,
        metaGanhos: 3,
        bonusPorCiclo: 0,
        bonusRecebido: 0,
        produto: mapGrupoToProduto(colab.cargo || ''),
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
      `SELECT DISTINCT c.nome_equipe AS nome
       FROM core.view_app_colaboradores c
       INNER JOIN app_comissionamento.view_app_metricas_assessores m
         ON LOWER(TRIM(c.email)) = LOWER(TRIM(m.email))
       WHERE m.data_metrica::date = $1::date
         AND c.nome_equipe IS NOT NULL AND TRIM(c.nome_equipe) != ''
         AND LOWER(c.status) != 'desativado'
         AND LOWER(c.cargo) != 'desativado'`,
      [dataMetrica]
    );

    const equipes = result.rows
      .map(r => ({ id: r.nome, nome: r.nome }))
      .filter(eq => !EXCLUDED_TEAMS.includes(eq.nome))
      .sort((a, b) => a.nome.localeCompare(b.nome));

    res.json({ success: true, data: equipes });
  } catch (err) {
    console.error('❌ Erro ao buscar equipes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;