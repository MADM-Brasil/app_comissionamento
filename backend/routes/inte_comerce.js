// backend/routes/inte_comerce.js
import express from 'express';
import db from '../services/db.js';
import {
  accessControl,
  getActiveSupportUser,
  isSupportAdmin,
} from '../services/access-control.js';

const router = express.Router();
const ANALYTICS_STATEMENT_TIMEOUT_MS = 55_000;
const ANALYTICS_QUERY_TIMEOUT_MS = ANALYTICS_STATEMENT_TIMEOUT_MS + 3_000;

async function analyticsQuery(text, values) {
  const client = await db.pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${ANALYTICS_STATEMENT_TIMEOUT_MS}ms'`);
    const result = await client.query({
      text,
      values,
      query_timeout: ANALYTICS_QUERY_TIMEOUT_MS,
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError;
      console.error('Falha ao reverter consulta analítica:', rollbackError);
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }

  try {
    const actor = await getActiveSupportUser(req.session.userId);
    if (!actor) {
      return res.status(403).json({ success: false, error: 'Usuário ativo não encontrado.' });
    }

    const level = accessControl.getEffectiveAccessLevel(actor);
    if (level < accessControl.LEVELS.COORDENADOR) {
      return res.status(403).json({ success: false, error: 'Perfil sem acesso à Inteligência Comercial.' });
    }

    const unidadeUsuario = actor.unidade_id != null ? Number(actor.unidade_id) : null;
    const requestedUnit = req.query.unidadeId;
    const isAdmin = isSupportAdmin(actor.cargo);
    if (
      requestedUnit != null &&
      (
        typeof requestedUnit !== 'string' ||
        !/^\d+$/.test(requestedUnit) ||
        !Number.isSafeInteger(Number(requestedUnit)) ||
        Number(requestedUnit) < 1
      )
    ) {
      return res.status(400).json({ success: false, error: 'Unidade inválida.' });
    }

    const unidadeSelecionada = requestedUnit != null ? Number(requestedUnit) : null;
    if (!isAdmin && unidadeUsuario !== 4) {
      if (!Number.isInteger(unidadeUsuario)) {
        return res.status(403).json({ success: false, error: 'Usuário sem unidade definida.' });
      }
      if (unidadeSelecionada != null && unidadeSelecionada !== unidadeUsuario) {
        return res.status(403).json({ success: false, error: 'A unidade selecionada está fora do seu escopo.' });
      }
    }

    const unidadeFiltro = !isAdmin && unidadeUsuario !== 4
      ? unidadeUsuario
      : unidadeSelecionada;
    const result = await db.pool.query(
      `SELECT DISTINCT id_assessor, unidade_id
       FROM core.view_app_colaboradores
       WHERE id_assessor IS NOT NULL
         AND LOWER(TRIM(COALESCE(status, ''))) != 'desativado'
         AND LOWER(TRIM(COALESCE(cargo, ''))) != 'desativado'`,
    );
    req.inteComerceActiveCollaboratorIds = result.rows.map((row) => String(row.id_assessor));
    req.inteComerceColaboradorIds = result.rows
      .filter((row) => unidadeFiltro == null || Number(row.unidade_id) === unidadeFiltro)
      .map((row) => String(row.id_assessor));

    next();
  } catch (error) {
    next(error);
  }
}

function readParams(req) {
  const { start, end, equipe, colaboradorId } = req.query;
  if (!start || !end) return null;
  if (typeof start !== 'string' || typeof end !== 'string') {
    return { error: 'start e end devem estar no formato YYYY-MM-DD.' };
  }
  const colabNum =
    colaboradorId != null && String(colaboradorId).trim() !== ''
      ? Number(colaboradorId)
      : null;

  const params = {
    inicio: start,
    fim_exclusivo: end,
    equipe: equipe && equipe !== 'todas' ? equipe : null,
    colaborador_id: Number.isFinite(colabNum) ? colabNum : null,
    colaborador_ids_escopo: req.inteComerceColaboradorIds,
    colaborador_ids_ativos: req.inteComerceActiveCollaboratorIds,
  };

  const validDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!validDate(start) || !validDate(end) || end <= start) {
    return { error: 'Período inválido. Use datas válidas no formato YYYY-MM-DD e end posterior a start.' };
  }

  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const todayParts = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  const year = Number(todayParts.year);
  const month = Number(todayParts.month);
  const day = Number(todayParts.day);
  const targetMonth = month - 2;
  const minDateYear = year + Math.floor((targetMonth - 1) / 12);
  const minDateMonth = ((targetMonth - 1) % 12 + 12) % 12 + 1;
  const daysInMinDateMonth = new Date(Date.UTC(minDateYear, minDateMonth, 0)).getUTCDate();
  const minDate = `${minDateYear}-${String(minDateMonth).padStart(2, '0')}-${String(Math.min(day, daysInMinDateMonth)).padStart(2, '0')}`;
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  if (start < minDate || end > tomorrow) {
    return {
      error: `Este relatório permite consultar somente os últimos dois meses (${minDate} até hoje).`,
    };
  }

  return params;
}

// CTE base — usa CURRENT_TIMESTAMP como as_of (produção).
// Para homologação contra base staging, troque por LEAST(TIMESTAMPTZ '...', CURRENT_TIMESTAMP).
const CTE_BASE = `
WITH p AS (
  SELECT $1::date AS inicio, $2::date AS fim_exclusivo,
         CURRENT_TIMESTAMP AS as_of,
         $3::text AS equipe, $4::bigint AS colaborador_id,
         $5::bigint[] AS colaborador_ids_escopo,
         $6::bigint[] AS colaborador_ids_ativos
), limites AS (
  SELECT p.*, (p.inicio::timestamp AT TIME ZONE 'America/Sao_Paulo') AS t0,
         (p.fim_exclusivo::timestamp AT TIME ZONE 'America/Sao_Paulo') AS t1
  FROM p
)`;

const CTE_EVENTOS = `,
eventos AS (
  SELECT e.deal_id, e.ocorrido_em, e.colaborador_id, e.equipe_atual, e.tipo
  FROM ops.v_bi_v6_eventos e CROSS JOIN limites p
  WHERE e.ocorrido_em >= p.t0
    AND e.ocorrido_em <= p.as_of
    AND (
      e.colaborador_id IS NULL
      OR e.colaborador_id = ANY($6::bigint[])
    )
    AND e.tipo IN (
      'RECEBIDO_CORPORATIVO', 'RECEBIDO_ASSESSOR', 'TRABALHADO_PROXY',
      'EM_CONTATO', 'COLETA', 'CONTRATO', 'EMITIDO_ORIGINAL',
      'ASSINADO_ORIGINAL', 'GANHO', 'PROTOCOLADO', 'DESQUALIFICADO'
    )
)`;

function cteCoorte(params) {
  const filters = [];
  if (params.equipe) {
    filters.push('AND pa.equipe_atual = $3::text');
  }
  if (params.colaborador_id != null) {
    filters.push('AND pa.colaborador_id = $4::bigint');
  }
  if (params.colaborador_ids_escopo !== null) {
    filters.push('AND pa.colaborador_id = ANY($5::bigint[])');
  }

  return CTE_BASE + CTE_EVENTOS + `,
recebimentos_corporativos AS (
  SELECT e.deal_id, MIN(e.ocorrido_em) AS recebido_em
  FROM eventos e CROSS JOIN limites p
  WHERE e.tipo = 'RECEBIDO_CORPORATIVO'
    AND e.ocorrido_em < p.t1
  GROUP BY e.deal_id
),
primeiro_assessor AS (
  SELECT DISTINCT ON (e.deal_id)
         e.deal_id, e.colaborador_id, e.equipe_atual, e.ocorrido_em
  FROM eventos e
  JOIN recebimentos_corporativos r
    ON r.deal_id = e.deal_id AND e.ocorrido_em >= r.recebido_em
  WHERE e.tipo = 'RECEBIDO_ASSESSOR'
    AND e.colaborador_id = ANY($5::bigint[])
  ORDER BY e.deal_id, e.ocorrido_em, e.colaborador_id NULLS LAST, e.equipe_atual
),
coorte_filtrada AS (
  SELECT r.deal_id, r.recebido_em
  FROM recebimentos_corporativos r
  LEFT JOIN primeiro_assessor pa ON pa.deal_id = r.deal_id
  WHERE true ${filters.join(' ')}
),
coorte AS (
  SELECT c.deal_id,
         c.recebido_em AS data_recebimento_corporativo,
         MIN(e.ocorrido_em) FILTER (
           WHERE e.tipo = 'TRABALHADO_PROXY' AND e.ocorrido_em >= c.recebido_em
         ) AS primeiro_trabalho_em,
         BOOL_OR(e.tipo = 'EM_CONTATO') AS chegou_em_contato,
         BOOL_OR(e.tipo = 'EM_CONTATO' AND e.ocorrido_em <= c.recebido_em) AS ja_em_contato_ao_receber,
         MIN(e.ocorrido_em) FILTER (WHERE e.tipo = 'EM_CONTATO') AS primeiro_em_contato_em,
         MIN(e.ocorrido_em) FILTER (
           WHERE e.tipo = 'COLETA' AND e.ocorrido_em >= c.recebido_em
         ) AS primeira_coleta_em,
         MIN(e.ocorrido_em) FILTER (
           WHERE e.tipo = 'CONTRATO' AND e.ocorrido_em >= c.recebido_em
         ) AS primeiro_contrato_em,
         MIN(e.ocorrido_em) FILTER (
           WHERE e.tipo = 'DESQUALIFICADO' AND e.ocorrido_em >= c.recebido_em
         ) AS primeira_desqualificacao_em,
         MIN(e.ocorrido_em) FILTER (
           WHERE e.tipo = 'EMITIDO_ORIGINAL' AND e.ocorrido_em >= c.recebido_em
         ) AS primeira_emissao_original_em,
         MIN(e.ocorrido_em) FILTER (
           WHERE e.tipo = 'ASSINADO_ORIGINAL' AND e.ocorrido_em >= c.recebido_em
         ) AS primeira_assinatura_original_em,
         MIN(e.ocorrido_em) FILTER (
           WHERE e.tipo = 'GANHO' AND e.ocorrido_em >= c.recebido_em
         ) AS data_ganho,
         MIN(e.ocorrido_em) FILTER (
           WHERE e.tipo = 'PROTOCOLADO' AND e.ocorrido_em >= c.recebido_em
         ) AS data_protocolo
  FROM coorte_filtrada c
  LEFT JOIN eventos e
    ON e.deal_id = c.deal_id
  GROUP BY c.deal_id, c.recebido_em
)`;
}

function cteRecebimentosAssessores(params) {
  const filters = [];
  if (params.equipe) filters.push('AND e.equipe_atual = $3::text');
  if (params.colaborador_id != null) filters.push('AND e.colaborador_id = $4::bigint');
  if (params.colaborador_ids_escopo !== null) {
    filters.push('AND e.colaborador_id = ANY($5::bigint[])');
  }

  return CTE_BASE + CTE_EVENTOS + `,
recebimentos AS (
  SELECT DISTINCT ON (
           e.deal_id, e.colaborador_id,
           (e.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date
         )
         e.deal_id, e.colaborador_id, e.equipe_atual, e.ocorrido_em AS recebido_em
  FROM eventos e CROSS JOIN limites p
  WHERE e.tipo = 'RECEBIDO_ASSESSOR'
    AND e.ocorrido_em < p.t1
    ${filters.join('\n    ')}
  ORDER BY e.deal_id, e.colaborador_id,
           (e.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date,
           e.ocorrido_em
),
marcos AS (
  SELECT r.deal_id, r.colaborador_id, r.equipe_atual, r.recebido_em,
         BOOL_OR(e.tipo = 'TRABALHADO_PROXY') AS trabalhou_na_posse,
         BOOL_OR(e.tipo = 'EM_CONTATO') AS contatou_etapa,
         BOOL_OR(e.tipo = 'ASSINADO_ORIGINAL') AS assinou_apos_receber,
         BOOL_OR(e.tipo = 'GANHO') AS ganhou_apos_receber,
         BOOL_OR(e.tipo = 'COLETA') AS coletou_apos_receber,
         BOOL_OR(e.tipo = 'PROTOCOLADO') AS protocolou_apos_receber
  FROM recebimentos r
  LEFT JOIN eventos e
    ON e.deal_id = r.deal_id AND e.ocorrido_em >= r.recebido_em
  GROUP BY r.deal_id, r.colaborador_id, r.equipe_atual, r.recebido_em
)`;
}

/* ============================================================
 * K01A | SAFRA | sete cards
 * ============================================================ */
router.get('/overview', requireAuth, async (req, res) => {
  const params = readParams(req);
  if (!params) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
  if (params.error) return res.status(400).json({ success: false, error: params.error });
  try {
    const r = await analyticsQuery(cteCoorte(params) + `
      SELECT
        COUNT(*)::int AS recebidos,
        COUNT(*) FILTER (WHERE primeiro_trabalho_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS trabalhados_proxy,
        COUNT(*) FILTER (WHERE chegou_em_contato AND (ja_em_contato_ao_receber OR primeiro_em_contato_em <= (SELECT as_of FROM p)))::int AS em_contato_crm,
        COUNT(*) FILTER (WHERE primeira_assinatura_original_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS assinados,
        COUNT(*) FILTER (WHERE data_ganho BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS ganhos,
        COUNT(*) FILTER (WHERE data_protocolo BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS protocolados,
        COUNT(*) FILTER (WHERE primeira_desqualificacao_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS desqualificados
      FROM coorte
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id, params.colaborador_ids_escopo, params.colaborador_ids_ativos]);
    res.json({ success: true, data: r.rows[0] || {} });
  } catch (err) {
    console.error('Erro /inte-comerce/overview:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
 * K02A | SAFRA | três estratégicos
 * ============================================================ */
router.get('/strategic', requireAuth, async (req, res) => {
  const params = readParams(req);
  if (!params) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
  if (params.error) return res.status(400).json({ success: false, error: params.error });
  try {
    const r = await analyticsQuery(cteCoorte(params) + `,
      cnt AS (
        SELECT
          COUNT(*)::int AS recebidos,
          COUNT(*) FILTER (WHERE chegou_em_contato AND (ja_em_contato_ao_receber OR primeiro_em_contato_em <= (SELECT as_of FROM p)))::int AS em_contato,
          COUNT(*) FILTER (WHERE primeira_assinatura_original_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS assinados,
          COUNT(*) FILTER (WHERE primeira_assinatura_original_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p)
                         AND data_ganho >= primeira_assinatura_original_em AND data_ganho <= (SELECT as_of FROM p))::int AS assinados_que_ganharam
        FROM coorte
      )
      SELECT recebidos, em_contato, assinados, assinados_que_ganharam,
        ROUND(100.0 * assinados / NULLIF(recebidos, 0), 2)::numeric AS pct_recebidos_ate_assinados,
        ROUND(100.0 * em_contato / NULLIF(recebidos, 0), 2)::numeric AS pct_recebidos_ate_em_contato,
        ROUND(100.0 * assinados_que_ganharam / NULLIF(assinados, 0), 2)::numeric AS pct_assinados_ate_ganhos,
        NULL::numeric AS variacao_safra_sem_maturidade_equivalente
      FROM cnt
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id, params.colaborador_ids_escopo, params.colaborador_ids_ativos]);
    res.json({ success: true, data: r.rows[0] || {} });
  } catch (err) {
    console.error('Erro /inte-comerce/strategic:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
 * K03A | SAFRA | progressão do funil
 * ============================================================ */
router.get('/funnel', requireAuth, async (req, res) => {
  const params = readParams(req);
  if (!params) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
  if (params.error) return res.status(400).json({ success: false, error: params.error });
  try {
    const r = await analyticsQuery(cteCoorte(params) + `
      SELECT
        COUNT(*)::int AS recebidos,
        COUNT(*) FILTER (WHERE primeiro_trabalho_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS trabalhados,
        COUNT(*) FILTER (WHERE chegou_em_contato AND (ja_em_contato_ao_receber OR primeiro_em_contato_em <= (SELECT as_of FROM p)))::int AS em_contato,
        COUNT(*) FILTER (WHERE primeira_coleta_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS coleta,
        COUNT(*) FILTER (WHERE primeiro_contrato_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS contrato,
        COUNT(*) FILTER (WHERE primeira_emissao_original_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS emitidos,
        COUNT(*) FILTER (WHERE primeira_assinatura_original_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS assinados,
        COUNT(*) FILTER (WHERE data_ganho BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS ganhos,
        COUNT(*) FILTER (WHERE data_protocolo BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS protocolados,
        COUNT(*) FILTER (WHERE primeira_desqualificacao_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS desqualificados_saida,
        COUNT(*) FILTER (WHERE primeira_coleta_em IS NOT NULL AND NOT chegou_em_contato)::int AS coleta_sem_contato_observado
      FROM coorte
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id, params.colaborador_ids_escopo, params.colaborador_ids_ativos]);
    res.json({ success: true, data: r.rows[0] || {} });
  } catch (err) {
    console.error('Erro /inte-comerce/funnel:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
 * K04A | SAFRA | motivos de desqualificação
 * ============================================================ */
router.get('/disqualify-reasons', requireAuth, async (req, res) => {
  const params = readParams(req);
  if (!params) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
  if (params.error) return res.status(400).json({ success: false, error: params.error });
  try {
    const r = await analyticsQuery(cteCoorte(params) + `,
      casos AS (
        SELECT c.deal_id, d.motivo_perda AS motivo
        FROM coorte c
        JOIN core.deals d ON d.deal_id = c.deal_id
        CROSS JOIN limites p
        WHERE c.primeira_desqualificacao_em BETWEEN c.data_recebimento_corporativo AND p.as_of
      )
      SELECT COALESCE(NULLIF(BTRIM(c.motivo), ''), '(SEM MOTIVO)') AS motivo,
             COUNT(DISTINCT c.deal_id)::int AS deals_desqualificados
      FROM casos c GROUP BY 1
      ORDER BY deals_desqualificados DESC, motivo
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id, params.colaborador_ids_escopo, params.colaborador_ids_ativos]);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Erro /inte-comerce/disqualify-reasons:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
 * K07A | SAFRA | gráfico diário duas barras
 * ============================================================ */
router.get('/daily', requireAuth, async (req, res) => {
  const params = readParams(req);
  if (!params) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
  if (params.error) return res.status(400).json({ success: false, error: params.error });
  try {
    const r = await analyticsQuery(cteCoorte(params) + `,
      dias AS (
        SELECT g::date AS dia FROM limites p
        CROSS JOIN LATERAL generate_series(p.inicio, p.fim_exclusivo - 1, INTERVAL '1 day') g
      ),
      agg AS (
        SELECT (data_recebimento_corporativo AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
               COUNT(DISTINCT deal_id)::int AS recebidos,
               COUNT(DISTINCT deal_id) FILTER (
                 WHERE primeira_assinatura_original_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p)
               )::int AS assinados_ate_corte
        FROM coorte GROUP BY 1
      )
      SELECT TO_CHAR(d.dia, 'YYYY-MM-DD') AS dia,
             COALESCE(a.recebidos, 0)::int AS recebidos,
             COALESCE(a.assinados_ate_corte, 0)::int AS assinados_ate_corte,
             ROUND(100.0 * a.assinados_ate_corte / NULLIF(a.recebidos, 0), 2)::numeric AS taxa_safra_pct
      FROM dias d LEFT JOIN agg a USING (dia)
      ORDER BY d.dia
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id, params.colaborador_ids_escopo, params.colaborador_ids_ativos]);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Erro /inte-comerce/daily:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
 * K05A | SAFRA | tabela por colaborador
 * Indicadores posteriores calculados pelos eventos do Deal após o recebimento.
 * ============================================================ */
router.get('/collaborators', requireAuth, async (req, res) => {
  const params = readParams(req);
  if (!params) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
  if (params.error) return res.status(400).json({ success: false, error: params.error });
  try {
    const r = await analyticsQuery(cteRecebimentosAssessores(params) + `
      SELECT m.colaborador_id::text AS colaborador_id,
             COALESCE(c.nome, '(SEM ATRIBUICAO)') AS colaborador,
             COALESCE(m.equipe_atual, '(SEM EQUIPE)') AS equipe_atual,
             COUNT(*)::int AS recebimentos_deal_dia,
             COUNT(*) FILTER (WHERE m.trabalhou_na_posse)::int AS trabalhados,
             COUNT(*) FILTER (WHERE m.contatou_etapa)::int AS em_contato,
             COUNT(DISTINCT m.deal_id) FILTER (WHERE m.coletou_apos_receber)::int AS coleta,
             COUNT(*) FILTER (WHERE m.assinou_apos_receber)::int AS assinados,
             COUNT(*) FILTER (WHERE m.ganhou_apos_receber)::int AS ganhos,
             COUNT(DISTINCT m.deal_id) FILTER (WHERE m.protocolou_apos_receber)::int AS protocolados,
             NULL::numeric AS pct_olos_pendente,
             NULL::numeric AS pct_hubspot_pendente
      FROM marcos m
      LEFT JOIN core.colaboradores c ON c.colaborador_id = m.colaborador_id
      GROUP BY 1, 2, 3
      ORDER BY assinados DESC, recebimentos_deal_dia DESC
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id, params.colaborador_ids_escopo, params.colaborador_ids_ativos]);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Erro /inte-comerce/collaborators:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
 * K06A | SAFRA | tabela por equipe
 * ============================================================ */
router.get('/teams', requireAuth, async (req, res) => {
  const params = readParams(req);
  if (!params) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
  if (params.error) return res.status(400).json({ success: false, error: params.error });
  try {
    const r = await analyticsQuery(cteRecebimentosAssessores(params) + `
      SELECT COALESCE(equipe_atual, '(SEM EQUIPE)') AS equipe,
             COUNT(*)::int AS recebimentos_assessor_deal_dia,
             COUNT(DISTINCT deal_id)::int AS deals_unicos_da_equipe,
             COUNT(DISTINCT deal_id) FILTER (WHERE trabalhou_na_posse)::int AS trabalhados,
             COUNT(DISTINCT deal_id) FILTER (WHERE contatou_etapa)::int AS em_contato,
             COUNT(DISTINCT deal_id) FILTER (WHERE coletou_apos_receber)::int AS coleta,
             COUNT(DISTINCT deal_id) FILTER (WHERE assinou_apos_receber)::int AS assinados,
             COUNT(DISTINCT deal_id) FILTER (WHERE ganhou_apos_receber)::int AS ganhos,
             COUNT(DISTINCT deal_id) FILTER (WHERE protocolou_apos_receber)::int AS protocolados
      FROM marcos
      GROUP BY 1
      ORDER BY assinados DESC
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id, params.colaborador_ids_escopo, params.colaborador_ids_ativos]);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Erro /inte-comerce/teams:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;