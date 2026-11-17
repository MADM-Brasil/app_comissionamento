// backend/services/linkHubBatchQueue.js
//
// Worker dedicado a movimentações por Link Hub (crm_origem = 'HUBSPOT_LINK').
//
// ─── RESPONSABILIDADE ──────────────────────────────────────────────
// Este worker é a AUTORIDADE do fluxo Link Hub. Ele aplica validações
// que o worker unificado (services/ticketQueue.js) NÃO tem:
//
//   • getActiveSupportUser(sourceOwnerEmail) — valida que o owner atual
//     do card é colaborador ativo.
//   • validateHubSpotMovementAccess({ enforceSourceTeam: true,
//     sourceTeam, sourceUnitId }) — bypass de permissões entre equipes.
//   • getHubSpotOwnerEmail(context.ownerId) — resolve e-mail do owner.
//   • Log detalhado de "origem do card" (owner, equipe, unidade, etc.).
//
// Por isso, o worker CRM (services/ticketQueue.js) NÃO deve processar
// tickets Link Hub. A query dele precisa filtrar `crm_origem = 'CRM'`
// — sem esse filtro, os dois workers brigam por tickets e o Link Hub
// cai no caminho simplificado, SEM as validações acima.
//
// ─── FLUXO ─────────────────────────────────────────────────────────
//   pendente → processando → concluido | suporte | bloqueado | pendente
//   (retry)                                      ↑          ↑
//   N tentativas                      falha           bloqueio
//   esgotadas → 'suporte'             terminal        definitivo
//
// ─── CONCORRÊNCIA ──────────────────────────────────────────────────
//   • pg_try_advisory_lock($LOCK_KEY) — só 1 worker ativo por vez
//     (se você rodar N réplicas, apenas uma processa em cada ciclo).
//   • FOR UPDATE SKIP LOCKED no claim — cada ticket é pego uma vez.
//   • isProcessing flag — previne ciclos sobrepostos no mesmo processo.
//
// ─── LEASE / RECUPERAÇÃO ───────────────────────────────────────────
//   • Tickets em 'processando' com lease expirado (>15min) voltam
//     para 'pendente' (ou 'suporte' se já esgotaram tentativas).
//   • MAX_ATTEMPTS=3 por padrão — evita retry infinito.
//
// ─── NOTIFICAÇÃO ───────────────────────────────────────────────────
//   • Teams: 'suporte' e 'bloqueado' disparam notificação.
//   • 'pendente' (retry) NÃO notifica — é automático.
//
// ─── MODO DE OPERAÇÃO ──────────────────────────────────────────────
//   A) Embutido no backend (server.js import dinâmico):
//        import('./services/linkHubBatchQueue.js')
//          .then(m => m.startLinkHubBatchQueue())
//          .catch(err => console.error(err.message));
//
//   B) Processo separado (RECOMENDADO em produção):
//        node backend/services/linkHubBatchQueue.js
//      Com PM2:
//        pm2 start backend/services/linkHubBatchQueue.js \
//          --name linkHubQueue --max-memory-restart 512M --time
//
//   C) Desativado (se preferir usar só o ticketQueue.js unificado —
//      mas perde as validações acima):
//        LINKHUB_ENABLED=false

import { pool } from './bd/db.js';
import {
  findOwnerIdByEmailStrict,
  getDealMovementContext,
  getHubSpotOwnerEmail,
  reassignDealForLinkHubMovement,
  hubspotRecordLink,
  HUBSPOT_PIPELINE_QUINQUENIO_ID,
  HUBSPOT_PIPELINE_ISENCAO_IR_ID,
} from './hubspot.js';
import { getActiveSupportUser, validateHubSpotMovementAccess } from './access-control.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';

// ── Configuração ────────────────────────────────────────────────────
const LOCK_KEY = 854730;
const MAX_ATTEMPTS              = Number(process.env.LINKHUB_MAX_ATTEMPTS     || 3);
const PROCESSING_LEASE_MINUTES  = Number(process.env.LINKHUB_LEASE_MINUTES    || 15);
const POLL_INTERVAL_MS          = Number(process.env.LINKHUB_POLL_MS          || 5_000);
const BATCH_SIZE                = Number(process.env.LINKHUB_BATCH            || 3);

let isProcessing = false;
let timer = null;
let running = false;

const stats = {
  iniciado_em: null,
  ciclos: 0,
  processados: 0,
  concluidos: 0,
  suportes: 0,
  bloqueados: 0,
  retentativas: 0,
  orfaos_recuperados: 0,
  ultimo_ciclo_em: null,
  ultimo_erro: null,
};

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

// Status que disparam notificação no Teams.
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
  // [NOVO] Gravações parciais exigem revisão humana obrigatória.
  if (error.requiresReconciliation) {
    parts.push('Gravação parcial no HubSpot — verifique o card manualmente antes de reprocessar.');
  }
  if (error.blocked) parts.push('Bloqueio definitivo — requer revisão manual.');
  return parts.filter(Boolean).join(' ');
}

function resolveRuleLabel(resultData) {
  const pipelineFinal = String(resultData?.pipeline || '');
  if (pipelineFinal === String(HUBSPOT_PIPELINE_QUINQUENIO_ID)) {
    return { regra: 'reassigned_in_quinquenio', mensagem: RULE_LABELS.reassigned_in_quinquenio };
  }
  // [ISENÇÃO IR]
  if (pipelineFinal === String(HUBSPOT_PIPELINE_ISENCAO_IR_ID)) {
    return { regra: 'reassigned_in_isencao_ir', mensagem: RULE_LABELS.reassigned_in_isencao_ir };
  }
  if (Boolean(resultData?.movedFromBaseLeads)) {
    return { regra: 'moved_from_base_leads', mensagem: RULE_LABELS.moved_from_base_leads };
  }
  return { regra: 'reassigned_in_closer', mensagem: RULE_LABELS.reassigned_in_closer };
}

async function reclaimStaleLeases(client) {
  // [CORRIGIDO]
  //   • 'erro' → 'suporte' (consistência com markFailure para falhas terminais)
  //   • analisado_em = NOW() quando transiciona para 'suporte'
  //   • erro_lease preenchido para rastreabilidade
  const result = await client.query(
    `UPDATE app_comissionamento.tickets_movimentacao_lead
     SET status_mapeamento = CASE
           WHEN COALESCE((observacao_sales_ops::jsonb #>> '{_worker,tentativas}')::int, 0) >= $2
             THEN 'suporte'
           ELSE 'pendente'
         END,
         analisado_em = CASE
           WHEN COALESCE((observacao_sales_ops::jsonb #>> '{_worker,tentativas}')::int, 0) >= $2
             THEN NOW()
           ELSE analisado_em
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
           ) < NOW() - ($1 * INTERVAL '1 minute')
     RETURNING id_ticket_movimentacao`,
    [PROCESSING_LEASE_MINUTES, MAX_ATTEMPTS]
  );
  if (result.rowCount > 0) {
    stats.orfaos_recuperados += result.rowCount;
    console.log(
      `[linkHubBatchQueue] reset de órfãos: ${result.rowCount} ticket(s) devolvido(s) para fila`
    );
  }
  return result.rowCount;
}

async function claimNextTicket(client) {
  // [CORRIGIDO] ORDER BY atualizado_em — evita starvation. Tickets em
  // retry têm atualizado_em recente → vão para o fim da fila, deixando
  // espaço para tickets novos. Antes usava id_ticket_movimentacao ASC,
  // que prendia retries antigos na frente da fila.
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
       ORDER BY tml.atualizado_em ASC NULLS FIRST, tml.id_ticket_movimentacao ASC
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

// [CORRIGIDO] Preserva o texto original do solicitante na 1ª vez que o
// worker sobrescreve `observacao` com o retorno do sistema.
function observacaoSolicitanteDe(meta) {
  if (Object.hasOwn(meta || {}, 'observacao_solicitante')) return meta.observacao_solicitante;
  return typeof meta?.observacao === 'string' ? meta.observacao : null;
}

function notaCoordenador(meta) {
  const v = meta?.validacaoCoordenador;
  if (v?.acao !== 'autorizar') return '';
  const quem = v.nome || v.usuario || 'nome não informado';
  return `Validado pelo coordenador (${quem})${v.observacao ? `: ${v.observacao}` : ''}`;
}

async function markSuccess(client, ticket, resultData) {
  const observacao = safeParse(ticket.observacao_sales_ops);
  const { regra, mensagem } = resolveRuleLabel(resultData);
  const movedFromBase = Boolean(resultData.movedFromBaseLeads);
  const agora = new Date().toISOString();
  const coordinatorNote = notaCoordenador(observacao);

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
    observacao_solicitante: observacaoSolicitanteDe(observacao),
    // [NOVO] Link clicável do card movimentado.
    link: resultData.link || hubspotRecordLink('deals', resultData.dealId || ticket.crm_lead_id),
    colaboradorDestinoNome: ticket.colaborador_destino_nome,
    validacaoFinal: true,
    _worker: {
      ...(observacao._worker || {}),
      processando_desde: null,
      erro_lease: null,
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

  stats.concluidos += 1;
}

async function markFailure(client, ticket, error) {
  const observacao = safeParse(ticket.observacao_sales_ops);
  const tentativas = Number(observacao._worker?.tentativas || 0);

  // [CORRIGIDO] requiresReconciliation: force 'suporte' mesmo se o
  // worker ainda tiver tentativas sobrando — gravação parcial no
  // HubSpot NÃO pode ser retentada automaticamente.
  const retryable = !error.requiresReconciliation
    && isRetryableError(error)
    && tentativas < MAX_ATTEMPTS;

  const statusFinal = error.blocked
    ? 'bloqueado'
    : retryable
      ? 'pendente'
      : 'suporte';
  const agora = new Date().toISOString();

  if (statusFinal === 'pendente') stats.retentativas += 1;
  else if (statusFinal === 'bloqueado') stats.bloqueados += 1;
  else stats.suportes += 1;

  const observacaoTexto = describeFailure(error, tentativas);
  const coordinatorNote = notaCoordenador(observacao);

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
    observacao_solicitante: observacaoSolicitanteDe(observacao),
    // [NOVO] Link do card informado no Link Hub (mesmo quando falha).
    link: error.partialResult?.link || hubspotRecordLink('deals', ticket.crm_lead_id) || observacao.link || null,
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

  const supportStatus =
    statusFinal === 'bloqueado' ? 'Bloqueado'
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
  let processedThisCycle = 0;

  try {
    client = await pool.connect();

    const lockResult = await client.query('SELECT pg_try_advisory_lock($1)', [LOCK_KEY]);
    hasLock = lockResult.rows[0].pg_try_advisory_lock === true;
    if (!hasLock) return;

    await reclaimStaleLeases(client);

    // [CORRIGIDO] batch configurável — processa N tickets por ciclo.
    // Antes era while(true), que podia segurar um ciclo por muito tempo
    // se houvesse muitos pendentes.
    while (processedThisCycle < BATCH_SIZE) {
      const ticket = await claimNextTicket(client);
      if (!ticket) break;

      processedThisCycle += 1;
      stats.processados += 1;

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
    stats.ultimo_erro = { em: new Date().toISOString(), msg: error?.message || String(error) };
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

// ────────────────────────────────────────────────────────────────────
// API pública
// ────────────────────────────────────────────────────────────────────

export function startLinkHubBatchQueue(intervalMs = POLL_INTERVAL_MS) {
  if (running) {
    console.warn('[linkHubBatchQueue] startLinkHubBatchQueue ignorado — já rodando');
    return { stop, status: statusLinkHubBatchQueue };
  }
  running = true;
  stats.iniciado_em = new Date().toISOString();

  const safeRun = () => {
    if (!running) return;
    stats.ciclos += 1;
    stats.ultimo_ciclo_em = new Date().toISOString();
    processLinkHubQueue().catch((err) => {
      stats.ultimo_erro = { em: new Date().toISOString(), msg: err?.message || String(err) };
      console.error(
        '[linkHubBatchQueue] falha não tratada no ciclo:',
        err?.stack || err?.message || err
      );
    });
  };

  timer = setInterval(safeRun, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `🔄 Fila de lotes Link Hub iniciada (poll=${intervalMs}ms, batch=${BATCH_SIZE}, ` +
    `lease=${PROCESSING_LEASE_MINUTES}min, max_attempts=${MAX_ATTEMPTS})`
  );
  return { stop, status: statusLinkHubBatchQueue };
}

export async function stopLinkHubBatchQueue({ timeoutMs = 15_000 } = {}) {
  if (!running) return;
  running = false;
  if (timer) { clearInterval(timer); timer = null; }
  const inicio = Date.now();
  while (isProcessing && (Date.now() - inicio) < timeoutMs) {
    await new Promise(r => setTimeout(r, 200));
  }
  if (isProcessing) {
    console.warn(`[linkHubBatchQueue] stop timeout após ${timeoutMs}ms — abandonando ciclo em andamento`);
  }
  console.log('[linkHubBatchQueue] worker parado');
}

export function statusLinkHubBatchQueue() {
  return {
    running,
    isProcessing,
    config: { MAX_ATTEMPTS, PROCESSING_LEASE_MINUTES, POLL_INTERVAL_MS, BATCH_SIZE, LOCK_KEY },
    stats,
  };
}

// ── Entrypoint standalone ───────────────────────────────────────────
// Permite: `node backend/services/linkHubBatchQueue.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.LINKHUB_ENABLED === 'false') {
    console.log('[linkHubBatchQueue] desativado por LINKHUB_ENABLED=false — saindo');
    process.exit(0);
  }

  startLinkHubBatchQueue();

  const shutdown = async (signal) => {
    console.log(`[linkHubBatchQueue] sinal ${signal} recebido`);
    await stopLinkHubBatchQueue({ timeoutMs: 10_000 });
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error('[linkHubBatchQueue] unhandledRejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[linkHubBatchQueue] uncaughtException:', err);
    // Não derruba — próximo ciclo tenta de novo
  });
}