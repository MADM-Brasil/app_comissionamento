// backend/services/ticketQueue.js
import { pool } from './db.js';
import {
  findContactAndValidate,
  createContact,
  garantirLeadNoCloser,
  findOwnerIdByEmail,
  validateFinalAssignment,
  HUBSPOT_PIPELINE_CLOSER_ID,
  HUBSPOT_PIPELINE_QUINQUENIO_ID,
  HUBSPOT_PIPELINE_ISENCAO_IR_ID,
  HUBSPOT_PORTAL_ID_CONFIGURED,
  HUBSPOT_STAGE_EM_CONTATO_ID,
  HUBSPOT_STAGE_QUINQUENIO_EM_CONTATO_ID,
  HUBSPOT_STAGE_ISENCAO_IR_EM_CONTATO_ID,
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
  reassigned_by_coordinator_validation: 'Card reatribuído com autorização do coordenador.',
  already_assigned: 'Card já estava com o responsável informado; contato alinhado.',
  ambiguous_deals: 'Contato associado a vários cards.',
  fallback_block: 'Card fora dos pipelines permitidos.',
  owned_by_another_recent_activity: 'Card pertence a outro responsável e a última modificação está dentro do prazo mínimo.',
  owner_missing: 'Responsável destino não informado.',
  missing_email: 'Campos pendentes: preencha e-mail para tentar novamente.',
  invalid_email: 'E-mail inválido. Corrija e reenvie.',
  contact_data_mismatch: 'Dados divergentes do cadastro da HubSpot. Valide as informações registradas.',
  contact_has_juridico_deal:
    'Movimentação bloqueada: o contato possui um negócio no pipeline Jurídico Auditoria de Ganho.',
  product_pipeline_routing: 'Produto exige pipeline dedicado; movimentação executada.',
});

function isQuinquenioOuConcomitante(produto) {
  const normalized = String(produto ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /\b(?:quinquenio|quinqueino|concomitantes?)\b/.test(normalized);
}

function isIsencaoIR(produto) {
  const normalized = String(produto ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return /\bisencao\b/.test(normalized) && /\bir\b/.test(normalized);
}

function expectedDestination(produto) {
  if (isQuinquenioOuConcomitante(produto)) {
    return {
      pipeline: HUBSPOT_PIPELINE_QUINQUENIO_ID,
      stage: HUBSPOT_STAGE_QUINQUENIO_EM_CONTATO_ID,
      name: 'Quinquenio/concomitante',
    };
  }
  if (isIsencaoIR(produto)) {
    return {
      pipeline: HUBSPOT_PIPELINE_ISENCAO_IR_ID,
      stage: HUBSPOT_STAGE_ISENCAO_IR_EM_CONTATO_ID,
      name: 'Isenção de IR Aposentadoria',
    };
  }
  return {
    pipeline: HUBSPOT_PIPELINE_CLOSER_ID,
    stage: HUBSPOT_STAGE_EM_CONTATO_ID,
    name: 'Closer',
  };
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
    console.error('[ticketQueue] Falha ao consultar unidade do solicitante:', error.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// [CORRIGIDO]
//   • `isProcessing = true` ANTES de `pool.connect()`
//   • `pool.connect()` DENTRO do try
//   • `if (client)` no finally ao dar release
//   • Qualquer erro do connect vira log controlado, não crash
// ═══════════════════════════════════════════════════════════════════
async function processTicketQueue() {
  if (isProcessing) return;
  isProcessing = true;                               // ← antes de qualquer await

  let client = null;
  let hasLock = false;

  try {
    client = await pool.connect();                   // ← dentro do try

    const lockResult = await client.query(`SELECT pg_try_advisory_lock($1)`, [LOCK_KEY]);
    hasLock = lockResult.rows[0].pg_try_advisory_lock === true;
    if (!hasLock) {
      console.log('⏭️ Outra instância está processando a fila. Aguardando...');
      return;
    }

    while (true) {
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

        // Best-effort: se a conexão morreu, os UPDATEs abaixo também falham.
        // Envolvemos em try/catch próprio para não propagar para o loop.
        try {
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
             SET status_mapeamento = 'suporte',
                 observacao_sales_ops = $1,
                 atualizado_em = NOW()
             WHERE id_ticket_movimentacao = $2`,
            [obs, ticket.id_ticket_movimentacao]
          );
          await client.query(
            `UPDATE app_comissionamento.tickets_suporte
             SET status = 'Aguardando Suporte', atualizado_em = NOW()
             WHERE id_ticket = $1`,
            [ticket.ticket_id]
          );
        } catch (persistErr) {
          console.error(
            `[ticketQueue] Falha ao persistir erro do ticket ${ticket.id_ticket_movimentacao}:`,
            persistErr?.message || persistErr
          );
        }
      }
    }
  } catch (err) {
    // Erros de infraestrutura (pool esgotado, timeout de connect, PG fora).
    // NÃO propagar — apenas logar. O próximo ciclo do setInterval tenta de novo.
    console.error('[ticketQueue] ciclo interrompido:', err?.message || err);
  } finally {
    if (client && hasLock) {
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
      } catch (unlockErr) {
        console.error('[ticketQueue] erro ao liberar advisory lock:', unlockErr?.message || unlockErr);
      }
    }
    if (client) {
      try {
        client.release();
      } catch (releaseErr) {
        // Conexão já morta — o pg-pool descarta sozinho.
        console.warn('[ticketQueue] release falhou (conexão já encerrada):', releaseErr?.message || releaseErr);
      }
    }
    isProcessing = false;
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

  const produto =
    observacaoAtual.produto ||
    ticket.metadados?.produto ||
    null;

  const bypassTemporalRestriction =
    observacaoAtual.validacaoCoordenador?.acao === 'autorizar' &&
    observacaoAtual.validacaoCoordenador?.bypassTemporalRestriction === true;

  const portalId = String(HUBSPOT_PORTAL_ID_CONFIGURED || '').trim();

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
            produto,
            { bypassTemporalRestriction }
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
      contactId = busca.contact.id;
      hubspotData.contactId = contactId;
      hubspotData.existe = true;
      hubspotData.status = 'aviso';
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
        produto,
        { bypassTemporalRestriction }
      );
      if (resultado && !resultado.blocked && resultado.dealId) {
        dealId = resultado.dealId;
      }
    }

    const expectedPipeline = String(resultado?.pipeline || destination.pipeline);
    const expectedStage = String(resultado?.stage || destination.stage);

    if (resultado && !resultado.blocked && contactId && dealId && ownerId) {
      const validateOptions = {
        produto,
        expectedPipeline,
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
      const isCoordinatorBlock = resultado.requiresCoordinator === true;
      statusFinal = isCoordinatorBlock ? 'coordenador' : 'bloqueado';
      hubspotData.status = statusFinal;
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
      resultado?.blocked
        ? describeBlockedReason(hubspotData)
        : (hubspotData.mensagem || RULE_LABELS[hubspotData.ruleApplied] || '');
    const validacaoCoordenador = observacaoAtual.validacaoCoordenador;
    const notaValidacaoCoordenador = validacaoCoordenador?.acao === 'autorizar'
      ? `Validado pelo coordenador (${validacaoCoordenador.nome || validacaoCoordenador.usuario || 'nome não informado'})`
      : '';
    const observacaoFinal = [observacaoTexto, notaValidacaoCoordenador]
      .filter(Boolean)
      .join('\n');

    const cardLink = dealId && /^\d+$/.test(portalId)
      ? `https://app.hubspot.com/contacts/${portalId}/record/0-3/${dealId}`
      : (contactId && /^\d+$/.test(portalId)
          ? `https://app.hubspot.com/contacts/${portalId}/record/0-1/${contactId}`
          : null);

    const novoObservacao = {
      ...observacaoAtual,
      processado: true,
      dealId: dealId || resultado?.dealId || observacaoAtual.dealId || null,
      link: cardLink || observacaoAtual.link || null,
      hubspot: hubspotData,
      motivoOriginal: ticket.motivo_solicitacao || '',
      observacao: observacaoFinal,
      regra: hubspotData.ruleApplied || null,
      colaboradorDestinoNome: ticket.colaborador_destino_nome,
      colaboradorDestinoEmail: colaboradorEmail,
      validacaoFinal: true,
      produto: observacaoAtual.produto || produto || null,
      destinoEsperado: destination.name,
      ...(bypassTemporalRestriction
        ? {
            validacaoCoordenador: {
              ...observacaoAtual.validacaoCoordenador,
              bypassTemporalRestriction: false,
              concluidoEm: new Date().toISOString(),
            },
          }
        : {}),
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
    else if (statusFinal === 'coordenador') suporteStatus = 'COORDENADOR';
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
        const unidadeId = (statusFinal === 'bloqueado' || statusFinal === 'coordenador')
          ? await requesterUnitId(client, ticket.metadados)
          : (ticket.metadados?.unidade_id ?? ticket.metadados?.unidadeId ?? null);
        const notification = await teamsNotificador.enviar({
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
          solicitanteEmail: ticket.metadados?.solicitante_email || null,
          equipe: ticket.equipe_origem_nome || 'N/A',
          anexosMarkdown: 'Nenhum anexo',
          cliente: nomeCompleto,
          telefone: ticket.telefone_cliente_informado || 'N/A',
          equipeDestino: ticket.equipe_destino_nome || 'N/A',
          assessorDestino: ticket.colaborador_destino_nome || 'N/A',
          status: (statusFinal === 'bloqueado' || statusFinal === 'coordenador')
            ? 'coordenador'
            : statusFinal,
          unidadeId,
          idTicketMovimentacao: ticket.id_ticket_movimentacao,
          idTicket: ticket.ticket_id,
          link: cardLink || null,
          dealId: dealId || null,
          mensagem: observacaoFinal || 'N/A',
          regra: hubspotData.ruleApplied || null,
          pipeline: hubspotData.pipelineNome || hubspotData.pipeline || null,
          stage: hubspotData.stageNome || hubspotData.stage || null,
          produto: produto || null,
          requiredHours: hubspotData.requiredHours,
          hoursSinceNote: hubspotData.hoursSinceNote,
          notesLastUpdated: hubspotData.notesLastUpdated,
        });
        if (!notification.success) {
          console.error('Falha ao enviar notificação Teams:', notification.error);
        }
      } catch (notifErr) {
        console.error('Erro ao enviar notificação Teams:', notifErr);
      }
    }
  } catch (error) {
    console.error(`Erro na integração HubSpot (ticket ${ticket.id_ticket_movimentacao}):`, error);

    const linkErro = contactId && /^\d+$/.test(portalId)
      ? `https://app.hubspot.com/contacts/${portalId}/record/0-1/${contactId}`
      : (dealId && /^\d+$/.test(portalId)
          ? `https://app.hubspot.com/contacts/${portalId}/record/0-3/${dealId}`
          : null);

    const obsErro = JSON.stringify({
      ...observacaoAtual,
      link: linkErro || observacaoAtual.link || null,
      hubspot: { ...hubspotData, erro: true, status: 'suporte', mensagem: error.message },
      motivoOriginal: ticket.motivo_solicitacao || '',
      observacao: [
        `Erro: ${error.message}`,
        observacaoAtual.validacaoCoordenador?.acao === 'autorizar'
          ? `Validado pelo coordenador (${observacaoAtual.validacaoCoordenador.nome || observacaoAtual.validacaoCoordenador.usuario || 'nome não informado'})`
          : '',
      ].filter(Boolean).join('\n'),
      processado: true,
      produto: observacaoAtual.produto || produto || null,
    });

    await client.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
       SET observacao_sales_ops = $1,
           status_mapeamento = 'suporte',
           analisado_em = NOW(),
           atualizado_em = NOW()
       WHERE id_ticket_movimentacao = $2`,
      [obsErro, ticket.id_ticket_movimentacao]
    );
    await client.query(
      `UPDATE app_comissionamento.tickets_suporte
       SET status = 'Aguardando Suporte', atualizado_em = NOW()
       WHERE id_ticket = $1`,
      [ticket.ticket_id]
    );
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════
// [CORRIGIDO] setInterval com .catch() — nenhuma rejeição escapa
// ═══════════════════════════════════════════════════════════════════
export function startTicketQueue(intervalMs = 5000) {
  const safeRun = () => {
    processTicketQueue().catch((err) => {
      console.error('[ticketQueue] falha não tratada no ciclo:', err?.stack || err?.message || err);
    });
  };

  const timer = setInterval(safeRun, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log('🔄 Fila de tickets de movimentação iniciada');
  return timer;
}