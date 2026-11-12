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

// Timeout defensivo — se a query demorar demais, respondemos 504 JSON
// antes do proxy reverso (nginx/caddy) matar a conexão → corpo vazio.
const ROUTE_TIMEOUT_MS = Number(process.env.INTE_COMERCE_ROUTE_TIMEOUT_MS) || 90_000;

function analyticsCacheKey(params) {
  // unchanged
}

function getAnalytics(params) {
  // unchanged
}

// ─────────────────────────────────────────────────────────────
// Helpers de segurança — garantem SEMPRE resposta JSON
// ─────────────────────────────────────────────────────────────
function sendJson(res, status, body) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  let text;
  try {
    text = JSON.stringify(body);
  } catch (err) {
    console.error('[inte-comerce] JSON serialize failed:', err);
    text = '{"success":false,"error":"Falha ao serializar resposta."}';
    status = 500;
  }
  try {
    res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(text);
  } catch (err) {
    console.error('[inte-comerce] send failed:', err);
    try { res.end(); } catch {}
  }
}

function safeAsync(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      console.error(`[inte-comerce] handler error (${req.method} ${req.path}):`, err);
      sendJson(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

function withTimeout(ms, handler) {
  return async (req, res, next) => {
    let fired = false;
    const timer = setTimeout(() => {
      if (fired) return;
      fired = true;
      if (res.headersSent) {
        try { res.end(); } catch {}
        return;
      }
      console.warn(`[inte-comerce] timeout ${req.method} ${req.path} after ${ms}ms`);
      sendJson(res, 504, {
        success: false,
        error: 'A consulta demorou mais do que o esperado. Tente novamente em instantes.',
      });
    }, ms);
    if (timer.unref) timer.unref();
    try {
      await handler(req, res, next);
    } finally {
      clearTimeout(timer);
      fired = true;
    }
  };
}

// ─────────────────────────────────────────────────────────────
// Autenticação e escopo — tudo dentro de try/catch
// ─────────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  try {
    if (!req.session?.isAuthenticated || !req.session?.userId) {
      return sendJson(res, 401, { success: false, error: 'Não autenticado' });
    }

    const actor = await getActiveSupportUser(req.session.userId);
    if (!actor) {
      return sendJson(res, 403, { success: false, error: 'Usuário ativo não encontrado.' });
    }

    const level = accessControl.getEffectiveAccessLevel(actor);
    if (level < accessControl.LEVELS.COORDENADOR) {
      return sendJson(res, 403, { success: false, error: 'Perfil sem acesso à Inteligência Comercial.' });
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
      return sendJson(res, 400, { success: false, error: 'Unidade inválida.' });
    }

    const unidadeSelecionada = requestedUnit != null ? Number(requestedUnit) : null;
    if (!isAdmin && unidadeUsuario !== 4) {
      if (!Number.isInteger(unidadeUsuario)) {
        return sendJson(res, 403, { success: false, error: 'Usuário sem unidade definida.' });
      }
      if (unidadeSelecionada != null && unidadeSelecionada !== unidadeUsuario) {
        return sendJson(res, 403, { success: false, error: 'A unidade selecionada está fora do seu escopo.' });
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

// ─────────────────────────────────────────────────────────────
// Leitura/validação de parâmetros
// ─────────────────────────────────────────────────────────────
function readParams(req) {
  // unchanged
}

function validateParams(req, res) {
  const params = readParams(req);
  if (!params) {
    sendJson(res, 400, { success: false, error: 'start e end obrigatórios' });
    return null;
  }
  if (params.error) {
    sendJson(res, 400, { success: false, error: params.error });
    return null;
  }
  return params;
}

// ─────────────────────────────────────────────────────────────
// Rotas
// ─────────────────────────────────────────────────────────────
router.get(
  '/overview',
  safeAsync(requireAuth),
  safeAsync(withTimeout(ROUTE_TIMEOUT_MS, async (req, res) => {
    const params = validateParams(req, res);
    if (!params) return;
    const result = await getAnalytics(params);
    sendJson(res, 200, { success: true, data: result.overview });
  })),
);

// ... similar for /all, /strategic, /funnel, /disqualify-reasons, /daily, /collaborators, /teams

// ─────────────────────────────────────────────────────────────
// Error handler do router — sempre JSON
// ─────────────────────────────────────────────────────────────
router.use((err, req, res, next) => {
  console.error(`[inte-comerce] router error (${req.method} ${req.path}):`, err);
  sendJson(res, 500, {
    success: false,
    error: err instanceof Error ? err.message : String(err),
  });
});

export default router;