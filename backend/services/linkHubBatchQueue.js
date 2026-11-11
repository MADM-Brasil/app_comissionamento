// backend/services/linkHubBatchQueue.js

import { pool } from './db.js';
import {
  findOwnerIdByEmailStrict,
  getDealMovementContext,
  getHubSpotOwnerEmail,
  reassignDealForLinkHubMovement,
  HUBSPOT_PIPELINE_CLOSER_ID,
  HUBSPOT_PIPELINE_QUINQUENIO_ID,
  HUBSPOT_PIPELINE_ISENCAO_IR_ID,   
} from './hubspot.js';
import { getActiveSupportUser, validateHubSpotMovementAccess } from './access-control.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';

const LOCK_KEY = 854730;
const MAX_ATTEMPTS = 3;
const PROCESSING_LEASE_MINUTES = 15;
let isProcessing = false;

const RULE_LABELS = Object.freeze({
  moved_from_base_leads:
    'Card movido da Base de Leads para o destino, motivo da perda limpo.',
  reassigned_in_closer:
    'Responsável alterado no Closer, pipeline e etapa preservados.',
  reassigned_in_quinquenio:
    'Card posicionado em Quinquenio/concomitante (Em contato).',
  // [ISENÇÃO IR]
  reassigned_in_isencao_ir:
    'Card posicionado em Isenção de IR Aposentadoria (Em Contato).',
});

// ALTERADO: de ['erro', 'bloqueado'] para ['suporte', 'bloqueado']
const NOTIFY_STATUSES = new Set(['suporte', 'bloqueado']);

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
    'sem proprietário', 'sem proprietario',
    'não existe como colaborador', 'nao existe como colaborador',
  ].some(fragment => normalizedMessage.includes(fragment));
}

function safeParse(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

async function requesterUnitId(client, metadata) {
  const storedUnit = Number(metadata?.unidade_id ?? metadata?.unidadeId);
  if (Number.isInteger(storedUnit) && storedUnit >= 1 && storedUnit <= 5) return storedUnit;
  const requesterEmail = String(metadata?.solicitante_email || '').trim();
  if (!requesterEmail) return null;

  try {
    const result = await client.query(
      `SELECT unidade_id
         FROM core.view_app_colaboradores
        WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
        LIMIT 1`,
      [requesterEmail]
    );
    const unit = Number(result.rows[0]?.unidade_id);
    return Number.isInteger(unit) && unit >= 1 && unit <= 5 ? unit : null;
  } catch (error) {
    console.error('[linkHubBatchQueue] Falha ao consultar unidade do solicitante:', error.message);
    return null;
  }
}

function describeFailure(error, attempts) {
  const parts = [];
  parts.push(error.message || 'Falha na movimentação Link Hub.');
  if (Number.isFinite(attempts) && attempts > 0) {
    parts.push(`Tentativas: ${attempts}/${MAX_ATTEMPTS}.`);
  }
  const partial = error.partialResult;
  if (partial?.previousPipeline) parts.push(`Pipeline de origem: ${partial.previousPipeline}.`);
  if (partial?.previousStage) parts.push(`Etapa de origem: ${partial.previousStage}.`);
  if (error.blocked) parts.push('Bloqueio definitivo — requer revisão manual.');
  return parts.filter(Boolean).join(' ');
}

function resolveRuleLabel(resultData) {
  const pipelineFinal = String(resultData?.pipeline || '');
  if (pipelineFinal === String(HUBSPOT_PIPELINE_QUINQUENIO_ID)) {
    return { regra: 'reassigned_in_quinquenio', mensagem: RULE_LABELS.reassigned_in_quinquenio };
  }
  // [ISENÇÃO IR] Pipeline dedicado da Equipe Leticia Mathias.
  if (pipelineFinal === String(HUBSPOT_PIPELINE_ISENCAO_IR_ID)) {
    return { regra: 'reassigned_in_isencao_ir', mensagem: RULE_LABELS.reassigned_in_isencao_ir };
  }
  if (Boolean(resultData?.movedFromBaseLeads)) {
    return { regra: 'moved_from_base_leads', mensagem: RULE_LABELS.moved_from_base_leads };
  }
  return { regra: 'reassigned_in_closer', mensagem: RULE_LABELS.reassigned_in_closer };
}

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

async function markSuccess(client, ticket, resultData) {
  const observacao = safeParse(ticket.observacao_sales_ops);
  const { regra, mensagem } = resolveRuleLabel(resultData);
  const movedFromBase = Boolean(resultData.movedFromBaseLeads);
  const agora = new Date().toISOString();
  const validation = observacao.validacaoCoordenador;
  const coordinatorNote = validation?.acao === 'autorizar'
    ? `Validado pelo coordenador (${validation.nome || validation.usuario || 'nome não informado'})`
    : '';

  const nova = {
    ...observacao,
    processado: true,
    dealId: resultData.dealId,
    regra,
    produto: resultData.produto || observacao.produto || null,
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
      ruleApplied: regra,
      mensagem,
      produto: resultData.produto || observacao.produto || null,
    },
    motivoOriginal: ticket.motivo_solicitacao || 'Movimentação Link Hub',
    observacao: [mensagem, coordinatorNote].filter(Boolean).join('\n'),
    colaboradorDestinoNome: ticket.colaborador_destino_nome,
    validacaoFinal: true,
    _worker: {
      ...(observacao._worker || {}),
      processando_desde: null,
      concluido_em: agora,
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

async function markFailure(client, ticket, error) {
  const observacao = safeParse(ticket.observacao_sales_ops);
  const tentativas = Number(observacao._worker?.tentativas || 0);
  const retryable = isRetryableError(error) && tentativas < MAX_ATTEMPTS;
  
  // ALTERADO: de 'erro' para 'suporte'
  const statusFinal = error.blocked ? 'bloqueado' : retryable ? 'pendente' : 'suporte';
  const agora = new Date().toISOString();

  const observacaoTexto = describeFailure(error, tentativas);
  const validation = observacao.validacaoCoordenador;
  const coordinatorNote = validation?.acao === 'autorizar'
    ? `Validado pelo coordenador (${validation.nome || validation.usuario || 'nome não informado'})`
    : '';

  const nova = {
    ...observacao,
    processado: !retryable && !error.blocked ? true : observacao.processado || false,
    hubspot: {
      ...(observacao.hubspot || {}),
      erro: true,
      status: statusFinal,
      ruleApplied: null,
      mensagem: observacaoTexto,
      ...(error.partialResult ? { resultadoParcial: error.partialResult } : {}),
    },
    motivoOriginal: ticket.motivo_solicitacao || 'Movimentação Link Hub',
    observacao: [observacaoTexto, coordinatorNote].filter(Boolean).join('\n'),
    _worker: {
      ...(observacao._worker || {}),
      tentativas,
      processando_desde: null,
      ultima_falha_em: agora,
      ...(retryable ? {} : { encerrado: true }),
    },
  };

  await client.query(
    `UPDATE app_comissionamento.tickets_movimentacao_lead
     SET observacao_sales_ops = $1::text,
         status_mapeamento = $2::text,
         analisado_em = CASE WHEN $2::text IN ('suporte','bloqueado') THEN NOW() ELSE analisado_em END,
         atualizado_em = NOW()
     WHERE id_ticket_movimentacao = $3`,
    [JSON.stringify(nova), statusFinal, ticket.id_ticket_movimentacao]
  );

  // ALTERADO: de 'ERRO' para 'Aguardando Suporte'
  const supportStatus =
    statusFinal === 'bloqueado' ? 'BLOQUEADO'
    : statusFinal === 'suporte' ? 'Aguardando Suporte'
    : 'Em Andamento';

  await client.query(
    `UPDATE app_comissionamento.tickets_suporte
     SET status = $1::text, atualizado_em = NOW()
     WHERE id_ticket = $2`,
    [supportStatus, ticket.ticket_id]
  );

  if (NOTIFY_STATUSES.has(statusFinal)) {
    try {
      const meta = ticket.metadados || {};
      const partial = error.partialResult || {};
      const unidadeId = statusFinal === 'bloqueado'
        ? await requesterUnitId(client, meta)
        : (meta.unidade_id ?? meta.unidadeId ?? null);
      const notification = await teamsNotificador.enviar({
        titulo: 'Movimentação Link Hub — Falha',
        assunto: 'MovimentacaoLinkHub',
        descricao:
          `Falha ao movimentar card ${ticket.crm_lead_id || 'N/A'} | ` +
          `Status: ${statusFinal} | ` +
          `Tentativas: ${tentativas}/${MAX_ATTEMPTS}`,
        solicitante: meta.solicitante_nome || meta.solicitante_email || 'N/A',
        solicitanteEmail: meta.solicitante_email || null,
        equipe: meta.origem_equipe || 'N/A',
        anexosMarkdown: 'Nenhum anexo',
        cliente: `Deal ${ticket.crm_lead_id || 'N/A'}`,
        equipeDestino: meta.destino_equipe || 'N/A',
        assessorDestino: ticket.colaborador_destino_nome || 'N/A',
        status: statusFinal === 'bloqueado' ? 'coordenador' : statusFinal,
        unidadeId,
        idTicketMovimentacao: ticket.id_ticket_movimentacao,
        idTicket: ticket.ticket_id,
        mensagem: observacaoTexto,
        pipeline: partial.previousPipeline || null,
        stage: partial.previousStage || null,
        dealId: ticket.crm_lead_id || null,
        link: meta.link_hub || null,
        produto: observacao.produto || meta.produto || null,
      });
      if (!notification.success) {
        console.error('Falha ao enviar notificação Teams (Link Hub):', notification.error);
      }
    } catch (notifErr) {
      console.error('Erro ao enviar notificação Teams (Link Hub):', notifErr);
    }
  }
}

async function handleLinkHubTicket(ticket, client) {
  const dealId = String(ticket.crm_lead_id || '').trim();
  if (!/^\d+$/.test(dealId)) {
    const error = new Error(`Deal ID inválido no ticket ${ticket.id_ticket_movimentacao}.`);
    error.retryable = false;
    error.blocked = true;
    throw error;
  }

  const meta = ticket.metadados || {};
  const observacao = safeParse(ticket.observacao_sales_ops);
  const produto = observacao.produto || meta.produto || null;

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
  const destinationName = String(meta.destino_colaborador || ticket.colaborador_destino_nome || '').trim();
  const destinationTeam = String(meta.destino_equipe || '').trim();

  const context = await getDealMovementContext(dealId, portalId);

  const sourceOwnerEmail = context.ownerId ? await getHubSpotOwnerEmail(context.ownerId) : null;
  const sourceOwner = sourceOwnerEmail ? await getActiveSupportUser(sourceOwnerEmail) : null;

  console.log(
    '[linkHubBatchQueue] origem do card',
    JSON.stringify({
      ticketId: ticket.id_ticket_movimentacao,
      dealId,
      produto,
      dealOwnerId: context.ownerId || null,
      sourceOwnerEmail: sourceOwnerEmail || null,
      sourceOwnerNome: sourceOwner?.nome || null,
      sourceOwnerEquipe: sourceOwner?.nome_equipe || null,
      sourceOwnerUnidade: sourceOwner?.unidade_id ?? null,
      sourceOwnerStatus: sourceOwner?.status || null,
      solicitanteEmail,
      destinationTeam,
    })
  );

  if (context.ownerId && !sourceOwner) {
    const error = new Error(
      sourceOwnerEmail
        ? `O proprietário atual do card (ownerId ${context.ownerId}, e-mail ${sourceOwnerEmail}) ` +
          `não existe como colaborador(a) ativo(a) na view de colaboradores. ` +
          `Revise o cadastro ou reatribua o card manualmente antes de usar o Link Hub.`
        : `O proprietário atual do card (ownerId ${context.ownerId}) não tem e-mail ` +
          `resolvido no HubSpot. Revise o cadastro do owner ou reatribua o card manualmente.`
    );
    error.retryable = false;
    error.blocked = true;
    throw error;
  }

  if (!context.ownerId) {
    const error = new Error(
      `O card não possui proprietário no HubSpot (hubspot_owner_id vazio). ` +
      `Atribua um proprietário antes de movimentar por Link Hub.`
    );
    error.retryable = false;
    error.blocked = true;
    throw error;
  }

  const access = await validateHubSpotMovementAccess({
    requesterEmail: solicitanteEmail,
    destinationName,
    destinationEmail: destinationEmail || undefined,
    destinationTeam,
    sourceTeam: sourceOwner?.nome_equipe || null,
    sourceUnitId: sourceOwner?.unidade_id ?? null,  
    enforceSourceTeam: true,
    enforceDestinationSameTeam: true,
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
    context,
    produto,
  );

  return {
    ...assignment,
    ownerDestinoId: ownerId,
    produto,
    sucesso: true,
  };
}

async function processLinkHubQueue() {
  if (isProcessing) return;
  isProcessing = true;

  let client = null;
  let hasLock = false;

  try {
    client = await pool.connect();

    const lockResult = await client.query('SELECT pg_try_advisory_lock($1)', [LOCK_KEY]);
    hasLock = lockResult.rows[0].pg_try_advisory_lock === true;
    if (!hasLock) return;

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
            persistError?.message || persistError
          );
        }
      }
    }
  } catch (error) {
    console.error('[linkHubBatchQueue] ciclo interrompido:', error?.message || error);
  } finally {
    if (client && hasLock) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      } catch (unlockErr) {
        console.error(
          '[linkHubBatchQueue] falha ao liberar advisory lock:',
          unlockErr?.message || unlockErr
        );
      }
    }
    if (client) {
      try {
        client.release();
      } catch (releaseErr) {
        console.warn(
          '[linkHubBatchQueue] release falhou (conexão já encerrada):',
          releaseErr?.message || releaseErr
        );
      }
    }
    isProcessing = false;
  }
}

export function startLinkHubBatchQueue(intervalMs = 5000) {
  const safeRun = () => {
    processLinkHubQueue().catch((err) => {
      console.error(
        '[linkHubBatchQueue] falha não tratada no ciclo:',
        err?.stack || err?.message || err
      );
    });
  };

  const timer = setInterval(safeRun, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log('🔄 Fila de lotes Link Hub iniciada');
  return timer;
}