// backend/routes/suporte.js
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { pool } from '../services/db.js';
import { searchContact, createContact } from '../services/hubspot.js';
import teamsNotificador from '../suporte/teams_notificacoes.js';
import { broadcastNotification } from './notificacoes.js'; // ✅ SSE

const router = express.Router();

const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';

const STATUS_MAP = {
  pendente: 'Aberto',
  processando: 'Em Andamento',
  concluido: 'Concluído',
  suporte: 'Aguardando Suporte',
  aviso: 'Aviso',
  erro: 'Erro',
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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB por arquivo
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|pdf|doc|docx|xls|xlsx|txt|zip/;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.test(ext)) cb(null, true);
    else cb(new Error('Formato de arquivo não suportado'));
  }
});

// ==================== REGISTO DE TICKET DE MOVIMENTAÇÃO ====================
router.post('/ticket-movimentacao', async (req, res) => {
  try {
    const {
      crm_origem = 'CRM',
      crm_lead_id: rawCrmLeadId = null,
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
      equipe_destino_nome,
      motivo_solicitacao: rawMotivo = null,
      observacao_sales_ops: rawObs = null,
      status_mapeamento = 'pendente',
    } = req.body;

    if (!nome_cliente_informado || !sobrenome_cliente_informado || !email_cliente_informado) {
      return res.status(400).json({ success: false, error: 'Nome, sobrenome e e‑mail são obrigatórios.' });
    }

    const toNull = (val) => (val === 'null' || val === null || val === undefined ? null : val);
    const crmLeadId = toNull(rawCrmLeadId);
    const observacao = toNull(rawObs);

    let motivoSolicitacao = toNull(rawMotivo);
    if (motivoSolicitacao === null) motivoSolicitacao = '';

    const cpfNumerico = cpf_cliente_informado ? cpf_cliente_informado.replace(/\D/g, '') : null;
    const cpfFinal = cpfNumerico && cpfNumerico.length > 11 ? cpfNumerico.substring(0, 11) : cpfNumerico;

    const descricao = `Cliente: ${nome_cliente_informado} ${sobrenome_cliente_informado} | E‑mail: ${email_cliente_informado} | Origem: ${origem_cliente_informada || 'N/A'} | Destino: ${colaborador_destino_nome} (${equipe_destino_nome || 'N/A'})`;

    const metadadosBase = {
      origem_colaborador: colaborador_origem_nome || '',
      origem_equipe: equipe_origem_nome || '',
      destino_colaborador: colaborador_destino_nome || '',
      destino_equipe: equipe_destino_nome || '',
    };

    // 1. Criar ticket base na tabela tickets_suporte
    const baseResult = await pool.query(
      `INSERT INTO app_comissionamento.tickets_suporte 
         (solicitante_usuario_id, categoria, tipo_ticket, prioridade, status, titulo, descricao, origem_ticket, encaminhado_em, atualizado_em, metadados)
       VALUES ($1, 'Movimentacao', 'Movimentacao', 'NORMAL', 'Aberto', 'movimentacao card', $2, 'suporte comissionamento', NOW(), NOW(), $3)
       RETURNING id_ticket`,
      [PLACEHOLDER_UUID, descricao, JSON.stringify(metadadosBase)]
    );
    const ticketId = baseResult.rows[0].id_ticket;

    // 2. Inserir na tabela de movimentação
    const insertQuery = `
      INSERT INTO app_comissionamento.tickets_movimentacao_lead (
        ticket_id,
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
        $10, $11, $12, $13, $14, NOW()
      )
      RETURNING id_ticket_movimentacao
    `;

    const values = [
      ticketId,
      crm_origem, crmLeadId,
      nome_cliente_informado, sobrenome_cliente_informado,
      email_cliente_informado, telefone_cliente_informado || null,
      cpfFinal || null, origem_cliente_informada,
      tipo_solicitacao,
      colaborador_destino_nome,
      motivoSolicitacao,
      status_mapeamento,
      observacao,
    ];

    const result = await pool.query(insertQuery, values);

    // Integração com HubSpot (em background)
    (async () => {
      try {
        let contact = await searchContact({
          email: email_cliente_informado,
          phone: telefone_cliente_informado,
          cpf: cpf_cliente_informado,
        });

        if (!contact) {
          contact = await createContact({
            firstName: nome_cliente_informado,
            lastName: sobrenome_cliente_informado,
            email: email_cliente_informado,
            phone: telefone_cliente_informado,
            cpf: cpf_cliente_informado,
          });
          console.log('✅ HubSpot: contacto criado com ID', contact.id);
        } else {
          console.log('ℹ️ HubSpot: contacto já existe (ID', contact.id, ')');
        }
      } catch (hubspotError) {
        console.error('❌ HubSpot: erro na integração:', hubspotError.message);
      }
    })();

    return res.status(201).json({
      success: true,
      message: 'Ticket de movimentação registrado com sucesso.',
      id: result.rows[0].id_ticket_movimentacao,
    });
  } catch (err) {
    console.error('Erro ao registrar ticket:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

// ==================== REGISTO DE TICKET DE SUPORTE (REPORTAR) COM UPLOAD ====================
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

    // Processa arquivos enviados
    const arquivos = req.files || [];
    const baseUrl = `${req.protocol}://${req.get('host')}/uploads/suporte/`;
    const arquivosComUrl = arquivos.map(file => ({
      nome: file.originalname,
      url: baseUrl + file.filename,
    }));

    // Monta string markdown para links de anexos
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

    // Insere no banco: categoria agora recebe o assunto
    const result = await pool.query(
      `INSERT INTO app_comissionamento.tickets_suporte 
         (solicitante_usuario_id, categoria, tipo_ticket, prioridade, status, titulo, descricao, origem_ticket, encaminhado_em, atualizado_em, metadados)
       VALUES ($1, $2, 'Reporte', 'NORMAL', 'Aberto', $3, $4, 'suporte comissionamento', NOW(), NOW(), $5)
       RETURNING id_ticket`,
      [
        PLACEHOLDER_UUID,
        assunto,                // categoria = assunto
        titulo.trim(),
        descricao,
        JSON.stringify(metadados),
      ]
    );

    // Envia notificação para o Power Automate com anexos em markdown
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
    const { status_mapeamento, colaborador_origem_nome, todos } = req.query;
    let query = `
      SELECT 
        tml.id_ticket_movimentacao,
        tml.ticket_id,
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
      if (colaborador_origem_nome) {
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

    if (!status_mapeamento && observacao_sales_ops === undefined) {
      return res.status(400).json({ success: false, error: 'Nenhum campo para atualizar.' });
    }

    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    if (status_mapeamento) {
      setClauses.push(`status_mapeamento = $${paramIndex++}`);
      values.push(status_mapeamento);
    }
    if (observacao_sales_ops !== undefined) {
      setClauses.push(`observacao_sales_ops = $${paramIndex++}`);
      values.push(observacao_sales_ops);
    }

    setClauses.push(`atualizado_em = NOW()`);

    const updateMovimentacaoQuery = `
      UPDATE app_comissionamento.tickets_movimentacao_lead
      SET ${setClauses.join(', ')}
      WHERE id_ticket_movimentacao = $${paramIndex}
      RETURNING ticket_id
    `;
    values.push(id);

    const movResult = await pool.query(updateMovimentacaoQuery, values);
    if (movResult.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Ticket de movimentação não encontrado.' });
    }

    const ticketId = movResult.rows[0].ticket_id;

    if (status_mapeamento) {
      const statusSuporte = STATUS_MAP[status_mapeamento] || 'Aberto';
      await pool.query(
        `UPDATE app_comissionamento.tickets_suporte 
         SET status = $1, atualizado_em = NOW()
         WHERE id_ticket = $2`,
        [statusSuporte, ticketId]
      );
    }

    if (observacao_sales_ops && observacao_sales_ops.trim() !== '') {
      await pool.query(
        `UPDATE app_comissionamento.tickets_suporte 
         SET descricao = descricao || ' | Observação (' || to_char(NOW(), 'DD/MM/YYYY HH24:MI') || '): ' || $1,
             atualizado_em = NOW()
         WHERE id_ticket = $2`,
        [observacao_sales_ops, ticketId]
      );
    }

    return res.json({ success: true, message: 'Ticket atualizado com sucesso (movimentação e ticket base).' });
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
      // Atualiza o JSON metadados -> observacao_sales_ops
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

    // ✅ Lógica de notificação SSE para status finais
    if (status && ['CONCLUÍDO', 'BLOQUEADO', 'ANALISE'].includes(status)) {
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
            broadcastNotification({
              tipo: 'info',
              titulo: '📢 Atualização da solicitação',
              mensagem: `Sua solicitação "${titulo}" foi marcada como ${status}.`,
              destinatario: solicitante_email,
              data: new Date().toISOString(),
            });
            console.log(`🔔 Notificação enviada para ${solicitante_email} sobre o ticket ${id}`);
          } else {
            console.warn(`⚠️ E-mail do solicitante não encontrado para o ticket ${id}`);
          }
        }
      } catch (notifErr) {
        console.error('Erro ao enviar notificação SSE:', notifErr);
      }
    }

    return res.json({ success: true, message: 'Ticket de suporte atualizado com sucesso.' });
  } catch (err) {
    console.error('Erro ao atualizar ticket de suporte:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

export default router;