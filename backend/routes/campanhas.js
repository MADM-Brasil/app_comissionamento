// backend/routes/campanhas.js
import express from 'express';
import db from '../services/db.js';
import { broadcastNotification } from './notificacoes.js';

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

// Helper para obter cargo do usuário a partir do email
async function getUserRole(email) {
  try {
    const result = await db.query(
      `SELECT cargo FROM core.view_app_colaboradores WHERE email = $1 LIMIT 1`,
      [email]
    );
    return (result.rows[0]?.cargo || '').trim().toLowerCase();
  } catch (err) {
    console.error('Erro ao obter cargo do usuário:', err);
    return '';
  }
}

// Função auxiliar para obter e-mails dos super administradores
async function getSuperAdminEmails() {
  try {
    const result = await db.query(
      `SELECT email 
       FROM core.view_app_colaboradores 
       WHERE LOWER(TRIM(cargo)) IN ('super admin', 'superadmin', 'ceo', 'diretoria', 'desenvolvedor', 'admin')
         AND status = 'ativo'`
    );
    return result.rows.map(r => r.email);
  } catch (err) {
    console.error('Erro ao buscar super admins:', err);
    return [];
  }
}

// ============================================================
// GET /api/campanhas?mes=YYYY-MM
// Retorna todas as campanhas (aprovadas e pendentes) em um array.
// ============================================================
router.get('/', requireAuth, async (req, res) => {
  try {
    const { mes } = req.query;
    let query = `
      SELECT tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro
      FROM app_comissionamento.registro_campanhas
    `;
    const params = [];

    if (mes) {
      query += ` WHERE TO_CHAR(data_publicacao::date, 'YYYY-MM') = $1`;
      params.push(mes);
    }

    query += ` ORDER BY data_publicacao DESC, tipo`;

    const result = await db.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro ao buscar campanhas:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /api/campanhas
// Registra uma nova campanha. validacao_financeiro inicia como false.
// Permissão: coordenador, administrativo, super_admin, superadmin.
// Envia notificação para super admins.
// ============================================================
router.post('/', requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.userId;
    const role = await getUserRole(userEmail);

    const allowedRoles = ['coordenador', 'administrativo', 'super_admin', 'superadmin'];
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ success: false, error: 'Você não tem permissão para registrar campanhas.' });
    }

    const { tipo, multiplicador, produto, data_publicacao, descricao } = req.body;

    if (!tipo || !multiplicador || !produto || !data_publicacao || !descricao) {
      return res.status(400).json({
        success: false,
        error: 'Todos os campos são obrigatórios: tipo, multiplicador, produto, data_publicacao, descricao',
      });
    }

    const result = await db.query(
      `INSERT INTO app_comissionamento.registro_campanhas 
         (tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro`,
      [tipo, Number(multiplicador), produto, data_publicacao, descricao]
    );

    // Notifica super admins
    const superAdminEmails = await getSuperAdminEmails();
    for (const adminEmail of superAdminEmails) {
      broadcastNotification({
        tipo: 'warning',
        titulo: 'Nova campanha registrada',
        mensagem: `Campanha de ${tipo} registrada e aguardando validação financeira.`,
        destinatario: adminEmail,
        data: new Date().toISOString(),
      });
    }

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Erro ao registrar campanha:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// PATCH /api/campanhas/validacao
// Atualiza a validação financeira de uma campanha (true/false).
// Permissão: somente super_admin, superadmin, ceo, diretoria.
// Ao aprovar (true), dispara notificação em tempo real para todos.
// ============================================================
router.patch('/validacao', requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.userId;
    const role = await getUserRole(userEmail);
    const superAdminRoles = ['super_admin', 'superadmin', 'ceo', 'diretoria'];

    if (!superAdminRoles.includes(role)) {
      return res.status(403).json({ success: false, error: 'Apenas super administradores podem aprovar ou rejeitar campanhas.' });
    }

    const { tipo, data_publicacao, produto, validacao_financeiro } = req.body;

    if (!tipo || !data_publicacao || !produto || typeof validacao_financeiro !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'tipo, data_publicacao, produto e validacao_financeiro são obrigatórios',
      });
    }

    const result = await db.query(
      `UPDATE app_comissionamento.registro_campanhas
       SET validacao_financeiro = $1
       WHERE tipo = $2 AND data_publicacao = $3 AND produto = $4
       RETURNING tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro`,
      [validacao_financeiro, tipo, data_publicacao, produto]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
    }

    if (validacao_financeiro) {
      const campanha = result.rows[0];
      broadcastNotification({
        tipo: 'success',
        titulo: 'Campanha Ativa',
        mensagem: `Campanha de ${campanha.tipo} ativa${campanha.produto && campanha.produto !== 'Todos' ? ` (${campanha.produto})` : ''}`,
        data: new Date().toISOString(),
      });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error('Erro ao atualizar validação:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /api/campanhas/aplicar
// Aplica campanhas ativas aos dados diários.
// Tipos suportados:
//   - GOLS: multiplica os gols do dia pelo multiplicador.
//   - ASSINADOS: cada assinado vale 1 gol.
//   - PROGRESSIVA: a partir de uma meta mínima de assinados, os gols = total de assinados.
// ============================================================
router.post('/aplicar', requireAuth, async (req, res) => {
  try {
    const { dailyData, metaGolsAssinados, metaGolsGanhos, mes } = req.body;

    if (!dailyData || !metaGolsAssinados || !metaGolsGanhos) {
      return res.status(400).json({
        success: false,
        error: 'dailyData, metaGolsAssinados e metaGolsGanhos são obrigatórios'
      });
    }

    let query = `
      SELECT tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro
      FROM app_comissionamento.registro_campanhas
      WHERE validacao_financeiro = true
    `;
    const params = [];

    if (mes) {
      query += ` AND TO_CHAR(data_publicacao::date, 'YYYY-MM') = $1`;
      params.push(mes);
    }

    const result = await db.query(query, params);

    // Separa campanhas por tipo
    const campanhasGols = result.rows.filter(c => (c.tipo || '').toUpperCase() === 'GOLS');
    const campanhasAssinados = result.rows.filter(c => (c.tipo || '').toUpperCase() === 'ASSINADOS');
    const campanhasProgressivas = result.rows.filter(c => (c.tipo || '').toUpperCase() === 'PROGRESSIVA');

    function aplicarCampanhas(dailyData, campanhasGols, campanhasAssinados, campanhasProgressivas, metaGolsAssinados, metaGolsGanhos) {
      const golsMap = new Map();       // data -> multiplicador máximo (campanha GOLS)
      const assinadosMap = new Map();  // data -> boolean (campanha ASSINADOS)
      const progressivaMap = new Map(); // data -> meta mínima de assinados

      // Preencher mapas de GOLS
      for (const camp of campanhasGols) {
        const dateKey = (camp.data_publicacao || '').split('T')[0];
        const atual = golsMap.get(dateKey);
        const mult = Number(camp.multiplicador) || 1;
        if (!atual || mult > atual) golsMap.set(dateKey, mult);
      }

      // Preencher mapas de ASSINADOS
      for (const camp of campanhasAssinados) {
        const dateKey = (camp.data_publicacao || '').split('T')[0];
        assinadosMap.set(dateKey, true);
      }

      // Preencher mapas de PROGRESSIVA
      for (const camp of campanhasProgressivas) {
        const dateKey = (camp.data_publicacao || '').split('T')[0];
        progressivaMap.set(dateKey, Number(camp.multiplicador) || 0);
      }

      let totalGols = 0;
      const dailyGols = dailyData.map(day => {
        const assinados = Number(day.assinados) || 0;
        const ganhos = Number(day.ganhos) || 0;
        const dateKey = (day.date || '').slice(0, 10);

        // Cálculo base (sem campanhas)
        let golsDoDia = Math.min(
          Math.floor(assinados / metaGolsAssinados),
          Math.floor(ganhos / metaGolsGanhos)
        );

        // Aplica GOLS (multiplicador)
        const mult = golsMap.get(dateKey);
        if (mult) golsDoDia = golsDoDia * mult;

        // Aplica ASSINADOS (+1 por assinado)
        if (assinadosMap.has(dateKey)) {
          golsDoDia += assinados;
        }

        // Aplica PROGRESSIVA (substitui os gols se atingir meta)
        const metaProgressiva = progressivaMap.get(dateKey);
        if (metaProgressiva !== undefined) {
          if (assinados >= metaProgressiva) {
            golsDoDia = assinados;
          } else {
            golsDoDia = 0;
          }
        }

        totalGols += golsDoDia;
        return { date: dateKey, gols: golsDoDia };
      });

      return { totalGols, dailyGols };
    }

    const resultado = aplicarCampanhas(
      dailyData,
      campanhasGols,
      campanhasAssinados,
      campanhasProgressivas,
      metaGolsAssinados,
      metaGolsGanhos
    );

    res.json({
      success: true,
      data: {
        ...resultado,
        campanhasAplicadas: {
          gols: campanhasGols.length,
          assinados: campanhasAssinados.length,
          progressivas: campanhasProgressivas.length,
        }
      }
    });
  } catch (err) {
    console.error('Erro ao aplicar campanhas:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;