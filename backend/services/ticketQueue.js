// backend/services/ticketQueue.js
// Worker do fluxo de movimentação normal (CRM).
// IMPORTANTE: filtra por crm_origem = 'CRM' para não concorrer com o
// linkHubBatchQueue.js, que processa apenas crm_origem = 'HUBSPOT_LINK'.
import { pool } from './db.js';
import {
  findContactAndValidate,
  createContact,
  garantirLeadNoCloser,
  findOwnerIdByEmail,
  getContactDeals,
  updateContactOwner,
  validateFinalAssignment,
  HUBSPOT_PIPELINE_CLOSER_ID,
  HUBSPOT_STAGE_EM_CONTATO_ID,
} from './hubspot.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';

let isProcessing = false;
const LOCK_KEY = 854729;

/**
 * Processa a fila de tickets de movimentação normal (CRM).
 * Usa advisory lock global para evitar concorrência entre instâncias.
 * Filtra apenas crm_origem = 'CRM' — o fluxo Link Hub tem worker próprio.
 */
async function processTicketQueue() {
  if (isProcessing) return;

  const client = await pool.connect();
  let hasLock = false;
  try {
    const lockResult = await client.query(`SELECT pg_try_advisory_lock($1)`, [LOCK_KEY]);
    hasLock = lockResult.rows[0].pg_try_advisory_lock === true;
    if (!hasLock) {
      console.log('⏭️ Outra instância está processando a fila. Aguardando...');
      return;
    }

    isProcessing = true;
    while (true) {
      const result = await client.query(
        `SELECT tml.*, ts.metadados
         FROM app_comissionamento.tickets_movimentacao_lead tml
         JOIN app_comissionamento.tickets_suporte ts ON tml.ticket_id = ts.id_ticket
         WHERE tml.crm_origem = 'CRM'
           AND (tml.status_mapeamento IS NULL
                OR tml.status_mapeamento = ''
                OR tml.status_mapeamento = 'pendente')
         ORDER BY tml.id_ticket_movimentacao
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );

      if (result.rows.length === 0) break;
      const ticket = result.rows[0];

      try {
        await handleTicket(ticket, client);
      } catch (err) {
        console.error(`Erro no ticket ${ticket.id_ticket_movimentacao}:`, err);
        const obs = JSON.stringify({
          erro: err.message,
          timestamp: new Date().toISOString(),
          ...(err.partialResult ? { resultadoParcial: err.partialResult } : {}),
        });
        await client.query(
          `UPDATE app_comissionamento.tickets_movimentacao_lead
           SET status_mapeamento = 'erro',
               observacao_sales_ops = $1,
               atualizado_em = NOW()
           WHERE id_ticket_movimentacao = $2`,
          [obs, ticket.id_ticket_movimentacao]
        );
        await client.query(
          `UPDATE app_comissionamento.tickets_suporte
           SET status = 'ERRO', atualizado_em = NOW()
           WHERE id_ticket = $1`,
          [ticket.ticket_id]
        );
      }
    }
  } catch (err) {
    console.error('Erro no processador de tickets:', err);
  } finally {
    if (hasLock) {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
      } catch (unlockErr) {
        console.error('Erro ao liberar advisory lock:', unlockErr);
      }
    }
    isProcessing = false;
    client.release();
  }
}

/**
 * Processa um ticket individualmente.
 * Busca o ownerId pelo nome do colaborador destino (via e-mail obtido do banco).
 */
async function handleTicket(ticket, client) {
  // 1) Idempotência — não reprocessa o que já foi concluído.
  let observacaoAtual = {};
  if (ticket.observacao_sales_ops) {
    try {
      observacaoAtual = JSON.parse(ticket.observacao_sales_ops);
    } catch {
      observacaoAtual = {};
    }
  }
  if (observacaoAtual.processado === true) {
    console.log(`⚠️ Ticket ${ticket.id_ticket_movimentacao} já processado. Pulando...`);
    return;
  }

  const nomeCompleto = `${ticket.nome_cliente_informado || ''} ${ticket.sobrenome_cliente_informado || ''}`.trim();

  const hubspotData = {
    contactId: null,
    existe: false,
    criadoAgora: false,
    status: null,
    mensagem: '',
    pipeline: null,
    stage: null,
    pipelineNome: null,
    stageNome: null,
  };

  let contactId = null;
  let dealId = null;
  let resultado = null;

  try {
    // 2) Obter e-mail do colaborador destino: primeiro dos metadados, senão pelo nome.
    let colaboradorEmail = ticket.metadados?.colaborador_destino_email || null;
    if (!colaboradorEmail && ticket.colaborador_destino_nome) {
      const lookup = await client.query(
        `SELECT email
         FROM core.view_app_colaboradores
         WHERE LOWER(TRIM(nome)) = LOWER(TRIM($1))
         LIMIT 1`,
        [ticket.colaborador_destino_nome]
      );
      if (lookup.rows.length > 0) {
        colaboradorEmail = lookup.rows[0].email;
      }
    }

    if (!colaboradorEmail) {
      throw new Error(
        `Não foi possível determinar o e-mail do colaborador destino "${ticket.colaborador_destino_nome}".`
      );
    }

    // 3) Resolver ownerId no HubSpot pelo e-mail.
    const ownerId = await findOwnerIdByEmail(colaboradorEmail);
    if (!ownerId) {
      throw new Error(`Owner do HubSpot não encontrado para o e-mail "${colaboradorEmail}".`);
    }

    // 4) Buscar/criar contato no HubSpot.
    const busca = await findContactAndValidate({
      email: ticket.email_cliente_informado,
      phone: ticket.telefone_cliente_informado,
      cpf: ticket.cpf_cliente_informado,
    });

    if (!busca.found) {
      if (!ticket.email_cliente_informado) {
        hubspotData.status = 'aviso';
        hubspotData.mensagem = 'Campos pendentes: preencha e-mail para tentar novamente.';
        resultado = { blocked: false, message: hubspotData.mensagem };
      } else {
        try {
          const novoContato = await createContact({
            firstName: ticket.nome_cliente_informado,
            lastName: ticket.sobrenome_cliente_informado,
            email: ticket.email_cliente_informado,
            phone: ticket.telefone_cliente_informado,
            cpf: ticket.cpf_cliente_informado,
            origem: ticket.origem_cliente_informada,
            ownerId,
          });
          contactId = novoContato.id;
          hubspotData.contactId = contactId;
          hubspotData.existe = true;
          hubspotData.criadoAgora = true;

          resultado = await garantirLeadNoCloser(
            contactId,
            nomeCompleto,
            ownerId,
            ticket.colaborador_destino_nome
          );
          if (resultado && !resultado.blocked && resultado.dealId) {
            dealId = resultado.dealId;
          }
        } catch (createError) {
          const isInvalidEmail =
            createError.code === 400 &&
            createError.body?.errors?.some(e => e.error === 'INVALID_EMAIL');

          if (isInvalidEmail) {
            hubspotData.status = 'aviso';
            hubspotData.mensagem = `E-mail inválido: "${ticket.email_cliente_informado}". Corrija e reenvie.`;
            resultado = { blocked: false, message: hubspotData.mensagem };
          } else {
            throw createError;
          }
        }
      }
    } else if (busca.divergente) {
      contactId = busca.contact.id;
      hubspotData.contactId = contactId;
      hubspotData.existe = true;
      hubspotData.status = 'suporte';
      hubspotData.mensagem = busca.motivo || 'Dados divergentes do cadastro. Aguardando suporte.';

      if (ownerId) {
        await updateContactOwner(contactId, ownerId);
      }
      resultado = { blocked: false, message: hubspotData.mensagem };
    } else {
      contactId = busca.contact.id;
      hubspotData.contactId = contactId;
      hubspotData.existe = true;

      if (ownerId) {
        await updateContactOwner(contactId, ownerId);
      }

      resultado = await garantirLeadNoCloser(
        contactId,
        nomeCompleto,
        ownerId,
        ticket.colaborador_destino_nome
      );
      if (resultado && !resultado.blocked && resultado.dealId) {
        dealId = resultado.dealId;
      }
    }

    // 5) Validação final (aguarda associação propagar no HubSpot).
    if (resultado && !resultado.blocked && contactId && dealId && ownerId) {
      let finalCheck = null;
      let attempts = 0;
      const maxAttempts = 8;
      const delayMs = 2000;

      while (attempts < maxAttempts) {
        attempts++;
        finalCheck = await validateFinalAssignment(contactId, ownerId, dealId);
        if (finalCheck.ok) {
          console.log(`✅ Validação final OK (tentativa ${attempts})`);
          break;
        }
        console.log(`⏳ Aguardando associação do deal (tentativa ${attempts}/${maxAttempts})...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      if (!finalCheck || !finalCheck.ok) {
        throw new Error(
          `Validação final falhou após ${maxAttempts} tentativas: ${JSON.stringify(finalCheck?.details || finalCheck)}`
        );
      }
    }

    // 6) Determinar status final.
    let statusFinal = 'pendente';
    if (resultado?.blocked) {
      statusFinal = 'bloqueado';
      hubspotData.status = 'bloqueado';
      hubspotData.mensagem = resultado.message;
      hubspotData.pipeline = resultado.pipeline;
      hubspotData.stage = resultado.stage;
      hubspotData.pipelineNome = resultado.pipelineNome || resultado.pipeline;
      hubspotData.stageNome = resultado.stageNome || resultado.stage;
    } else if (hubspotData.status === 'suporte' || hubspotData.status === 'aviso') {
      statusFinal = hubspotData.status;
    } else if (
      resultado?.pipeline === HUBSPOT_PIPELINE_CLOSER_ID &&
      resultado?.stage === HUBSPOT_STAGE_EM_CONTATO_ID
    ) {
      statusFinal = 'concluido';
      hubspotData.status = 'concluido';
      hubspotData.pipeline = resultado.pipeline;
      hubspotData.stage = resultado.stage;
      hubspotData.pipelineNome = resultado.pipelineNome || resultado.pipeline;
      hubspotData.stageNome = resultado.stageNome || resultado.stage;
    } else {
      statusFinal = 'fora_pipeline';
      hubspotData.status = 'fora_pipeline';
    }

    // 7) Persistir observação + status no ticket de movimentação.
    const novoObservacao = {
      ...observacaoAtual,
      processado: true,
      dealId: dealId || observacaoAtual.dealId || null,
      hubspot: hubspotData,
      motivoOriginal: ticket.motivo_solicitacao || '',
      observacao: hubspotData.mensagem || '',
      colaboradorDestinoNome: ticket.colaborador_destino_nome,
      colaboradorDestinoEmail: colaboradorEmail,
      validacaoFinal: true,
    };

    await client.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
       SET observacao_sales_ops = $1,
           status_mapeamento = $2,
           analisado_em = NOW(),
           atualizado_em = NOW()
       WHERE id_ticket_movimentacao = $3`,
      [JSON.stringify(novoObservacao), statusFinal, ticket.id_ticket_movimentacao]
    );

    // 8) Atualizar o ticket base em tickets_suporte.
    let suporteStatus = 'EM ANDAMENTO';
    if (statusFinal === 'concluido') suporteStatus = 'CONCLUÍDO';
    else if (statusFinal === 'bloqueado') suporteStatus = 'BLOQUEADO';
    else if (statusFinal === 'erro') suporteStatus = 'ERRO';
    else if (statusFinal === 'aviso') suporteStatus = 'AVISO';

    if (statusFinal === 'concluido') {
      await client.query(
        `UPDATE app_comissionamento.tickets_suporte
         SET status = $1, concluido_em = NOW(), atualizado_em = NOW()
         WHERE id_ticket = $2`,
        [suporteStatus, ticket.ticket_id]
      );
    } else {
      await client.query(
        `UPDATE app_comissionamento.tickets_suporte
         SET status = $1, atualizado_em = NOW()
         WHERE id_ticket = $2`,
        [suporteStatus, ticket.ticket_id]
      );
    }

    // 9) Notificação Teams apenas para casos não concluídos.
    if (statusFinal !== 'concluido') {
      try {
        await teamsNotificador.enviar({
          titulo: 'Movimentação de Lead',
          assunto: 'Movimentacao',
          descricao: `Movimentação solicitada: ${nomeCompleto} | Tel: ${ticket.telefone_cliente_informado || 'N/A'} | Equipe destino: ${ticket.equipe_destino_nome || 'N/A'}`,
          solicitante: ticket.colaborador_origem_nome || 'N/A',
          equipe: ticket.equipe_origem_nome || 'N/A',
          anexosMarkdown: 'Nenhum anexo',
          cliente: nomeCompleto,
          telefone: ticket.telefone_cliente_informado || 'N/A',
          equipeDestino: ticket.equipe_destino_nome || 'N/A',
          assessorDestino: ticket.colaborador_destino_nome || 'N/A',
          status: statusFinal,
          mensagem: hubspotData.mensagem || 'N/A',
          pipeline: hubspotData.pipelineNome || hubspotData.pipeline || null,
          stage: hubspotData.stageNome || hubspotData.stage || null,
        });
      } catch (notifErr) {
        console.error('Erro ao enviar notificação Teams:', notifErr);
      }
    }
  } catch (error) {
    console.error(`Erro na integração HubSpot (ticket ${ticket.id_ticket_movimentacao}):`, error);
    const obsErro = JSON.stringify({
      ...observacaoAtual,
      hubspot: { ...hubspotData, erro: true, status: 'erro', mensagem: error.message },
      motivoOriginal: ticket.motivo_solicitacao || '',
      processado: true,
    });
    await client.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
       SET observacao_sales_ops = $1,
           status_mapeamento = 'erro',
           analisado_em = NOW(),
           atualizado_em = NOW()
       WHERE id_ticket_movimentacao = $2`,
      [obsErro, ticket.id_ticket_movimentacao]
    );
    throw error;
  }
}

export function startTicketQueue(intervalMs = 5000) {
  setInterval(() => processTicketQueue(), intervalMs);
  console.log('🔄 Fila de tickets de movimentação iniciada');
}