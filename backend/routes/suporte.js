// routes/suporte.js
import express from 'express';
import { pool } from '../services/db.js';
import { searchContact, createContact } from '../services/hubspot.js';

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

// ════════════════════════════════════════════════════════════════════════════
// ANTES DE USAR, execute no banco de dados:
//   ALTER TABLE app_comissionamento.tickets_suporte
//     ADD COLUMN IF NOT EXISTS solicitante_nome TEXT,
//     ADD COLUMN IF NOT EXISTS equipe_nome TEXT,
//     ADD COLUMN IF NOT EXISTS observacao_sales_ops TEXT;
//
//   -- Se a coluna metadados permitir NULL, não precisa alterar.
//   -- Mas para garantir consistência, defina um valor padrão:
//   ALTER TABLE app_comissionamento.tickets_suporte
//     ALTER COLUMN metadados SET DEFAULT '{}'::jsonb;
// ════════════════════════════════════════════════════════════════════════════

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

    const descricao = `Cliente: ${nome_cliente_informado} ${sobrenome_cliente_informado} | E‑mail: ${email_cliente_informado} | Origem: ${origem_cliente_informada || 'N/A'} | Destino: ${colaborador_destino_nome} (${equipe_destino_nome})`;

    // 1. Criar ticket base na tabela tickets_suporte
    const baseResult = await pool.query(
      `INSERT INTO app_comissionamento.tickets_suporte 
         (solicitante_usuario_id, categoria, tipo_ticket, prioridade, status, titulo, descricao, origem_ticket, metadados, criado_em, atualizado_em)
       VALUES ($1, 'Movimentacao', 'Movimentacao', 'AUTO', 'Aberto', 'movimentacao card', $2, 'suporte comissionamento', '{}'::jsonb, NOW(), NOW())
       RETURNING id_ticket`,
      [PLACEHOLDER_UUID, descricao]
    );
    const ticketId = baseResult.rows[0].id_ticket;

    // 2. Inserir na tabela de movimentação
    const safe = {
      ticket_id:                    ticketId,
      crm_origem:                   crm_origem,
      crm_lead_id:                  crmLeadId,
      nome_cliente_informado:       nome_cliente_informado,
      sobrenome_cliente_informado:  sobrenome_cliente_informado,
      email_cliente_informado:      email_cliente_informado,
      telefone_cliente_informado:   telefone_cliente_informado,
      cpf_cliente_informado:        cpfFinal,
      origem_cliente_informada:     origem_cliente_informada,
      tipo_solicitacao:             tipo_solicitacao,
      colaborador_origem_nome:      colaborador_origem_nome,
      equipe_origem_nome:           equipe_origem_nome,
      colaborador_destino_nome:     colaborador_destino_nome,
      equipe_destino_nome:          equipe_destino_nome,
      motivo_solicitacao:           motivoSolicitacao,
      observacao_sales_ops:         observacao,
      status_mapeamento:            status_mapeamento,
    };

    console.log('📦 Dados finais para inserção:');
    Object.entries(safe).forEach(([key, value]) => {
      console.log(`   ${key}: "${value}" (${value ? String(value).length : 0} caracteres)`);
    });

    const query = `
      INSERT INTO app_comissionamento.tickets_movimentacao_lead (
        ticket_id,
        crm_origem, crm_lead_id,
        nome_cliente_informado, sobrenome_cliente_informado,
        email_cliente_informado, telefone_cliente_informado,
        cpf_cliente_informado, origem_cliente_informada,
        tipo_solicitacao,
        colaborador_origem_nome, equipe_origem_nome,
        colaborador_destino_nome, equipe_destino_nome,
        motivo_solicitacao, observacao_sales_ops,
        status_mapeamento, criado_em, atualizado_em
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17,
        NOW(), NOW()
      )
      RETURNING id_ticket_movimentacao
    `;

    const values = [
      safe.ticket_id,
      safe.crm_origem, safe.crm_lead_id,
      safe.nome_cliente_informado, safe.sobrenome_cliente_informado,
      safe.email_cliente_informado, safe.telefone_cliente_informado || null,
      safe.cpf_cliente_informado || null, safe.origem_cliente_informada,
      safe.tipo_solicitacao,
      safe.colaborador_origem_nome || req.session?.userId || 'frontend',
      safe.equipe_origem_nome || '',
      safe.colaborador_destino_nome, safe.equipe_destino_nome,
      safe.motivo_solicitacao, safe.observacao_sales_ops,
      safe.status_mapeamento,
    ];

    const result = await pool.query(query, values);

    // ========== INTEGRAÇÃO COM HUBSPOT (em background) ==========
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

// ==================== REGISTO DE TICKET DE SUPORTE (REPORTAR) ====================
router.post('/ticket-suporte', async (req, res) => {
  try {
    const {
      assunto,
      descricao,
      files = [],
    } = req.body;

    if (!assunto || !descricao) {
      return res.status(400).json({ success: false, error: 'Assunto e descrição são obrigatórios.' });
    }

    // Garante que metadados nunca seja NULL
    const metadados = files.length > 0 ? { arquivos: files } : {};
    const metadadosJson = JSON.stringify(metadados);

    // Obtém o nome do utilizador e equipa da sessão (ou usa fallback)
    const solicitanteNome = req.user?.nome || req.body?.solicitante_nome || 'frontend';
    const equipeNome = req.user?.equipe || req.body?.equipe_nome || '';

    const result = await pool.query(
      `INSERT INTO app_comissionamento.tickets_suporte 
         (solicitante_usuario_id, categoria, tipo_ticket, prioridade, status, titulo, descricao, origem_ticket, metadados, solicitante_nome, equipe_nome, criado_em, atualizado_em)
       VALUES ($1, $2, $3, NULL, 'Aberto', $4, $5, 'suporte comissionamento', $6, $7, $8, NOW(), NOW())
       RETURNING id_ticket`,
      [
        PLACEHOLDER_UUID,
        'Reporte',
        'Reporte',
        assunto,
        descricao,
        metadadosJson,
        solicitanteNome,
        equipeNome,
      ]
    );

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
      SELECT id_ticket_movimentacao, ticket_id, crm_origem, tipo_solicitacao,
             nome_cliente_informado, sobrenome_cliente_informado,
             email_cliente_informado, telefone_cliente_informado,
             cpf_cliente_informado, origem_cliente_informada,
             colaborador_origem_nome, equipe_origem_nome,
             colaborador_destino_nome, equipe_destino_nome,
             status_mapeamento, observacao_sales_ops, criado_em
      FROM app_comissionamento.tickets_movimentacao_lead
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status_mapeamento) {
      query += ` AND status_mapeamento = $${paramIndex++}`;
      params.push(status_mapeamento);
    }
    if (!todos || todos !== '1') {
      if (colaborador_origem_nome) {
        query += ` AND LOWER(TRIM(colaborador_origem_nome)) = LOWER(TRIM($${paramIndex++}))`;
        params.push(colaborador_origem_nome);
      }
    }

    query += ' ORDER BY criado_em DESC';

    const result = await pool.query(query, params);
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro ao listar tickets:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

// ==================== LISTAGEM DE TICKETS DE SUPORTE (NOVO) ====================
router.get('/ticket-suporte', async (req, res) => {
  try {
    const { solicitante_nome, todos } = req.query;
    let query = `
      SELECT id_ticket AS id_ticket_suporte,
             titulo AS assunto,
             descricao,
             solicitante_nome,
             equipe_nome,
             status,
             COALESCE(observacao_sales_ops, '') AS observacao_sales_ops,
             criado_em
      FROM app_comissionamento.tickets_suporte
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (todos === '1') {
      // Administrador pode ver todos; opcional: verificar permissão aqui
      // Nenhum filtro adicional
    } else if (solicitante_nome) {
      query += ` AND LOWER(TRIM(solicitante_nome)) = LOWER(TRIM($${paramIndex++}))`;
      params.push(solicitante_nome);
    } else {
      // Sem filtro? retorna array vazio (ou todos, dependendo da regra)
      // Aqui devolve vazio por segurança
      return res.json({ success: true, data: [] });
    }

    query += ' ORDER BY criado_em DESC';

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

    // === 1. Atualiza a tabela de movimentação ===
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

    // Auditoria
    setClauses.push(`analisado_por_usuario_id = $${paramIndex++}`);
    values.push(PLACEHOLDER_UUID);
    setClauses.push(`analisado_em = NOW()`);
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

    // === 2. Atualiza o ticket base (tickets_suporte) ===
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

// ==================== ATUALIZAÇÃO DE TICKET DE SUPORTE (NOVO) ====================
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
      setClauses.push(`observacao_sales_ops = $${paramIndex++}`);
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

    return res.json({ success: true, message: 'Ticket de suporte atualizado com sucesso.' });
  } catch (err) {
    console.error('Erro ao atualizar ticket de suporte:', err);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor.' });
  }
});

export default router;