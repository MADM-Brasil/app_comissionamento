// backend/services/ticketQueue.js
import { pool } from './db.js';
import {
  findContactAndValidate,
  createContact,
  garantirLeadNoCloser,
  findOwnerIdByEmail,
  getContactDeals,
  updateContactOwner,
  HUBSPOT_PIPELINE_CLOSER_ID,
  HUBSPOT_STAGE_EM_CONTATO_ID
} from './hubspot.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';

let isProcessing = false;
const LOCK_KEY = 854729; // Número arbitrário único para advisory lock da fila de tickets

/**
 * Processa a fila de tickets de movimentação.
 * Cada registro pendente é tratado um por vez.
 * Usa advisory lock para evitar concorrência entre múltiplas instâncias.
 */
async function processTicketQueue() {
  if (isProcessing) return;

  // Tenta adquirir lock global (advisory lock)
  const lockClient = await pool.connect();
  let hasLock = false;
  try {
    const lockResult = await lockClient.query(`SELECT pg_try_advisory_lock($1)`, [LOCK_KEY]);
    hasLock = lockResult.rows[0].pg_try_advisory_lock === true;
  } finally {
    lockClient.release();
  }

  if (!hasLock) {
    console.log('⏭️ Outra instância está processando a fila. Aguardando...');
    return;
  }

  isProcessing = true;
  const client = await pool.connect();
  try {
    while (true) {
      // Seleciona o próximo ticket pendente com bloqueio de linha para evitar concorrência
      const result = await client.query(
        `SELECT *
         FROM app_comissionamento.tickets_movimentacao_lead
         WHERE status_mapeamento IS NULL
            OR status_mapeamento = ''
            OR status_mapeamento = 'pendente'
         ORDER BY id_ticket_movimentacao
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );

      if (result.rows.length === 0) break;
      const ticket = result.rows[0];

      try {
        await handleTicket(ticket, client);

        // Marca como concluído
        await client.query(
          `UPDATE app_comissionamento.tickets_movimentacao_lead
           SET status_mapeamento = 'concluido',
               atualizado_em = NOW()
           WHERE id_ticket_movimentacao = $1`,
          [ticket.id_ticket_movimentacao]
        );

        // Sincroniza tickets_suporte
        await client.query(
          `UPDATE app_comissionamento.tickets_suporte
           SET status = 'CONCLUÍDO', concluido_em = NOW(), atualizado_em = NOW()
           WHERE id_ticket = $1`,
          [ticket.ticket_id]
        );
      } catch (err) {
        console.error(`Erro no ticket ${ticket.id_ticket_movimentacao}:`, err);
        // Em caso de erro, marca como erro e registra observação
        const obs = JSON.stringify({
          erro: err.message,
          timestamp: new Date().toISOString(),
        });
        await client.query(
          `UPDATE app_comissionamento.tickets_movimentacao_lead
           SET status_mapeamento = 'erro',
               observacao_sales_ops = $1,
               atualizado_em = NOW()
           WHERE id_ticket_movimentacao = $2`,
          [obs, ticket.id_ticket_movimentacao]
        );
      }
    }
  } catch (err) {
    console.error('Erro no processador de tickets:', err);
  } finally {
    client.release();
    isProcessing = false;

    // Libera o advisory lock
    const unlockClient = await pool.connect();
    try {
      await unlockClient.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
    } catch (unlockErr) {
      console.error('Erro ao liberar advisory lock:', unlockErr);
    } finally {
      unlockClient.release();
    }
  }
}

/**
 * Processa um ticket individualmente.
 * Implementa a lógica que antes estava no endpoint /ticket-movimentacao.
 * Inclui verificação de idempotência para evitar reprocessamento acidental.
 */
async function handleTicket(ticket, client) {
  // Verifica idempotência
  let observacaoAtual = {};
  if (ticket.observacao_sales_ops) {
    try {
      observacaoAtual = JSON.parse(ticket.observacao_sales_ops);
    } catch (e) {
      observacaoAtual = {};
    }
  }

  if (observacaoAtual.processado === true && ticket.status_mapeamento !== 'pendente') {
    console.log(`⚠️ Ticket ${ticket.id_ticket_movimentacao} já processado. Pulando...`);
    return;
  }

  const nomeCompleto = `${ticket.nome_cliente_informado} ${ticket.sobrenome_cliente_informado}`;

  // Buscar ownerId
  let ownerId = null;
  if (ticket.colaborador_destino_email) {
    ownerId = await findOwnerIdByEmail(ticket.colaborador_destino_email);
    if (!ownerId) console.warn(`⚠️ Owner não encontrado para: ${ticket.colaborador_destino_email}`);
  }

  let hubspotData = {};
  let resultado = null;

  try {
    const busca = await findContactAndValidate({
      email: ticket.email_cliente_informado,
      phone: ticket.telefone_cliente_informado,
      cpf: ticket.cpf_cliente_informado,
    });

    if (!busca.found) {
      if (!ticket.email_cliente_informado) {
        hubspotData.status = 'aviso';
        hubspotData.mensagem = 'Campos pendentes: preencha e‑mail para tentar novamente.';
        resultado = { blocked: false, message: hubspotData.mensagem };
      } else {
        const novoContato = await createContact({
          firstName: ticket.nome_cliente_informado,
          lastName: ticket.sobrenome_cliente_informado,
          email: ticket.email_cliente_informado,
          phone: ticket.telefone_cliente_informado,
          cpf: ticket.cpf_cliente_informado,
          origem: ticket.origem_cliente_informada,
          ownerId,
        });

        hubspotData.contactId = novoContato.id;
        hubspotData.existe = true;
        hubspotData.criadoAgora = true;

        await waitForDealCreation(novoContato.id, 2000, 3);

        resultado = await garantirLeadNoCloser(
          novoContato.id,
          nomeCompleto,
          ownerId,
          ticket.colaborador_destino_nome
        );
      }
    } else if (busca.divergente) {
      hubspotData.status = 'suporte';
      hubspotData.mensagem = busca.motivo || 'Dados divergentes do cadastro. Aguardando suporte.';
      hubspotData.contactId = busca.contact.id;
      hubspotData.existe = true;

      if (ownerId) {
        await updateContactOwner(busca.contact.id, ownerId);
      }

      resultado = { blocked: false, message: hubspotData.mensagem };
    } else {
      hubspotData.contactId = busca.contact.id;
      hubspotData.existe = true;

      if (ownerId) {
        await updateContactOwner(busca.contact.id, ownerId);
      }

      resultado = await garantirLeadNoCloser(
        busca.contact.id,
        nomeCompleto,
        ownerId,
        ticket.colaborador_destino_nome
      );
    }

    if (resultado?.blocked) {
      hubspotData.status = 'bloqueado';
      hubspotData.mensagem = resultado.message;
      hubspotData.pipeline = resultado.pipeline;
      hubspotData.stage = resultado.stage;
      hubspotData.pipelineNome = resultado.pipelineNome || resultado.pipeline;
      hubspotData.stageNome = resultado.stageNome || resultado.stage;
    } else if (hubspotData.status === 'suporte' || hubspotData.status === 'aviso') {
      // Mantém status
    } else {
      hubspotData.pipeline = resultado.pipeline;
      hubspotData.stage = resultado.stage;
      hubspotData.pipelineNome = resultado.pipelineNome || resultado.pipeline;
      hubspotData.stageNome = resultado.stageNome || resultado.stage;
      const isCardMovido = (resultado.pipeline === HUBSPOT_PIPELINE_CLOSER_ID && resultado.stage === HUBSPOT_STAGE_EM_CONTATO_ID);
      hubspotData.status = isCardMovido ? 'concluido' : 'fora_pipeline';
      hubspotData.mensagem = isCardMovido ? 'Card movido' : undefined;
    }

    // Adiciona flag de processado à observação
    const novoObservacao = {
      ...observacaoAtual,
      processado: true,
      hubspot: hubspotData,
      motivoOriginal: ticket.motivo_solicitacao || '',
      observacao: hubspotData.mensagem || '',
    };

    await client.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
       SET observacao_sales_ops = $1
       WHERE id_ticket_movimentacao = $2`,
      [JSON.stringify(novoObservacao), ticket.id_ticket_movimentacao]
    );

    // Notificação Teams se não foi concluído
    if (hubspotData.status !== 'concluido') {
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
          status: hubspotData.status || 'N/A',
          mensagem: hubspotData.mensagem || 'N/A',
          pipeline: hubspotData.pipelineNome || hubspotData.pipeline || null,
          stage: hubspotData.stageNome || hubspotData.stage || null,
        });
      } catch (notifErr) {
        console.error('Erro ao enviar notificação Teams:', notifErr);
      }
    }

    // Define statusFinal baseado no hubspotData.status
    let statusFinal = 'pendente';
    switch (hubspotData.status) {
      case 'concluido':
        statusFinal = 'concluido';
        break;
      case 'bloqueado':
        statusFinal = 'bloqueado';
        break;
      case 'suporte':
        statusFinal = 'suporte';
        break;
      case 'aviso':
        statusFinal = 'aviso';
        break;
      case 'erro':
        statusFinal = 'erro';
        break;
      case 'fora_pipeline':
        statusFinal = 'fora_pipeline';
        break;
      default:
        statusFinal = 'pendente';
    }

    await client.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
       SET status_mapeamento = $1
       WHERE id_ticket_movimentacao = $2`,
      [statusFinal, ticket.id_ticket_movimentacao]
    );

    if (statusFinal === 'concluido') {
      await client.query(
        `UPDATE app_comissionamento.tickets_suporte
         SET status = 'CONCLUÍDO', concluido_em = NOW()
         WHERE id_ticket = $1`,
        [ticket.ticket_id]
      );
    }
  } catch (error) {
    console.error(`Erro na integração HubSpot (ticket ${ticket.id_ticket_movimentacao}):`, error);
    const obsErro = JSON.stringify({
      hubspot: { erro: true, status: 'erro', mensagem: error.message },
      motivoOriginal: ticket.motivo_solicitacao || '',
    });
    await client.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
       SET observacao_sales_ops = $1, status_mapeamento = 'erro'
       WHERE id_ticket_movimentacao = $2`,
      [obsErro, ticket.id_ticket_movimentacao]
    );
  }
}

async function waitForDealCreation(contactId, intervalMs, attempts) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const deals = await getContactDeals(contactId);
    if (deals.length > 0) return;
  }
}

/**
 * Inicia o loop da fila em intervalos regulares.
 * @param {number} intervalMs - Intervalo em milissegundos (padrão: 5 segundos)
 */
export function startTicketQueue(intervalMs = 5000) {
  setInterval(() => processTicketQueue(), intervalMs);
  console.log('🔄 Fila de tickets de movimentação iniciada');
}