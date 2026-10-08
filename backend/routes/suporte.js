// backend/routes/suporte.js
// Fluxo unificado: movimentações normais (CRM) e por Link Hub (HUBSPOT_LINK)
// compartilham a mesma tabela app_comissionamento.tickets_movimentacao_lead.
// Nenhuma tabela adicional é necessária.
// Autenticação de sessão e proteção CSRF devem ser montadas antes deste router.

import express from 'express';
import { createHash, randomUUID } from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { pool } from '../services/db.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';
import { broadcastNotification } from './notificacoes.js';
import { HUBSPOT_PORTAL_ID_CONFIGURED } from '../services/hubspot.js';
import {
  getActiveSupportUser,
  isSupportAdmin,
  isSupportCoordinatorOrAbove,
  isSupportSupervisor,
  normalizeAccessValue,
  validateHubSpotMovementAccess,
} from '../services/access-control.js';
import {
  DEFAULT_PRODUCT,
  PRODUCTS_BY_TEAM,
  resolveTeamProduct,
} from '../config/teamProducts.js';

const router = express.Router();
const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';
const HUBSPOT_LINK_MOVEMENT = 'HUBSPOT_LINK';
const STATUS_MAP = Object.freeze({
  pendente: 'Aberto', processando: 'Em Andamento', concluido: 'Concluído',
  suporte: 'Aguardando Suporte', aviso: 'Aviso', erro: 'Erro',
  bloqueado: 'Bloqueado', fora_pipeline: 'Fora do Pipeline', no_pipeline: 'No Pipeline',
});
const SUPPORT_STATUSES = new Set(Object.values(STATUS_MAP));

// Mapeamento de unidade_id para nome legível.
// 4 (HO) é tratado como "vê todas as unidades".
const UNIDADES_MAP = Object.freeze({
  1: 'Osasco',
  2: 'Ribeirão Preto',
  3: 'Curitiba',
});
const HO_UNIDADE_ID = 4;

// Unidades em que o supervisor fica travado à própria equipe também no
// fluxo CRM (aba "Movimentar", modo individual). Coordenador/Admin seguem
// sem restrição. Link Hub continua travado para qualquer supervisor.
const UNIDADES_TRAVADAS_EQUIPE = new Set([2, 3, 4, 5]);

// Equipes que impõem trava de destino para supervisores que PERTENCEM a elas
// (mesmo fora das unidades 2–5). Hoje: Equipe Tatiane (unidade 1).
//
// Regra adicional: supervisores de unidade 1 que NÃO pertencem a uma equipe
// reservada não veem a equipe reservada na seleção de destino e não
// conseguem direcionar movimentações para ela (a validação final fica em
// access-control.js, via RESERVED_DESTINATION_TEAMS).
//
// Chaves normalizadas (lowercase, sem acento).
const EQUIPES_TRAVADAS_DESTINO = new Set([
  normalizeAccessValue('Equipe Tatiane'),
]);

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
function text(value, label, { required = false, max = 500 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail(400, `${label} é obrigatório.`);
    return '';
  }
  if (typeof value !== 'string') throw fail(400, `${label} deve ser texto.`);
  const result = value.trim();
  if (required && !result) throw fail(400, `${label} é obrigatório.`);
  if (result.length > max) throw fail(400, `${label} excede o limite de ${max} caracteres.`);
  return result;
}
function nullable(value, label, max = 500) {
  const result = text(value, label, { max });
  return !result || result === 'null' ? null : result;
}
function email(value, label, required = false) {
  const result = text(value, label, { required, max: 254 }).toLowerCase();
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw fail(400, `${label} inválido.`);
  return result;
}
function idempotencyKey(value) {
  if (typeof value !== 'string' || !/^[\w-]{16,128}$/.test(value)) {
    throw fail(400, 'Chave de idempotência inválida ou ausente.');
  }
  return value;
}
function hashRequest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* Observação legada não JSON. */ }
  }
  return {};
}
function recordId(value) {
  const result = String(value || '');
  if (!/^\d+$/.test(result) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) {
    throw fail(400, 'Identificador inválido.');
  }
  return result;
}
function pageParams(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw fail(400, 'Paginação inválida: page >= 1 e limit entre 1 e 200.');
  }
  return { page, limit, offset: (page - 1) * limit };
}

function extractHubSpotDealId(link) {
  if (typeof link !== 'string' || link.length > 2048) return null;
  try {
    const url = new URL(link.trim());
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.hubspot.com') ||
        url.username || url.password || (url.port && url.port !== '443')) return null;
    const pathname = decodeURIComponent(url.pathname);
    const contactsPortal = pathname.match(/^\/contacts\/(\d+)(?:\/|$)/i)?.[1];
    const record = pathname.match(/^\/contacts\/(\d+)\/record\/0-3\/(\d+)\/?$/i);
    const contactsDeal = pathname.match(/^\/contacts\/(\d+)\/deal\/(\d+)\/?$/i);
    const legacy = pathname.match(/^\/(?:deal|deals)\/(\d+)\/(\d+)\/?$/i);
    const standalone = pathname.match(/^\/record\/0-3\/(\d+)\/?$/i);
    const match = record || contactsDeal || legacy;
    const dealId = match?.[2] || standalone?.[1];
    const pathPortal = match?.[1] || contactsPortal;
    const queryPortals = [...url.searchParams.getAll('portalId'), ...url.searchParams.getAll('portalid')];
    const portals = [pathPortal, ...queryPortals].filter(value => value !== undefined);
    if (!dealId || !portals.length || portals.some(value => !/^\d+$/.test(value)) ||
        new Set(portals).size !== 1) return null;
    return { dealId, portalId: portals[0], link: url.href };
  } catch { return null; }
}

function validatePhone(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  const national = digits.startsWith('55') && digits.length >= 12
    ? digits.slice(2)
    : digits;
  return national.length === 10 || national.length === 11;
}

async function transaction(callback) {
  const client = await pool.connect();
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    const result = await callback(client);
    await client.query('COMMIT');
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try { await client.query('ROLLBACK'); } catch (rollbackError) {
        console.error('Falha no rollback de suporte:', rollbackError.message);
      }
    }
    throw error;
  } finally { client.release(); }
}
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// Executado antes de uploads e antes de qualquer acesso aos dados.
router.use(asyncRoute(async (req, res, next) => {
  const requesterEmail = email(req.session?.userId, 'Identidade da sessão');
  if (!requesterEmail) throw fail(401, 'Autenticação necessária.');
  const actor = await getActiveSupportUser(requesterEmail);
  if (!actor || (!isSupportSupervisor(actor.cargo) && !isSupportCoordinatorOrAbove(actor.cargo))) {
    throw fail(403, 'Perfil sem acesso à página de Suporte.');
  }
  req.supportActor = { ...actor, email: email(actor.email, 'E-mail do usuário', true) };
  next();
}));
function requireAdmin(req) {
  if (!isSupportAdmin(req.supportActor.cargo)) throw fail(403, 'Sem permissão para esta operação.');
}

async function destinationFor(req, enforceEmail = false, { enforceDestinationSameTeam = false } = {}) {
  const name = text(req.body.colaborador_destino_nome, 'Assessor destino', { required: true });
  const team = text(req.body.equipe_destino_nome, 'Equipe destino', { required: true });
  const destinationEmail = email(req.body.colaborador_destino_email, 'E-mail destino', enforceEmail);
  const access = await validateHubSpotMovementAccess({
    requesterEmail: req.supportActor.email,
    destinationName: name,
    destinationEmail: destinationEmail || undefined,
    destinationTeam: team,
    enforceDestinationSameTeam,
  });
  if (access.error) throw fail(access.status || 403, access.error);
  if (!access.destination) throw fail(500, 'A validação do destino não retornou o colaborador.');
  return {
    name: text(access.destination.nome, 'Nome do destino validado', { required: true }),
    email: email(access.destination.email, 'E-mail do destino validado', true),
    team: text(access.destination.nome_equipe || team, 'Equipe do destino validado', { required: true }),
  };
}

// Supervisor em unidade travada (2,3,4,5) OU pertencente a uma equipe
// reservada (Equipe Tatiane) → destino travado na própria equipe.
// Coordenador/Admin não são afetados.
function supervisorDeveTravarEquipe(actor) {
  if (!isSupportSupervisor(actor?.cargo)) return false;

  const unidade = actor?.unidade_id != null ? Number(actor.unidade_id) : null;
  if (unidade != null && UNIDADES_TRAVADAS_EQUIPE.has(unidade)) return true;

  const equipeNorm = normalizeAccessValue(actor?.nome_equipe);
  return !!equipeNorm && EQUIPES_TRAVADAS_DESTINO.has(equipeNorm);
}

// Supervisor de unidade 1 que NÃO pertence a uma equipe reservada → não deve
// ver equipes reservadas (ex.: Equipe Tatiane) na lista de destino.
function deveOcultarEquipesReservadas(actor) {
  if (!isSupportSupervisor(actor?.cargo)) return false;

  const unidade = actor?.unidade_id != null ? Number(actor.unidade_id) : null;
  if (unidade !== 1) return false;

  const equipeNorm = normalizeAccessValue(actor?.nome_equipe);
  return !EQUIPES_TRAVADAS_DESTINO.has(equipeNorm);
}

function historyScope(req) {
  const all = req.query.todos === '1';
  if (req.query.todos !== undefined && !['0', '1'].includes(req.query.todos)) throw fail(400, 'Parâmetro todos inválido.');
  if (all) requireAdmin(req);
  const requestedEmail = email(req.query.solicitante_email, 'E-mail do solicitante');
  const requestedName = text(req.query.colaborador_origem_nome, 'Nome do solicitante');
  if (!isSupportAdmin(req.supportActor.cargo)) {
    if (requestedEmail && requestedEmail !== req.supportActor.email) throw fail(403, 'Sem permissão para consultar outro solicitante.');
    if (requestedName && normalizeAccessValue(requestedName) !== normalizeAccessValue(req.supportActor.nome)) {
      throw fail(403, 'Sem permissão para consultar outro solicitante.');
    }
    return { email: req.supportActor.email, name: null };
  }
  return { email: requestedEmail || (requestedName || all ? null : req.supportActor.email), name: requestedName || null };
}

// Upload: autenticação já executada pelo router.use acima.
const uploadDir = path.join(process.cwd(), 'uploads', 'suporte');
fs.mkdirSync(uploadDir, { recursive: true });
const allowedExtensions = new Set(['.jpeg', '.jpg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.zip']);
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 5, fields: 20, fieldSize: 100 * 1024 },
  fileFilter: (req, file, cb) => allowedExtensions.has(path.extname(file.originalname).toLowerCase())
    ? cb(null, true) : cb(fail(400, 'Formato de arquivo não suportado.')),
});
async function cleanupUploads(req) {
  await Promise.all((req.files || []).map(file => fs.promises.unlink(file.path).catch(error => {
    if (error.code !== 'ENOENT') console.error('Falha ao remover upload rejeitado:', error.message);
  })));
}
function notify(payload) {
  if (!payload?.destinatario) return;
  try {
    Promise.resolve(broadcastNotification(payload)).catch(error => console.error('Falha na notificação:', error.message));
  } catch (error) { console.error('Falha na notificação:', error.message); }
}

// ============================================================
// GET /escopo/debug
// Diagnóstico temporário. Mostra exatamente o que o servidor vê.
// Pode ser removido após a validação do filtro por unidade.
// ============================================================
router.get('/escopo/debug', asyncRoute(async (req, res) => {
  const actor = req.supportActor;
  const isAdmin = isSupportAdmin(actor.cargo);
  const unidadeId = actor.unidade_id != null ? Number(actor.unidade_id) : null;
  const ehHO = unidadeId === HO_UNIDADE_ID;
  const aplicarFiltroUnidade = !isAdmin && !ehHO && unidadeId != null;

  const mesParam = text(req.query.mes, 'Mês');
  let dataMetrica;
  if (mesParam) {
    dataMetrica = /^\d{4}-\d{2}$/.test(mesParam) ? `${mesParam}-01` : mesParam;
  } else {
    const now = new Date();
    dataMetrica = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  const params = [dataMetrica];
  let filtroUnidadeSql = '';
  if (aplicarFiltroUnidade) {
    params.push(unidadeId);
    filtroUnidadeSql = ` AND TRIM(COALESCE(c.unidade_id::text, '')) = $${params.length}::text`;
  }

  const sql = `SELECT
       COALESCE(c.email, m.email) AS email,
       COALESCE(c.nome, m.email) AS nome,
       c.nome_equipe,
       c.cargo,
       c.status,
       c.unidade_id
     FROM app_comissionamento.view_app_metricas_assessores m
     LEFT JOIN core.view_app_colaboradores c
       ON LOWER(TRIM(c.email)) = LOWER(TRIM(m.email))
     WHERE m.data_metrica::date = $1::date
       AND (c.nome_equipe IS NULL OR TRIM(c.nome_equipe) != '')
       AND (c.status IS NULL OR LOWER(TRIM(c.status)) != 'desativado')
       AND (c.cargo IS NULL OR LOWER(TRIM(c.cargo)) != 'desativado')
       AND (m.classificacao_operacional IS NOT NULL AND TRIM(m.classificacao_operacional) != '')
       ${filtroUnidadeSql}
     ORDER BY c.nome_equipe, c.nome`;

  let queryError = null;
  let queryResult = [];
  try {
    const r = await pool.query(sql, params);
    queryResult = r.rows;
  } catch (err) {
    queryError = err.message;
  }

  let distribuicao = [];
  try {
    const r = await pool.query(
      `SELECT
         COALESCE(c.unidade_id::text, 'null') AS unidade,
         COUNT(*) AS total
       FROM app_comissionamento.view_app_metricas_assessores m
       LEFT JOIN core.view_app_colaboradores c
         ON LOWER(TRIM(c.email)) = LOWER(TRIM(m.email))
       WHERE m.data_metrica::date = $1::date
         AND (c.status IS NULL OR LOWER(TRIM(c.status)) != 'desativado')
         AND (c.cargo IS NULL OR LOWER(TRIM(c.cargo)) != 'desativado')
         AND m.classificacao_operacional IS NOT NULL AND TRIM(m.classificacao_operacional) != ''
       GROUP BY c.unidade_id
       ORDER BY c.unidade_id NULLS LAST`,
      [dataMetrica]
    );
    distribuicao = r.rows;
  } catch (err) {
    distribuicao = [{ erro: err.message }];
  }

  const equipesUnicas = [...new Set(queryResult.map(r => r.nome_equipe).filter(Boolean))];

  res.json({
    success: true,
    debug: {
      supportActorCompleto: actor,
      calculo: {
        isAdmin,
        ehHO,
        HO_UNIDADE_ID,
        unidadeId,
        aplicarFiltroUnidade,
        supervisorTravado: supervisorDeveTravarEquipe(actor),
        equipesReservadasOcultas: deveOcultarEquipesReservadas(actor),
        unidadesTravadas: [...UNIDADES_TRAVADAS_EQUIPE],
        equipesTravadas: [...EQUIPES_TRAVADAS_DESTINO],
      },
      dataMetrica,
      sqlExecutada: sql,
      paramsEnviados: params,
      queryError,
      resultado: {
        totalLinhas: queryResult.length,
        equipesUnicas,
        primeiraLinha: queryResult[0] || null,
      },
      distribuicaoPorUnidade: distribuicao,
    },
  });
}));

// ============================================================
// GET /escopo
// Retorna equipes e assessores disponíveis para o usuário logado.
//
// Regra de unidade:
//   - Admin → sem filtro.
//   - HO (unidade_id = 4) → sem filtro (HO vê todas as unidades).
//   - Coordenador / Supervisor com unidade_id (1, 2, 3) → apenas da própria unidade.
//   - Sem unidade_id → fallback sem filtro (com aviso no log).
//
// Regra de equipes reservadas (Equipe Tatiane):
//   - Supervisor fora da equipe reservada na unidade 1 → não vê a equipe
//     reservada na lista.
//
// Fonte: view_app_metricas_assessores (mês corrente) JOIN view_app_colaboradores.
//  - m.data_metrica do mês corrente garante apenas colaboradores do mês.
//  - m.classificacao_operacional preenchida filtra os desativados/duplicados.
//  - c.unidade_id aplica o filtro de unidade.
// ============================================================
router.get('/escopo', asyncRoute(async (req, res) => {
  const actor = req.supportActor;
  const isAdmin = isSupportAdmin(actor.cargo);
  const unidadeId = actor.unidade_id != null ? Number(actor.unidade_id) : null;

  const ehHO = unidadeId === HO_UNIDADE_ID;
  const aplicarFiltroUnidade = !isAdmin && !ehHO && unidadeId != null;

  if (!isAdmin && unidadeId == null) {
    console.warn(
      `[suporte/escopo] Usuário ${actor.email} (${actor.cargo}) sem unidade_id definida; ` +
      `exibindo equipes e assessores de todas as unidades.`
    );
  }
  if (ehHO) {
    console.info(
      `[suporte/escopo] Usuário ${actor.email} pertence a HO; exibindo todas as unidades.`
    );
  }

  const mesParam = text(req.query.mes, 'Mês');
  let dataMetrica;
  if (mesParam) {
    dataMetrica = /^\d{4}-\d{2}$/.test(mesParam) ? `${mesParam}-01` : mesParam;
  } else {
    const now = new Date();
    dataMetrica = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  const params = [dataMetrica];
  let filtroUnidadeSql = '';
  if (aplicarFiltroUnidade) {
    params.push(unidadeId);
    filtroUnidadeSql = ` AND TRIM(COALESCE(c.unidade_id::text, '')) = $${params.length}::text`;
  }

  const result = await pool.query(
    `SELECT
       COALESCE(c.email, m.email) AS email,
       COALESCE(c.nome, m.email) AS nome,
       c.nome_equipe,
       c.cargo,
       c.status,
       c.unidade_id
     FROM app_comissionamento.view_app_metricas_assessores m
     LEFT JOIN core.view_app_colaboradores c
       ON LOWER(TRIM(c.email)) = LOWER(TRIM(m.email))
     WHERE m.data_metrica::date = $1::date
       AND (c.nome_equipe IS NULL OR TRIM(c.nome_equipe) != '')
       AND (c.status IS NULL OR LOWER(TRIM(c.status)) != 'desativado')
       AND (c.cargo IS NULL OR LOWER(TRIM(c.cargo)) != 'desativado')
       AND (m.classificacao_operacional IS NOT NULL AND TRIM(m.classificacao_operacional) != '')
       ${filtroUnidadeSql}
     ORDER BY c.nome_equipe, c.nome`,
    params
  );

  const equipesSet = new Set();
  const assessores = [];
  const ocultarEquipesReservadas = deveOcultarEquipesReservadas(actor);

  for (const row of result.rows) {
    const equipeNome = (row.nome_equipe || '').trim();
    if (!equipeNome) continue;

    // Unidade 1 (supervisor fora da equipe reservada): não exibe a equipe
    // reservada nem seus assessores.
    if (ocultarEquipesReservadas
        && EQUIPES_TRAVADAS_DESTINO.has(normalizeAccessValue(equipeNome))) {
      continue;
    }

    equipesSet.add(equipeNome);
    assessores.push({
      id: row.email,
      nome: row.nome || row.email,
      email: row.email,
      cargo: row.cargo || '',
      status: row.status || 'ativo',
      equipeNome,
      unidadeId: row.unidade_id != null ? Number(row.unidade_id) : null,
    });
  }

  console.log(
    `[suporte/escopo] user=${actor.email} cargo=${actor.cargo} ` +
    `unidade_id=${unidadeId} ehHO=${ehHO} isAdmin=${isAdmin} aplicarFiltro=${aplicarFiltroUnidade} ` +
    `travaEquipe=${supervisorDeveTravarEquipe(actor)} ocultaReservadas=${ocultarEquipesReservadas} ` +
    `mes=${dataMetrica} equipes=${equipesSet.size} assessores=${assessores.length}`
  );

  res.json({
    success: true,
    data: {
      usuario: {
        cargo: actor.cargo || '',
        equipe: actor.nome_equipe || '',
        unidadeId,
        unidadeNome: unidadeId != null ? (UNIDADES_MAP[unidadeId] || null) : null,
        isAdmin,
        aplicarFiltroUnidade,
        supervisorTravado: supervisorDeveTravarEquipe(actor),
        equipesReservadasOcultas: ocultarEquipesReservadas,
      },
      equipes: [...equipesSet].sort((a, b) => a.localeCompare(b, 'pt-BR')),
      assessores,
      produtos: {
        default: DEFAULT_PRODUCT,
        porEquipe: PRODUCTS_BY_TEAM,
      },
    },
  });
}));

// ---------------------- Movimentação normal (CRM) ----------------------
router.post('/ticket-movimentacao', asyncRoute(async (req, res) => {
  const body = req.body;

  if (body.crm_origem === HUBSPOT_LINK_MOVEMENT || body.tipo_solicitacao === 'Movimentação Link Hub') {
    throw fail(410, 'Use a rota de lote dedicada para movimentações por Link Hub.');
  }

  const REQUIRED_FIELDS = [
    { key: 'nome_cliente_informado',      label: 'Nome' },
    { key: 'sobrenome_cliente_informado', label: 'Sobrenome' },
    { key: 'telefone_cliente_informado',  label: 'Telefone' },
  ];
  const missingFields = REQUIRED_FIELDS
    .filter(({ key }) => {
      const value = body?.[key];
      return value === undefined || value === null || String(value).trim() === '';
    })
    .map(({ label }) => label);

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Campos obrigatórios ausentes para movimentação normal: ${missingFields.join(', ')}.`,
      campos_faltantes: missingFields,
      tipo: 'VALIDACAO_MOVIMENTACAO_NORMAL',
    });
  }

  if (!validatePhone(body.telefone_cliente_informado)) {
    return res.status(400).json({
      success: false,
      error: 'Telefone inválido. Informe DDD + número (ex.: 11 00000-1234).',
      campos_faltantes: ['Telefone'],
      tipo: 'VALIDACAO_MOVIMENTACAO_NORMAL',
    });
  }

  const key = idempotencyKey(body.idempotency_key);
  const firstName = text(body.nome_cliente_informado, 'Nome', { required: true });
  const lastName = text(body.sobrenome_cliente_informado, 'Sobrenome', { required: true });
  const phone = text(body.telefone_cliente_informado, 'Telefone', { required: true, max: 50 });
  const customerEmail = email(body.email_cliente_informado, 'E-mail do cliente');

  const rawCpf = text(body.cpf_cliente_informado, 'CPF', { max: 30 });
  const cpf = rawCpf.replace(/\D/g, '');
  if (rawCpf && cpf.length !== 11) throw fail(400, 'CPF deve conter 11 dígitos.');

  const origin = nullable(body.origem_cliente_informada, 'Origem');
  const crmLeadId = nullable(body.crm_lead_id, 'Identificador CRM');
  const rawLeadId = nullable(body.lead_id, 'Identificador do lead');
  const leadId = rawLeadId ? recordId(rawLeadId) : null;
  const reason = text(body.motivo_solicitacao, 'Motivo', { max: 10000 });
  const observation = text(body.observacao_sales_ops, 'Observação', { max: 10000 });

  // Supervisor em unidade travada (2,3,4,5) OU pertencente à Equipe Tatiane
  // → destino obrigatoriamente na própria equipe. Coordenador/Admin e demais
  // supervisores seguem o fluxo antigo.
  const destination = await destinationFor(req, false, {
    enforceDestinationSameTeam: supervisorDeveTravarEquipe(req.supportActor),
  });
  const actor = req.supportActor;

  // Resolve produto com base na equipe VALIDADA pelo servidor.
  // - Equipes com allowChange=false: ignora o que veio, usa o default.
  // - Equipes com allowChange=true:  valida contra as opções permitidas.
  // - Lança erro 400 se o valor enviado não for permitido.
  const produto = resolveTeamProduct(destination.team, body.produto);

  const requestHash = hashRequest({ firstName, lastName, phone, customerEmail, cpf, origin,
    crmLeadId, leadId, reason, observation, destination, produto });

  const result = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`crm:${actor.email}:${key}`]);
    const existing = await client.query(`
      SELECT tml.id_ticket_movimentacao, ts.metadados->>'request_hash' AS request_hash
      FROM app_comissionamento.tickets_movimentacao_lead tml
      JOIN app_comissionamento.tickets_suporte ts ON ts.id_ticket = tml.ticket_id
      WHERE LOWER(TRIM(ts.metadados->>'solicitante_email')) = $1
        AND ts.metadados->>'idempotency_key' = $2 LIMIT 1`, [actor.email, key]);
    if (existing.rowCount) {
      if (!existing.rows[0].request_hash) throw fail(409, 'Solicitação legada sem assinatura de conteúdo. Verifique o ticket existente antes de reenviar.');
      if (existing.rows[0].request_hash !== requestHash) throw fail(409, 'Chave de idempotência já usada com outro conteúdo.');
      return { id: existing.rows[0].id_ticket_movimentacao, repeated: true };
    }
    const metadata = {
      assunto: 'Movimentacao',
      origem_colaborador: actor.nome || '',
      origem_equipe: actor.nome_equipe || '',
      destino_colaborador: destination.name,
      destino_equipe: destination.team,
      solicitante_email: actor.email,
      solicitante_nome: actor.nome || actor.email,
      colaborador_destino_email: destination.email,
      idempotency_key: key,
      request_hash: requestHash,
      produto,
    };
    const base = await client.query(`
      INSERT INTO app_comissionamento.tickets_suporte
      (solicitante_usuario_id, categoria, tipo_ticket, prioridade, status, titulo, descricao,
       origem_ticket, encaminhado_em, atualizado_em, metadados)
      VALUES ($1, 'Movimentacao', 'Movimentacao', 'NORMAL', 'Aberto', 'movimentacao card', $2,
              'suporte comissionamento', NOW(), NOW(), $3) RETURNING id_ticket`,
    [PLACEHOLDER_UUID, `Movimentação de lead solicitada por ${actor.nome || actor.email}`, JSON.stringify(metadata)]);

    const movement = await client.query(`
      INSERT INTO app_comissionamento.tickets_movimentacao_lead
      (ticket_id, lead_id, crm_origem, crm_lead_id, nome_cliente_informado, sobrenome_cliente_informado,
       email_cliente_informado, telefone_cliente_informado, cpf_cliente_informado, origem_cliente_informada,
       tipo_solicitacao, colaborador_destino_nome, motivo_solicitacao, status_mapeamento, observacao_sales_ops, atualizado_em)
      VALUES ($1,$2,'CRM',$3,$4,$5,$6,$7,$8,$9,'Movimentação',$10,$11,'pendente',$12,NOW())
      RETURNING id_ticket_movimentacao`,
    [base.rows[0].id_ticket, leadId, crmLeadId, firstName, lastName, customerEmail, phone, cpf || null,
      origin, destination.name, reason,
      JSON.stringify({ observacao: observation, idempotency_key: key, produto })]);

    return { id: movement.rows[0].id_ticket_movimentacao, repeated: false };
  });

  const camposValidados = ['Nome', 'Sobrenome', 'Telefone'];
  const camposOpcionais = [];
  if (!customerEmail) camposOpcionais.push('E-mail do cliente');
  if (!cpf) camposOpcionais.push('CPF');
  if (!origin) camposOpcionais.push('Origem');

  res.status(result.repeated ? 200 : 202).json({
    success: true,
    id: result.id,
    repetido: result.repeated,
    tipo_solicitacao: 'Movimentação',
    crm_origem: 'CRM',
    produto,
    ...(result.repeated ? {} : { status_mapeamento: 'pendente' }),
    campos_validados: camposValidados,
    campos_opcionais: camposOpcionais,
    ...(result.repeated
      ? {}
      : {
          aviso: camposOpcionais.length
            ? `A solicitação foi registrada. Caso o contato não seja encontrado no HubSpot, ${camposOpcionais.includes('E-mail do cliente') ? 'sem e-mail informado ' : ''}o worker poderá devolver status "aviso" com instrução de correção.`
            : undefined,
        }),
    message: result.repeated
      ? 'Solicitação já registrada anteriormente.'
      : 'Solicitação registrada para processamento. O worker irá validar e movimentar o card.',
  });
}));

// ---------------------- Movimentação por Link Hub (mesma tabela) ----------------------
router.post('/movimentacoes-linkhub/lotes', asyncRoute(async (req, res) => {
  const { links } = req.body;
  if (!Array.isArray(links) || links.length < 1 || links.length > 50) {
    throw fail(400, 'Envie de 1 a 50 links HubSpot por lote.');
  }
  const key = idempotencyKey(req.body.idempotency_key);
  const portalId = String(HUBSPOT_PORTAL_ID_CONFIGURED || '').trim();
  if (!/^\d+$/.test(portalId)) throw fail(503, 'A conta da integração HubSpot não está configurada corretamente.');

  const byDeal = new Map();
  for (const rawLink of links) {
    const parsed = extractHubSpotDealId(rawLink);
    if (!parsed || parsed.portalId !== portalId) throw fail(400, 'Há link inválido ou pertencente a outra conta HubSpot.');
    if (!byDeal.has(parsed.dealId)) byDeal.set(parsed.dealId, parsed);
  }
  const items = [...byDeal.values()];

  // Regra do fluxo Link Hub:
  //   - Supervisor só pode direcionar para a própria equipe (qualquer unidade).
  //   - Coordenador/Admin não são afetados por esta restrição.
  const destination = await destinationFor(req, true, { enforceDestinationSameTeam: true });
  const actor = req.supportActor;

  // Produto resolvido para o lote inteiro (mesma equipe destino).
  const produto = resolveTeamProduct(destination.team, req.body.produto);

  // Assinatura do lote: deals + destino + produto. Garante que reaproveitar
  // a mesma chave com outro conteúdo dispara conflito.
  const requestHash = hashRequest({
    deals: items.map(item => item.dealId).sort(),
    destination,
    produto,
  });

  const result = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`linkhub:${actor.email}:${key}`]);

    const existing = await client.query(`
      SELECT tml.id_ticket_movimentacao, tml.ticket_id, tml.crm_lead_id,
             ts.metadados->>'request_hash' AS request_hash
      FROM app_comissionamento.tickets_movimentacao_lead tml
      JOIN app_comissionamento.tickets_suporte ts ON ts.id_ticket = tml.ticket_id
      WHERE tml.crm_origem = 'HUBSPOT_LINK'
        AND LOWER(TRIM(ts.metadados->>'solicitante_email')) = $1
        AND ts.metadados->>'idempotency_key' = $2`,
      [actor.email, key]);

    if (existing.rowCount) {
      // 1) Verifica cards — conjunto idêntico.
      const existingDeals = new Set(existing.rows.map(r => String(r.crm_lead_id)));
      const requestedDeals = new Set(items.map(i => String(i.dealId)));
      if (existingDeals.size !== requestedDeals.size ||
          [...requestedDeals].some(d => !existingDeals.has(d))) {
        throw fail(409, 'Chave de idempotência já usada com outro conjunto de cards.');
      }
      // 2) Verifica assinatura (destino + produto). Tickets legados não têm hash.
      if (existing.rows.some(row => !row.request_hash || row.request_hash !== requestHash)) {
        throw fail(409, 'Chave de idempotência já usada com outro conteúdo ou lote legado sem assinatura.');
      }
      return {
        id_lote: existing.rows[0].ticket_id,
        total_itens: existing.rowCount,
        itens: existing.rows.map(r => ({
          id_ticket_movimentacao: r.id_ticket_movimentacao,
          deal_id: r.crm_lead_id,
          status_mapeamento: 'pendente',
        })),
        repetido: true,
      };
    }

    const itens = [];
    let firstTicketId = null;
    for (const item of items) {
      const metadata = {
        assunto: 'MovimentacaoLinkHub',
        origem_colaborador: actor.nome || '',
        origem_equipe: actor.nome_equipe || '',
        destino_colaborador: destination.name,
        destino_equipe: destination.team,
        solicitante_email: actor.email,
        solicitante_nome: actor.nome || actor.email,
        colaborador_destino_email: destination.email,
        idempotency_key: key,
        request_hash: requestHash,
        produto,
        portal_id: item.portalId,
        link_hub: item.link,
        deal_id: item.dealId,
      };
      const base = await client.query(`
        INSERT INTO app_comissionamento.tickets_suporte
        (solicitante_usuario_id, categoria, tipo_ticket, prioridade, status, titulo, descricao,
         origem_ticket, encaminhado_em, atualizado_em, metadados)
        VALUES ($1, 'Movimentacao', 'MovimentacaoLinkHub', 'NORMAL', 'Aberto', $2, $3,
                'suporte comissionamento', NOW(), NOW(), $4)
        RETURNING id_ticket`,
      [PLACEHOLDER_UUID,
       `Movimentação Link Hub — Deal ${item.dealId}`,
       `Movimentação por link HubSpot solicitada por ${actor.nome || actor.email}`,
       JSON.stringify(metadata)]);
      const ticketId = base.rows[0].id_ticket;
      if (firstTicketId === null) firstTicketId = ticketId;

      const movement = await client.query(`
        INSERT INTO app_comissionamento.tickets_movimentacao_lead
        (ticket_id, lead_id, crm_origem, crm_lead_id, nome_cliente_informado, sobrenome_cliente_informado,
         email_cliente_informado, telefone_cliente_informado, cpf_cliente_informado, origem_cliente_informada,
         tipo_solicitacao, colaborador_destino_nome, motivo_solicitacao, status_mapeamento, observacao_sales_ops, atualizado_em)
        VALUES ($1, NULL, 'HUBSPOT_LINK', $2, $3, '', '', '', '', '',
                'Movimentação Link Hub', $4, $5, 'pendente', $6, NOW())
        RETURNING id_ticket_movimentacao`,
      [ticketId,
       item.dealId,
       `Deal ${item.dealId}`,
       destination.name,
       `Movimentação Link Hub — Deal ${item.dealId}`,
       JSON.stringify({
         link_hub: item.link,
         portal_id: item.portalId,
         idempotency_key: key,
         request_hash: requestHash,
         produto,
       })]);

      itens.push({
        id_ticket_movimentacao: movement.rows[0].id_ticket_movimentacao,
        deal_id: item.dealId,
        status_mapeamento: 'pendente',
      });
    }
    return { id_lote: firstTicketId, total_itens: items.length, itens, repetido: false };
  });

  res.status(result.repetido ? 200 : 202).json({
    success: true,
    id_lote: result.id_lote,
    total_itens: result.total_itens,
    duplicados_removidos: links.length - items.length,
    repetido: result.repetido,
    itens: result.itens,
    produto,
    ...(result.repetido ? {} : { status: 'pendente' }),
    message: result.repetido
      ? 'Lote já registrado anteriormente.'
      : `Lote registrado com ${result.total_itens} card(s). O worker irá processar em até 5s.`,
  });
}));

// ---------------------- Histórico unificado ----------------------
router.get('/tickets-movimentacao', asyncRoute(async (req, res) => {
  const scope = historyScope(req);
  const status = text(req.query.status_mapeamento, 'Status', { max: 40 }) || null;
  if (status && !Object.hasOwn(STATUS_MAP, status)) throw fail(400, 'Status de movimentação inválido.');
  const { page, limit, offset } = pageParams(req.query);
  const rows = await pool.query(`
    SELECT
      to_jsonb(tml) || jsonb_build_object(
        'colaborador_origem_nome', COALESCE(ts.metadados->>'origem_colaborador',''),
        'equipe_origem_nome', COALESCE(ts.metadados->>'origem_equipe',''),
        'equipe_destino_nome', COALESCE(ts.metadados->>'destino_equipe', tml.colaborador_destino_nome),
        'colaborador_destino_nome', COALESCE(ts.metadados->>'destino_colaborador', tml.colaborador_destino_nome),
        'colaborador_destino_email', COALESCE(ts.metadados->>'colaborador_destino_email',''),
        'solicitante_email', COALESCE(ts.metadados->>'solicitante_email',''),
        'solicitante_nome', COALESCE(ts.metadados->>'solicitante_nome',''),
        'criado_em', ts.encaminhado_em,
        'tipo_registro', tml.crm_origem,
        'pode_editar', $4::boolean
      ) AS payload
    FROM app_comissionamento.tickets_movimentacao_lead tml
    LEFT JOIN app_comissionamento.tickets_suporte ts ON ts.id_ticket = tml.ticket_id
    WHERE ($1::text IS NULL OR LOWER(TRIM(COALESCE(ts.metadados->>'solicitante_email',''))) = $1)
      AND ($2::text IS NULL OR LOWER(TRIM(COALESCE(ts.metadados->>'solicitante_nome',''))) = LOWER(TRIM($2)))
      AND ($3::text IS NULL OR tml.status_mapeamento::text = $3)
    ORDER BY tml.atualizado_em DESC NULLS LAST, tml.id_ticket_movimentacao DESC
    LIMIT $5 OFFSET $6`,
  [scope.email, scope.name, status, isSupportAdmin(req.supportActor.cargo), limit + 1, offset]);
  const data = rows.rows.slice(0, limit).map(row => row.payload);
  res.json({ success: true, data, pagination: { page, limit, hasMore: rows.rows.length > limit } });
}));

// ---------------------- Reportes ----------------------
router.get('/ticket-suporte', asyncRoute(async (req, res) => {
  const scope = historyScope(req);
  const { page, limit, offset } = pageParams(req.query);
  const result = await pool.query(`
    SELECT id_ticket AS id_ticket_suporte, titulo,
           COALESCE(metadados->>'assunto', titulo) AS assunto, descricao, status,
           COALESCE(metadados->>'solicitante_nome','') AS solicitante_nome,
           COALESCE(metadados->>'equipe_nome','') AS equipe_nome,
           COALESCE(metadados->>'observacao_sales_ops','') AS observacao_sales_ops,
           encaminhado_em AS criado_em, concluido_em
    FROM app_comissionamento.tickets_suporte
    WHERE tipo_ticket = 'Reporte'
      AND ($1::text IS NULL OR LOWER(TRIM(metadados->>'solicitante_email')) = $1)
      AND ($2::text IS NULL OR LOWER(TRIM(metadados->>'solicitante_nome')) = LOWER(TRIM($2)))
    ORDER BY encaminhado_em DESC NULLS LAST, id_ticket DESC LIMIT $3 OFFSET $4`,
  [scope.email, scope.name, limit + 1, offset]);
  res.json({ success: true, data: result.rows.slice(0, limit),
    pagination: { page, limit, hasMore: result.rows.length > limit } });
}));

router.post('/ticket-suporte', upload.array('arquivos', 5), asyncRoute(async (req, res) => {
  const title = text(req.body.titulo, 'Título', { required: true, max: 500 });
  const subject = text(req.body.assunto, 'Assunto', { required: true, max: 500 });
  const description = text(req.body.descricao, 'Descrição', { required: true, max: 50000 });
  const actor = req.supportActor;
  const configuredUrl = process.env.SUPPORT_PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL;
  if ((req.files || []).length && !configuredUrl) throw fail(503, 'URL pública dos anexos não configurada.');
  let attachments = [];
  if ((req.files || []).length) {
    let base;
    try { base = new URL(configuredUrl); } catch { throw fail(503, 'URL pública dos anexos inválida.'); }
    if (base.protocol !== 'https:' || base.username || base.password) throw fail(503, 'A URL dos anexos deve usar HTTPS sem credenciais.');
    attachments = req.files.map(file => ({ nome: file.originalname,
      url: new URL(`/uploads/suporte/${encodeURIComponent(file.filename)}`, base.origin).href }));
  }
  const metadata = { arquivos: attachments, solicitante_nome: actor.nome || actor.email,
    solicitante_email: actor.email, equipe_nome: actor.nome_equipe || '', observacao_sales_ops: '', assunto: subject };
  const result = await pool.query(`
    INSERT INTO app_comissionamento.tickets_suporte
    (solicitante_usuario_id, categoria, tipo_ticket, prioridade, status, titulo, descricao,
     origem_ticket, encaminhado_em, atualizado_em, metadados)
    VALUES ($1,$2,'Reporte','NORMAL','Aberto',$3,$4,'suporte comissionamento',NOW(),NOW(),$5)
    RETURNING id_ticket`, [PLACEHOLDER_UUID, subject, title, description, JSON.stringify(metadata)]);
  req.supportUploadsPersisted = true;
  try {
    const escapeLabel = value => value.replace(/[\[\]\\\r\n]/g, ' ');
    Promise.resolve(teamsNotificador.enviar({ titulo: title, assunto: subject, descricao: description,
      solicitante: actor.nome || actor.email, equipe: actor.nome_equipe || '', arquivos: attachments,
      anexosMarkdown: attachments.length ? attachments.map(a => `[${escapeLabel(a.nome)}](${a.url})`).join(', ') : 'Nenhum anexo',
    })).catch(error => console.error('Falha na notificação Teams:', error.message));
  } catch (error) { console.error('Falha na notificação Teams:', error.message); }
  res.status(201).json({ success: true, message: 'Ticket de suporte registrado com sucesso.', id_ticket: result.rows[0].id_ticket });
}));

// ---------------------- Edição manual (SalesOps) ----------------------
router.patch('/tickets-movimentacao/:id', asyncRoute(async (req, res) => {
  requireAdmin(req);
  const id = recordId(req.params.id);
  const hasStatus = req.body.status_mapeamento !== undefined;
  const hasObservation = req.body.observacao_sales_ops !== undefined;
  if (!hasStatus && !hasObservation) throw fail(400, 'Nenhum campo para atualizar.');
  const status = hasStatus ? text(req.body.status_mapeamento, 'Status', { required: true, max: 40 }) : null;
  if (hasStatus && !Object.hasOwn(STATUS_MAP, status)) throw fail(400, 'Status de movimentação inválido.');
  const observation = hasObservation ? text(req.body.observacao_sales_ops, 'Observação', { max: 10000 }) : null;
  const payload = await transaction(async client => {
    const current = await client.query(`
      SELECT id_ticket_movimentacao, ticket_id, crm_origem, observacao_sales_ops
      FROM app_comissionamento.tickets_movimentacao_lead WHERE id_ticket_movimentacao = $1 FOR UPDATE`, [id]);
    if (!current.rowCount) throw fail(404, 'Ticket de movimentação não encontrado.');
    const movement = current.rows[0];
    if (movement.crm_origem === HUBSPOT_LINK_MOVEMENT && hasStatus) {
      throw fail(409, 'O status de uma execução Link Hub deve ser confirmado pelo processamento, não alterado manualmente.');
    }
    const previous = movement.observacao_sales_ops;
    const metadata = parseJsonObject(previous);
    if (typeof previous === 'string' && previous.trim() && !Object.keys(metadata).length) metadata.observacao_anterior = previous;
    if (hasObservation) metadata.observacao = observation;
    if (hasStatus) metadata.ultima_alteracao_manual = { usuario: req.supportActor.email, status, em: new Date().toISOString() };
    await client.query(`
      UPDATE app_comissionamento.tickets_movimentacao_lead
      SET status_mapeamento = CASE WHEN $2::boolean THEN $3 ELSE status_mapeamento END,
          analisado_em = CASE WHEN $2::boolean THEN NOW() ELSE analisado_em END,
          observacao_sales_ops = $4, atualizado_em = NOW()
      WHERE id_ticket_movimentacao = $1`, [id, hasStatus, status, JSON.stringify(metadata)]);
    const support = await client.query(`
      UPDATE app_comissionamento.tickets_suporte
      SET status = CASE WHEN $2::boolean THEN $3 ELSE status END,
          concluido_em = CASE WHEN $2::boolean THEN CASE WHEN $4::boolean THEN NOW() ELSE NULL END ELSE concluido_em END,
          atualizado_em = NOW()
      WHERE id_ticket = $1 RETURNING titulo, metadados->>'solicitante_email' AS solicitante_email`,
    [movement.ticket_id, hasStatus, hasStatus ? STATUS_MAP[status] : null, status === 'concluido']);
    if (!support.rowCount) throw fail(409, 'Ticket base ausente; atualização cancelada.');
    return { tipo: 'info', titulo: 'Atualização da movimentação', destinatario: support.rows[0].solicitante_email,
      mensagem: `Sua solicitação "${support.rows[0].titulo}" foi atualizada.\nStatus: ${hasStatus ? STATUS_MAP[status] : 'inalterado'}.\nObservação: ${hasObservation ? observation : 'inalterada'}`,
      data: new Date().toISOString() };
  });
  notify(payload);
  res.json({ success: true, message: 'Ticket atualizado. Alteração manual de status não comprova execução no HubSpot.' });
}));

router.patch('/tickets-suporte/:id', asyncRoute(async (req, res) => {
  requireAdmin(req);
  const id = recordId(req.params.id);
  const hasStatus = req.body.status !== undefined;
  const hasObservation = req.body.observacao_sales_ops !== undefined;
  if (!hasStatus && !hasObservation) throw fail(400, 'Nenhum campo para atualizar.');
  const rawStatus = hasStatus ? text(req.body.status, 'Status', { required: true, max: 40 }) : null;
  const status = hasStatus ? [...SUPPORT_STATUSES].find(value => normalizeAccessValue(value) === normalizeAccessValue(rawStatus)) : null;
  if (hasStatus && !status) throw fail(400, 'Status de suporte inválido.');
  const observation = hasObservation ? text(req.body.observacao_sales_ops, 'Observação', { max: 10000 }) : null;
  const result = await pool.query(`
    UPDATE app_comissionamento.tickets_suporte
    SET status = CASE WHEN $2::boolean THEN $3 ELSE status END,
        concluido_em = CASE WHEN $2::boolean THEN CASE WHEN $3 = 'Concluído' THEN NOW() ELSE NULL END ELSE concluido_em END,
        metadados = CASE WHEN $4::boolean THEN
          jsonb_set(COALESCE(metadados, '{}'::jsonb), '{observacao_sales_ops}', to_jsonb($5::text), true)
          ELSE metadados END,
        atualizado_em = NOW()
    WHERE id_ticket = $1 AND tipo_ticket = 'Reporte'
    RETURNING titulo, metadados->>'solicitante_email' AS solicitante_email`,
  [id, hasStatus, status, hasObservation, observation]);
  if (!result.rowCount) throw fail(404, 'Ticket de suporte não encontrado.');
  notify({ tipo: 'info', titulo: 'Atualização da solicitação', destinatario: result.rows[0].solicitante_email,
    mensagem: `Sua solicitação "${result.rows[0].titulo}" foi atualizada.\nStatus: ${hasStatus ? status : 'inalterado'}.\nObservação: ${hasObservation ? observation : 'inalterada'}`,
    data: new Date().toISOString() });
  res.json({ success: true, message: 'Ticket de suporte atualizado com sucesso.' });
}));

router.use((error, req, res, next) => {
  Promise.resolve().then(async () => {
    if (!req.supportUploadsPersisted) await cleanupUploads(req);
    if (res.headersSent) return next(error);
    const multerError = error instanceof multer.MulterError;
    const candidate = Number(error.status);
    const status = multerError ? 400 : (Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500);
    if (status >= 500) console.error('Erro na rota de suporte:', error.message);
    return res.status(status).json({ success: false,
      error: multerError ? 'Upload inválido. Limite: 5 arquivos, até 10 MB por arquivo.'
        : status < 500 ? error.message : status === 503 ? error.message : 'Erro interno do servidor.' });
  }).catch(next);
});

export default router;