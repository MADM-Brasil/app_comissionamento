import express from 'express';
import db from '../services/db.js';

const router = express.Router();

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
  return `${year}-${month}`;
}

// Mapeamento de cargo para produto (mantido)
function mapGrupoToProduto(cargo) {
  const mapping = {
    'Elite': 'Auxilio Acidente',
    'Quinquenio': 'Quinquenio',
    'Quinquênio ': 'Quinquenio',
    'Concomitante': 'Concomitante',
  };
  return mapping[cargo] || '';
}

const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing',
  'Equipe Ariana', 'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia'
];

function normalize(str) {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Função de correspondência: tenta várias combinações de e‑mail
function findMetricByEmail(email, metricsMap) {
  const clean = normalize(email);
  if (!clean) return null;

  if (metricsMap.has(clean)) return metricsMap.get(clean);

  const variants = new Set();
  variants.add(clean);
  if (clean.endsWith('.br')) {
    variants.add(clean.slice(0, -3));
  } else {
    variants.add(clean + '.br');
  }

  if (clean.includes('@')) {
    const localPart = clean.split('@')[0];
    variants.add(localPart);
    variants.add(localPart + '@madmbrasil.com.br');
    if (!localPart.endsWith('.br')) {
      variants.add(localPart + '.br');
    }
  }

  for (const v of variants) {
    if (metricsMap.has(v)) return metricsMap.get(v);
  }
  return null;
}

// GET /api/collaborators
router.get('/collaborators', requireAuth, async (req, res) => {
  const periodo = req.query.mes || getCurrentPeriod();
  console.log(`📅 Buscando colaboradores para o período: ${periodo}`);

  try {
    // Consulta base na view de colaboradores
    const todosColabs = await db.query(`
      SELECT email, nome, nome_equipe, cargo, status, periodo
      FROM core.view_app_colaboradores
      WHERE periodo = $1
        AND nome_equipe IS NOT NULL AND TRIM(nome_equipe) != ''
        AND LOWER(status) != 'desativado'
        AND LOWER(cargo) != 'desativado'
    `, [periodo]);
    const colabsArray = todosColabs.rows;

    if (colabsArray.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // Métricas da view de métricas assessores
    const metricas = await db.query(`
      SELECT email, data_metrica,
             COALESCE(peso_meta_assinados_diario, 3)   AS meta_diario_assinados,
             COALESCE(peso_meta_ganho_diario, 3)       AS meta_diario_ganhos,
             COALESCE(peso_meta_assinados_semanal, 3)  AS meta_semanal_assinados,
             COALESCE(peso_meta_ganho_semanal, 3)      AS meta_semanal_ganhos,
             COALESCE(peso_meta_assinados_mensal, 10)  AS meta_mensal_assinados,
             COALESCE(peso_meta_ganho_mensal, 10)      AS meta_mensal_ganhos,
             COALESCE(comissao_bonus, 0)               AS comissao,
             COALESCE(comissao_bonus, 0)               AS bonus_comissao
      FROM app_comissionamento.view_app_metricas_assessores
      WHERE TO_CHAR(data_metrica::date, 'YYYY-MM') = $1
    `, [periodo]);

    const metricsByEmail = new Map();
    for (const m of metricas.rows) {
      const normalized = normalize(m.email);
      metricsByEmail.set(normalized, m);
      if (normalized.endsWith('.br')) {
        metricsByEmail.set(normalized.slice(0, -3), m);
      } else {
        metricsByEmail.set(normalized + '.br', m);
      }
    }

    const colaboradores = [];
    for (const colab of colabsArray) {
      const equipeNome = (colab.nome_equipe || '').trim();
      if (EXCLUDED_TEAMS.includes(equipeNome)) continue;

      const emailColab = normalize(colab.email);
      let metrica = findMetricByEmail(emailColab, metricsByEmail);

      if (!metrica) {
        const nomeColab = normalize(colab.nome);
        for (const [key, m] of metricsByEmail.entries()) {
          if (key === nomeColab || key.includes(nomeColab) || nomeColab.includes(key)) {
            metrica = m;
            break;
          }
        }
      }

      colaboradores.push({
        id: colab.email,
        name: colab.nome,
        email: colab.email,
        equipeId: '',  // id_equipe não disponível na view
        equipeNome,
        grupo: colab.cargo || '',
        status: colab.status || 'ativo',
        periodo: colab.periodo || periodo,
        avatar: (colab.nome || '?').charAt(0).toUpperCase(),
        emitidos: 0,
        assinados: 0,
        ganhos: 0,
        perdidos: 0,
        metaDiarioAssinados: metrica ? Number(metrica.meta_diario_assinados) : 3,
        metaDiarioGanhos: metrica ? Number(metrica.meta_diario_ganhos) : 3,
        metaSemanalAssinados: metrica ? Number(metrica.meta_semanal_assinados) : 15,
        metaSemanalGanhos: metrica ? Number(metrica.meta_semanal_ganhos) : 15,
        metaMensalAssinados: metrica ? Number(metrica.meta_mensal_assinados) : 60,
        metaMensalGanhos: metrica ? Number(metrica.meta_mensal_ganhos) : 60,
        comissao: metrica ? Number(metrica.comissao) : 0,
        bonusComissao: metrica ? Number(metrica.bonus_comissao) : 0,
        metaAssinados: 3,
        metaGanhos: 3,
        bonusPorCiclo: 0,
        bonusRecebido: 0,
        produto: mapGrupoToProduto(colab.cargo || ''),
      });
    }

    console.log(`✅ Retornando ${colaboradores.length} colaboradores.`);
    res.json({ success: true, data: colaboradores });
  } catch (err) {
    console.error('❌ Erro ao buscar colaboradores:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/equipes
router.get('/equipes', requireAuth, async (req, res) => {
  const gruposPermitidos = [
    'Elite', 'Supervisor', 'Análise de segurado', 'Concomitante',
    'Salesops', 'Quinquenio', 'Quinquênio ', 'Coordenador', 'CEO', 'Diretoria'
  ];
  const periodo = getCurrentPeriod();

  try {
    const result = await db.query(
      `SELECT DISTINCT nome_equipe AS equipe
       FROM core.view_app_colaboradores
       WHERE periodo = $1 AND cargo = ANY($2)
         AND nome_equipe IS NOT NULL AND TRIM(nome_equipe) != ''`,
      [periodo, gruposPermitidos]
    );

    const teamsMap = new Map();
    for (const row of result.rows) {
      const nome = (row.equipe || '').trim();
      if (!teamsMap.has(nome)) {
        teamsMap.set(nome, nome);  // id não disponível, usa o próprio nome
      }
    }

    const equipes = Array.from(teamsMap.entries())
      .map(([nome, id]) => ({ id, nome }))
      .filter(eq => !EXCLUDED_TEAMS.includes(eq.nome))
      .sort((a, b) => a.nome.localeCompare(b.nome));

    res.json({ success: true, data: equipes });
  } catch (err) {
    console.error('❌ Erro ao buscar equipes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;