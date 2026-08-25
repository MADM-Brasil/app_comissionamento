// backend/routes/suporte.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { pool } from '../services/db.js';
import {
  findContactAndValidate,
  createContact,
  garantirLeadNoCloser,
  findOwnerIdByEmail,
  getContactDeals,
  HUBSPOT_PIPELINE_CLOSER_ID,
  HUBSPOT_STAGE_EM_CONTATO_ID
} from '../services/hubspot.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';
import { broadcastNotification } from './notificacoes.js';

const router = express.Router();

const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';

const STATUS_MAP = {
  pendente: 'Aberto',
  processando: 'Em Andamento',
  concluido: 'Concluído',
  suporte: 'Aguardando Suporte',
  aviso: 'Aviso',
  erro: 'Erro',
  bloqueado: 'Bloqueado',
  fora_pipeline: 'Fora do Pipeline',
  no_pipeline: 'No Pipeline',
};

// ==================== CONFIGURAÇÃO DE UPLOAD ====================
const uploadDir = path.join(process.cwd(), 'uploads', 'suporte');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|pdf|doc|docx|xls|xlsx|txt|zip/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.test(ext)) cb(null, true);
    else cb(new Error('Formato de arquivo não suportado'));
  }
});

// ==================== REGISTRO DE TICKET DE MOVIMENTAÇÃO ====================
router.post('/ticket-movimentacao', async (req, res) => {
  try {
    const {
      crm_origem = 'CRM',
      crm_lead_id: rawCrmLeadId = null,
      lead_id: rawLeadId = null,
      nome_cliente_informado,
      sobrenome_cliente_informado,
      email_cliente_informado,
      telefone_cliente_informado,
      cpf_cliente_informado,
      origem_cliente_informada,
      tipo_solicitacao = 'Movimentação',
      colaborador_origem_nome,
      equipe_origem_nome,
      colaborador_destino_nome,
      colaborador_destino_email,
      equipe_destino_nome,
      motivo_solicitacao: rawMotivo = null,
      observacao_sales_ops: rawObs = null,
      status_mapeamento = 'pendente',
      idempotency_key,
    } = req.body;

    // ---------- Validação de campos ----------
    if (!nome_cliente_informado || !sobrenome_cliente_informado || !telefone_cliente_informado) {
      return res.status(400).json({ success: false, error: 'Nome, sobrenome e telefone são obrigatórios.' });
    }

    // ---------- Verificação de idempotência ----------
    if (idempotency_key) {
      const existing = await pool.query(
        `SELECT id_ticket_movimentacao FROM app_comissionamento.tickets_movimentacao_lead
         WHERE observacao_sales_ops IS NOT NULL
           AND LTRIM(observacao_sales_ops) LIKE '{%'
           AND observacao_sales_ops::jsonb->>'idempotency_key' = $1
         LIMIT 1`,
        [idempotency_key]
      );
      if (existing.rowCount > 0) {
        console.log(`🔁 Requisição duplicada detectada (idempotency_key: ${idempotency_key}). Retornando ticket existente.`);
        return res.status(200).json({
          success: true,
          message: 'Ticket de movimentação já registrado anteriormente.',
          id: existing.rows[0].id_ticket_movimentacao,
        });
      }
    }

    const toNull = (val) => (val === 'null' || val === null || val === undefined ? null : val);
    const crmLeadId = toNull(rawCrmLeadId);
    const leadId = toNull(rawLeadId);
    const observacaoInicial = toNull(rawObs);

    let motivoSolicitacao = toNull(rawMotivo);
    if (motivoSolicitacao === null) motivoSolicitacao = '';

    const cpfNumerico = cpf_cliente_informado ? cpf_cliente_informado.replace(/\D/g, '') : null;
    const cpfFinal = cpfNumerico && cpfNumerico.length > 11 ? cpfNumerico.substring(0, 11) : cpfNumerico;

    // 1. Criar ticket base na tabela tickets_suporte
    const descricaoBase = `Movimentação de lead solicitada por ${colaborador_origem_nome || 'N/A'}`;
    const metadadosBase = {
      assunto: 'Movimentacao',
      origem_colaborador: colaborador_origem_nome || '',
      origem_equipe: equipe_origem_nome || '',
      destino_colaborador: colaborador_destino_nome || '',
      destino_equipe: equipe_destino_nome || '',
      solicitante_email: req.user?.email || '',
      solicitante_nome: colaborador_origem_nome || req.user?.nome || '',
    };

    const baseResult = await pool.query(
      `INSERT INTO app_comissionamento.tickets_suporte 
         (solicitante_usuario_id, categoria, tipo_ticket, prioridade, status, titulo, descricao, origem_ticket, encaminhado_em, atualizado_em, metadados)
       VALUES ($1, 'Movimentacao', 'Movimentacao', 'NORMAL', 'Aberto', 'movimentacao card', $2, 'suporte comissionamento', NOW(), NOW(), $3)
       RETURNING id_ticket`,
      [PLACEHOLDER_UUID, descricaoBase, JSON.stringify(metadadosBase)]
    );
    const ticketId = baseResult.rows[0].id_ticket;

    // 2. Inserir o registro específico da movimentação
    const insertMovimentacaoQuery = `
      INSERT INTO app_comissionamento.tickets_movimentacao_lead (
        ticket_id,
        lead_id,
        crm_origem, crm_lead_id,
        nome_cliente_informado, sobrenome_cliente_informado,
        email_cliente_informado, telefone_cliente_informado,
        cpf_cliente_informado, origem_cliente_informada,
        tipo_solicitacao,
        colaborador_destino_nome,
        motivo_solicitacao,
        status_mapeamento,
        observacao_sales_ops,
        atualizado_em
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, NOW()
      )
      RETURNING id_ticket_movimentacao
    `;

    const movValues = [
      ticketId,
      leadId,
      crm_origem, crmLeadId,
      nome_cliente_informado, sobrenome_cliente_informado,
      email_cliente_informado, telefone_cliente_informado || null,
      cpfFinal || null, origem_cliente_informada,
      tipo_solicitacao,
      colaborador_destino_nome,
      motivoSolicitacao,
      status_mapeamento,
      observacaoInicial,
    ];

    const movResult = await pool.query(insertMovimentacaoQuery, movValues);
    const movimentacaoId = movResult.rows[0].id_ticket_movimentacao;

    // ==================== INTEGRAÇÃO HUBSPOT ====================
    let hubspotData = {};
    let resultado = null;

    try {
      const busca = await findContactAndValidate({
        email: email_cliente_informado,
        phone: telefone_cliente_informado,
        cpf: cpf_cliente_informado,
      });

      if (!busca.found) {
        if (!email_cliente_informado && !cpf_cliente_informado) {
          hubspotData.status = 'aviso';
          hubspotData.mensagem = 'Campos pendentes: preencha e‑mail ou CPF para tentar novamente.';
          resultado = { blocked: false, message: hubspotData.mensagem };
        } else {
          const novoContato = await createContact({
            firstName: nome_cliente_informado,
            lastName: sobrenome_cliente_informado,
            email: email_cliente_informado,
            phone: telefone_cliente_informado,
            cpf: cpf_cliente_informado,
            origem: origem_cliente_informada,
          });

          hubspotData.contactId = novoContato.id;
          hubspotData.existe = true;
          hubspotData.criadoAgora = true;
          console.log('✅ HubSpot: novo contato criado com ID', novoContato.id);

          await waitForDealCreation(novoContato.id, 2000, 3);

          const assessorEmail = colaborador_destino_email || '';
          let ownerId = null;
          if (assessorEmail) {
            ownerId = await findOwnerIdByEmail(assessorEmail);
            if (!ownerId) console.warn('⚠️ Owner não encontrado para e-mail:', assessorEmail);
            else console.log('👤 Owner encontrado:', ownerId);
          } else {
            console.warn('⚠️ E-mail do colaborador destino não fornecido. Owner não será preenchido.');
          }

          resultado = await garantirLeadNoCloser(
            novoContato.id,
            `${nome_cliente_informado} ${sobrenome_cliente_informado}`,
            ownerId,
            colaborador_destino_nome
          );
        }
      } else if (busca.divergente) {
        hubspotData.status = 'suporte';
        hubspotData.mensagem = busca.motivo || 'Dados divergentes do cadastro. Aguardando suporte.';
        hubspotData.contactId = busca.contact.id;
        hubspotData.existe = true;
        resultado = { blocked: false, message: hubspotData.mensagem };
      } else {
        hubspotData.contactId = busca.contact.id;
        hubspotData.existe = true;

        const assessorEmail = colaborador_destino_email || '';
        let ownerId = null;
        if (assessorEmail) {
          ownerId = await findOwnerIdByEmail(assessorEmail);
          if (!ownerId) console.warn('⚠️ Owner não encontrado para e-mail:', assessorEmail);
          else console.log('👤 Owner encontrado:', ownerId);
        } else {
          console.warn('⚠️ E-mail do colaborador destino não fornecido. Owner não será preenchido.');
        }

        resultado = await garantirLeadNoCloser(
          busca.contact.id,
          `${nome_cliente_informado} ${sobrenome_cliente_informado}`,
          ownerId,
          colaborador_destino_nome
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
    } catch (error) {
      console.error('❌ HubSpot: erro na integração:', error.message);
      hubspotData.erro = true;
      hubspotData.status = 'erro';
      hubspotData.mensagem = `Erro na integração HubSpot: ${error.message}`;
    }

    // ==================== ATUALIZA STATUS_MAPEAMENTO ====================
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

    await pool.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
       SET status_mapeamento = $1
       WHERE id_ticket_movimentacao = $2`,
      [statusFinal, movimentacaoId]
    );

    const observacaoJson = JSON.stringify({
      hubspot: hubspotData,
      motivoOriginal: motivoSolicitacao || '',
      idempotency_key: idempotency_key || null,
    });

    await pool.query(
      `UPDATE app_comissionamento.tickets_movimentacao_lead
       SET observacao_sales_ops = $1
       WHERE id_ticket_movimentacao = $2`,
      [observacaoJson, movimentacaoId]
    );

    // ==================== NOTIFICAÇÃO TEAMS ====================
    try {
      await teamsNotificador.enviar({
        titulo: 'Movimentação de Lead',
        assunto: 'Movimentacao',
        descricao: `Movimentação solicitada: ${nome_cliente_informado} ${sobrenome_cliente_informado} | Tel: ${telefone_cliente_informado || 'N/A'} | Equipe destino: ${equipe_destino_nome || 'N/A'}`,
        solicitante: colaborador_origem_nome || 'N/A',
        equipe: equipe_origem_nome || 'N/A',
        anexosMarkdown: 'Nenhum anexo',
        cliente: `${nome_cliente_informado} ${sobrenome_cliente_informado}`,
        telefone: telefone_cliente_informado || 'N/A',
        equipeDestino: equipe_destino_nome || 'N/A',
        assessorDestino: colaborador_destino_nome || 'N/A',
        status: hubspotData.status || 'N/A',
        mensagem: hubspotData.mensagem || 'N/A',
        pipeline: hubspotData.pipelineNome || hubspotData.pipeline || null,
        stage: hubspotData.stageNome || hubspotData.stage || null,
      });
    } catch (notifErr) {
      console.error('❌ Erro ao enviar notificação Teams para movimentação:', notifErr.message);
    }

    let mensagem;
    let success = true;
    if (hubspotData.status === 'aviso') {
      mensagem = hubspotData.mensagem || 'Campos pendentes.';
      success = false;
    } else if (hubspotData.status === 'suporte') {
      mensagem = hubspotData.mensagem || 'Dados divergentes do cadastro. Aguardando suporte.';
      success = false;
    } else if (hubspotData.status === 'bloqueado') {
      mensagem = hubspotData.mensagem;
      success = false;
    } else if (hubspotData.status === 'erro' || hubspotData.erro) {
      mensagem = hubspotData.mensagem || 'Erro na integração HubSpot.';
      success = false;
    } else if (hubspotData.status === 'concluido') {
      mensagem = hubspotData.mensagem || 'Card movido';
      success = true;
    } else {
      mensagem = 'Ticket de movimentação registrado com sucesso.';
      success = true;
    }

    return res.status(201).json({
      success,
      message: mensagem,
      id: movimentacaoId,
    });
  } catch (err) {
    console.error('Erro ao registrar ticket:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

// Função auxiliar para aguardar automação do HubSpot criar negócio
async function waitForDealCreation(contactId, intervalMs, attempts) {
  for (let i = 0; i < attempts; i++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const deals = await getContactDeals(contactId);
    if (deals.length > 0) {
      console.log(`🔎 Automação HubSpot criou negócio(s). Encontrados: ${deals.length}`);
      return;
    }
    console.log(`⏳ Aguardando automação... tentativa ${i + 1}/${attempts}`);
  }
}

// ==================== REGISTRO DE TICKET DE SUPORTE (REPORTAR) COM UPLOAD ====================
router.post('/ticket-suporte', upload.array('arquivos', 5), async (req, res) => {
  try {
    const {
      titulo,
      assunto,
      descricao,
      solicitante_nome,
      solicitante_email,
      equipe_nome,
    } = req.body;

    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ success: false, error: 'Título é obrigatório.' });
    }
    if (!assunto || !descricao) {
      return res.status(400).json({ success: false, error: 'Assunto e descrição são obrigatórios.' });
    }

    const solicitanteNome = req.user?.nome || solicitante_nome || 'frontend';
    const solicitanteEmail = solicitante_email || req.user?.email || '';
    const equipeNome = req.user?.equipe || equipe_nome || '';

    const arquivos = req.files || [];
    const baseUrl = `${req.protocol}://${req.get('host')}/uploads/suporte/`;
    const arquivosComUrl = arquivos.map(file => ({
      nome: file.originalname,
      url: baseUrl + file.filename,
    }));

    const anexosMarkdown = arquivosComUrl.length > 0
      ? arquivosComUrl.map(a => `[${a.nome}](${a.url})`).join(', ')
      : 'Nenhum anexo';

    const metadados = {
      arquivos: arquivosComUrl,
      solicitante_nome: solicitanteNome,
      solicitante_email: solicitanteEmail,
      equipe_nome: equipeNome,
      observacao_sales_ops: '',
      assunto: assunto,
    };

    const result = await pool.query(
      `INSERT INTO app_comissionamento.tickets_suporte 
         (solicitante_usuario_id, categoria, tipo_ticket, prioridade, status, titulo, descricao, origem_ticket, encaminhado_em, atualizado_em, metadados)
       VALUES ($1, $2, 'Reporte', 'NORMAL', 'Aberto', $3, $4, 'suporte comissionamento', NOW(), NOW(), $5)
       RETURNING id_ticket`,
      [
        PLACEHOLDER_UUID,
        assunto,
        titulo.trim(),
        descricao,
        JSON.stringify(metadados),
      ]
    );

    teamsNotificador.enviar({
      titulo: titulo.trim(),
      assunto,
      descricao,
      solicitante: solicitanteNome,
      equipe: equipeNome,
      anexosMarkdown,
      arquivos: arquivosComUrl,
    }).then((resNotif) => {
      console.log('📤 Notificação Teams:', resNotif);
    }).catch((err) => {
      console.error('❌ Erro ao enviar notificação Teams:', err);
    });

    return res.status(201).json({
      success: true,
      message: 'Ticket de suporte registado com sucesso.',
      id_ticket: result.rows[0].id_ticket,
    });
  } catch (err) {
    console.error('Erro ao registar ticket de suporte:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

// ==================== LISTAGEM DE TICKETS DE MOVIMENTAÇÃO ====================
router.get('/tickets-movimentacao', async (req, res) => {
  try {
    const { status_mapeamento, colaborador_origem_nome, todos, solicitante_email } = req.query;
    let query = `
      SELECT 
        tml.id_ticket_movimentacao,
        tml.ticket_id,
        tml.lead_id,
        tml.crm_origem,
        tml.tipo_solicitacao,
        tml.nome_cliente_informado,
        tml.sobrenome_cliente_informado,
        tml.email_cliente_informado,
        tml.telefone_cliente_informado,
        tml.cpf_cliente_informado,
        tml.origem_cliente_informada,
        COALESCE(ts.metadados->>'origem_colaborador', '') AS colaborador_origem_nome,
        COALESCE(ts.metadados->>'origem_equipe', '') AS equipe_origem_nome,
        tml.colaborador_destino_nome,
        COALESCE(ts.metadados->>'destino_equipe', '') AS equipe_destino_nome,
        tml.status_mapeamento,
        tml.observacao_sales_ops,
        tml.motivo_solicitacao,
        tml.atualizado_em AS criado_em
      FROM app_comissionamento.tickets_movimentacao_lead tml
      LEFT JOIN app_comissionamento.tickets_suporte ts ON tml.ticket_id = ts.id_ticket
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status_mapeamento) {
      query += ` AND tml.status_mapeamento = $${paramIndex++}`;
      params.push(status_mapeamento);
    }

    if (todos !== '1') {
      if (solicitante_email) {
        query += ` AND LOWER(TRIM(COALESCE(ts.metadados->>'solicitante_email', ''))) = LOWER(TRIM($${paramIndex++}))`;
        params.push(solicitante_email);
      } else if (colaborador_origem_nome) {
        query += ` AND LOWER(TRIM(COALESCE(ts.metadados->>'origem_colaborador', ''))) = LOWER(TRIM($${paramIndex++}))`;
        params.push(colaborador_origem_nome);
      } else {
        return res.json({ success: true, data: [] });
      }
    }

    query += ' ORDER BY tml.atualizado_em DESC';

    const result = await pool.query(query, params);
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro ao listar tickets:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

// ==================== LISTAGEM DE TICKETS DE SUPORTE ====================
router.get('/ticket-suporte', async (req, res) => {
  try {
    const { solicitante_email, todos } = req.query;
    let query = `
      SELECT 
        id_ticket AS id_ticket_suporte,
        titulo,
        COALESCE(metadados->>'assunto', titulo) AS assunto,
        descricao,
        status,
        COALESCE(metadados->>'solicitante_nome', '') AS solicitante_nome,
        COALESCE(metadados->>'equipe_nome', '') AS equipe_nome,
        COALESCE(metadados->>'observacao_sales_ops', '') AS observacao_sales_ops,
        encaminhado_em AS criado_em
      FROM app_comissionamento.tickets_suporte
      WHERE tipo_ticket = 'Reporte'
    `;
    const params = [];
    let paramIndex = 1;

    if (todos === '1') {
      // Admin pode ver todos os reportes
    } else if (solicitante_email) {
      query += ` AND LOWER(TRIM(COALESCE(metadados->>'solicitante_email', ''))) = LOWER(TRIM($${paramIndex++}))`;
      params.push(solicitante_email);
    } else {
      return res.json({ success: true, data: [] });
    }

    query += ' ORDER BY encaminhado_em DESC';

    const result = await pool.query(query, params);
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro ao listar tickets de suporte:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

// ==================== ATUALIZAÇÃO DE TICKET DE MOVIMENTAÇÃO ====================
router.patch('/tickets-movimentacao/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status_mapeamento, observacao_sales_ops } = req.body;

    if (status_mapeamento === undefined && observacao_sales_ops === undefined) {
      return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const setClauses = [];
      const values = [];
      let paramIndex = 1;

      if (status_mapeamento !== undefined) {
        setClauses.push(`status_mapeamento = $${paramIndex++}`);
        values.push(status_mapeamento);
      }

      if (observacao_sales_ops !== undefined) {
        const current = await client.query(
          `SELECT observacao_sales_ops FROM app_comissionamento.tickets_movimentacao_lead WHERE id_ticket_movimentacao = $1`,
          [id]
        );

        let jsonAtual = {};
        if (current.rowCount > 0 && current.rows[0].observacao_sales_ops) {
          try {
            jsonAtual = JSON.parse(current.rows[0].observacao_sales_ops);
          } catch (e) {
            jsonAtual = {};
          }
        }

        jsonAtual.observacao = observacao_sales_ops;
        setClauses.push(`observacao_sales_ops = $${paramIndex++}`);
        values.push(JSON.stringify(jsonAtual));
      }

      setClauses.push(`atualizado_em = NOW()`);

      const updateMovimentacaoQuery = `
        UPDATE app_comissionamento.tickets_movimentacao_lead
        SET ${setClauses.join(', ')}
        WHERE id_ticket_movimentacao = $${paramIndex}
        RETURNING id_ticket_movimentacao, ticket_id
      `;
      values.push(id);

      const movResult = await client.query(updateMovimentacaoQuery, values);
      if (movResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ success: false, error: 'Ticket de movimentação não encontrado.' });
      }

      // Sincroniza status com tickets_suporte
      if (status_mapeamento !== undefined) {
        const ticketId = movResult.rows[0].ticket_id;
        const mappedStatus = STATUS_MAP[status_mapeamento] || status_mapeamento;

        await client.query(
          `UPDATE app_comissionamento.tickets_suporte
           SET status = $1, atualizado_em = NOW()
           WHERE id_ticket = $2`,
          [mappedStatus, ticketId]
        );
      }

      // Notificação SSE
      try {
        const ticketInfo = await client.query(
          `SELECT ts.titulo, ts.metadados->>'solicitante_email' AS solicitante_email
           FROM app_comissionamento.tickets_suporte ts
           JOIN app_comissionamento.tickets_movimentacao_lead tml ON tml.ticket_id = ts.id_ticket
           WHERE tml.id_ticket_movimentacao = $1`,
          [id]
        );

        if (ticketInfo.rowCount > 0) {
          const { titulo, solicitante_email } = ticketInfo.rows[0];
          if (solicitante_email) {
            const statusLabel = status_mapeamento || 'inalterado';
            const obsLabel = observacao_sales_ops !== undefined ? observacao_sales_ops : 'inalterada';
            broadcastNotification({
              tipo: 'info',
              titulo: '📢 Atualização da movimentação',
              mensagem: `Sua solicitação de movimentação "${titulo}" foi atualizada.\nNovo status: ${statusLabel}.\nObservação: ${obsLabel}`,
              destinatario: solicitante_email,
              data: new Date().toISOString(),
            });
          }
        }
      } catch (notifErr) {
        console.error('Erro ao enviar notificação SSE (movimentação):', notifErr);
      }

      await client.query('COMMIT');
      return res.json({ success: true, message: 'Ticket atualizado com sucesso.' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Erro ao atualizar ticket:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

// ==================== ATUALIZAÇÃO DE TICKET DE SUPORTE ====================
router.patch('/tickets-suporte/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, observacao_sales_ops } = req.body;

    if (!status && observacao_sales_ops === undefined) {
      return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar.' });
    }

    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    if (status) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(status);
    }

    if (observacao_sales_ops !== undefined) {
      setClauses.push(`metadados = jsonb_set(COALESCE(metadados, '{}'), '{observacao_sales_ops}', to_jsonb($${paramIndex++}::text))`);
      values.push(observacao_sales_ops);
    }

    setClauses.push(`atualizado_em = NOW()`);

    const query = `
      UPDATE app_comissionamento.tickets_suporte
      SET ${setClauses.join(', ')}
      WHERE id_ticket = $${paramIndex}
      RETURNING id_ticket
    `;
    values.push(id);

    const result = await pool.query(query, values);
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Ticket de suporte não encontrado.' });
    }

    // Notificação SSE
    try {
      const ticketResult = await pool.query(
        `SELECT titulo, metadados->>'solicitante_email' AS solicitante_email
         FROM app_comissionamento.tickets_suporte
         WHERE id_ticket = $1`,
        [id]
      );

      if (ticketResult.rows.length > 0) {
        const { titulo, solicitante_email } = ticketResult.rows[0];
        if (solicitante_email) {
          const statusLabel = status || 'inalterado';
          const obsLabel = observacao_sales_ops !== undefined ? observacao_sales_ops : 'inalterada';
          broadcastNotification({
            tipo: 'info',
            titulo: '📢 Atualização da solicitação',
            mensagem: `Sua solicitação "${titulo}" foi atualizada.\nNovo status: ${statusLabel}.\nObservação: ${obsLabel}`,
            destinatario: solicitante_email,
            data: new Date().toISOString(),
          });
        }
      }
    } catch (notifErr) {
      console.error('Erro ao enviar notificação SSE (suporte):', notifErr);
    }

    return res.json({ success: true, message: 'Ticket de suporte atualizado com sucesso.' });
  } catch (err) {
    console.error('Erro ao atualizar ticket de suporte:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

export default router;