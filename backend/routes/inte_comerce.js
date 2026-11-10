// backend/routes/inte_comerce.js
import express from 'express';
import db from '../services/db.js';
import {
  accessControl,
  getActiveSupportUser,
  isSupportAdmin,
} from '../services/access-control.js';
import { createHash } from 'node:crypto';
import { cached } from '../services/inteComerceCache.js';
import {
  getInteComerceRawAnalytics,
} from '../services/inteComerceRawAnalytics.js';

const router = express.Router();

function analyticsCacheKey(params) {
  const normalizeIds = (ids) => ids == null
    ? ids
    : [...new Set(ids.map(String))].sort();
  const scope = JSON.stringify({
    mode: params.mode,
    selected_day: params.selected_day,
    cohort_inicio: params.cohort_inicio,
    cohort_fim: params.cohort_fim,
    result_inicio: params.result_inicio,
    result_fim: params.result_fim,
    production_month_inicio: params.production_month_inicio,
    production_month_fim: params.production_month_fim,
    inicio: params.inicio,
    fim_exclusivo: params.fim_exclusivo,
    equipe: params.equipe,
    produto: params.produto,
    include_unassigned: params.include_unassigned,
    colaborador_id: params.colaborador_id,
    colaborador_ids_escopo: normalizeIds(params.colaborador_ids_escopo),
    colaborador_ids_ativos: normalizeIds(params.colaborador_ids_ativos),
    // refresh NÃO entra na chave: queremos reusar a mesma entrada
    // e apenas forçar o refetch.
  });
  return createHash('sha256').update(scope).digest('hex');
}

function getAnalytics(params) {
  return cached(
    analyticsCacheKey(params),
    () => getInteComerceRawAnalytics(params),
    { forceRefresh: params.refresh === true },
  );
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
      `SELECT DISTINCT colaborador_id AS id_assessor, unidade_id
       FROM core.view_app_colaboradores
       WHERE colaborador_id IS NOT NULL
         AND LOWER(TRIM(COALESCE(status, ''))) != 'desativado'
         AND LOWER(TRIM(COALESCE(cargo, ''))) != 'desativado'`,
    );
    req.inteComerceActiveCollaboratorIds = result.rows.map((row) => String(row.id_assessor));
    req.inteComerceColaboradorIds = result.rows
      .filter((row) => unidadeFiltro == null || Number(row.unidade_id) === unidadeFiltro)
      .map((row) => String(row.id_assessor));
    req.inteComerceIncludeUnassigned = isAdmin && unidadeFiltro == null;

    next();
  } catch (error) {
    next(error);
  }
}

function readParams(req) {
  const { start, end, equipe, colaboradorId, mode, selectedDay, produto, refresh } = req.query;
  if (!start || !end) return null;
  const supportedModes = ['safra', 'producao', 'producao-3-meses'];
  if (mode != null && !supportedModes.includes(mode)) {
    return { error: `mode deve ser um destes valores: ${supportedModes.join(', ')}.` };
  }
  if (typeof start !== 'string' || typeof end !== 'string') {
    return { error: 'start e end devem estar no formato YYYY-MM-DD.' };
  }
  const colabNum =
    colaboradorId != null && String(colaboradorId).trim() !== ''
      ? Number(colaboradorId)
      : null;

  const validDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!validDate(start) || !validDate(end) || end <= start) {
    return { error: 'Período inválido. Use datas válidas no formato YYYY-MM-DD e end posterior a start.' };
  }
  if (produto != null && (typeof produto !== 'string' || produto.length > 100)) {
    return { error: 'produto deve ser um texto válido.' };
  }

  const params = {
    mode: mode || 'safra',
    equipe: equipe && equipe !== 'todas' ? equipe : null,
    colaborador_id: Number.isFinite(colabNum) ? colabNum : null,
    produto: produto && produto !== 'Todos' ? produto : null,
    include_unassigned: req.inteComerceIncludeUnassigned === true,
    colaborador_ids_escopo: req.inteComerceColaboradorIds,
    colaborador_ids_ativos: req.inteComerceActiveCollaboratorIds,
    // 🔄 bypass de cache quando o usuário clica "Atualizar dados"
    refresh: refresh === '1' || refresh === 'true',
  };

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
  const isProductionComparison = params.mode === 'producao-3-meses';
  const targetMonth = month - 24;
  const minDateYear = year + Math.floor((targetMonth - 1) / 12);
  const minDateMonth = ((targetMonth - 1) % 12 + 12) % 12 + 1;
  const minDate = `${minDateYear}-${String(minDateMonth).padStart(2, '0')}-01`;
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  const maxDate = tomorrow;
  const cohortStart = isProductionComparison
    ? new Date(Date.UTC(
        Number(start.slice(0, 4)),
        Number(start.slice(5, 7)) - 3,
        1,
      )).toISOString().slice(0, 10)
    : start;
  const cohortEnd = isProductionComparison ? start : end;
  if (cohortStart < minDate || start < minDate || end > maxDate) {
    return {
      error: `O período selecionado está fora do limite permitido (${minDate} até hoje).`,
    };
  }

  params.cohort_inicio = cohortStart;
  params.cohort_fim = cohortEnd;
  params.result_inicio = start;
  params.result_fim = end;
  if (params.mode === 'producao') {
    params.production_month_inicio = start;
    params.production_month_fim = end;
  }

  if (params.mode === 'safra' || params.mode === 'producao') {
    const hasSelectedDay = selectedDay != null && selectedDay !== '';
    if (hasSelectedDay) {
      if (
        typeof selectedDay !== 'string' ||
        !validDate(selectedDay) ||
        selectedDay < start ||
        selectedDay >= end ||
        selectedDay > todayParts.year + '-' + todayParts.month + '-' + todayParts.day
      ) {
        return { error: 'selectedDay deve ser uma data válida dentro do mês e não pode ser futura.' };
      }
      const selectedEnd = new Date(
        Date.parse(`${selectedDay}T00:00:00.000Z`) + 86_400_000,
      ).toISOString().slice(0, 10);
      params.selected_day = selectedDay;
      params.selected_day_end = selectedEnd;
    } else {
      params.selected_day = null;
      params.selected_day_end = null;
    }
    params.result_inicio = start;
    params.result_fim = end;
  }

  params.inicio = cohortStart < params.result_inicio ? cohortStart : params.result_inicio;
  params.fim_exclusivo = end > params.result_fim ? end : params.result_fim;
  return params;
}

function validateParams(req, res) {
  const params = readParams(req);
  if (!params) {
    res.status(400).json({ success: false, error: 'start e end obrigatórios' });
    return null;
  }
  if (params.error) {
    res.status(400).json({ success: false, error: params.error });
    return null;
  }
  return params;
}

router.get('/overview', requireAuth, async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;
  try {
    const result = await getAnalytics(params);
    res.json({ success: true, data: result.overview });
  } catch (error) {
    console.error('Erro /inte-comerce/overview:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/all', requireAuth, async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;
  try {
    const result = await getAnalytics(params);
    res.json({
      success: true,
      data: {
        overview: result.overview,
        strategic: result.strategic,
        funnel: result.funnel,
        daily: result.daily,
        reasons: result.reasons,
        dataAsOf: result.asOf,
        safraComparison: result.safraComparison,
        productionComparison: result.productionComparison,
      },
    });
  } catch (error) {
    console.error('Erro /inte-comerce/all:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/strategic', requireAuth, async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;
  try {
    const result = await getAnalytics(params);
    res.json({ success: true, data: result.strategic });
  } catch (error) {
    console.error('Erro /inte-comerce/strategic:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/funnel', requireAuth, async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;
  try {
    const result = await getAnalytics(params);
    res.json({ success: true, data: result.funnel });
  } catch (error) {
    console.error('Erro /inte-comerce/funnel:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/disqualify-reasons', requireAuth, async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;
  try {
    const result = await getAnalytics(params);
    res.json({ success: true, data: result.reasons });
  } catch (error) {
    console.error('Erro /inte-comerce/disqualify-reasons:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/daily', requireAuth, async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;
  try {
    const result = await getAnalytics(params);
    res.json({ success: true, data: result.daily });
  } catch (error) {
    console.error('Erro /inte-comerce/daily:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/collaborators', requireAuth, async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;
  try {
    const result = await getAnalytics(params);
    res.json({ success: true, data: result.collaborators });
  } catch (error) {
    console.error('Erro /inte-comerce/collaborators:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/teams', requireAuth, async (req, res) => {
  const params = validateParams(req, res);
  if (!params) return;
  try {
    const result = await getAnalytics(params);
    res.json({ success: true, data: result.teams });
  } catch (error) {
    console.error('Erro /inte-comerce/teams:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;