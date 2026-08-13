// backend/routes/campanhas.js
import express from 'express';
import db from '../services/db.js';

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.isAuthenticated || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Não autenticado' });
  }
  next();
}

// GET /api/campanhas?mes=YYYY-MM (opcional, filtra por mês da data_publicacao)
// Retorna as campanhas com validacao_financeiro = true, já separadas por tipo.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { mes } = req.query;
    let query = `
      SELECT tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro
      FROM app_comissionamento.vw_registro_campanhas
      WHERE validacao_financeiro = true
    `;
    const params = [];

    if (mes) {
      query += ` AND TO_CHAR(data_publicacao::date, 'YYYY-MM') = $1`;
      params.push(mes);
    }

    query += ` ORDER BY data_publicacao, tipo`;

    const result = await db.query(query, params);
    
    // Separa as campanhas por tipo
    const campanhasGols = result.rows.filter(c => c.tipo === 'GOLS');
    const campanhasAssinados = result.rows.filter(c => c.tipo === 'ASSINADOS');
    
    res.json({ 
      success: true, 
      data: {
        gols: campanhasGols,
        assinados: campanhasAssinados,
        todas: result.rows
      }
    });
  } catch (err) {
    console.error('Erro ao buscar campanhas:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Aplica os efeitos das campanhas nos dados diários de um colaborador.
 * 
 * REGRAS:
 * - Campanha ASSINADOS (multiplicador = 1 por padrão): cada 1 assinado no dia da campanha vale 1 gol extra.
 * - Campanha GOLS: multiplica os gols do dia pelo valor da coluna 'multiplicador'.
 * - Ambas as campanhas só afetam o dia exato da data_publicacao.
 * 
 * @param {Array} dailyData - Array de { date, assinados, ganhos }
 * @param {Array} campanhasGols - Campanhas do tipo GOLS
 * @param {Array} campanhasAssinados - Campanhas do tipo ASSINADOS
 * @param {number} metaGolsAssinados - Meta diária de assinados para gol
 * @param {number} metaGolsGanhos - Meta diária de ganhos para gol
 * @returns {Object} { totalGols, dailyGols, detalhesCampanhas }
 */
function aplicarCampanhas(dailyData, campanhasGols, campanhasAssinados, metaGolsAssinados, metaGolsGanhos) {
  // Cria mapas para acesso rápido por data (YYYY-MM-DD)
  const golsMap = new Map();
  const assinadosMap = new Map();
  
  for (const camp of campanhasGols) {
    const dateKey = camp.data_publicacao.split('T')[0]; // garante YYYY-MM-DD
    // Se houver mais de uma campanha GOLS no mesmo dia, usa o maior multiplicador
    const atual = golsMap.get(dateKey);
    if (!atual || camp.multiplicador > atual.multiplicador) {
      golsMap.set(dateKey, camp);
    }
  }
  
  for (const camp of campanhasAssinados) {
    const dateKey = camp.data_publicacao.split('T')[0];
    // Acumula efeitos de campanhas de assinados no mesmo dia (soma multiplicadores? mantemos 1 por padrão)
    if (!assinadosMap.has(dateKey)) {
      assinadosMap.set(dateKey, []);
    }
    assinadosMap.get(dateKey).push(camp);
  }
  
  let totalGols = 0;
  const dailyGols = dailyData.map(day => {
    const assinados = day.assinados || 0;
    const ganhos = day.ganhos || 0;
    const dateKey = day.date;
    
    // Gols base (sem campanha)
    let golsDoDia = Math.min(
      Math.floor(assinados / metaGolsAssinados),
      Math.floor(ganhos / metaGolsGanhos)
    );
    
    // Aplica campanha de GOLS (multiplicador)
    const campGols = golsMap.get(dateKey);
    if (campGols) {
      golsDoDia = golsDoDia * (campGols.multiplicador || 1);
    }
    
    // Aplica campanha de ASSINADOS (cada assinado = 1 gol extra)
    const campsAssinados = assinadosMap.get(dateKey);
    if (campsAssinados) {
      // Cada campanha de assinados adiciona 1 gol por assinado
      const golsExtras = assinados; // 1 gol por assinado (multiplicador = 1)
      golsDoDia += golsExtras;
    }
    
    totalGols += golsDoDia;
    return { date: day.date, gols: golsDoDia };
  });
  
  return { totalGols, dailyGols };
}

// Rota para aplicar campanhas nos dados de um colaborador específico
router.post('/aplicar', requireAuth, async (req, res) => {
  try {
    const { 
      dailyData,          // Array de { date, assinados, ganhos }
      metaGolsAssinados,  // Meta diária de assinados
      metaGolsGanhos,     // Meta diária de ganhos
      mes                 // Mês para filtrar campanhas (YYYY-MM)
    } = req.body;
    
    if (!dailyData || !metaGolsAssinados || !metaGolsGanhos) {
      return res.status(400).json({ 
        success: false, 
        error: 'dailyData, metaGolsAssinados e metaGolsGanhos são obrigatórios' 
      });
    }
    
    // Busca campanhas ativas
    let query = `
      SELECT tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro
      FROM app_comissionamento.vw_registro_campanhas
      WHERE validacao_financeiro = true
    `;
    const params = [];
    
    if (mes) {
      query += ` AND TO_CHAR(data_publicacao::date, 'YYYY-MM') = $1`;
      params.push(mes);
    }
    
    const result = await db.query(query, params);
    const campanhasGols = result.rows.filter(c => c.tipo === 'GOLS');
    const campanhasAssinados = result.rows.filter(c => c.tipo === 'ASSINADOS');
    
    // Aplica as campanhas
    const resultado = aplicarCampanhas(
      dailyData, 
      campanhasGols, 
      campanhasAssinados, 
      metaGolsAssinados, 
      metaGolsGanhos
    );
    
    res.json({ 
      success: true, 
      data: {
        ...resultado,
        campanhasAplicadas: {
          gols: campanhasGols.length,
          assinados: campanhasAssinados.length
        }
      }
    });
  } catch (err) {
    console.error('Erro ao aplicar campanhas:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;