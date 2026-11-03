// backend/routes/inte_comerce.js
import express from 'express';
import db from '../services/db.js';

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

function readParams(req) {
  const { start, end, equipe, colaboradorId } = req.query;
  if (!start || !end) return null;
  const colabNum =
    colaboradorId != null && String(colaboradorId).trim() !== ''
      ? Number(colaboradorId)
      : null;
  return {
    inicio: start,
    fim_exclusivo: end,
    equipe: equipe && equipe !== 'todas' ? equipe : null,
    colaborador_id: Number.isFinite(colabNum) ? colabNum : null,
  };
}

// CTE base — usa CURRENT_TIMESTAMP como as_of (produção).
// Para homologação contra base staging, troque por LEAST(TIMESTAMPTZ '...', CURRENT_TIMESTAMP).
const CTE_BASE = `
WITH p AS (
  SELECT $1::date AS inicio, $2::date AS fim_exclusivo,
         CURRENT_TIMESTAMP AS as_of,
         $3::text AS equipe, $4::bigint AS colaborador_id
), limites AS (
  SELECT p.*, (p.inicio::timestamp AT TIME ZONE 'America/Sao_Paulo') AS t0,
         (p.fim_exclusivo::timestamp AT TIME ZONE 'America/Sao_Paulo') AS t1
  FROM p
)`;

const CTE_COORTE = CTE_BASE + `,
coorte AS (
  SELECT c.* FROM ops.v_bi_v6_coortes c CROSS JOIN limites p
  WHERE c.data_recebimento_corporativo >= p.t0
    AND c.data_recebimento_corporativo < p.t1
    AND c.data_recebimento_corporativo <= p.as_of
    AND (p.equipe IS NULL OR (c.recebido_primeiro_assessor_em <= p.as_of AND c.equipe_primeiro_assessor_atual = p.equipe))
    AND (p.colaborador_id IS NULL OR (c.recebido_primeiro_assessor_em <= p.as_of AND c.primeiro_assessor_id = p.colaborador_id))
)`;

/* ============================================================
 * K01A | SAFRA | sete cards
 * ============================================================ */
router.get('/overview', requireAuth, async (req, res) => {
  const params = readParams(req);
  if (!params) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
  try {
    const r = await db.query(CTE_COORTE + `
      SELECT
        COUNT(*)::int AS recebidos,
        COUNT(*) FILTER (WHERE primeiro_trabalho_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS trabalhados_proxy,
        COUNT(*) FILTER (WHERE chegou_em_contato AND (ja_em_contato_ao_receber OR primeiro_em_contato_em <= (SELECT as_of FROM p)))::int AS em_contato_crm,
        COUNT(*) FILTER (WHERE primeira_assinatura_original_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS assinados,
        COUNT(*) FILTER (WHERE data_ganho BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS ganhos,
        COUNT(*) FILTER (WHERE data_protocolo BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS protocolados,
        COUNT(*) FILTER (WHERE primeira_desqualificacao_em BETWEEN data_recebimento_corporativo AND (SELECT as_of FROM p))::int AS desqualificados
      FROM coorte
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id]);
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
  try {
    const r = await db.query(CTE_COORTE + `,
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
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id]);
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
  try {
    const r = await db.query(CTE_COORTE + `
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
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id]);
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
  try {
    const r = await db.query(CTE_COORTE + `,
      casos AS (
        SELECT c.deal_id, c.motivo_perda_atual AS motivo
        FROM coorte c CROSS JOIN limites p
        WHERE c.primeira_desqualificacao_em BETWEEN c.data_recebimento_corporativo AND p.as_of
      )
      SELECT COALESCE(NULLIF(BTRIM(motivo), ''), '(SEM MOTIVO)') AS motivo,
             COUNT(DISTINCT deal_id)::int AS deals_desqualificados
      FROM casos GROUP BY 1
      ORDER BY deals_desqualificados DESC, motivo
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id]);
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
  try {
    const r = await db.query(CTE_COORTE + `,
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
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id]);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Erro /inte-comerce/daily:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ============================================================
 * K05A | SAFRA | tabela por colaborador
 * (coleta + protocolados agregados a partir de v_bi_v6_coortes)
 * ============================================================ */
router.get('/collaborators', requireAuth, async (req, res) => {
  const params = readParams(req);
  if (!params) return res.status(400).json({ success: false, error: 'start e end obrigatórios' });
  try {
    const r = await db.query(CTE_BASE + `,
      recebimentos AS (
        SELECT DISTINCT ON (a.deal_id, a.colaborador_id, (a.recebido_em AT TIME ZONE 'America/Sao_Paulo')::date)
          a.deal_id, a.colaborador_id, a.colaborador, a.equipe_atual, a.recebido_em,
          a.primeira_mudanca_etapa_em, a.etapa_ao_receber
        FROM ops.v_bi_v6_atribuicoes a CROSS JOIN limites p
        WHERE a.cargo = 'Assessor' AND a.recebido_em >= p.t0 AND a.recebido_em < p.t1
          AND a.recebido_em <= p.as_of
          AND (p.equipe IS NULL OR a.equipe_atual = p.equipe)
          AND (p.colaborador_id IS NULL OR a.colaborador_id = p.colaborador_id)
        ORDER BY a.deal_id, a.colaborador_id, (a.recebido_em AT TIME ZONE 'America/Sao_Paulo')::date, a.recebido_em
      ),
      marcos AS (
        SELECT r.*,
          (r.primeira_mudanca_etapa_em BETWEEN r.recebido_em AND p.as_of) AS trabalhou_na_posse,
          (r.etapa_ao_receber = 6650 OR EXISTS (
            SELECT 1 FROM core.historico_movimentacoes h
            WHERE h.deal_id = r.deal_id AND h.crm_origem = 'HUBSPOT' AND h.tipo_movimentacao = 'MUDANCA_ETAPA'
              AND h.etapa_nova_id = 6650 AND h.data_movimentacao BETWEEN r.recebido_em AND p.as_of
          )) AS contatou_etapa,
          (s.primeira_assinatura_original_em BETWEEN r.recebido_em AND p.as_of) AS assinou_apos_receber,
          (d.data_ganho BETWEEN r.recebido_em AND p.as_of) AS ganhou_apos_receber,
          (cc.primeira_coleta_em BETWEEN r.recebido_em AND p.as_of) AS coletou_apos_receber,
          (cc.data_protocolo BETWEEN r.recebido_em AND p.as_of) AS protocolou_apos_receber
        FROM recebimentos r CROSS JOIN limites p
        JOIN core.deals d ON d.deal_id = r.deal_id
        LEFT JOIN ops.v_bi_v6_assinaturas_originais s ON s.deal_id = r.deal_id
        LEFT JOIN ops.v_bi_v6_coortes cc ON cc.deal_id = r.deal_id
      )
      SELECT colaborador_id::text AS colaborador_id,
             colaborador,
             equipe_atual,
             COUNT(*)::int AS recebimentos_deal_dia,
             COUNT(*) FILTER (WHERE trabalhou_na_posse)::int AS trabalhados,
             COUNT(*) FILTER (WHERE contatou_etapa)::int AS em_contato,
             COUNT(DISTINCT CASE WHEN coletou_apos_receber THEN deal_id END)::int AS coleta,
             COUNT(*) FILTER (WHERE assinou_apos_receber)::int AS assinados,
             COUNT(*) FILTER (WHERE ganhou_apos_receber)::int AS ganhos,
             COUNT(DISTINCT CASE WHEN protocolou_apos_receber THEN deal_id END)::int AS protocolados,
             NULL::numeric AS pct_olos_pendente,
             NULL::numeric AS pct_hubspot_pendente
      FROM marcos
      GROUP BY 1, 2, 3
      ORDER BY assinados DESC, recebimentos_deal_dia DESC
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id]);
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
  try {
    const r = await db.query(CTE_BASE + `,
      rec AS (
        SELECT DISTINCT ON (a.deal_id, a.colaborador_id, (a.recebido_em AT TIME ZONE 'America/Sao_Paulo')::date)
          a.deal_id, a.colaborador_id, a.equipe_atual, a.recebido_em, a.primeira_mudanca_etapa_em, a.etapa_ao_receber
        FROM ops.v_bi_v6_atribuicoes a CROSS JOIN limites p
        WHERE a.cargo = 'Assessor' AND a.recebido_em >= p.t0 AND a.recebido_em < p.t1
          AND a.recebido_em <= p.as_of
          AND (p.equipe IS NULL OR a.equipe_atual = p.equipe)
          AND (p.colaborador_id IS NULL OR a.colaborador_id = p.colaborador_id)
        ORDER BY a.deal_id, a.colaborador_id, (a.recebido_em AT TIME ZONE 'America/Sao_Paulo')::date, a.recebido_em
      ),
      fatos AS (
        SELECT r.*,
          (r.primeira_mudanca_etapa_em BETWEEN r.recebido_em AND p.as_of) AS trabalhou,
          (r.etapa_ao_receber = 6650 OR EXISTS (
            SELECT 1 FROM core.historico_movimentacoes h
            WHERE h.deal_id = r.deal_id AND h.crm_origem = 'HUBSPOT' AND h.tipo_movimentacao = 'MUDANCA_ETAPA'
              AND h.etapa_nova_id = 6650 AND h.data_movimentacao BETWEEN r.recebido_em AND p.as_of
          )) AS contatou,
          (s.primeira_assinatura_original_em BETWEEN r.recebido_em AND p.as_of) AS assinou,
          (d.data_ganho BETWEEN r.recebido_em AND p.as_of) AS ganhou,
          (cc.primeira_coleta_em BETWEEN r.recebido_em AND p.as_of) AS coletou,
          (cc.data_protocolo BETWEEN r.recebido_em AND p.as_of) AS protocolou
        FROM rec r CROSS JOIN limites p
        JOIN core.deals d ON d.deal_id = r.deal_id
        LEFT JOIN ops.v_bi_v6_assinaturas_originais s ON s.deal_id = r.deal_id
        LEFT JOIN ops.v_bi_v6_coortes cc ON cc.deal_id = r.deal_id
      )
      SELECT COALESCE(equipe_atual, '(SEM EQUIPE)') AS equipe,
             COUNT(*)::int AS recebimentos_assessor_deal_dia,
             COUNT(DISTINCT deal_id)::int AS deals_unicos_da_equipe,
             COUNT(DISTINCT deal_id) FILTER (WHERE trabalhou)::int AS trabalhados,
             COUNT(DISTINCT deal_id) FILTER (WHERE contatou)::int AS em_contato,
             COUNT(DISTINCT deal_id) FILTER (WHERE coletou)::int AS coleta,
             COUNT(DISTINCT deal_id) FILTER (WHERE assinou)::int AS assinados,
             COUNT(DISTINCT deal_id) FILTER (WHERE ganhou)::int AS ganhos,
             COUNT(DISTINCT deal_id) FILTER (WHERE protocolou)::int AS protocolados
      FROM fatos
      GROUP BY 1
      ORDER BY assinados DESC
    `, [params.inicio, params.fim_exclusivo, params.equipe, params.colaborador_id]);
    res.json({ success: true, data: r.rows });
  } catch (err) {
    console.error('Erro /inte-comerce/teams:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;