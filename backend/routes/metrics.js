// backend/routes/metrics.js
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

// ============================================================
// Catálogo de variantes de produto (case/acento)
// ============================================================
const PRODUCT_VARIANTS = {
  'Auxilio Acidente': ['Auxilio Acidente', 'Auxílio Acidente'],
  'Quinquenio':       ['Quinquenio', 'Quinquênio'],
  'Concomitante':     ['Concomitante', 'concomitante'],
  'BPC/LOAS':         ['BPC/LOAS', 'BPC / LOAS', 'BPC_LOAS'],
  'Isenção de IR Aposentadoria': ['Isenção de IR Aposentadoria', 'Isencao de IR Aposentadoria'],
};

function buildProdutoClause(produto, columnExpr, startIdx) {
  if (!produto || produto === 'Todos') {
    return { clause: '', params: [], nextIdx: startIdx };
  }

  const variants = PRODUCT_VARIANTS[produto];
  const normalizedColumn = `LOWER(TRIM(${columnExpr}))`;

  if (variants) {
    const list = variants.map(v => v.trim().toLowerCase());
    const placeholders = list.map((_, i) => `$${startIdx + i}`).join(', ');
    return {
      clause: ` AND ${normalizedColumn} IN (${placeholders})`,
      params: list,
      nextIdx: startIdx + list.length,
    };
  }

  return {
    clause: ` AND ${normalizedColumn} = $${startIdx}`,
    params: [String(produto).trim().toLowerCase()],
    nextIdx: startIdx + 1,
  };
}

// ============================================================
// Filtros fuzzy de colaborador e equipe
// ============================================================
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

function applyEquipeFilter(rows, equipeNome, keyCandidates = ['equipe']) {
  if (!equipeNome || equipeNome === 'todas') return rows;
  const normFilter = normalize(equipeNome);
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

// ============================================================
// Resolução de EQUIPE → lista de nomes de colaboradores
// ============================================================
const STOPWORDS_EQUIPE = new Set([
  'equipe', 'time', 'grupo', 'setor', 'area', 'área',
  'comercial', 'discadora', 'judit', 'olos', 'crm',
  '-', '–', '—', 'de', 'da', 'do', 'das', 'dos', 'e', '&',
]);

function tokenizeEquipe(str) {
  return normalize(str)
    .split(/\s+/)
    .filter(t => t && !STOPWORDS_EQUIPE.has(t));
}

async function resolveNomesPorEquipe(equipeNome) {
  if (!equipeNome || equipeNome === 'todas') return [];
  try {
    const r = await db.query(
      `SELECT nome, nome_equipe
         FROM core.view_app_colaboradores
        WHERE nome IS NOT NULL`
    );
    const filtroTokens = tokenizeEquipe(equipeNome);
    if (filtroTokens.length === 0) return [];

    return r.rows
      .filter(row => {
        const normRow = normalize(row.nome_equipe || '');
        if (normRow === normalize(equipeNome)) return true;
        const rowTokens = new Set(tokenizeEquipe(row.nome_equipe || ''));
        return filtroTokens.every(t => rowTokens.has(t));
      })
      .map(row => row.nome)
      .filter(Boolean);
  } catch (err) {
    console.error('Erro ao resolver nomes por equipe:', err);
    return [];
  }
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

    const prod = buildProdutoClause(produto, 'e.produto', idx);
    query += prod.clause;
    params.push(...prod.params);
    idx = prod.nextIdx;

    if (gran) {
      query += ` GROUP BY 
        COALESCE(NULLIF(TRIM(e.consultor_responsavel_emissao), ''), 'Sem responsável'),
        e.equipe_responsavel_emissao,
        (DATE_TRUNC('${gran}', e.data_emissao) AT TIME ZONE 'UTC')::date
        ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(e.consultor_responsavel_emissao), ''), 'Sem responsável'), e.equipe_responsavel_emissao ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    const rows = applyColaboradorFilter(result.rows, colaboradorNome, ['colaborador']);
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

    const prod = buildProdutoClause(produto, 'produto', idx);
    query += prod.clause;
    params.push(...prod.params);
    idx = prod.nextIdx;

    if (gran) {
      query += ` GROUP BY 
        COALESCE(NULLIF(TRIM(consultor_responsavel_assinatura), ''), 'Sem responsável'),
        equipe_responsavel_assinatura,
        (DATE_TRUNC('${gran}', data_assinatura) AT TIME ZONE 'UTC')::date
        ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(consultor_responsavel_assinatura), ''), 'Sem responsável'), equipe_responsavel_assinatura ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    const rows = applyColaboradorFilter(result.rows, colaboradorNome, ['colaborador']);
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

    const prod = buildProdutoClause(produto, 'l.produto', idx);
    query += prod.clause;
    params.push(...prod.params);
    idx = prod.nextIdx;

    if (gran) {
      query += ` GROUP BY 
        COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'),
        c.nome_equipe,
        (DATE_TRUNC('${gran}', l.data_ganho) AT TIME ZONE 'UTC')::date
        ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    const rows = applyColaboradorFilter(result.rows, colaboradorNome, ['colaborador']);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /protocolados:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- GANHOS ---
router.get('/ganhos', requireAuth, async (req, res) => {
  try {
    let { start, end, equipe, produto, granularity, demanda } = req.query;
    if (!start || !end) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    const colaboradorNome = await resolveColaboradorNome(req);
    const gran = mapGranularity(granularity);
    const somenteDemandaAtual = String(demanda || '').toLowerCase() === 'atual';

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

    if (somenteDemandaAtual) {
      query += ` AND EXISTS (
        SELECT 1
        FROM core.assinaturas a
        WHERE a.deal_id = l.deal_id
          AND (a.data_assinatura AT TIME ZONE 'UTC')::date >= DATE_TRUNC('month', $1::date)
          AND (a.data_assinatura AT TIME ZONE 'UTC')::date <  DATE_TRUNC('month', $1::date) + INTERVAL '1 month'
      )`;
    }

    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe); idx++;
    }

    const prod = buildProdutoClause(produto, 'l.produto', idx);
    query += prod.clause;
    params.push(...prod.params);
    idx = prod.nextIdx;

    if (gran) {
      query += ` GROUP BY 
        COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'),
        c.nome_equipe,
        (DATE_TRUNC('${gran}', l.data_ganho) AT TIME ZONE 'UTC')::date
        ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    const rows = applyColaboradorFilter(result.rows, colaboradorNome, ['colaborador']);
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

    const prod = buildProdutoClause(produto, 'l.produto', idx);
    query += prod.clause;
    params.push(...prod.params);
    idx = prod.nextIdx;

    if (gran) {
      query += ` GROUP BY 
        COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'),
        c.nome_equipe,
        (DATE_TRUNC('${gran}', l.data_perda) AT TIME ZONE 'UTC')::date
        ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY COALESCE(NULLIF(TRIM(l.responsavel_lead), ''), 'Sem responsável'), c.nome_equipe ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    const rows = applyColaboradorFilter(result.rows, colaboradorNome, ['colaborador']);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /perdidos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// --- LEADS RECEBIDOS ---
// ------------------------------------------------------------
// IMPORTANTE 1 — Sem AT TIME ZONE:
//   core.deals.data_distribuicao_comercial é TIMESTAMP WITHOUT
//   TIME ZONE e os valores JÁ estão em horário de São Paulo.
//   Aplicar `AT TIME ZONE 'America/Sao_Paulo'` reinterpretaria
//   os horários como SP e converteria para UTC, empurrando os
//   últimos 3h de cada dia para o dia seguinte (gap de ~8 deals
//   por período na borda). Por isso usamos `::date` direto.
//
// IMPORTANTE 2 — is_deleted agora é contado:
//   Deals com is_deleted = TRUE passam a ser incluídos no total
//   de leads recebidos, conforme regra de negócio atual.
//
// Dois modos:
//   • Com `granularity` (daily|weekly|monthly) → série temporal
//     { colaborador, equipe, periodo, total } (Home, Analytics).
//   • Sem `granularity` → agregado enriquecido (pipeline, etapa,
//     produto, leads_recebidos, assinados, ganhos, protocolados,
//     taxas). `total` é exposto como alias de `leads_recebidos`.
// ============================================================
router.get('/leads-recebidos', requireAuth, async (req, res) => {
  try {
    const { start, end, equipe, produto, granularity } = req.query;
    if (!start || !end) {
      return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    }
    const colaboradorNome = await resolveColaboradorNome(req);
    const gran = mapGranularity(granularity);

    // ----------------------------------------------------------
    // MODO 1 — SÉRIE TEMPORAL
    // ----------------------------------------------------------
    if (gran) {
      let query = `
        SELECT
          COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável') AS colaborador,
          COALESCE(c.nome_equipe, '') AS equipe,
          (DATE_TRUNC('${gran}', d.data_distribuicao_comercial))::date AS periodo,
          COUNT(DISTINCT d.deal_id)::int AS total
        FROM core.deals d
        LEFT JOIN core.colaboradores c
          ON c.colaborador_id = COALESCE(d.closer_id, d.responsavel_id)
        LEFT JOIN core.produtos pr
          ON pr.produto_id = d.produto_id
        WHERE d.data_distribuicao_comercial IS NOT NULL
          AND d.data_distribuicao_comercial::date >= $1::date
          AND d.data_distribuicao_comercial::date <  $2::date
      `;
      const params = [start, end];
      let idx = 3;

      if (equipe && equipe !== 'todas') {
        query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
        params.push(equipe);
        idx++;
      }

      const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
      query += prod.clause;
      params.push(...prod.params);
      idx = prod.nextIdx;

      query += `
        GROUP BY
          COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável'),
          COALESCE(c.nome_equipe, ''),
          (DATE_TRUNC('${gran}', d.data_distribuicao_comercial))::date
        ORDER BY
          (DATE_TRUNC('${gran}', d.data_distribuicao_comercial))::date,
          COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável')
      `;

      const result = await db.query(query, params);
      const rows = applyColaboradorFilter(result.rows, colaboradorNome, ['colaborador']);
      return res.json({ success: true, data: rows });
    }

    // ----------------------------------------------------------
    // MODO 2 — AGREGADO POR COLABORADOR
    // ----------------------------------------------------------
    let query = `
      WITH assinatura_por_deal AS (
        SELECT
          deal_id,
          MIN(data_assinatura) FILTER (
            WHERE data_assinatura IS NOT NULL
              AND UPPER(COALESCE(status_assinatura, '')) = 'ASSINADO'
          ) AS data_assinatura
        FROM core.assinaturas
        WHERE deal_id IS NOT NULL
        GROUP BY deal_id
      ),
      protocolo_por_deal AS (
        SELECT
          deal_id,
          MIN(data_protocolo) FILTER (
            WHERE data_protocolo IS NOT NULL
              AND (
                NULLIF(BTRIM(numero_processo), '') IS NOT NULL
                OR NULLIF(BTRIM(numero_protocolo), '') IS NOT NULL
              )
          ) AS data_protocolo
        FROM core.processos
        WHERE deal_id IS NOT NULL
        GROUP BY deal_id
      ),
      base AS (
        SELECT
          d.deal_id,
          d.data_distribuicao_comercial::date AS data_recebimento,
          COALESCE(d.closer_id, d.responsavel_id) AS colaborador_id,
          c.nome AS colaborador,
          c.nome_equipe,
          c.unidade_id,
          COALESCE(p.nome_pipeline, 'Sem pipeline') AS pipeline,
          COALESCE(e.nome_etapa,    'Sem etapa')    AS etapa,
          COALESCE(pr.nome_produto, 'Sem produto')  AS produto,
          a.data_assinatura,
          d.data_ganho,
          pp.data_protocolo
        FROM core.deals d
        LEFT JOIN core.colaboradores c
          ON c.colaborador_id = COALESCE(d.closer_id, d.responsavel_id)
        LEFT JOIN ops.crm_pipelines p
          ON p.pipeline_id = d.pipeline_id
        LEFT JOIN ops.crm_etapas e
          ON e.etapa_id = d.etapa_id
         AND (p.crm IS NULL OR e.crm = p.crm)
        LEFT JOIN core.produtos pr
          ON pr.produto_id = d.produto_id
        LEFT JOIN assinatura_por_deal a
          ON a.deal_id = d.deal_id
        LEFT JOIN protocolo_por_deal pp
          ON pp.deal_id = d.deal_id
        WHERE d.data_distribuicao_comercial IS NOT NULL
          AND d.data_distribuicao_comercial::date >= $1::date
          AND d.data_distribuicao_comercial::date <  $2::date
    `;

    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe);
      idx++;
    }

    const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
    query += prod.clause;
    params.push(...prod.params);
    idx = prod.nextIdx;

    query += `
      )
      SELECT
        colaborador_id,
        COALESCE(NULLIF(TRIM(colaborador), ''), 'Sem responsável') AS colaborador,
        COALESCE(nome_equipe, '') AS equipe,
        unidade_id,
        pipeline,
        etapa,
        produto,
        COUNT(DISTINCT deal_id)::int AS leads_recebidos,
        COUNT(DISTINCT deal_id)::int AS total,
        COUNT(DISTINCT deal_id) FILTER (WHERE data_assinatura IS NOT NULL)::int AS assinados,
        COUNT(DISTINCT deal_id) FILTER (WHERE data_ganho      IS NOT NULL)::int AS ganhos,
        COUNT(DISTINCT deal_id) FILTER (WHERE data_protocolo  IS NOT NULL)::int AS protocolados,
        ROUND(
          100.0 * COUNT(DISTINCT deal_id) FILTER (WHERE data_assinatura IS NOT NULL)
          / NULLIF(COUNT(DISTINCT deal_id), 0),
          2
        ) AS conversao_assinatura_pct,
        ROUND(
          100.0 * COUNT(DISTINCT deal_id) FILTER (WHERE data_ganho IS NOT NULL)
          / NULLIF(COUNT(DISTINCT deal_id), 0),
          2
        ) AS conversao_ganho_pct,
        ROUND(
          100.0 * COUNT(DISTINCT deal_id) FILTER (WHERE data_protocolo IS NOT NULL)
          / NULLIF(COUNT(DISTINCT deal_id), 0),
          2
        ) AS conversao_protocolo_pct
      FROM base
      GROUP BY colaborador_id, colaborador, nome_equipe, unidade_id, pipeline, etapa, produto
      ORDER BY colaborador, pipeline, etapa
    `;

    const result = await db.query(query, params);
    const rows = applyColaboradorFilter(result.rows, colaboradorNome, ['colaborador']);

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

    if (gran) {
      query += ` GROUP BY (DATE_TRUNC('${gran}', call_date) AT TIME ZONE 'UTC')::date, agent_name, equipe, campaign_name ORDER BY periodo, colaborador`;
    } else {
      query += ` GROUP BY agent_name, equipe, campaign_name ORDER BY colaborador`;
    }

    const result = await db.query(query, params);
    let rows = result.rows;

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

    const categories = {
      productive: QUALIFICATIONS.productive,
      appointments: QUALIFICATIONS.appointments,
      occurrences: QUALIFICATIONS.occurrences,
      failures: QUALIFICATIONS.failures,
    };
    const qualifications = typeof categoria === 'string' ? categories[categoria] : null;
    if (!qualifications) return res.status(400).json({ success: false, error: 'categoria inválida' });

    let query = `
      SELECT qualification_name AS tabulacao,
             agent_name AS colaborador,
             equipe AS equipe,
             COUNT(*)::int AS total
      FROM madm.view_base_olos_temp
      WHERE call_date::date >= $1::date
        AND call_date::date < $2::date
        AND LOWER(BTRIM(qualification_name)) = ANY($3::text[])
    `;
    const params = [start, end, qualifications.map(value => value.trim().toLowerCase())];

    query += ` GROUP BY qualification_name, agent_name, equipe ORDER BY total DESC, tabulacao`;

    const rawResult = await db.query(query, params);
    let filtered = rawResult.rows;

    if (equipe && equipe !== 'todas') {
      const nomesEquipe = await resolveNomesPorEquipe(equipe);
      filtered = filterByNomesEquipe(filtered, nomesEquipe, ['colaborador', 'agent_name']);
    }

    filtered = applyColaboradorFilter(filtered, colaborador, ['colaborador', 'agent_name']);

    const agg = new Map();
    filtered.forEach(row => {
      const key = row.tabulacao;
      agg.set(key, (agg.get(key) || 0) + (Number(row.total) || 0));
    });

    const data = Array.from(agg.entries())
      .map(([tabulacao, total]) => ({ tabulacao, total }))
      .sort((left, right) => right.total - left.total || left.tabulacao.localeCompare(right.tabulacao));

    res.json({ success: true, data });
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
      const nomesEquipe = await resolveNomesPorEquipe(equipe);
      if (nomesEquipe.length === 0) {
        return res.json({ success: true, total: 0 });
      }
      query += ` AND agent_name = ANY($${idx}::text[])`;
      params.push(nomesEquipe);
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

// ============================================================
// --- LEADS POR ETAPA ---
// ------------------------------------------------------------
// Mesma correção de timezone e is_deleted aplicada em
// `/leads-recebidos`, para manter o total consistente entre
// as telas (Home, Analytics, Funil, Visão Geral, Equipe).
// ============================================================
router.get('/leads/stages', requireAuth, async (req, res) => {
  try {
    let { start, end, equipe, produto } = req.query;
    if (!start || !end) {
      return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    }
    const colaboradorNome = await resolveColaboradorNome(req);

    let query = `
      SELECT
        COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável') AS colaborador,
        COALESCE(e.nome_etapa,    'Sem etapa')    AS etapa_lead,
        COALESCE(p.nome_pipeline, 'Sem pipeline') AS pipeline,
        COUNT(DISTINCT d.deal_id)::int            AS total
      FROM core.deals d
      LEFT JOIN core.colaboradores c
        ON c.colaborador_id = COALESCE(d.closer_id, d.responsavel_id)
      LEFT JOIN ops.crm_pipelines p
        ON p.pipeline_id = d.pipeline_id
      LEFT JOIN ops.crm_etapas e
        ON e.etapa_id = d.etapa_id
       AND (p.crm IS NULL OR e.crm = p.crm)
      LEFT JOIN core.produtos pr
        ON pr.produto_id = d.produto_id
      WHERE d.data_distribuicao_comercial IS NOT NULL
        AND d.data_distribuicao_comercial::date >= $1::date
        AND d.data_distribuicao_comercial::date <  $2::date
    `;
    const params = [start, end];
    let idx = 3;

    if (equipe && equipe !== 'todas') {
      query += ` AND LOWER(TRIM(c.nome_equipe)) = LOWER(TRIM($${idx}))`;
      params.push(equipe);
      idx++;
    }

    const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
    query += prod.clause;
    params.push(...prod.params);
    idx = prod.nextIdx;

    query += `
      GROUP BY
        COALESCE(NULLIF(TRIM(c.nome), ''), 'Sem responsável'),
        COALESCE(e.nome_etapa,    'Sem etapa'),
        COALESCE(p.nome_pipeline, 'Sem pipeline')
      ORDER BY colaborador, etapa_lead
    `;

    const result = await db.query(query, params);
    const rows = applyColaboradorFilter(result.rows, colaboradorNome, ['colaborador']);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Erro em /leads/stages:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- CATÁLOGO DE ETAPAS/PIPELINES ---
router.get('/leads/stages/catalog', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    }
    const query = `
      SELECT DISTINCT
        COALESCE(p.nome_pipeline, 'Sem pipeline')  AS pipeline,
        COALESCE(p.crm,           '(sem crm)')     AS crm,
        COALESCE(e.nome_etapa,    'Sem etapa')     AS etapa,
        COALESCE(pr.nome_produto, '(sem produto)') AS produto
      FROM core.deals d
      LEFT JOIN ops.crm_pipelines p ON p.pipeline_id = d.pipeline_id
      LEFT JOIN ops.crm_etapas   e ON e.etapa_id   = d.etapa_id
                                  AND (p.crm IS NULL OR e.crm = p.crm)
      LEFT JOIN core.produtos    pr ON pr.produto_id = d.produto_id
      WHERE d.data_distribuicao_comercial IS NOT NULL
        AND d.data_distribuicao_comercial::date >= $1::date
        AND d.data_distribuicao_comercial::date <  $2::date
      ORDER BY pipeline, etapa, produto
    `;
    const result = await db.query(query, [start, end]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro em /leads/stages/catalog:', err);
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
      GROUP BY (DATE_TRUNC('week', data_assinatura) AT TIME ZONE 'UTC')::date
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

// ============================================================
// DEMANDA ATUAL E DEMANDA REPRIMIDA
// ============================================================
async function runDemandaQuery({ tipo, equipe, produto }) {
  const baseSelect = `
    SELECT
      c.nome AS colaborador,
      COALESCE(cc.nome_equipe, '') AS equipe,
      a.lead_id,
      a.deal_id,
      (a.data_emissao    AT TIME ZONE 'UTC')::date AS data_emissao,
      (a.data_assinatura AT TIME ZONE 'UTC')::date AS data_assinatura,
      (d.data_ganho      AT TIME ZONE 'UTC')::date AS data_ganho,
      p.nome_pipeline AS pipeline,
      e.nome_etapa    AS etapa,
      COALESCE(pr.nome_produto, 'Sem produto') AS produto
    FROM core.assinaturas a
    INNER JOIN core.colaboradores c
      ON c.colaborador_id = a.consultor_responsavel_assinatura_id
    INNER JOIN core.deals d
      ON d.deal_id = a.deal_id
    LEFT JOIN core.view_app_colaboradores cc
      ON cc.nome = c.nome
    LEFT JOIN ops.crm_pipelines p
      ON p.pipeline_id = d.pipeline_id
     AND p.crm = 'HUBSPOT'
    LEFT JOIN ops.crm_etapas e
      ON e.etapa_id = d.etapa_id
     AND e.crm = 'HUBSPOT'
    LEFT JOIN core.produtos pr
      ON pr.produto_id = d.produto_id
  `;

  const where = tipo === 'atual'
    ? `WHERE a.data_assinatura >= DATE_TRUNC('month', CURRENT_DATE)`
    : `WHERE a.data_assinatura <  DATE_TRUNC('month', CURRENT_DATE)
         AND d.data_ganho IS NULL`;

  let query = `${baseSelect} ${where}`;
  const params = [];
  let idx = 1;

  if (equipe && equipe !== 'todas') {
    query += ` AND LOWER(TRIM(cc.nome_equipe)) = LOWER(TRIM($${idx}))`;
    params.push(equipe); idx++;
  }

  const prod = buildProdutoClause(produto, 'pr.nome_produto', idx);
  query += prod.clause;
  params.push(...prod.params);
  idx = prod.nextIdx;

  query += ` ORDER BY a.data_assinatura DESC`;

  const result = await db.query(query, params);
  return result.rows;
}

// --- DEMANDA ATUAL ---
router.get('/demanda-atual', requireAuth, async (req, res) => {
  try {
    const { equipe, produto } = req.query;
    const colaboradorNome = await resolveColaboradorNome(req);

    const rows = await runDemandaQuery({ tipo: 'atual', equipe, produto });
    const filtered = applyColaboradorFilter(rows, colaboradorNome, ['colaborador']);

    res.json({
      success: true,
      total: filtered.length,
      data: filtered,
    });
  } catch (err) {
    console.error('Erro em /demanda-atual:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- DEMANDA REPRIMIDA ---
router.get('/demanda-reprimida', requireAuth, async (req, res) => {
  try {
    const { equipe, produto } = req.query;
    const colaboradorNome = await resolveColaboradorNome(req);

    const rows = await runDemandaQuery({ tipo: 'reprimida', equipe, produto });
    const filtered = applyColaboradorFilter(rows, colaboradorNome, ['colaborador']);

    res.json({
      success: true,
      total: filtered.length,
      data: filtered,
    });
  } catch (err) {
    console.error('Erro em /demanda-reprimida:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- DEMANDA RESUMO ---
router.get('/demanda-resumo', requireAuth, async (req, res) => {
  try {
    const { equipe, produto } = req.query;
    const colaboradorNome = await resolveColaboradorNome(req);

    const [atualRows, reprimidaRows] = await Promise.all([
      runDemandaQuery({ tipo: 'atual', equipe, produto }),
      runDemandaQuery({ tipo: 'reprimida', equipe, produto }),
    ]);

    const agg = (rows) => {
      const map = new Map();
      for (const r of rows) {
        const key = `${r.colaborador}||${r.equipe || ''}`;
        const cur = map.get(key) || { colaborador: r.colaborador, equipe: r.equipe || '', total: 0 };
        cur.total += 1;
        map.set(key, cur);
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