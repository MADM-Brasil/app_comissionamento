// backend/routes/inte_comerce.js
//
// Este arquivo é APENAS rotas HTTP. Toda lógica de cache e analytics
// está em ../services/. Se você ver `inteComerceCache` neste arquivo,
// ele está corrompido com uma versão antiga — substitua pelo conteúdo
// abaixo.

import express from 'express';
import { pool } from '../services/db.js';
import {
  getInteComerceRawAnalytics,
  getInteComercePeriodSummary,
} from '../services/inteComerceRawAnalytics.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────
function ok(res, data) { return res.json({ success: true, data }); }
function badRequest(res, message) { return res.status(400).json({ success: false, error: message }); }

function readStartEnd(req) {
  const start = req.query.start || req.query.inicio || req.query.data_inicio;
  const end = req.query.end || req.query.fim_exclusivo || req.query.data_fim;
  return { start, end };
}

/**
 * Decide se o usuário atual pode ver a conta inteira.
 *
 * Estratégia defensiva:
 *   1. Se `req.user` existe → respeita isAdmin / role / perfil / permissions.
 *   2. Se `req.user` NÃO existe → assume `true`.
 *      Auth é aplicado por middleware EXTERNO ao router.
 */
function canSeeWholeAccount(req) {
  const u = req.user;
  if (!u) return true;

  if (u.isAdmin === true) return true;
  if (u.is_admin === true) return true;
  if (u.role === 'admin') return true;
  if (u.perfil === 'admin') return true;
  if (u.nivel_acesso === 'admin') return true;

  if (Array.isArray(u.permissions)) {
    if (u.permissions.includes('inte_comerce.conta_inteira')) return true;
    if (u.permissions.includes('admin')) return true;
  }
  if (Array.isArray(u.permissoes)) {
    if (u.permissoes.includes('inte_comerce.conta_inteira')) return true;
    if (u.permissoes.includes('admin')) return true;
  }
  return false;
}

/**
 * Normaliza o parâmetro de unidade vindo da query.
 * Aceita `unidadeId`, `unidade_id` ou `unidade`.
 * Retorna `undefined` quando ausente/"todas"; retorna número quando válido.
 * Retorna `{ error }` quando o valor é inválido (string não numérica).
 */
function parseUnidadeId(req) {
  const raw = req.query.unidadeId ?? req.query.unidade_id ?? req.query.unidade;
  if (raw == null) return { unidadeId: undefined };
  const s = String(raw).trim();
  if (s === '' || s.toLowerCase() === 'todas' || s.toLowerCase() === 'all') {
    return { unidadeId: undefined };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: `unidadeId inválido: "${s}"` };
  }
  return { unidadeId: n };
}

/**
 * Carrega colaboradores comerciais (Assessor/Supervisor).
 *
 * Se `unidadeId` for informado, restringe a `unidade_id = unidadeId`.
 * Faz fallback defensivo caso a coluna `email` ou `unidade_id` não existam.
 */
async function loadCommercialCollaborators(unidadeId) {
  const hasUnit = unidadeId != null;
  const where = `
    WHERE LOWER(TRIM(departamento)) = 'comercial'
      AND LOWER(TRIM(cargo)) IN ('assessor','supervisor')
      ${hasUnit ? 'AND unidade_id = $1' : ''}
  `;
  const values = hasUnit ? [unidadeId] : [];

  // Tentativa 1: com email + filtro de unidade (se aplicável)
  try {
    const { rows } = await pool.query(`
      SELECT colaborador_id::text                  AS id,
             LOWER(TRIM(COALESCE(nome_equipe,''))) AS team_key,
             LOWER(TRIM(COALESCE(nome,'')))        AS nome_key,
             LOWER(TRIM(COALESCE(email,'')))       AS email_key
        FROM core.colaboradores
        ${where}
    `, values);
    return rows;
  } catch (e1) {
    // Tentativa 2: sem email
    try {
      const { rows } = await pool.query(`
        SELECT colaborador_id::text                  AS id,
               LOWER(TRIM(COALESCE(nome_equipe,''))) AS team_key,
               LOWER(TRIM(COALESCE(nome,'')))        AS nome_key
          FROM core.colaboradores
          ${where}
      `, values);
      return rows.map((r) => ({ ...r, email_key: '' }));
    } catch (e2) {
      // Tentativa 3: sem filtro de unidade (coluna pode não existir neste ambiente)
      if (hasUnit) {
        console.warn(
          '[inte-comerce] Falha ao filtrar por unidade_id — coluna ausente em core.colaboradores? ' +
          'Filtro de unidade será ignorado. Erro:', e2?.message,
        );
      }
      try {
        const { rows } = await pool.query(`
          SELECT colaborador_id::text                  AS id,
                 LOWER(TRIM(COALESCE(nome_equipe,''))) AS team_key,
                 LOWER(TRIM(COALESCE(nome,'')))        AS nome_key,
                 ''                                    AS email_key
            FROM core.colaboradores
           WHERE LOWER(TRIM(departamento)) = 'comercial'
             AND LOWER(TRIM(cargo)) IN ('assessor','supervisor')
        `);
        return rows;
      } catch {
        return [];
      }
    }
  }
}

async function resolveScope({ equipe, colaboradorId, unidadeId }) {
  const rows = await loadCommercialCollaborators(unidadeId);
  const eqKey = equipe ? String(equipe).trim().toLowerCase() : null;
  const colabKey = colaboradorId ? String(colaboradorId).trim().toLowerCase() : null;

  const matched = rows
    .filter((r) => !eqKey || r.team_key === eqKey)
    .filter(
      (r) =>
        !colabKey ||
        r.id === colabKey ||
        r.nome_key === colabKey ||
        (r.email_key && r.email_key === colabKey),
    );

  let resolvedColabId = null;
  if (colabKey) {
    const exact = matched.find((r) => r.id === colabKey);
    if (exact) resolvedColabId = exact.id;
    else if (matched.length === 1) resolvedColabId = matched[0].id;
    else if (/^\d+$/.test(colabKey)) resolvedColabId = colabKey;
  }

  return {
    activeIds: matched.map((r) => r.id),
    resolvedColabId,
    unmatched: {
      equipe: eqKey && matched.length === 0,
      colaborador: colabKey && !resolvedColabId,
    },
  };
}

async function buildServiceParams(req) {
  const { start, end } = readStartEnd(req);
  const { mode, equipe, colaboradorId, produto, selectedDay } = req.query;

  // ── Unidade ──
  const parsedUnit = parseUnidadeId(req);
  if (parsedUnit.error) {
    return { error: { status: 400, message: parsedUnit.error } };
  }
  const unidadeIdNum = parsedUnit.unidadeId;

  const eq = equipe && equipe !== 'todas' ? String(equipe).trim() : undefined;
  const rawColab = colaboradorId && String(colaboradorId).trim() !== ''
    ? String(colaboradorId).trim()
    : undefined;
  const prod = produto && produto !== 'Todos' ? produto : undefined;

  const scope = await resolveScope({
    equipe: eq,
    colaboradorId: rawColab,
    unidadeId: unidadeIdNum,
  });

  if (scope.unmatched.colaborador) {
    return {
      error: {
        status: 404,
        message:
          `Colaborador "${rawColab}" não encontrado em core.colaboradores ` +
          `(tentou ID, nome e email).`,
      },
    };
  }
  if (scope.unmatched.equipe) {
    return {
      error: {
        status: 404,
        message:
          `Equipe "${eq}" não possui colaboradores Assessor/Supervisor ativos.`,
      },
    };
  }
  if (unidadeIdNum != null && scope.activeIds.length === 0) {
    return {
      error: {
        status: 404,
        message:
          `Unidade ${unidadeIdNum} não possui colaboradores Assessor/Supervisor ativos.`,
      },
    };
  }

  const normalizedColabId = scope.resolvedColabId ?? rawColab;
  const scopedIds = scope.activeIds.length > 0 ? scope.activeIds : undefined;

  // ── Escopo total ──
  const hasUnitFilter = unidadeIdNum != null;
  const hasScopeFilter = Boolean(eq) || normalizedColabId != null || hasUnitFilter;
  const podeVerContaInteira = canSeeWholeAccount(req) && !hasScopeFilter;

  // Conta inteira → null. Qualquer filtro (unidade/equipe/colab) → lista.
  const colaboradorIdsEscopo = podeVerContaInteira
    ? null
    : (scopedIds ?? []);

  const params = {
    inicio: start,
    fim_exclusivo: end,
    mode: mode || 'safra',
    equipe: eq,
    colaborador_id: normalizedColabId,
    unidade_id: unidadeIdNum,                       // ← para debug/rastreio
    produto: prod,
    colaborador_ids_ativos: scopedIds,
    colaborador_ids_escopo: colaboradorIdsEscopo,
    pode_ver_conta_inteira: podeVerContaInteira,
    refresh: req.query.refresh === 'true',
    include_unassigned: !hasScopeFilter,
  };

  if (params.mode === 'producao') {
    params.production_month_inicio = start;
    params.production_month_fim = end;
    if (selectedDay) {
      params.selected_day = selectedDay;
      params.selected_day_end = end;
    }
  } else {
    params.cohort_inicio = start;
    params.cohort_fim = end;
    params.result_inicio = start;
    params.result_fim = end;
    if (selectedDay) {
      params.selected_day = selectedDay;
      params.selected_day_end = end;
    }
  }

  return { params };
}

async function prepare(req, res) {
  const { start, end } = readStartEnd(req);
  if (!start || !end) {
    badRequest(res, 'start e end obrigatórios');
    return null;
  }
  const built = await buildServiceParams(req);
  if (built.error) {
    res.status(built.error.status).json({
      success: false,
      error: built.error.message,
    });
    return null;
  }
  return built.params;
}

// ─────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────
router.get('/overview', async (req, res, next) => {
  try {
    const params = await prepare(req, res); if (!params) return;
    const r = await getInteComerceRawAnalytics(params);
    return ok(res, r.overview);
  } catch (e) { next(e); }
});

router.get('/strategic', async (req, res, next) => {
  try {
    const params = await prepare(req, res); if (!params) return;
    const r = await getInteComerceRawAnalytics(params);
    return ok(res, r.strategic);
  } catch (e) { next(e); }
});

router.get('/funnel', async (req, res, next) => {
  try {
    const params = await prepare(req, res); if (!params) return;
    const r = await getInteComerceRawAnalytics(params);
    return ok(res, r.funnel);
  } catch (e) { next(e); }
});

router.get('/disqualify-reasons', async (req, res, next) => {
  try {
    const params = await prepare(req, res); if (!params) return;
    const r = await getInteComerceRawAnalytics(params);
    return ok(res, r.reasons);
  } catch (e) { next(e); }
});

router.get('/daily', async (req, res, next) => {
  try {
    const params = await prepare(req, res); if (!params) return;
    const r = await getInteComerceRawAnalytics(params);
    return ok(res, r.daily);
  } catch (e) { next(e); }
});

router.get('/collaborators', async (req, res, next) => {
  try {
    const params = await prepare(req, res); if (!params) return;
    const r = await getInteComerceRawAnalytics(params);
    return ok(res, r.collaborators);
  } catch (e) { next(e); }
});

router.get('/teams', async (req, res, next) => {
  try {
    const params = await prepare(req, res); if (!params) return;
    const r = await getInteComerceRawAnalytics(params);
    return ok(res, r.teams);
  } catch (e) { next(e); }
});

router.get('/all', async (req, res, next) => {
  try {
    const params = await prepare(req, res); if (!params) return;
    const r = await getInteComerceRawAnalytics(params);
    return ok(res, {
      overview: r.overview,
      strategic: r.strategic,
      funnel: r.funnel,
      daily: r.daily,
      reasons: r.reasons,
      collaborators: r.collaborators ?? [],
      teams: r.teams ?? [],
      dataAsOf: r.asOf,
      safraComparison: r.safraComparison,
      productionComparison: r.productionComparison,
      hubspot: r.hubspot ?? null,
      hubspotCards: r.hubspotCards ?? null,
    });
  } catch (e) { next(e); }
});

router.get('/period-summary', async (req, res, next) => {
  try {
    const params = await prepare(req, res); if (!params) return;
    const r = await getInteComercePeriodSummary(params);
    return ok(res, r);
  } catch (e) { next(e); }
});

router.get('/debug/data', async (req, res, next) => {
  try {
    const { start, end } = readStartEnd(req);
    if (!start || !end) return badRequest(res, 'start e end obrigatórios');

    const parsedUnit = parseUnidadeId(req);
    if (parsedUnit.error) return badRequest(res, parsedUnit.error);

    const scope = await resolveScope({
      equipe: req.query.equipe && req.query.equipe !== 'todas'
        ? String(req.query.equipe).trim() : undefined,
      colaboradorId: req.query.colaboradorId
        ? String(req.query.colaboradorId).trim() : undefined,
      unidadeId: parsedUnit.unidadeId,
    });

    const built = await buildServiceParams(req);

    let sample = null;
    let errorMessage = null;
    if (!built.error) {
      try {
        const r = await getInteComerceRawAnalytics(built.params);
        sample = {
          overview: r.overview,
          funnel: r.funnel,
          dailyLength: Array.isArray(r.daily) ? r.daily.length : 0,
          collaboratorsLength: Array.isArray(r.collaborators) ? r.collaborators.length : 0,
          teamsLength: Array.isArray(r.teams) ? r.teams.length : 0,
          asOf: r.asOf,
          hubspot: r.hubspot ?? null,
          hubspotCards: r.hubspotCards ?? null,
        };
      } catch (e) {
        errorMessage = e?.message || String(e);
      }
    }

    return ok(res, {
      query: {
        start, end,
        mode: req.query.mode || 'safra',
        equipe: req.query.equipe || null,
        colaboradorId: req.query.colaboradorId || null,
        unidadeId: parsedUnit.unidadeId ?? null,
        produto: req.query.produto || null,
        refresh: req.query.refresh || null,
      },
      scope: {
        activeIdsCount: scope.activeIds.length,
        activeIdsSample: scope.activeIds.slice(0, 5),
        resolvedColabId: scope.resolvedColabId,
        unmatched: scope.unmatched,
      },
      serviceParams: built.error ? null : {
        colaborador_id: built.params.colaborador_id,
        unidade_id: built.params.unidade_id,
        colaborador_ids_ativos_count: (built.params.colaborador_ids_ativos || []).length,
        colaborador_ids_escopo: built.params.colaborador_ids_escopo,
        pode_ver_conta_inteira: built.params.pode_ver_conta_inteira,
        refresh: built.params.refresh,
        equipe: built.params.equipe,
        mode: built.params.mode,
        include_unassigned: built.params.include_unassigned,
      },
      buildError: built.error || null,
      sample,
      serviceError: errorMessage,
    });
  } catch (e) { next(e); }
});

router.get('/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      router: 'inte-comerce',
      endpoints: [
        'overview', 'strategic', 'funnel', 'disqualify-reasons',
        'daily', 'collaborators', 'teams', 'all', 'period-summary',
        'debug/data', 'health',
      ],
    },
  });
});

export default router;