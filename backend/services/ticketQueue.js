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
 * Usa advisory lock global para evitar concorrência entre múltiplas instâncias.
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
      // Seleciona o próximo ticket pendente com bloqueio de linha
      const result = await client.query(
        `SELECT tml.*, ts.metadados
         FROM app_comissionamento.tickets_movimentacao_lead tml
         JOIN app_comissionamento.tickets_suporte ts ON tml.ticket_id = ts.id_ticket
         WHERE tml.status_mapeamento IS NULL
            OR tml.status_mapeamento = ''
            OR tml.status_mapeamento = 'pendente'
         ORDER BY tml.id_ticket_movimentacao
         LIMIT 1
         FOR UPDATE SKIP LOCKED`
      );

      if (result.rows.length === 0) break;
      const ticket = result.rows[0];

      // Extrai o e‑mail destino dos metadados (campo JSONB)
      let colaboradorDestinoEmail = null;
      try {
        const metadados = typeof ticket.metadados === 'string' ? JSON.parse(ticket.metadados) : ticket.metadados;
        colaboradorDestinoEmail = metadados?.colaborador_destino_email || null;
      } catch (e) {
        console.warn(`⚠️ Erro ao parsear metadados do ticket ${ticket.id_ticket_movimentacao}:`, e);
      }

      // Se não houver e‑mail destino, marca como erro e pula
      if (!colaboradorDestinoEmail) {
        console.warn(`⚠️ Ticket ${ticket.id_ticket_movimentacao} sem e‑mail destino. Marcando como erro.`);
        await client.query(
          `UPDATE app_comissionamento.tickets_movimentacao_lead
           SET status_mapeamento = 'erro',
               observacao_sales_ops = jsonb_set(COALESCE(observacao_sales_ops, '{}'), '{erro}', '"E-mail do colaborador destino não informado"'),
               atualizado_em = NOW()
           WHERE id_ticket_movimentacao = $1`,
          [ticket.id_ticket_movimentacao]
        );
        continue;
      }

      try {
        await handleTicket(ticket, colaboradorDestinoEmail, client);
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

    // Libera o advisory lock global
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
 * Implementa a lógica de integração com HubSpot e atualiza o status final.
 */
async function handleTicket(ticket, colaboradorDestinoEmail, client) {
  // Verifica se já foi processado (idempotência baseada em 'processado')
  let observacaoAtual = {};
  if (ticket.observacao_sales_ops) {
    try {
      observacaoAtual = JSON.parse(ticket.observacao_sales_ops);
    } catch (e) {
      observacaoAtual = {};
    }
  }

  // Se já foi processado e o status é final, ignora
  if (observacaoAtual.processado === true) {
    console.log(`⚠️ Ticket ${ticket.id_ticket_movimentacao} já processado. Pulando...`);
    return;
  }

  // Resolve ownerId a partir do e‑mail destino
  let ownerId = null;
  if (colaboradorDestinoEmail) {
    ownerId = await findOwnerIdByEmail(colaboradorDestinoEmail);
    if (!ownerId) {
      console.warn(`⚠️ Owner não encontrado para: ${colaboradorDestinoEmail}`);
    }
  }

  const nomeCompleto = `${ticket.nome_cliente_informado} ${ticket.sobrenome_cliente_informado}`;
  let hubspotData = {};
  let resultado = null;
  let dealId = null;

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

        if (resultado && !resultado.blocked) {
          const deals = await getContactDeals(novoContato.id);
          if (deals.length > 0) {
            dealId = deals[0].id;
          }
        }
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

      if (resultado && !resultado.blocked) {
        const deals = await getContactDeals(busca.contact.id);
        if (deals.length > 0) {
          dealId = deals[0].id;
        }
      }
    }

    // Determina status final baseado no resultado
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
    } else if (resultado?.pipeline === HUBSPOT_PIPELINE_CLOSER_ID && resultado?.stage === HUBSPOT_STAGE_EM_CONTATO_ID) {
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

    // Atualiza observação com informações finais
    const novoObservacao = {
      ...observacaoAtual,
      processado: true,
      dealId: dealId || observacaoAtual.dealId || null,
      hubspot: hubspotData,
      motivoOriginal: ticket.motivo_solicitacao || '',
      observacao: hubspotData.mensagem || '',
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

    // Atualiza tickets_suporte com status correspondente
    if (statusFinal === 'concluido') {
      await client.query(
        `UPDATE app_comissionamento.tickets_suporte
         SET status = 'CONCLUÍDO', concluido_em = NOW(), atualizado_em = NOW()
         WHERE id_ticket = $1`,
        [ticket.ticket_id]
      );
    } else if (statusFinal === 'bloqueado') {
      await client.query(
        `UPDATE app_comissionamento.tickets_suporte
         SET status = 'BLOQUEADO', atualizado_em = NOW()
         WHERE id_ticket = $1`,
        [ticket.ticket_id]
      );
    } else if (statusFinal === 'erro') {
      await client.query(
        `UPDATE app_comissionamento.tickets_suporte
         SET status = 'ERRO', atualizado_em = NOW()
         WHERE id_ticket = $1`,
        [ticket.ticket_id]
      );
    } else {
      await client.query(
        `UPDATE app_comissionamento.tickets_suporte
         SET status = 'EM ANDAMENTO', atualizado_em = NOW()
         WHERE id_ticket = $1`,
        [ticket.ticket_id]
      );
    }

    // Notificação Teams apenas para casos não concluídos ou bloqueados
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
      hubspot: { erro: true, status: 'erro', mensagem: error.message },
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
    throw error; // repassa para o loop principal tratar
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