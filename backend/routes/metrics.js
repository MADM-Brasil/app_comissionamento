import express from 'express';
import db from '../services/db.js';

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

// Auxiliares
async function getColaboradorNomeFromId(colaboradorId) {
  // Na view não há internal_id, então se for usado id, retornamos null; mantido para compatibilidade
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

function mapGranularity(granularity) {
  const map = { daily: 'day', weekly: 'week', monthly: 'month' };
  return map[granularity] || null;
}

function normalize(str) {
  return (str || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const QUALIFICATIONS = {
  productive: [
    'Transferida a Outro Módulo',
    'SMS Enviado',
    'Pediu contato via WhatsApp',
    'Coleta de documentacao',
    'Emissao de contrato',
    'Tratativa via WhatsApp',
  ],
  appointments: ['Retornar ligacao', 'Trabalhando'],
  occurrences: [
    'Nao tabulada - tempo excedido', 'Não tabulada - tempo excedido',
    'Mudo', 'Queda de ligacao', 'Queda de ligação', 'Caixa postal',
  ],
  failures: [
    'Ja tem advogado','Ja revisado','Ja em processo de revisao',
    'Sem interesse', 'Nao pertence ao cliente', 'Faleceu', 'Ja tem acao',
    'Nao tem direito', 'Nunca trabalhou de carteira assinada', 'Nunca sofreu acidente',
    'Cliente desconhece o cadastro', 'Nao quer mais contato', 'Nao concomitante',
    'Nao aposentado', 'Fora do periodo aquisitivo', 'Pensionista', 'Aposentadoria RPPS',
    'Aposentado antes de 2015', 'BPC - LOAS Desqualificado', 'BPC - LOAS Ganho',
    'Ja recebe o auxilio-acidente', 'Em processo com a MADM', 'Sem sequela',
    'Aposentado', 'Sem documentacao', 'Contribuinte individual - autonomo',
    'Acidente a mais de 20 anos', 'Ja tem processo de auxilio acidente',
    'Cliente Atritado', 'Ja em processo de revisao', 'Recebendo auxilio-doenca',
    'Acidente recente', 'Fora do periodo de graca', 'Cliente desqualificado',
  ],
};

// --- EMITIDOS ---
router.get('/emitidos', requireAuth, async (req, res) => {
  try {
    let { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);
    const gran = mapGranularity(granularity);

    let query = `
      SELECT 
        COALESCE(NULLIF(TRIM(e.consultor_responsavel_emissao), ''), 'Sem responsável') as colaborador,
        COALESCE(e.equipe_responsavel_emissao, '') as equipe,
        COUNT(*)::int as total
    `;
    if (gran) {
      query = `
        SELECT 
          COALESCE(NULLIF(TRIM(e.consultor_responsavel_emissao), ''), 'Sem responsável') as colaborador,
          COALESCE(e.equipe_responsavel_emissao, '') as equipe,
          (DATE_TRUNC('${gran}', e.data_emissao) AT TIME ZONE 'UTC')::date as periodo,
          COUNT(*)::int as total
      `;
    }
    query += `
      FROM core.view_emitidos e
      WHERE (e.data_emissao AT TIME ZONE 'UTC')::date >= $1 AND (e.data_emissao AT TIME ZONE 'UTC')::date < $2
    `;
    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(e.equipe_responsavel_emissao)) = LOWER(TRIM($${idx}))`;
      params.push(equipe); idx++;
    }
    if (produto && produto !== 'Todos') {
      const productVariants = {
        'Auxilio Acidente': ['Auxilio Acidente', 'Auxílio Acidente'],
        'Quinquenio': ['Quinquenio', 'Quinquênio']
      };
      if (productVariants[produto]) {
        const variants = productVariants[produto];
        const placeholders = variants.map((_, i) => `$${idx + i}`).join(', ');
        query += ` AND e.produto IN (${placeholders})`;
        params.push(...variants); idx += variants.length;
      } else {
        query += ` AND e.produto = $${idx}`;
        params.push(produto); idx++;
      }
    }
    if (gran) {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(e.consultor_responsavel_emissao), ''), 'Sem responsável'), e.equipe_responsavel_emissao, DATE_TRUNC('${gran}', e.data_emissao) ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(e.consultor_responsavel_emissao), ''), 'Sem responsável'), e.equipe_responsavel_emissao ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    let rows = result.rows;

    if (colaboradorNome) {
      const normFilter = normalize(colaboradorNome);
      rows = rows.filter(row => {
        const rowColab = normalize(row.colaborador);
        return rowColab === normFilter || rowColab.includes(normFilter) || normFilter.includes(rowColab);
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /emitidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ASSINADOS ---
router.get('/assinados', requireAuth, async (req, res) => {
  try {
    let { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);
    const gran = mapGranularity(granularity);

    let query = `
      SELECT 
        COALESCE(NULLIF(TRIM(consultor_responsavel_assinatura), ''), 'Sem responsável') as colaborador,
        equipe_responsavel_assinatura as equipe,
        COUNT(*)::int as total
    `;
    if (gran) {
      query = `
        SELECT 
          COALESCE(NULLIF(TRIM(consultor_responsavel_assinatura), ''), 'Sem responsável') as colaborador,
          equipe_responsavel_assinatura as equipe,
          (DATE_TRUNC('${gran}', data_assinatura) AT TIME ZONE 'UTC')::date as periodo,
          COUNT(*)::int as total
      `;
    }
    query += `
      FROM core.view_assinados
      WHERE (data_assinatura AT TIME ZONE 'UTC')::date >= $1 AND (data_assinatura AT TIME ZONE 'UTC')::date < $2
    `;
    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(equipe_responsavel_assinatura)) = LOWER(TRIM($${idx}))`;
      params.push(equipe); idx++;
    }
    if (produto && produto !== 'Todos') {
      const productVariants = {
        'Auxilio Acidente': ['Auxilio Acidente', 'Auxílio Acidente'],
        'Quinquenio': ['Quinquenio', 'Quinquênio']
      };
      if (productVariants[produto]) {
        const variants = productVariants[produto];
        const placeholders = variants.map((_, i) => `$${idx + i}`).join(', ');
        query += ` AND produto IN (${placeholders})`;
        params.push(...variants); idx += variants.length;
      } else {
        query += ` AND produto = $${idx}`;
        params.push(produto); idx++;
      }
    }
    if (gran) {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(consultor_responsavel_assinatura), ''), 'Sem responsável'), equipe_responsavel_assinatura, DATE_TRUNC('${gran}', data_assinatura) ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(consultor_responsavel_assinatura), ''), 'Sem responsável'), equipe_responsavel_assinatura ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    let rows = result.rows;

    if (colaboradorNome) {
      const normFilter = normalize(colaboradorNome);
      rows = rows.filter(row => {
        const rowColab = normalize(row.colaborador);
        return rowColab === normFilter || rowColab.includes(normFilter) || normFilter.includes(rowColab);
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /assinados:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/assinados-diario-por-equipe', requireAuth, async (req, res) => {
  try {
    const { inicio, fim, equipe } = req.query;
    if (!inicio || !fim) return res.status(400).json({ success: false, error: 'inicio e fim obrigatórios' });

    let query = `
      SELECT
        equipe_responsavel_assinatura as equipe,
        (data_assinatura AT TIME ZONE 'UTC')::date as dia,
        COUNT(*)::int as total
      FROM core.view_assinados
      WHERE (data_assinatura AT TIME ZONE 'UTC')::date >= $1
        AND (data_assinatura AT TIME ZONE 'UTC')::date < $2
    `;
    const params = [inicio, fim];

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(equipe_responsavel_assinatura)) = LOWER(TRIM($3))`;
      params.push(equipe);
    }

    query += ` GROUP BY equipe_responsavel_assinatura, dia ORDER BY dia, equipe_responsavel_assinatura`;

    const result = await db.query(query, params);
    const rows = result.rows.map(item => ({
      equipe: item.equipe,
      time: item.equipe,
      dia: item.dia instanceof Date ? item.dia.toISOString().slice(0, 10) : item.dia,
      total: Number(item.total) || 0,
    }));

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /assinados-diario-por-equipe:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ASSINADOS DIÁRIOS POR COLABORADOR ---
router.get('/assinados-diario-colaborador', requireAuth, async (req, res) => {
  try {
    const { inicio, fim } = req.query;
    if (!inicio || !fim) {
      return res.status(400).json({ success: false, error: 'inicio e fim obrigatórios' });
    }

    const query = `
      SELECT 
        (data_assinatura AT TIME ZONE 'UTC')::date as dia,
        consultor_responsavel_assinatura as colaborador,
        COUNT(*)::int as total
      FROM core.view_assinados
      WHERE (data_assinatura AT TIME ZONE 'UTC')::date >= $1 
        AND (data_assinatura AT TIME ZONE 'UTC')::date < $2
      GROUP BY dia, consultor_responsavel_assinatura
      ORDER BY dia, consultor_responsavel_assinatura
    `;

    const result = await db.query(query, [inicio, fim]);
    const rows = result.rows.map(item => ({
      dia: item.dia instanceof Date ? item.dia.toISOString().slice(0, 10) : item.dia,
      colaborador: item.colaborador,
      total: Number(item.total) || 0,
    }));

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /assinados-diario-colaborador:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PROTOCOLADOS ---
router.get('/protocolados', requireAuth, async (req, res) => {
  try {
    let { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);
    const gran = mapGranularity(granularity);

    let query = `
      SELECT 
        COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
        COALESCE(c.nome_equipe, '') as equipe,
        COUNT(*)::int as total
    `;
    if (gran) {
      query = `
        SELECT 
          COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
          COALESCE(c.nome_equipe, '') as equipe,
          (DATE_TRUNC('${gran}', l.data_ganho) AT TIME ZONE 'UTC')::date as periodo,
          COUNT(*)::int as total
      `;
    }
    query += `
      FROM core.view_app_juridico_auditoria l
      LEFT JOIN core.view_app_colaboradores c ON l.responsavel_lead = c.nome
      WHERE (l.data_ganho AT TIME ZONE 'UTC')::date >= $1
        AND (l.data_ganho AT TIME ZONE 'UTC')::date < $2
        AND l.etapa IN ('Protocolado')
    `;
    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe); idx++;
    }
    if (produto && produto !== 'Todos') {
      const productVariants = {
        'Auxilio Acidente': ['Auxilio Acidente', 'Auxílio Acidente'],
        'Quinquenio': ['Quinquenio', 'Quinquênio']
      };
      if (productVariants[produto]) {
        const variants = productVariants[produto];
        const placeholders = variants.map((_, i) => `$${idx + i}`).join(', ');
        query += ` AND l.produto IN (${placeholders})`;
        params.push(...variants); idx += variants.length;
      } else {
        query += ` AND l.produto = $${idx}`;
        params.push(produto); idx++;
      }
    }
    if (gran) {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe, DATE_TRUNC('${gran}', l.data_ganho) ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    let rows = result.rows;

    if (colaboradorNome) {
      const normFilter = normalize(colaboradorNome);
      rows = rows.filter(row => {
        const rowColab = normalize(row.colaborador);
        return rowColab === normFilter || rowColab.includes(normFilter) || normFilter.includes(rowColab);
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /protocolados:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- GANHOS ---
router.get('/ganhos', requireAuth, async (req, res) => {
  try {
    let { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);
    const gran = mapGranularity(granularity);

    let query = `
      SELECT 
        COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
        COALESCE(c.nome_equipe, '') as equipe,
        COUNT(*)::int as total
    `;
    if (gran) {
      query = `
        SELECT 
          COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
          COALESCE(c.nome_equipe, '') as equipe,
          (DATE_TRUNC('${gran}', l.data_ganho) AT TIME ZONE 'UTC')::date as periodo,
          COUNT(*)::int as total
      `;
    }
    query += `
      FROM core.view_app_juridico_auditoria l
      LEFT JOIN core.view_app_colaboradores c ON l.responsavel_lead = c.nome
      WHERE (l.data_ganho AT TIME ZONE 'UTC')::date >= $1 AND (l.data_ganho AT TIME ZONE 'UTC')::date < $2
        AND l.etapa <> 'Venda perdida'
    `;
    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe); idx++;
    }
    if (produto && produto !== 'Todos') {
      const productVariants = {
        'Auxilio Acidente': ['Auxilio Acidente', 'Auxílio Acidente'],
        'Quinquenio': ['Quinquenio', 'Quinquênio'],
        'Concomitante': ['Concomitante', 'concomitante']
      };
      if (productVariants[produto]) {
        const variants = productVariants[produto];
        const placeholders = variants.map((_, i) => `$${idx + i}`).join(', ');
        query += ` AND l.produto IN (${placeholders})`;
        params.push(...variants); idx += variants.length;
      } else {
        query += ` AND l.produto = $${idx}`;
        params.push(produto); idx++;
      }
    }
    if (gran) {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe, DATE_TRUNC('${gran}', l.data_ganho) ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    let rows = result.rows;

    if (colaboradorNome) {
      const normFilter = normalize(colaboradorNome);
      rows = rows.filter(row => {
        const rowColab = normalize(row.colaborador);
        return rowColab === normFilter || rowColab.includes(normFilter) || normFilter.includes(rowColab);
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /ganhos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PERDIDOS ---
router.get('/perdidos', requireAuth, async (req, res) => {
  try {
    let { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);
    const gran = mapGranularity(granularity);

    let query = `
      SELECT 
        COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
        COALESCE(c.nome_equipe, '') as equipe,
        COUNT(*)::int as total
    `;
    if (gran) {
      query = `
        SELECT 
          COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
          COALESCE(c.nome_equipe, '') as equipe,
          (DATE_TRUNC('${gran}', l.data_perda) AT TIME ZONE 'UTC')::date as periodo,
          COUNT(*)::int as total
      `;
    }
    query += `
      FROM core.view_app_juridico_auditoria l
      LEFT JOIN core.view_app_colaboradores c ON l.responsavel_lead = c.nome
      WHERE (l.data_perda AT TIME ZONE 'UTC')::date >= $1 AND (l.data_perda AT TIME ZONE 'UTC')::date < $2
        AND l.etapa = 'Venda perdida'
    `;
    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe); idx++;
    }
    if (produto && produto !== 'Todos') {
      const productVariants = {
        'Auxilio Acidente': ['Auxilio Acidente', 'Auxílio Acidente'],
        'Quinquenio': ['Quinquenio', 'Quinquênio']
      };
      if (productVariants[produto]) {
        const variants = productVariants[produto];
        const placeholders = variants.map((_, i) => `$${idx + i}`).join(', ');
        query += ` AND l.produto IN (${placeholders})`;
        params.push(...variants); idx += variants.length;
      } else {
        query += ` AND l.produto = $${idx}`;
        params.push(produto); idx++;
      }
    }
    if (gran) {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe, DATE_TRUNC('${gran}', l.data_perda) ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    let rows = result.rows;

    if (colaboradorNome) {
      const normFilter = normalize(colaboradorNome);
      rows = rows.filter(row => {
        const rowColab = normalize(row.colaborador);
        return rowColab === normFilter || rowColab.includes(normFilter) || normFilter.includes(rowColab);
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /perdidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- LEADS RECEBIDOS ---
router.get('/leads-recebidos', requireAuth, async (req, res) => {
  try {
    let { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);
    const gran = mapGranularity(granularity);

    let query = `
      SELECT 
        COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
        COALESCE(c.nome_equipe, '') as equipe,
        COUNT(*)::int as total
    `;
    if (gran) {
      query = `
        SELECT 
          COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
          COALESCE(c.nome_equipe, '') as equipe,
          DATE_TRUNC('${gran}', l.data_qualificacao::timestamp)::date as periodo,
          COUNT(*)::int as total
      `;
    }
    query += `
      FROM core.view_qualificados l
      LEFT JOIN core.view_app_colaboradores c ON l.responsavel_lead = c.nome
      WHERE l.data_qualificacao::date >= $1::date
        AND l.data_qualificacao::date < $2::date
    `;
    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe); idx++;
    }
    if (gran) {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe, DATE_TRUNC('${gran}', l.data_qualificacao::timestamp)::date ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    let rows = result.rows;

    if (colaboradorNome) {
      const normFilter = normalize(colaboradorNome);
      rows = rows.filter(row => {
        const rowColab = normalize(row.colaborador);
        return rowColab === normFilter || rowColab.includes(normFilter) || normFilter.includes(rowColab);
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /leads-recebidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- METRICAS DE LIGACOES ---
router.get('/ligacoes', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, colaborador, granularity } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const gran = mapGranularity(granularity);
    let query = `
      SELECT
        agent_name AS colaborador,
        equipe,
        campaign_name AS campanha,
        COUNT(*)::int AS total_ligacoes,
        COUNT(DISTINCT lead_id)::int AS leads_distintos,
        COUNT(*) FILTER (WHERE qualification_name = ANY($3::text[]))::int AS produtivas,
        COUNT(*) FILTER (WHERE qualification_name = ANY($4::text[]))::int AS agendamentos,
        COUNT(*) FILTER (WHERE LOWER(BTRIM(qualification_name)) = ANY($5::text[]))::int AS ocorrencias,
        COUNT(*) FILTER (WHERE qualification_name = ANY($6::text[]))::int AS insucessos,
        AVG(tma)::numeric(12, 2) AS tma_medio
    `;
    if (gran) {
      query = `
        SELECT
          (DATE_TRUNC('${gran}', call_date) AT TIME ZONE 'UTC')::date AS periodo,
          agent_name AS colaborador,
          equipe,
          campaign_name AS campanha,
          COUNT(*)::int AS total_ligacoes,
          COUNT(DISTINCT lead_id)::int AS leads_distintos,
          COUNT(*) FILTER (WHERE qualification_name = ANY($3::text[]))::int AS produtivas,
          COUNT(*) FILTER (WHERE qualification_name = ANY($4::text[]))::int AS agendamentos,
          COUNT(*) FILTER (WHERE LOWER(BTRIM(qualification_name)) = ANY($5::text[]))::int AS ocorrencias,
          COUNT(*) FILTER (WHERE qualification_name = ANY($6::text[]))::int AS insucessos,
          AVG(tma)::numeric(12, 2) AS tma_medio
      `;
    }
    query += `
      FROM madm.view_base_olos_temp
      WHERE call_date::date >= $1::date
        AND call_date::date < $2::date
    `;
    const params = [
      start,
      end,
      QUALIFICATIONS.productive,
      QUALIFICATIONS.appointments,
      QUALIFICATIONS.occurrences.map(value => value.trim().toLowerCase()),
      QUALIFICATIONS.failures,
    ];
    let idx = 7;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe);
      idx++;
    }
    if (colaborador) {
      query += ` AND LOWER(TRIM(agent_name)) = LOWER(TRIM($${idx}))`;
      params.push(colaborador);
      idx++;
    }
    if (gran) {
      query += ` GROUP BY DATE_TRUNC('${gran}', call_date), agent_name, equipe, campaign_name ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY agent_name, equipe, campaign_name ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro em /ligacoes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/ligacoes/tabulacoes', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, colaborador, categoria } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    const categories = {
      productive: QUALIFICATIONS.productive,
      appointments: QUALIFICATIONS.appointments,
      occurrences: QUALIFICATIONS.occurrences,
      failures: QUALIFICATIONS.failures,
    };
    const qualifications = typeof categoria === 'string' ? categories[categoria] : null;
    if (!qualifications) return res.status(400).json({ success: false, error: 'categoria inválida' });

    let query = `
      SELECT qualification_name AS tabulacao, COUNT(*)::int AS total
      FROM madm.view_base_olos_temp
      WHERE call_date::date >= $1::date
        AND call_date::date < $2::date
        AND LOWER(BTRIM(qualification_name)) = ANY($3::text[])
    `;
    const params = [start, end, qualifications.map(value => value.trim().toLowerCase())];
    let idx = 4;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe);
      idx++;
    }
    if (colaborador) {
      query += ` AND LOWER(TRIM(agent_name)) = LOWER(TRIM($${idx}))`;
      params.push(colaborador);
    }

    query += ` GROUP BY qualification_name ORDER BY total DESC, tabulacao`;
    const result = await db.query(query, params);
    res.json({
      success: true,
      data: result.rows.map(row => ({ ...row, total: Number(row.total) || 0 })),
    });
  } catch (err) {
    console.error('Erro em /ligacoes/tabulacoes:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- LIGACOES PRODUTIVAS ---
router.get('/ligacoes-produtivas', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, colaborador } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });

    let query = `
      SELECT COUNT(*)::int AS total
      FROM madm.view_base_olos_temp
      WHERE qualification_name = ANY($1::text[])
        AND call_date::date >= $2::date
        AND call_date::date < $3::date
    `;
    const params = [QUALIFICATIONS.productive, start, end];
    let idx = 4;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe);
      idx++;
    }
    if (colaborador) {
      query += ` AND LOWER(TRIM(agent_name)) = LOWER(TRIM($${idx}))`;
      params.push(colaborador);
    }

    const result = await db.query(query, params);

    res.json({ success: true, total: Number(result.rows[0]?.total) || 0 });
  } catch (err) {
    console.error('Erro em /ligacoes-produtivas:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- LEADS POR ETAPA ---
router.get('/leads/stages', requireAuth, async (req, res) => {
  try {
    let { start, end, equipe, produto } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);

    let query = `
      SELECT 
        COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável') as colaborador,
        l.etapa_lead,
        COUNT(*)::int as total
      FROM core.view_qualificados l
      LEFT JOIN core.view_app_colaboradores c ON l.responsavel_lead = c.nome
      WHERE l.data_qualificacao::date >= $1::date
        AND l.data_qualificacao::date < $2::date
    `;
    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe); idx++;
    }
    query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), l.etapa_lead, c.nome_equipe ORDER BY colaborador`;

    const result = await db.query(query, params);
    let rows = result.rows;

    if (colaboradorNome) {
      const normFilter = normalize(colaboradorNome);
      rows = rows.filter(row => {
        const rowColab = normalize(row.colaborador);
        return rowColab === normFilter || rowColab.includes(normFilter) || normFilter.includes(rowColab);
      });
    }
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /leads/stages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PERFORMANCE SEMANAL ---
router.get('/weekly', requireAuth, async (req, res) => {
  try {
    let { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const query = `
      SELECT 
        (DATE_TRUNC('week', data_assinatura) AT TIME ZONE 'UTC')::date as semana,
        COUNT(*)::int as vendas
      FROM core.view_assinados
      WHERE (data_assinatura AT TIME ZONE 'UTC')::date >= $1 AND (data_assinatura AT TIME ZONE 'UTC')::date < $2
      GROUP BY semana
      ORDER BY semana
    `;
    const result = await db.query(query, [start, end]);
    const weeklyData = result.rows.map(row => ({
      semana: row.semana,
      vendas: row.vendas,
      meta: 5
    }));
    res.json({ success: true, data: weeklyData });
  } catch (err) {
    console.error('Erro em /weekly:', err);
    const mock = [
      { semana: '2026-05-04', vendas: 0, meta: 5 },
      { semana: '2026-05-11', vendas: 0, meta: 5 },
      { semana: '2026-05-18', vendas: 0, meta: 5 },
      { semana: '2026-05-25', vendas: 0, meta: 5 },
    ];
    res.json({ success: true, data: mock });
  }
});

export default router;