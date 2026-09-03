// backend/services/ticketQueue.js
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
  HUBSPOT_STAGE_EM_CONTATO_ID
} from './hubspot.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';

let isProcessing = false;
const LOCK_KEY = 854729;

/**
 * Processa a fila de tickets de movimentação.
 * Usa advisory lock global para evitar concorrência entre instâncias.
 */
async function processTicketQueue() {
  if (isProcessing) return;

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

      try {
        await handleTicket(ticket, client);
      } catch (err) {
        console.error(`Erro no ticket ${ticket.id_ticket_movimentacao}:`, err);
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
 * Busca o ownerId pelo nome do colaborador destino (via e‑mail obtido do banco).
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

  if (observacaoAtual.processado === true) {
    console.log(`⚠️ Ticket ${ticket.id_ticket_movimentacao} já processado. Pulando...`);
    return;
  }

  // 1. Obter e‑mail do colaborador destino a partir do nome
  let colaboradorEmail = null;
  if (ticket.colaborador_destino_nome) {
    try {
      const result = await client.query(
        `SELECT email
         FROM core.view_app_colaboradores
         WHERE LOWER(TRIM(nome)) = LOWER(TRIM($1))
         LIMIT 1`,
        [ticket.colaborador_destino_nome]
      );
      if (result.rows.length > 0) {
        colaboradorEmail = result.rows[0].email;
      } else {
        console.warn(`⚠️ Colaborador não encontrado no banco: ${ticket.colaborador_destino_nome}`);
      }
    } catch (err) {
      console.error(`❌ Erro ao buscar e‑mail do colaborador ${ticket.colaborador_destino_nome}:`, err);
    }
  }

  // 2. Resolver ownerId no HubSpot
  let ownerId = null;
  if (colaboradorEmail) {
    ownerId = await findOwnerIdByEmail(colaboradorEmail);
    if (!ownerId) {
      console.warn(`⚠️ Owner não encontrado no HubSpot para: ${colaboradorEmail}`);
    }
  }

  const nomeCompleto = `${ticket.nome_cliente_informado} ${ticket.sobrenome_cliente_informado}`;
  let hubspotData = {};
  let resultado = null;
  let dealId = null;
  let contactId = null;

  try {
    const busca = await findContactAndValidate({
      email: ticket.email_cliente_informado,
      phone: ticket.telefone_cliente_informado,
      cpf: ticket.cpf_cliente_informado,
    });

    if (!busca.found) {
      // Contato não encontrado – tentamos criar
      if (!ticket.email_cliente_informado) {
        hubspotData.status = 'aviso';
        hubspotData.mensagem = 'Campos pendentes: preencha e‑mail para tentar novamente.';
        resultado = { blocked: false, message: hubspotData.mensagem };
      } else {
        // Tenta criar o contato com tratamento específico para e‑mail inválido
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

          // Sucesso na criação
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
          // Verifica se é erro de e‑mail inválido
          const isInvalidEmail = createError.code === 400 &&
            createError.body?.errors?.some(e => e.error === 'INVALID_EMAIL');

          if (isInvalidEmail) {
            // Trata como aviso – não bloqueia, mas não prossegue
            hubspotData.status = 'aviso';
            hubspotData.mensagem = `E-mail inválido: "${ticket.email_cliente_informado}". Corrija e reenvie.`;
            resultado = { blocked: false, message: hubspotData.mensagem };
            // Não define contactId, pois não foi criado
          } else {
            // Outro erro – repassa para o catch externo
            throw createError;
          }
        }
      }
    } else if (busca.divergente) {
      // Contato existe com divergências
      contactId = busca.contact.id;
      hubspotData.status = 'suporte';
      hubspotData.mensagem = busca.motivo || 'Dados divergentes do cadastro. Aguardando suporte.';
      hubspotData.contactId = contactId;
      hubspotData.existe = true;

      if (ownerId) {
        await updateContactOwner(contactId, ownerId);
      }
      resultado = { blocked: false, message: hubspotData.mensagem };
    } else {
      // Contato encontrado sem divergências
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

    // Se o contato foi criado ou já existia e não houve bloqueio, faz a validação final
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

    // Determina status final
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

    // Atualiza observação e status
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
    } else if (statusFinal === 'aviso') {
      await client.query(
        `UPDATE app_comissionamento.tickets_suporte
         SET status = 'AVISO', atualizado_em = NOW()
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

    // Notificação Teams para casos não concluídos ou com aviso
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
    throw error;
  }
}

export function startTicketQueue(intervalMs = 5000) {
  setInterval(() => processTicketQueue(), intervalMs);
  console.log('🔄 Fila de tickets de movimentação iniciada');
}