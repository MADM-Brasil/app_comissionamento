// backend/services/ticketQueue.js

import { pool } from './bd/db.js';
import * as hubspotModule from './hubspot.js';
import { broadcastNotification } from '../routes/notificacoes.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';

// ── Configuração ────────────────────────────────────────────────────
const POLL_INTERVAL_MS      = Number(process.env.TICKET_QUEUE_POLL_MS      || 5_000);
const BATCH_SIZE            = Number(process.env.TICKET_QUEUE_BATCH        || 5);
const STALE_PROCESSANDO_MS  = Number(process.env.TICKET_QUEUE_STALE_MS     || 10 * 60 * 1000);
const MAX_TENTATIVAS        = Number(process.env.TICKET_QUEUE_MAX_TENTATIVAS || 5);
const HUBSPOT_TIMEOUT_MS    = Number(process.env.HUBSPOT_TIMEOUT_MS        || 45_000);

const WORKER_ID = `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

// ── Verificação das funções obrigatórias do hubspot.js ─────────────
const FUNCOES_OBRIGATORIAS = [
  'garantirLeadNoCloser',
  'reassignDealForLinkHubMovement',
  'getDealMovementContext',
  'findOwnerIdByEmail',
  'findContactAndValidate',
  'createContact',
];

const _faltantes = FUNCOES_OBRIGATORIAS.filter(
  nome => typeof hubspotModule?.[nome] !== 'function'
);
const _modoDegradado = _faltantes.length > 0;
const _motivoDegradado = _modoDegradado
  ? `hubspot.js não exporta: ${_faltantes.join(', ')}. Exports disponíveis: ${
      Object.keys(hubspotModule || {}).sort().join(', ') || '(nenhum)'
    }`
  : null;

// ── Estado ──────────────────────────────────────────────────────────
let running = false;
let loopHandle = null;
let inFlight = 0;

const stats = {
  iniciado_em: new Date().toISOString(),
  ciclos: 0,
  claims: 0,
  concluidos: 0,
  erros: 0,
  suportes: 0,
  avisos: 0,
  coordenador: 0,
  bloqueados: 0,
  orfaos_recuperados: 0,
  ultimo_ciclo_em: null,
  ultimo_erro: null,
  modo_degradado: _modoDegradado,
};

// ── Helpers ─────────────────────────────────────────────────────────
function log(level, ...args) {
  const ts = new Date().toISOString();
  const fn = level === 'error' ? console.error : console.log;
  fn(`[ticketQueue ${WORKER_ID} ${ts}]`, ...args);
}

function parseJson(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* legado */ }
  }
  return {};
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(
        new Error(`Timeout ${ms}ms em ${label}`),
        { code: 'HUBSPOT_TIMEOUT', retryable: true },
      )),
      ms,
    );
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

// ────────────────────────────────────────────────────────────────────
// Adapter — normaliza retorno das funções reais do hubspot.js
// ────────────────────────────────────────────────────────────────────
function mapErroHubSpot(err) {
  if (!err) return { ok: false, status: 'erro', erro: 'Erro desconhecido' };
  const code = String(err.code || '');
  const msg = String(err.message || err).slice(0, 2000);

  if (err.requiresReconciliation) {
    return {
      ok: false,
      status: 'suporte',
      erro: `Gravação parcial no HubSpot. Verifique manualmente. ${msg}`,
      hubspot: { resultado_parcial: err.partialResult || null },
    };
  }
  if (code === 'CONTEXT_CHANGED') {
    return { ok: false, status: 'erro', erro: msg };
  }
  if (['AMBIGUOUS_CONTACT', 'CONTACT_DATA_MISMATCH', 'SHARED_CONTACT',
       'CONTACT_ASSOCIATION_NOT_UNIQUE'].includes(code)) {
    return { ok: false, status: 'suporte', erro: msg, hubspot: { code } };
  }
  if (err.blocked === true ||
      ['PIPELINE_NOT_ALLOWED', 'INVALID_STAGE', 'ACCOUNT_MISMATCH',
       'CONFIGURATION_ERROR', 'INVALID_ID'].includes(code)) {
    return { ok: false, status: 'bloqueado', erro: msg, hubspot: { code } };
  }
  if (code === 'NETWORK_ERROR' || code === 'HUBSPOT_TIMEOUT' || err.retryable) {
    return { ok: false, status: 'erro', erro: msg };
  }
  if (code === 'CONFIRMATION_FAILED' || code === 'PRODUCT_CONFIRMATION_FAILED') {
    return { ok: false, status: 'suporte', erro: msg, hubspot: { code } };
  }
  return { ok: false, status: 'erro', erro: msg, hubspot: { code } };
}

async function executarCrm({ movement, produto, ownerId, bypassRegraTemporal }) {
  let contactId;
  try {
    const busca = await hubspotModule.findContactAndValidate({
      email: movement.email_cliente_informado || undefined,
      phone: movement.telefone_cliente_informado || undefined,
      cpf:   movement.cpf_cliente_informado || undefined,
    });

    if (busca?.found && busca?.contact?.id) {
      if (busca.divergente) {
        return {
          ok: false,
          status: 'aviso',
          erro: busca.motivo || 'Dados do cliente divergem do cadastro HubSpot — revise antes de movimentar.',
          hubspot: { contato_id: busca.contact.id, divergencias: busca.motivo || null },
        };
      }
      contactId = String(busca.contact.id);
    } else {
      const criado = await hubspotModule.createContact({
        firstName: movement.nome_cliente_informado,
        lastName:  movement.sobrenome_cliente_informado,
        email:     movement.email_cliente_informado || undefined,
        phone:     movement.telefone_cliente_informado || undefined,
        cpf:       movement.cpf_cliente_informado || undefined,
        origem:    movement.origem_cliente_informada || undefined,
        ownerId,
        produto,
      });
      contactId = String(criado.id);
    }
  } catch (err) {
    return mapErroHubSpot(err);
  }

  const dealName = ['Movimentação -', movement.nome_cliente_informado, movement.sobrenome_cliente_informado]
    .filter(Boolean).join(' ').trim();

  let resultado;
  try {
    resultado = await hubspotModule.garantirLeadNoCloser(
      contactId, dealName, ownerId, '', produto,
      { bypassTemporalRestriction: Boolean(bypassRegraTemporal) },
    );
  } catch (err) {
    // [NOVO] Mantém o contato localizado/criado para gerar o link do caso.
    const mapeado = mapErroHubSpot(err);
    return { ...mapeado, hubspot: { ...(mapeado.hubspot || {}), contactId } };
  }

  if (resultado && resultado.blocked === false) {
    return { ok: true, status: 'concluido', hubspot: resultado };
  }
  if (resultado?.requiresCoordinator) {
    return {
      ok: false,
      status: 'coordenador',
      erro: resultado.message || 'Bloqueio por regra temporal — precisa autorização do coordenador.',
      hubspot: resultado,
      requiresCoordinator: true,
    };
  }
  if (['contact_has_juridico_deal', 'fallback_block'].includes(resultado?.ruleApplied)) {
    return {
      ok: false,
      status: 'bloqueado',
      erro: resultado?.message || resultado?.ruleApplied || 'Bloqueio definitivo.',
      hubspot: resultado,
    };
  }
  return {
    ok: false,
    status: 'suporte',
    erro: resultado?.message || resultado?.ruleApplied || 'Bloqueio no fluxo HubSpot.',
    hubspot: resultado,
  };
}

async function executarLinkHub({ movement, metadata, produto, ownerId }) {
  const dealId = String(movement.crm_lead_id || '').trim();
  if (!/^\d+$/.test(dealId)) {
    return { ok: false, status: 'erro', erro: 'Deal ID inválido no ticket Link Hub.' };
  }
  const portalId = String(
    metadata?.portal_id || hubspotModule.HUBSPOT_PORTAL_ID_CONFIGURED || ''
  ).trim();
  if (!/^\d+$/.test(portalId)) {
    return { ok: false, status: 'erro', erro: 'Portal ID HubSpot não configurado (HUBSPOT_PORTAL_ID).' };
  }

  let expectedContext;
  try {
    expectedContext = await hubspotModule.getDealMovementContext(dealId, portalId);
  } catch (err) {
    return mapErroHubSpot(err);
  }

  try {
    const resultado = await hubspotModule.reassignDealForLinkHubMovement(
      dealId, ownerId, portalId, expectedContext, produto,
    );
    return { ok: true, status: 'concluido', hubspot: resultado };
  } catch (err) {
    return mapErroHubSpot(err);
  }
}

async function moverLeadHubSpot({ movement, metadata, produto, bypassRegraTemporal }) {
  const destinoEmail = String(
    movement.colaborador_destino_email || metadata?.colaborador_destino_email || ''
  ).trim().toLowerCase();

  if (!destinoEmail) {
    return {
      ok: false, status: 'suporte',
      erro: 'Ticket sem e-mail do responsável destino — não é possível resolver o owner HubSpot.',
    };
  }

  let ownerId;
  try {
    ownerId = await hubspotModule.findOwnerIdByEmail(destinoEmail);
  } catch (err) {
    return mapErroHubSpot(err);
  }
  if (!ownerId) {
    return {
      ok: false, status: 'suporte',
      erro: `Owner HubSpot não encontrado para ${destinoEmail}. Verifique se o colaborador destino existe/está ativo na conta.`,
      hubspot: { email_destino: destinoEmail },
    };
  }

  if (movement.crm_origem === 'HUBSPOT_LINK') {
    return executarLinkHub({ movement, metadata, produto, ownerId });
  }
  return executarCrm({ movement, produto, ownerId, bypassRegraTemporal });
}

// ────────────────────────────────────────────────────────────────────
// DB — reset de órfãos, claim, finalização
// ────────────────────────────────────────────────────────────────────
async function resetOrfaos() {
  try {
    const r = await pool.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
          SET status_mapeamento = 'pendente',
              analisado_em = NULL,
              observacao_sales_ops =
                jsonb_set(
                  COALESCE(observacao_sales_ops::jsonb, '{}'::jsonb),
                  '{_worker}',
                  COALESCE(observacao_sales_ops::jsonb->'_worker', '{}'::jsonb)
                  || jsonb_build_object(
                       'processando_desde', null,
                       'ultima_falha_em', to_jsonb(NOW()),
                       'erro_lease', to_jsonb('lease expirado em ' || NOW()::text)
                     ),
                  true
                ),
              atualizado_em = NOW()
        WHERE status_mapeamento = 'processando'
          AND COALESCE(
                (observacao_sales_ops::jsonb->'_worker'->>'processando_desde')::timestamptz,
                atualizado_em
              ) < NOW() - ($1::int || ' milliseconds')::interval
        RETURNING id_ticket_movimentacao`,
      [STALE_PROCESSANDO_MS],
    );
    if (r.rowCount > 0) {
      stats.orfaos_recuperados += r.rowCount;
      log('warn', `reset de órfãos: ${r.rowCount} ticket(s) → 'pendente'`);
    }
    return r.rowCount;
  } catch (err) {
    log('error', 'resetOrfaos falhou:', err.message);
    return 0;
  }
}

async function claimLote(limit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT tml.id_ticket_movimentacao
         FROM app_comissionamento.tickets_movimentacao_lead tml
        WHERE tml.status_mapeamento = 'pendente'
          AND tml.crm_origem <> 'HUBSPOT_LINK'       
          AND tml.colaborador_destino_nome IS NOT NULL
          AND TRIM(tml.colaborador_destino_nome) <> ''
        ORDER BY tml.atualizado_em ASC NULLS FIRST, tml.id_ticket_movimentacao ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (sel.rowCount === 0) {
      await client.query('COMMIT');
      return [];
    }
    const ids = sel.rows.map(r => r.id_ticket_movimentacao);
    await client.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
          SET status_mapeamento = 'processando',
              analisado_em = NOW(),
              atualizado_em = NOW(),
              observacao_sales_ops =
                jsonb_set(
                  COALESCE(observacao_sales_ops::jsonb, '{}'::jsonb),
                  '{_worker}',
                  COALESCE(observacao_sales_ops::jsonb->'_worker', '{}'::jsonb)
                  || jsonb_build_object(
                       'processando_desde', to_jsonb(NOW()),
                       'tentativas', COALESCE(
                         (observacao_sales_ops::jsonb->'_worker'->>'tentativas')::int, 0
                       ) + 1,
                       'worker_id', to_jsonb($2::text)
                     ),
                  true
                )
        WHERE id_ticket_movimentacao = ANY($1::bigint[])`,
      [ids, WORKER_ID],
    );
    const enriched = await client.query(
      `SELECT tml.id_ticket_movimentacao, tml.ticket_id, tml.crm_origem, tml.crm_lead_id,
              tml.nome_cliente_informado, tml.sobrenome_cliente_informado,
              tml.email_cliente_informado, tml.telefone_cliente_informado,
              tml.cpf_cliente_informado, tml.origem_cliente_informada,
              tml.tipo_solicitacao, tml.colaborador_destino_nome, tml.motivo_solicitacao,
              tml.observacao_sales_ops, tml.status_mapeamento, tml.atualizado_em,
              COALESCE(ts.metadados->>'colaborador_destino_email', '') AS colaborador_destino_email,
              COALESCE(ts.metadados->>'destino_equipe', '')            AS destino_equipe,
              COALESCE(ts.metadados->>'solicitante_email', '')         AS solicitante_email
         FROM app_comissionamento.tickets_movimentacao_lead tml
         LEFT JOIN app_comissionamento.tickets_suporte ts ON ts.id_ticket = tml.ticket_id
        WHERE tml.id_ticket_movimentacao = ANY($1::bigint[])`,
      [ids],
    );
    await client.query('COMMIT');
    return enriched.rows;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

// [NOVO] Link clicável do caso (card localizado/criado; sem card, o contato).
// Lido pelas abas Histórico, Visão SalesOps e Visão Coordenador.
function linkDoCaso(movement, resultado) {
  const h = resultado?.hubspot || {};
  if (h.link) return h.link;
  const parcial = h.resultado_parcial || {};
  if (parcial.link) return parcial.link;
  const dealId = h.dealId || parcial.createdDealId || parcial.dealId ||
    (movement.crm_origem === 'HUBSPOT_LINK' ? movement.crm_lead_id : null);
  if (dealId) return hubspotModule.hubspotRecordLink('deals', dealId);
  const contactId = h.contactId || h.contato_id || parcial.contactId;
  return contactId ? hubspotModule.hubspotRecordLink('contacts', contactId) : null;
}

// [CORRIGIDO] Nota exibida quando o coordenador autorizou o reprocessamento.
function notaCoordenador(meta) {
  const v = meta?.validacaoCoordenador;
  if (v?.acao === 'autorizar') {
    const quem = v.nome || v.usuario || 'nome não informado';
    return `Validado pelo coordenador (${quem})${v.observacao ? `: ${v.observacao}` : ''}`;
  }
  const b = meta?.bypass_regra_temporal;
  if (b) {
    return `Validado pelo coordenador (${b.autorizado_por || 'nome não informado'})${b.observacao ? `: ${b.observacao}` : ''}`;
  }
  return '';
}

// [CORRIGIDO] Texto de retorno do sistema que vai em `observacao`
// (é o campo lido pelas abas Histórico, Visão SalesOps e Visão Coordenador).
function montarObservacaoSistema(novoStatus, resultado, meta) {
  const base = novoStatus === 'concluido'
    ? (resultado?.hubspot?.message || resultado?.hubspot?.mensagem || 'Movimentação concluída.')
    : (resultado?.erro || resultado?.hubspot?.message || 'Movimentação não concluída.');
  return [base, notaCoordenador(meta)].filter(Boolean).join('\n');
}

async function finalizar(movementId, ticketId, novoStatus, metadataExtra = {}, erro = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const metaAtual = await client.query(
      `SELECT observacao_sales_ops
         FROM app_comissionamento.tickets_movimentacao_lead
        WHERE id_ticket_movimentacao = $1
        FOR UPDATE`,
      [movementId],
    );
    if (metaAtual.rowCount === 0) {
      await client.query('COMMIT');
      return null;
    }
    const baseMeta = parseJson(metaAtual.rows[0].observacao_sales_ops);
    const tentativas = Number(baseMeta?._worker?.tentativas || 0);
    // [CORRIGIDO] `observacao` passa a ser SEMPRE o retorno do sistema.
    // O texto original digitado pelo solicitante fica preservado em
    // `observacao_solicitante` (gravado só na primeira vez).
    const { observacaoSistema, ...extrasSemObservacao } = metadataExtra;
    const observacaoSolicitante = Object.hasOwn(baseMeta || {}, 'observacao_solicitante')
      ? baseMeta.observacao_solicitante
      : (typeof baseMeta?.observacao === 'string' ? baseMeta.observacao : null);
    const novoMeta = {
      ...baseMeta,
      ...extrasSemObservacao,
      ...(observacaoSistema
        ? { observacao: observacaoSistema, observacao_solicitante: observacaoSolicitante }
        : {}),
      processado: novoStatus === 'concluido',
      _worker: {
        processando_desde: null,
        tentativas,
        erro_lease: null,
        ultima_falha_em: erro
          ? new Date().toISOString()
          : baseMeta?._worker?.ultima_falha_em || null,
        worker_id: WORKER_ID,
        ultimo_status: novoStatus,
        ...(erro ? { ultimo_erro: String(erro).slice(0, 1000) } : {}),
      },
    };
    if (novoStatus === 'concluido') {
      novoMeta._worker.concluido_em = new Date().toISOString();
    }
    // [NOVO] Nunca perde um link já conhecido do caso.
    if (!novoMeta.link && baseMeta?.link) novoMeta.link = baseMeta.link;
    await client.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
          SET status_mapeamento = $2,
              observacao_sales_ops = $3,
              atualizado_em = NOW()
        WHERE id_ticket_movimentacao = $1`,
      [movementId, novoStatus, JSON.stringify(novoMeta)],
    );
    await client.query(
      `UPDATE app_comissionamento.tickets_suporte
          SET status = CASE
                         WHEN $2 = 'concluido'   THEN 'Concluído'
                         WHEN $2 = 'erro'        THEN 'Erro'
                         WHEN $2 = 'suporte'     THEN 'Aguardando Suporte'
                         WHEN $2 = 'aviso'       THEN 'Aviso'
                         WHEN $2 = 'coordenador' THEN 'Coordenador'
                         WHEN $2 = 'bloqueado'   THEN 'Bloqueado'
                         ELSE status
                       END,
              concluido_em = CASE WHEN $2 = 'concluido' THEN NOW() ELSE NULL END,
              atualizado_em = NOW()
        WHERE id_ticket = $1`,
      [ticketId, novoStatus],
    );
    await client.query('COMMIT');
    return novoMeta;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    log('error', `finalizar(${movementId}) falhou:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

// ────────────────────────────────────────────────────────────────────
// Processamento de UM ticket
// ────────────────────────────────────────────────────────────────────
async function processar(movement) {
  const movementId = movement.id_ticket_movimentacao;
  const ticketId = movement.ticket_id;
  const metadata = parseJson(movement.observacao_sales_ops);
  const tentativas = Number(metadata?._worker?.tentativas || 1);

  log('info', `processando #${movementId} (ticket ${ticketId}, ${movement.crm_origem}) tentativa ${tentativas}`);

  if (tentativas > MAX_TENTATIVAS) {
    log('warn', `#${movementId} excedeu ${MAX_TENTATIVAS} tentativas — 'suporte'`);
    await finalizar(movementId, ticketId, 'suporte', {
      erro_motivo: `Excedeu ${MAX_TENTATIVAS} tentativas de processamento`,
      observacaoSistema: `Excedeu ${MAX_TENTATIVAS} tentativas de processamento — encaminhado ao suporte.`,
    }, 'max_tentativas_excedido');
    stats.suportes += 1;
    return;
  }

  const produto = metadata?.produto || null;
  const bypassRegraTemporal = Boolean(metadata?.bypass_regra_temporal);

  let resultado;
  try {
    resultado = await withTimeout(
      moverLeadHubSpot({ movement, metadata, produto, bypassRegraTemporal }),
      HUBSPOT_TIMEOUT_MS,
      `moverLeadHubSpot(#${movementId})`,
    );
  } catch (err) {
  log('error', `#${movementId} timeout/exceção:`, err.message);
  await finalizar(movementId, ticketId, 'erro', {
    hubspot: { erro: String(err.message || err).slice(0, 1000), em: new Date().toISOString() },
    link: linkDoCaso(movement, null),
    observacaoSistema: `Erro ao processar: ${String(err.message || err).slice(0, 1000)}`,
  }, err.message);
  stats.erros += 1;
  await notificarSolicitante(ticketId, movementId, 'erro', err.message, {
    movement, resultado: null,
  });
  return;
}

  if (resultado?.ok) {
    await finalizar(movementId, ticketId, 'concluido', {
      // `mensagem` (pt) espelha `message` para a UI, que lê hubspot.mensagem.
      hubspot: { ...(resultado.hubspot || {}), mensagem: resultado.hubspot?.message || resultado.hubspot?.mensagem || null },
      observacaoSistema: montarObservacaoSistema('concluido', resultado, metadata),
      link: linkDoCaso(movement, resultado),
      dealId: resultado.hubspot?.dealId || null,
    });
    stats.concluidos += 1;
    log('info', `#${movementId} → 'concluido'`);
    notificarSolicitante(ticketId, movementId, 'concluido', null);
    return;
  }

  const status = resultado?.status || 'erro';
  const extras = {
    hubspot: { ...(resultado?.hubspot || {}), mensagem: resultado?.erro || resultado?.hubspot?.message || null },
    erro_motivo: resultado?.erro || null,
    observacaoSistema: montarObservacaoSistema(status, resultado, metadata),
    link: linkDoCaso(movement, resultado),
    ...(resultado?.hubspot?.dealId ? { dealId: resultado.hubspot.dealId } : {}),
    ...(resultado?.requiresCoordinator ? { requiresCoordinator: true } : {}),
  };
  await finalizar(movementId, ticketId, status, extras, resultado?.erro);

  switch (status) {
    case 'coordenador': stats.coordenador += 1; break;
    case 'bloqueado':   stats.bloqueados += 1;   break;
    case 'suporte':     stats.suportes += 1;     break;
    case 'aviso':       stats.avisos += 1;       break;
    default:            stats.erros += 1;
  }
  log(status === 'erro' ? 'error' : 'warn', `#${movementId} → '${status}' (${resultado?.erro || 'sem detalhe'})`);
  await notificarSolicitante(ticketId, movementId, status, resultado?.erro, {
  movement,
  resultado,
});
}

async function notificarSolicitante(ticketId, movementId, status, erro, ctx = {}) {
  const { movement = {}, resultado = null } = ctx;

  // 1) SSE — mantém o que já funciona
  try {
    const r = await pool.query(
      `SELECT titulo, metadados->>'solicitante_email' AS email,
              metadados
         FROM app_comissionamento.tickets_suporte
        WHERE id_ticket = $1`,
      [ticketId],
    );
    if (!r.rowCount) return;
    const row = r.rows[0];
    const meta = parseJson(row.metadados);

    if (row.email) {
      const mensagens = {
        concluido: 'sua solicitação foi concluída com sucesso.',
        aviso:     `sua solicitação precisa de atenção: ${erro || 'dado faltante'}.`,
        erro:      `sua solicitação encontrou um erro: ${erro || 'não classificado'}.`,
        suporte:   'sua solicitação foi encaminhada ao suporte.',
        bloqueado: 'sua solicitação foi bloqueada — precisa de revisão manual.',
        coordenador: 'sua solicitação aguarda validação do coordenador.',
      };
      const msg = mensagens[status];
      if (msg) {
        Promise.resolve(broadcastNotification({
          tipo: status === 'concluido' ? 'success' : 'warn',
          titulo: `Movimentação #${movementId}`,
          destinatario: row.email,
          mensagem: `Sobre "${row.titulo}": ${msg}`,
          data: new Date().toISOString(),
        })).catch((err) => log('error', 'broadcastNotification falhou:', err.message));
      }
    }

    // 2) Teams — só para status que pedem ação de suporte
    const STATUS_TEAMS = new Set(['suporte', 'bloqueado', 'coordenador', 'aviso']);
    if (!STATUS_TEAMS.has(status)) return;

    // Unidade 1-5 é obrigatória quando o destino é o webhook de coordenador
    const unidadeId = Number(meta?.unidade_id ?? meta?.unidadeId) || null;
    const viraCoordenador =
      status === 'coordenador' ||
      (status === 'bloqueado' && unidadeId != null && unidadeId >= 1 && unidadeId <= 5);

    // Se 'coordenador' exigido mas sem unidade → cai para 'suporte' (não exige unidade)
    if (status === 'coordenador' && !viraCoordenador) {
      log('warn', `#${movementId} coordenador sem unidade — enviando como 'suporte'`);
    }

    const statusPayload = viraCoordenador ? 'coordenador' : 'suporte';
    const assunto = statusPayload === 'coordenador'
      ? `Validacao_unidade_${unidadeId}`
      : 'Movimentacao';

    const descricao =
      `Ticket ${movementId} (origem ${movement.crm_origem || 'CRM'}) ` +
      `terminou como "${status}". Motivo: ${erro || resultado?.erro || 'não informado'}.`;

    const r2 = await teamsNotificador.enviar({
      titulo: `Movimentação #${movementId} — ${status.toUpperCase()}`,
      assunto,
      descricao,
      solicitante: meta.solicitante_nome || row.email || 'N/A',
      solicitanteEmail: row.email || null,
      equipe: meta.origem_equipe || meta.equipe || 'N/A',
      cliente: movement.nome_cliente_informado || meta.cliente || 'N/A',
      telefone: movement.telefone_cliente_informado || meta.telefone || null,
      equipeDestino: meta.destino_equipe || movement.colaborador_destino_nome || 'N/A',
      assessorDestino: movement.colaborador_destino_nome || meta.assessor_destino || 'N/A',
      status: statusPayload,
      unidadeId: viraCoordenador ? unidadeId : (unidadeId ?? null),
      idTicketMovimentacao: movementId,
      idTicket: ticketId,
      mensagem: erro || resultado?.erro || null,
      pipeline: meta.pipelineNome || meta.pipeline || null,
      stage: meta.stageNome || meta.stage || null,
      produto: meta.produto || null,
      link: resultado?.hubspot?.link || movement?.link || null,
      dealId: movement.crm_lead_id || null,
    });

    if (!r2.success) {
      log('error', `#${movementId} Teams falhou:`, r2.error);
    } else {
      log('info', `#${movementId} Teams OK (canal=${r2.channel}, assunto=${r2.assunto})`);
    }
  } catch (err) {
    log('error', 'notificarSolicitante falhou:', err.message);
  }
}

// ────────────────────────────────────────────────────────────────────
// Ciclo principal
// ────────────────────────────────────────────────────────────────────
async function ciclo() {
  if (!running) return;
  stats.ciclos += 1;
  stats.ultimo_ciclo_em = new Date().toISOString();
  if (_modoDegradado) return;

  try {
    await resetOrfaos();
    const lote = await claimLote(BATCH_SIZE);
    if (lote.length === 0) return;
    stats.claims += lote.length;
    log('info', `claim de ${lote.length} ticket(s)`);
    await Promise.allSettled(lote.map(async m => {
      inFlight += 1;
      try { await processar(m); }
      finally { inFlight -= 1; }
    }));
  } catch (err) {
    stats.ultimo_erro = { em: new Date().toISOString(), msg: err.message };
    log('error', 'ciclo falhou:', err.message);
  }
}

function scheduleProximo() {
  if (!running) return;
  loopHandle = setTimeout(async () => {
    await ciclo();
    scheduleProximo();
  }, POLL_INTERVAL_MS);
}

// ────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────
export async function start() {
  if (running) { log('warn', 'start() ignorado — já rodando'); return; }
  running = true;

  if (_modoDegradado) {
    log('error', '⚠️  MODO DEGRADADO:', _motivoDegradado);
    log('error', '   O worker não processará tickets até as funções serem resolvidas.');
  } else {
    log('info', 'iniciando worker', {
      funcoes: FUNCOES_OBRIGATORIAS,
      POLL_INTERVAL_MS, BATCH_SIZE, STALE_PROCESSANDO_MS, MAX_TENTATIVAS,
    });
  }

  await resetOrfaos();
  await ciclo();
  scheduleProximo();
}

export async function stop({ timeoutMs = 15_000 } = {}) {
  if (!running) return;
  log('info', 'parando worker...');
  running = false;
  if (loopHandle) { clearTimeout(loopHandle); loopHandle = null; }
  const inicio = Date.now();
  while (inFlight > 0 && (Date.now() - inicio) < timeoutMs) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (inFlight > 0) log('warn', `${inFlight} em andamento após ${timeoutMs}ms — abandonando`);
  log('info', 'worker parado', { inFlight });
}

export function status() {
  return {
    worker_id: WORKER_ID,
    running,
    inFlight,
    modo_degradado: _modoDegradado,
    motivo_degradado: _motivoDegradado,
    funcoes_obrigatorias: FUNCOES_OBRIGATORIAS,
    funcoes_ok: !_modoDegradado,
    exports_hubspot: Object.keys(hubspotModule || {}).sort(),
    config: { POLL_INTERVAL_MS, BATCH_SIZE, STALE_PROCESSANDO_MS, MAX_TENTATIVAS, HUBSPOT_TIMEOUT_MS },
    stats,
  };
}

let _bootstrapped = false;
export function bootstrap() {
  if (_bootstrapped) return;
  _bootstrapped = true;

  const onSignal = async signal => {
    log('info', `sinal ${signal} recebido`);
    try { await stop({ timeoutMs: 10_000 }); }
    catch (e) { log('error', 'stop falhou:', e.message); }
    process.exit(0);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT',  () => onSignal('SIGINT'));
  process.on('unhandledRejection', reason => log('error', 'unhandledRejection:', reason));
  process.on('uncaughtException',  err    => log('error', 'uncaughtException:', err));

  start().catch(err => log('error', 'start() falhou:', err));
}

// ── COMPATIBILIDADE COM server.js ───────────────────────────────────
// server.js importa `startTicketQueue` (nome antigo). O worker
// unificado exporta `start` / `bootstrap`. Este alias mantém o contrato
// sem exigir alteração do server.js.
export const startTicketQueue = start;

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrap();
}