// backend/services/ticketQueue.js
// Worker do fluxo de movimentação normal (CRM).
//
// IMPORTANTE: filtra por crm_origem = 'CRM' para não concorrer com o
// linkHubBatchQueue.js, que processa apenas crm_origem = 'HUBSPOT_LINK'.
//
// Produto: lido de `observacao_sales_ops.produto` (fonte principal) ou, em
// tickets legados, de `metadados.produto`. É propagado via garantirLeadNoCloser,
// que decide o pipeline de destino:
//   - Auxílio e demais produtos comuns → Closer / Em Contato.
//   - Quinquênio/Quinqueino/Concomitante(s) → Quinquênio / Em contato.
//
// A busca do card no contato também é orientada pelo produto (ver
// garantirLeadNoCloser em hubspot.js).
//
// Não chamamos updateContactOwner direto aqui — deixamos que
// garantirLeadNoCloser sincronize proprietário + produto apenas depois de
// avaliar as regras do card (evita alterar contato em ticket bloqueado).
//
// Fila: o SELECT exclui explicitamente tickets com processado=true em
// observacao_sales_ops. Isso evita loop infinito caso status_mapeamento e o
// marcador `processado` divirjam (ex.: ticket devolvido a 'pendente' sem
// revisão do resultado). Esses tickets só voltam a ser processados após
// revisão manual e limpeza controlada do marcador.

import { pool } from './db.js';
import {
  findContactAndValidate,
  createContact,
  garantirLeadNoCloser,
  findOwnerIdByEmail,
  validateFinalAssignment,
  HUBSPOT_PIPELINE_CLOSER_ID,
  HUBSPOT_PIPELINE_QUINQUENIO_ID,
  HUBSPOT_STAGE_EM_CONTATO_ID,
  HUBSPOT_STAGE_QUINQUENIO_EM_CONTATO_ID,
} from './hubspot.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';

let isProcessing = false;
const LOCK_KEY = 854729;

const ACCEPTED_CLOSER_STAGES = new Set(
  (
    process.env.HUBSPOT_CLOSER_ACCEPTED_STAGES ||
    `${HUBSPOT_STAGE_EM_CONTATO_ID},1368997800`
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const ENFORCE_EXACT_STAGE =
  String(process.env.MOVIMENTACAO_CRM_EXIGE_ETAPA || 'false').toLowerCase() === 'true';

console.log(
  `[ticketQueue] etapas do Closer aceitas: ${[...ACCEPTED_CLOSER_STAGES].join(', ')}` +
    ` (ENFORCE_EXACT_STAGE=${ENFORCE_EXACT_STAGE})`
);

const RULE_LABELS = Object.freeze({
  created_and_moved: 'Card criado na Base de Leads e movido para o destino.',
  base_to_closer: 'Card movido da Base de Leads para o destino.',
  desqualificado_to_em_contato: 'Card desqualificado reativado no destino.',
  closer_without_owner: 'Card estava sem responsável; atribuído agora.',
  reassigned_by_last_modified_date: 'Card reatribuído com base na última modificação.',
  already_assigned: 'Card já estava com o responsável informado; contato alinhado.',
  ambiguous_deals: 'Contato associado a vários cards.',
  fallback_block: 'Card fora dos pipelines permitidos.',
  owned_by_another_recent_activity: 'Card pertence a outro responsável e a última modificação está dentro do prazo mínimo.',
  owner_missing: 'Responsável destino não informado.',
  missing_email: 'Campos pendentes: preencha e-mail para tentar novamente.',
  invalid_email: 'E-mail inválido. Corrija e reenvie.',
  contact_data_mismatch: 'Dados divergentes do cadastro. Aguardando suporte.',
  product_pipeline_routing: 'Produto exige pipeline dedicado; movimentação executada.',
});

// Normaliza o produto para casar com a lógica do hubspot.js.
function isQuinquenioOuConcomitante(produto) {
  const normalized = String(produto ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /\b(?:quinquenio|quinqueino|concomitantes?)\b/.test(normalized);
}

// Destino esperado, dado o produto. Fonte única para o worker CRM.
function expectedDestination(produto) {
  return isQuinquenioOuConcomitante(produto)
    ? { pipeline: HUBSPOT_PIPELINE_QUINQUENIO_ID, stage: HUBSPOT_STAGE_QUINQUENIO_EM_CONTATO_ID, name: 'Quinquenio/concomitante' }
    : { pipeline: HUBSPOT_PIPELINE_CLOSER_ID, stage: HUBSPOT_STAGE_EM_CONTATO_ID, name: 'Closer' };
}

function describeBlockedReason(hubspotData) {
  const parts = [];
  if (hubspotData.mensagem) parts.push(hubspotData.mensagem);
  if (Number.isFinite(hubspotData.requiredHours)) {
    parts.push(`Prazo mínimo: ${hubspotData.requiredHours}h desde a última modificação.`);
  }
  if (Number.isFinite(hubspotData.hoursSinceNote)) {
    parts.push(`Decorrido: ${hubspotData.hoursSinceNote}h.`);
  }
  if (hubspotData.notesLastUpdated) {
    parts.push(`Última modificação: ${hubspotData.notesLastUpdated}.`);
  }
  if (hubspotData.pipelineNome || hubspotData.stageNome) {
    parts.push(`Pipeline: ${hubspotData.pipelineNome || '—'} / Etapa: ${hubspotData.stageNome || '—'}.`);
  }
  return parts.filter(Boolean).join(' ');
}

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
      // SELECT exclui tickets já marcados como processado=true no JSON.
      // Isso evita loop quando o status estiver em 'pendente' por engano.
      const result = await client.query(
        `SELECT tml.*, ts.metadados
         FROM app_comissionamento.tickets_movimentacao_lead tml
         JOIN app_comissionamento.tickets_suporte ts ON tml.ticket_id = ts.id_ticket
         WHERE tml.crm_origem = 'CRM'
           AND (tml.status_mapeamento IS NULL
                OR tml.status_mapeamento = ''
                OR tml.status_mapeamento = 'pendente')
           AND COALESCE(tml.observacao_sales_ops::jsonb->>'processado', 'false') <> 'true'
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

        // Preserva o JSON existente (produto, idempotency_key, etc.) em vez
        // de sobrescrever com apenas { erro, timestamp }.
        let previous = {};
        try {
          const persisted = await client.query(
            `SELECT observacao_sales_ops
             FROM app_comissionamento.tickets_movimentacao_lead
             WHERE id_ticket_movimentacao = $1`,
            [ticket.id_ticket_movimentacao]
          );
          const raw = persisted.rows[0]?.observacao_sales_ops;
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed;
        } catch { /* Mantém fallback vazio para observação legada. */ }

        const obs = JSON.stringify({
          ...previous,
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

async function handleTicket(ticket, client) {
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

  // Produto: tenta primeiro em observacao_sales_ops.produto (fonte nova);
  // em seguida em metadados.produto (fallback para tickets que não gravaram
  // na observação). Nunca assume um default — o default vem da rota.
  const produto =
    observacaoAtual.produto ||
    ticket.metadados?.produto ||
    null;

  // Destino esperado pelo produto (Auxílio → Closer; Quinquênio → Quinquênio).
  const destination = expectedDestination(produto);

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
    ruleApplied: null,
    lastUpdatedAt: null,
    requiredHours: null,
    hoursSinceNote: null,
    notesLastUpdated: null,
    produto,
    destinoEsperado: destination.name,
  };

  let contactId = null;
  let dealId = null;
  let resultado = null;

  try {
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

    const ownerId = await findOwnerIdByEmail(colaboradorEmail);
    if (!ownerId) {
      throw new Error(`Owner do HubSpot não encontrado para o e-mail "${colaboradorEmail}".`);
    }

    const busca = await findContactAndValidate({
      email: ticket.email_cliente_informado,
      phone: ticket.telefone_cliente_informado,
      cpf: ticket.cpf_cliente_informado,
    });

    if (!busca.found) {
      if (!ticket.email_cliente_informado) {
        hubspotData.status = 'aviso';
        hubspotData.ruleApplied = 'missing_email';
        hubspotData.mensagem = RULE_LABELS.missing_email;
        resultado = { blocked: false, message: hubspotData.mensagem, ruleApplied: 'missing_email' };
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
            produto,
          });
          contactId = novoContato.id;
          hubspotData.contactId = contactId;
          hubspotData.existe = true;
          hubspotData.criadoAgora = true;

          resultado = await garantirLeadNoCloser(
            contactId,
            nomeCompleto,
            ownerId,
            ticket.colaborador_destino_nome,
            produto
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
            hubspotData.ruleApplied = 'invalid_email';
            hubspotData.mensagem = `E-mail inválido: "${ticket.email_cliente_informado}". Corrija e reenvie.`;
            resultado = { blocked: false, message: hubspotData.mensagem, ruleApplied: 'invalid_email' };
          } else {
            throw createError;
          }
        }
      }
    } else if (busca.divergente) {
      // Contato divergente: apenas sinaliza suporte. NÃO altera o contato no
      // HubSpot.
      contactId = busca.contact.id;
      hubspotData.contactId = contactId;
      hubspotData.existe = true;
      hubspotData.status = 'suporte';
      hubspotData.ruleApplied = 'contact_data_mismatch';
      hubspotData.mensagem = busca.motivo || RULE_LABELS.contact_data_mismatch;
      resultado = { blocked: false, message: hubspotData.mensagem, ruleApplied: 'contact_data_mismatch' };
    } else {
      contactId = busca.contact.id;
      hubspotData.contactId = contactId;
      hubspotData.existe = true;

      resultado = await garantirLeadNoCloser(
        contactId,
        nomeCompleto,
        ownerId,
        ticket.colaborador_destino_nome,
        produto
      );
      if (resultado && !resultado.blocked && resultado.dealId) {
        dealId = resultado.dealId;
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Pipeline/etapa esperados após a movimentação.
    // Preferimos o que o próprio hubspot.js confirmou (resultado.pipeline /
    // resultado.stage). Se por algum motivo não vier, usamos o destino
    // padrão calculado a partir do produto.
    // ─────────────────────────────────────────────────────────────
    const expectedPipeline = String(resultado?.pipeline || destination.pipeline);
    const expectedStage = String(resultado?.stage || destination.stage);

    if (resultado && !resultado.blocked && contactId && dealId && ownerId) {
      const validateOptions = {
        produto,
        expectedPipeline,
        // Em modo estrito exigimos a etapa exata do destino. Fora dele,
        // aceitamos qualquer etapa entre as aceitas do Closer quando o
        // destino é o Closer — mesmo comportamento anterior para Auxílio.
        expectedStage: ENFORCE_EXACT_STAGE
          ? expectedStage
          : (String(expectedPipeline) === HUBSPOT_PIPELINE_CLOSER_ID ? null : expectedStage),
      };

      let finalCheck = null;
      let attempts = 0;
      const maxAttempts = 8;
      const delayMs = 2000;

      while (attempts < maxAttempts) {
        attempts++;
        finalCheck = await validateFinalAssignment(contactId, ownerId, dealId, validateOptions);
        if (finalCheck.ok) {
          console.log(`✅ Validação final OK (tentativa ${attempts}) — destino ${destination.name}`);
          break;
        }
        console.log(`⏳ Aguardando associação do deal (tentativa ${attempts}/${maxAttempts})...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      if (!finalCheck || !finalCheck.ok) {
        const d = finalCheck?.details || {};
        const ownerOk = String(d.dealOwnerId) === String(ownerId)
          && String(d.contactOwnerId) === String(ownerId);
        const pipelineOk = String(d.dealPipeline) === expectedPipeline;

        // Aceitação de etapa:
        //   - Modo estrito: precisa ser exatamente expectedStage.
        //   - Não estrito + destino Closer: qualquer etapa entre as aceitas.
        //   - Não estrito + destino Quinquênio: exige a etapa do pipeline.
        const stageOk = ENFORCE_EXACT_STAGE
          ? String(d.dealStage) === expectedStage
          : (String(expectedPipeline) === HUBSPOT_PIPELINE_CLOSER_ID
              ? ACCEPTED_CLOSER_STAGES.has(String(d.dealStage))
              : String(d.dealStage) === expectedStage);

        if (ownerOk && pipelineOk && stageOk) {
          console.log(
            `ℹ️ Validação estrita retornou não-ok, mas owner/pipeline/etapa válidos. ` +
            `Pipeline: ${d.dealPipeline}, etapa atual: ${d.dealStage}. Aceitando como sucesso.`
          );
        } else {
          throw new Error(
            `Validação final falhou após ${maxAttempts} tentativas: ${JSON.stringify(finalCheck?.details || finalCheck)}`
          );
        }
      }
    }

    let statusFinal = 'pendente';
    if (resultado?.blocked) {
      statusFinal = 'bloqueado';
      hubspotData.status = 'bloqueado';
      hubspotData.mensagem = resultado.message || RULE_LABELS[resultado.ruleApplied] || 'Movimentação bloqueada pela política atual.';
      hubspotData.pipeline = resultado.pipeline || null;
      hubspotData.stage = resultado.stage || null;
      hubspotData.pipelineNome = resultado.pipelineNome || resultado.pipeline || null;
      hubspotData.stageNome = resultado.stageNome || resultado.stage || null;
      hubspotData.ruleApplied = resultado.ruleApplied || null;
      hubspotData.lastUpdatedAt = resultado.lastUpdatedAt || null;
      if (resultado.requiredHours !== undefined && resultado.requiredHours !== null) {
        hubspotData.requiredHours = resultado.requiredHours;
      }
      if (resultado.hoursSinceNote !== undefined && resultado.hoursSinceNote !== null) {
        hubspotData.hoursSinceNote = Math.round(resultado.hoursSinceNote * 10) / 10;
      }
      if (resultado.notesLastUpdated !== undefined && resultado.notesLastUpdated !== null) {
        hubspotData.notesLastUpdated = resultado.notesLastUpdated;
      }
    } else if (hubspotData.status === 'suporte' || hubspotData.status === 'aviso') {
      statusFinal = hubspotData.status;
      hubspotData.ruleApplied = resultado?.ruleApplied || hubspotData.ruleApplied || null;
    } else if (
      resultado &&
      !resultado.blocked &&
      resultado.dealId &&
      String(resultado.pipeline) === expectedPipeline &&
      (
        String(resultado.stage) === expectedStage ||
        (String(expectedPipeline) === HUBSPOT_PIPELINE_CLOSER_ID &&
          !ENFORCE_EXACT_STAGE &&
          ACCEPTED_CLOSER_STAGES.has(String(resultado.stage)))
      )
    ) {
      statusFinal = 'concluido';
      hubspotData.status = 'concluido';
      hubspotData.pipeline = resultado.pipeline;
      hubspotData.stage = resultado.stage;
      hubspotData.pipelineNome = resultado.pipelineNome || resultado.pipeline;
      hubspotData.stageNome = resultado.stageNome || resultado.stage;
      hubspotData.ruleApplied = resultado.ruleApplied || null;
      hubspotData.lastUpdatedAt = resultado.lastUpdatedAt || null;
      hubspotData.mensagem =
        resultado.message ||
        RULE_LABELS[resultado.ruleApplied] ||
        'Movimentação concluída com sucesso.';
    } else if (resultado && resultado.dealId) {
      statusFinal = 'fora_pipeline';
      hubspotData.status = 'fora_pipeline';
      hubspotData.pipeline = resultado.pipeline || null;
      hubspotData.stage = resultado.stage || null;
      hubspotData.pipelineNome = resultado.pipelineNome || resultado.pipeline || 'Pipeline desconhecido';
      hubspotData.stageNome = resultado.stageNome || resultado.stage || 'Etapa desconhecida';
      hubspotData.ruleApplied = resultado.ruleApplied || null;
      hubspotData.lastUpdatedAt = resultado.lastUpdatedAt || null;
      hubspotData.mensagem =
        `Card foi atribuído mas está no pipeline "${hubspotData.pipelineNome}" ` +
        `na etapa "${hubspotData.stageNome}", fora do destino esperado ` +
        `("${destination.name}": pipeline ${expectedPipeline} / etapa ${expectedStage}). ` +
        `Verifique manualmente.`;
    } else {
      statusFinal = 'pendente';
      hubspotData.status = 'pendente';
      hubspotData.mensagem = 'Movimentação não pôde ser concluída. Revise os dados do cliente.';
    }

    const observacaoTexto =
      hubspotData.status === 'bloqueado'
        ? describeBlockedReason(hubspotData)
        : (hubspotData.mensagem || RULE_LABELS[hubspotData.ruleApplied] || '');

    const novoObservacao = {
      ...observacaoAtual,
      processado: true,
      dealId: dealId || observacaoAtual.dealId || null,
      hubspot: hubspotData,
      motivoOriginal: ticket.motivo_solicitacao || '',
      observacao: observacaoTexto,
      regra: hubspotData.ruleApplied || null,
      colaboradorDestinoNome: ticket.colaborador_destino_nome,
      colaboradorDestinoEmail: colaboradorEmail,
      validacaoFinal: true,
      produto: observacaoAtual.produto || produto || null,
      destinoEsperado: destination.name,
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

    let suporteStatus = 'EM ANDAMENTO';
    if (statusFinal === 'concluido') suporteStatus = 'CONCLUÍDO';
    else if (statusFinal === 'bloqueado') suporteStatus = 'BLOQUEADO';
    else if (statusFinal === 'erro') suporteStatus = 'ERRO';
    else if (statusFinal === 'aviso') suporteStatus = 'AVISO';
    else if (statusFinal === 'fora_pipeline') suporteStatus = 'EM ANDAMENTO';

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

    if (statusFinal !== 'concluido') {
      try {
        await teamsNotificador.enviar({
          titulo: 'Movimentação de Lead',
          assunto: 'Movimentacao',
          descricao:
            `Movimentação solicitada: ${nomeCompleto} | ` +
            `Tel: ${ticket.telefone_cliente_informado || 'N/A'} | ` +
            `Equipe destino: ${ticket.equipe_destino_nome || 'N/A'} | ` +
            `Produto: ${produto || 'N/A'} | ` +
            `Destino esperado: ${destination.name} | ` +
            `Status: ${statusFinal}`,
          solicitante: ticket.colaborador_origem_nome || 'N/A',
          equipe: ticket.equipe_origem_nome || 'N/A',
          anexosMarkdown: 'Nenhum anexo',
          cliente: nomeCompleto,
          telefone: ticket.telefone_cliente_informado || 'N/A',
          equipeDestino: ticket.equipe_destino_nome || 'N/A',
          assessorDestino: ticket.colaborador_destino_nome || 'N/A',
          status: statusFinal,
          mensagem: observacaoTexto || 'N/A',
          regra: hubspotData.ruleApplied || null,
          pipeline: hubspotData.pipelineNome || hubspotData.pipeline || null,
          stage: hubspotData.stageNome || hubspotData.stage || null,
          produto: produto || null,
          requiredHours: hubspotData.requiredHours,
          hoursSinceNote: hubspotData.hoursSinceNote,
          notesLastUpdated: hubspotData.notesLastUpdated,
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
      observacao: `Erro: ${error.message}`,
      processado: true,
      produto: observacaoAtual.produto || produto || null,
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