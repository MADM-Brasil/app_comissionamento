// backend/services/linkHubBatchQueue.js
// Worker do fluxo de Movimentação por Link Hub.
// Opera sobre a MESMA tabela app_comissionamento.tickets_movimentacao_lead,
// filtrando por crm_origem = 'HUBSPOT_LINK'.
// Regra aplicada no HubSpot (via reassignDealForLinkHubMovement):
//   - Base de Leads → move para Closer (Em Contato), limpa motivo_da_perda;
//   - Closer → apenas troca o proprietário, preserva pipeline/etapa.
// O estado de tentativas/lease é mantido dentro do JSON observacao_sales_ops
// na chave "_worker", para não exigir novas colunas na tabela.
import { pool } from './db.js';
import {
  findOwnerIdByEmailStrict,
  getDealMovementContext,
  getHubSpotOwnerEmail,
  reassignDealForLinkHubMovement,
} from './hubspot.js';
import { getActiveSupportUser, validateHubSpotMovementAccess } from './supportAccess.js';

const LOCK_KEY = 854730;
const MAX_ATTEMPTS = 3;
const PROCESSING_LEASE_MINUTES = 15;
let isProcessing = false;

function getRetryDelayMinutes(attempt) {
  return Math.min(15, 2 ** Math.max(1, attempt));
}

function isRetryableError(error) {
  if (error.retryable === false) return false;
  const message = String(error.message || '');
  const messageStatus = message.match(/\((\d{3})\)/)?.[1];
  const status = Number(
    error.httpStatus || error.status || error.response?.status || messageStatus || error.code
  );
  if (status) return status === 429 || status >= 500;
  const normalizedMessage = message.toLowerCase();
  return ![
    'não encontrado', 'nao encontrado', 'não permitida', 'nao permitida',
    'inválido', 'invalido', 'outra conta', 'mudou desde', 'mudou após',
    'sem acesso', 'própria equipe', 'propria equipe', 'somente supervisores',
    'não corresponde', 'nao corresponde', 'portal hubspot', 'permitida somente',
    'múltiplos contatos', 'multiplos contatos',
  ].some(fragment => normalizedMessage.includes(fragment));
}

function safeParse(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Recupera tickets presos em 'processando' cujo lease expirou.
 * Se ainda houver tentativas disponíveis, volta para 'pendente';
 * caso contrário, marca como 'erro'.
 * Executado no início de cada ciclo, antes de reivindicar novos tickets.
 */
async function reclaimStaleLeases(client) {
  await client.query(
    `UPDATE app_comissionamento.tickets_movimentacao_lead
     SET status_mapeamento = CASE
           WHEN COALESCE((observacao_sales_ops::jsonb #>> '{_worker,tentativas}')::int, 0) >= $2
             THEN 'erro'
           ELSE 'pendente'
         END,
         observacao_sales_ops = jsonb_set(
           jsonb_set(
             COALESCE(observacao_sales_ops::jsonb, '{}'::jsonb),
             '{_worker,processando_desde}',
             'null'::jsonb,
             true
           ),
           '{_worker,erro_lease}',
           CASE
             WHEN COALESCE((observacao_sales_ops::jsonb #>> '{_worker,tentativas}')::int, 0) >= $2
               THEN to_jsonb('Lease expirado após limite de tentativas.'::text)
             ELSE 'null'::jsonb
           END,
           true
         )::text,
         atualizado_em = NOW()
     WHERE crm_origem = 'HUBSPOT_LINK'
       AND status_mapeamento = 'processando'
       AND COALESCE(
             (observacao_sales_ops::jsonb #>> '{_worker,processando_desde}')::timestamptz,
             '1970-01-01'::timestamptz
           ) < NOW() - ($1 * INTERVAL '1 minute')`,
    [PROCESSING_LEASE_MINUTES, MAX_ATTEMPTS]
  );
}

/**
 * Reivindica o próximo ticket da fila de forma atômica.
 * - Marca como 'processando'
 * - Incrementa _worker.tentativas
 * - Grava _worker.processando_desde
 * Retorna a linha completa com metadados, ou null se a fila estiver vazia.
 */
async function claimNextTicket(client) {
  const claimed = await client.query(
    `UPDATE app_comissionamento.tickets_movimentacao_lead
     SET status_mapeamento = 'processando',
         observacao_sales_ops = jsonb_set(
           jsonb_set(
             COALESCE(observacao_sales_ops::jsonb, '{}'::jsonb),
             '{_worker,processando_desde}',
             to_jsonb(NOW()::text),
             true
           ),
           '{_worker,tentativas}',
           to_jsonb(
             COALESCE((observacao_sales_ops::jsonb #>> '{_worker,tentativas}')::int, 0) + 1
           ),
           true
         )::text,
         atualizado_em = NOW()
     WHERE id_ticket_movimentacao = (
       SELECT tml.id_ticket_movimentacao
       FROM app_comissionamento.tickets_movimentacao_lead tml
       WHERE tml.crm_origem = 'HUBSPOT_LINK'
         AND (tml.status_mapeamento IS NULL
              OR tml.status_mapeamento = ''
              OR tml.status_mapeamento = 'pendente')
       ORDER BY tml.id_ticket_movimentacao
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id_ticket_movimentacao, ticket_id, crm_lead_id,
               colaborador_destino_nome, motivo_solicitacao, observacao_sales_ops`
  );

  if (claimed.rowCount === 0) return null;

  const base = claimed.rows[0];
  const full = await client.query(
    `SELECT tml.*, ts.metadados
     FROM app_comissionamento.tickets_movimentacao_lead tml
     JOIN app_comissionamento.tickets_suporte ts ON ts.id_ticket = tml.ticket_id
     WHERE tml.id_ticket_movimentacao = $1`,
    [base.id_ticket_movimentacao]
  );
  return full.rows[0];
}

/**
 * Persiste o sucesso da movimentação, diferenciando o caso Base → Closer
 * do caso apenas troca de proprietário no Closer.
 */
async function markSuccess(client, ticket, resultData) {
  const observacao = safeParse(ticket.observacao_sales_ops);
  const movedFromBase = Boolean(resultData.movedFromBaseLeads);

  const nova = {
    ...observacao,
    processado: true,
    dealId: resultData.dealId,
    hubspot: {
      status: 'concluido',
      dealId: resultData.dealId,
      dealName: resultData.dealName || null,
      pipeline: resultData.pipeline || null,
      stage: resultData.stage || null,
      movedFromBaseLeads: movedFromBase,
      previousDealOwnerId: resultData.previousDealOwnerId || null,
      previousPipeline: resultData.previousPipeline || null,
      previousStage: resultData.previousStage || null,
      contactIds: resultData.contactIds || [],
      lastUpdatedAt: resultData.lastUpdatedAt || null,
      ownerDestinoId: resultData.ownerDestinoId || null,
      mensagem: movedFromBase
        ? 'Movimentação Link Hub concluída (Base de Leads → Closer).'
        : 'Movimentação Link Hub concluída (troca de responsável no Closer).',
    },
    motivoOriginal: ticket.motivo_solicitacao || 'Movimentação Link Hub',
    observacao: movedFromBase
      ? 'Card movido da Base de Leads para o Closer com motivo da perda limpo.'
      : 'Responsável alterado no Closer, etapa preservada.',
    colaboradorDestinoNome: ticket.colaborador_destino_nome,
    validacaoFinal: true,
    _worker: {
      ...(observacao._worker || {}),
      processando_desde: null,
      concluido_em: new Date().toISOString(),
    },
  };

  await client.query(
    `UPDATE app_comissionamento.tickets_movimentacao_lead
     SET observacao_sales_ops = $1,
         status_mapeamento = 'concluido',
         analisado_em = NOW(),
         atualizado_em = NOW()
     WHERE id_ticket_movimentacao = $2`,
    [JSON.stringify(nova), ticket.id_ticket_movimentacao]
  );
  await client.query(
    `UPDATE app_comissionamento.tickets_suporte
     SET status = 'Concluído', concluido_em = NOW(), atualizado_em = NOW()
     WHERE id_ticket = $1`,
    [ticket.ticket_id]
  );
}

/**
 * Persiste a falha, decidindo entre retry ('pendente') ou encerramento ('erro' / 'bloqueado').
 */
async function markFailure(client, ticket, error) {
  const observacao = safeParse(ticket.observacao_sales_ops);
  const tentativas = Number(observacao._worker?.tentativas || 0);
  const retryable = isRetryableError(error) && tentativas < MAX_ATTEMPTS;
  const statusFinal = error.blocked ? 'bloqueado' : retryable ? 'pendente' : 'erro';

  const nova = {
    ...observacao,
    processado: !retryable && !error.blocked ? true : observacao.processado || false,
    hubspot: {
      ...(observacao.hubspot || {}),
      erro: true,
      status: statusFinal,
      mensagem: error.message || 'Falha na movimentação Link Hub.',
      ...(error.partialResult ? { resultadoParcial: error.partialResult } : {}),
    },
    motivoOriginal: ticket.motivo_solicitacao || 'Movimentação Link Hub',
    observacao: error.message || 'Falha na movimentação Link Hub.',
    _worker: {
      ...(observacao._worker || {}),
      tentativas,
      processando_desde: null,
      ultima_falha_em: new Date().toISOString(),
      ...(retryable ? {} : { encerrado: true }),
    },
  };

  await client.query(
    `UPDATE app_comissionamento.tickets_movimentacao_lead
     SET observacao_sales_ops = $1,
         status_mapeamento = $2,
         analisado_em = CASE WHEN $2 IN ('erro','bloqueado') THEN NOW() ELSE analisado_em END,
         atualizado_em = NOW()
     WHERE id_ticket_movimentacao = $3`,
    [JSON.stringify(nova), statusFinal, ticket.id_ticket_movimentacao]
  );

  const supportStatus =
    statusFinal === 'bloqueado' ? 'BLOQUEADO'
    : statusFinal === 'erro' ? 'ERRO'
    : 'Em Andamento';

  await client.query(
    `UPDATE app_comissionamento.tickets_suporte
     SET status = $1, atualizado_em = NOW()
     WHERE id_ticket = $2`,
    [supportStatus, ticket.ticket_id]
  );
}

/**
 * Executa a movimentação em si para um ticket já reivindicado.
 * Revalida contexto, acesso, e chama reassignDealForLinkHubMovement,
 * que decide entre "Base → Closer" e "troca de owner no Closer".
 */
async function handleLinkHubTicket(ticket, client) {
  const dealId = String(ticket.crm_lead_id || '').trim();
  if (!/^\d+$/.test(dealId)) {
    const error = new Error(`Deal ID inválido no ticket ${ticket.id_ticket_movimentacao}.`);
    error.retryable = false;
    error.blocked = true;
    throw error;
  }

  const meta = ticket.metadados || {};
  const portalId = String(meta.portal_id || '').trim();
  if (!/^\d+$/.test(portalId)) {
    const error = new Error('Portal ID do HubSpot ausente ou inválido.');
    error.retryable = false;
    error.blocked = true;
    throw error;
  }

  const solicitanteEmail = String(meta.solicitante_email || '').trim();
  if (!solicitanteEmail) {
    const error = new Error('E-mail do solicitante ausente nos metadados do ticket.');
    error.retryable = false;
    error.blocked = true;
    throw error;
  }

  const destinationEmail = String(meta.colaborador_destino_email || '').trim();
  const destinationName = String(
    meta.destino_colaborador || ticket.colaborador_destino_nome || ''
  ).trim();
  const destinationTeam = String(meta.destino_equipe || '').trim();

  // Revalida o contexto atual do card antes de qualquer escrita.
  const context = await getDealMovementContext(dealId, portalId);

  // Descobre a equipe de origem a partir do owner atual do card.
  const sourceOwnerEmail = context.ownerId ? await getHubSpotOwnerEmail(context.ownerId) : null;
  const sourceOwner = sourceOwnerEmail ? await getActiveSupportUser(sourceOwnerEmail) : null;

  const access = await validateHubSpotMovementAccess({
    requesterEmail: solicitanteEmail,
    destinationName,
    destinationEmail: destinationEmail || undefined,
    destinationTeam,
    sourceTeam: sourceOwner?.nome_equipe || null,
    enforceSourceTeam: true,
  });
  if (access.error) {
    const error = new Error(access.error);
    error.retryable = false;
    error.blocked = true;
    throw error;
  }

  const ownerId = await findOwnerIdByEmailStrict(access.destination.email);
  if (!ownerId) {
    const error = new Error(`Owner HubSpot não encontrado para ${access.destination.email}.`);
    error.retryable = false;
    error.blocked = true;
    throw error;
  }
  
  const assignment = await reassignDealForLinkHubMovement(
    dealId,
    ownerId,
    portalId,
    context
  );

  return {
    ...assignment,
    ownerDestinoId: ownerId,
    sucesso: true,
  };
}

async function processLinkHubQueue() {
  if (isProcessing) return;
  const client = await pool.connect();
  let hasLock = false;

  try {
    const lockResult = await client.query('SELECT pg_try_advisory_lock($1)', [LOCK_KEY]);
    hasLock = lockResult.rows[0].pg_try_advisory_lock === true;
    if (!hasLock) return;
    isProcessing = true;

    // Recupera leases expirados antes de começar o loop principal.
    await reclaimStaleLeases(client);

    while (true) {
      const ticket = await claimNextTicket(client);
      if (!ticket) break;

      try {
        const resultData = await handleLinkHubTicket(ticket, client);
        await markSuccess(client, ticket, resultData);
      } catch (error) {
        try {
          await markFailure(client, ticket, error);
        } catch (persistError) {
          console.error(
            `Falha ao persistir erro do ticket Link Hub ${ticket.id_ticket_movimentacao}:`,
            persistError
          );
        }
      }
    }
  } catch (error) {
    console.error('Erro no worker Link Hub:', error);
  } finally {
    if (hasLock) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      } catch (unlockErr) {
        console.error('Erro ao liberar advisory lock Link Hub:', unlockErr);
      }
    }
    isProcessing = false;
    client.release();
  }
}

export function startLinkHubBatchQueue(intervalMs = 5000) {
  setInterval(() => { void processLinkHubQueue(); }, intervalMs);
  console.log('🔄 Fila de lotes Link Hub iniciada');
}