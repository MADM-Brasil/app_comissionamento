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
// GRUPOS DE CAMPANHAS
// ------------------------------------------------------------
// Cada página consome apenas o grupo de seu interesse:
//   - gols      → páginas que calculam gols (multiplicador/progressiva)
//   - assinados → páginas que calculam bônus por assinados
//   - ganhos    → Página de Comissões (CAMPGANHOS_2026 + faixas)
// ============================================================
const GRUPOS_CAMPANHAS = {
  gols: ['GOLS', 'PROGRESSIVA'],
  assinados: ['ASSINADOS'],
  ganhos: [
    'CAMPGANHOS_2026',
    'CAMPGANHOS_DIA_2026',
    'CAMPGANHOS_MEN_2026',
    'CAMPGANHOS_SEM_2026_SUPER',
    'CAMPGANHOS_MEN_2026_SUPER',
  ],
};

function getGrupoDoTipo(tipo) {
  const up = String(tipo || '').toUpperCase();
  for (const [grupo, tipos] of Object.entries(GRUPOS_CAMPANHAS)) {
    if (tipos.includes(up)) return grupo;
  }
  return 'outros';
}

function getTiposDoGrupo(grupo) {
  const key = String(grupo || '').toLowerCase();
  return GRUPOS_CAMPANHAS[key] || null;
}

/**
 * Agrupa uma lista de linhas de registro_campanhas em { gols, assinados, ganhos, outros }.
 */
function agruparCampanhas(rows) {
  const acc = { gols: [], assinados: [], ganhos: [], outros: [] };
  for (const row of rows || []) {
    const g = getGrupoDoTipo(row.tipo);
    if (!acc[g]) acc[g] = [];
    acc[g].push(row);
  }
  return acc;
}

// ============================================================
// CAMPGANHOS_2026 — faixas registradas em registro_campanhas
// ------------------------------------------------------------
// Toggle: tipo = 'CAMPGANHOS_2026' com validacao_financeiro = true
//
// Subtipos (faixas):
//   CAMPGANHOS_DIA_2026        → assessor  diário   → estimativa_dia
//   CAMPGANHOS_MEN_2026        → assessor  mensal   → SOMA no total
//   CAMPGANHOS_SEM_2026_SUPER  → supervisor semanal → estimativa_semana
//   CAMPGANHOS_MEN_2026_SUPER  → supervisor mensal  → SOMA no total
//
// Regra: faixas NÃO são acumulativas — paga SOMENTE o valor da faixa atingida.
// ============================================================
const CAMPGANHOS_2026_PARENT = 'CAMPGANHOS_2026';
const CAMPGANHOS_2026_TIPOS = [
  'CAMPGANHOS_DIA_2026',
  'CAMPGANHOS_MEN_2026',
  'CAMPGANHOS_SEM_2026_SUPER',
  'CAMPGANHOS_MEN_2026_SUPER',
];
const CAMPGANHOS_2026_TIPOS_SET = new Set(CAMPGANHOS_2026_TIPOS);

function parseFaixaDescricao(descricao) {
  const raw = String(descricao || '').trim();
  if (!raw) return null;

  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      const valor = Number(obj.valor ?? obj.valor_comissao ?? obj.value ?? obj.comissao);
      const faixaMax = obj.max ?? obj.faixa_max;
      const max = faixaMax == null ? null : Number(faixaMax);
      if (Number.isFinite(valor)) {
        return { valor, max: Number.isFinite(max) ? max : null };
      }
    } catch {
      // cai para os próximos formatos
    }
  }

  if (raw.includes('|')) {
    const [v, m] = raw.split('|').map(s => s.trim());
    const valor = Number(v);
    const max = m === '' || m == null ? null : Number(m);
    if (Number.isFinite(valor)) {
      return { valor, max: Number.isFinite(max) ? max : null };
    }
  }

  const only = Number(raw);
  if (Number.isFinite(only)) {
    return { valor: only, max: null };
  }

  return null;
}

function extractFaixasFromRows(rows, tipo) {
  const faixas = [];
  for (const row of rows || []) {
    if ((row.tipo || '').toUpperCase() !== tipo) continue;

    const faixa_min = Number(row.multiplicador);
    if (!Number.isFinite(faixa_min)) continue;

    const parsed = parseFaixaDescricao(row.descricao);
    if (!parsed) {
      console.warn(
        `[CAMPGANHOS_2026] Faixa com descrição inválida em tipo=${tipo}: ${row.descricao}`
      );
      continue;
    }

    faixas.push({
      faixa_min,
      faixa_max: parsed.max,
      valor_comissao: parsed.valor,
    });
  }

  faixas.sort((a, b) => a.faixa_min - b.faixa_min);
  for (let i = 0; i < faixas.length; i++) {
    if (faixas[i].faixa_max == null && i < faixas.length - 1) {
      faixas[i].faixa_max = faixas[i + 1].faixa_min - 1;
    }
  }
  return faixas;
}

function calcFaixaGanhosValue(faixas, ganhos) {
  const value = Number(ganhos) || 0;
  if (!Array.isArray(faixas) || faixas.length === 0) return 0;
  for (const f of faixas) {
    const min = Number(f.faixa_min) || 0;
    const max = f.faixa_max == null ? Infinity : Number(f.faixa_max);
    if (value >= min && value <= max) {
      return Number(f.valor_comissao) || 0;
    }
  }
  return 0;
}

function getWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return dateStr;
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const dd = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function calcularCampGanhos2026(dailyData, faixasPorTipo) {
  const dias = [];

  for (const day of dailyData || []) {
    const dateKey = String(day.date || '').slice(0, 10);
    if (!dateKey) continue;
    const ganhos = Number(day.ganhos) || 0;
    const valor = calcFaixaGanhosValue(faixasPorTipo.CAMPGANHOS_DIA_2026, ganhos);
    dias.push({ date: dateKey, ganhos, valor });
  }
  const estimativa_dia = dias.reduce((s, d) => s + d.valor, 0);

  const semanasMap = new Map();
  for (const day of dias) {
    const weekKey = getWeekKey(day.date);
    if (!semanasMap.has(weekKey)) {
      semanasMap.set(weekKey, { weekKey, ganhos: 0, dias: [] });
    }
    const entry = semanasMap.get(weekKey);
    entry.ganhos += day.ganhos;
    entry.dias.push(day.date);
  }
  const semanas = Array.from(semanasMap.values())
    .sort((a, b) => a.weekKey.localeCompare(b.weekKey))
    .map(w => ({
      weekKey: w.weekKey,
      ganhos: w.ganhos,
      dias: w.dias,
      valor: calcFaixaGanhosValue(faixasPorTipo.CAMPGANHOS_SEM_2026_SUPER, w.ganhos),
    }));
  const estimativa_semana = semanas.reduce((s, w) => s + w.valor, 0);

  const ganhos_mes = dias.reduce((s, d) => s + d.ganhos, 0);
  const comissao_mes_assessor = calcFaixaGanhosValue(
    faixasPorTipo.CAMPGANHOS_MEN_2026,
    ganhos_mes
  );
  const comissao_mes_supervisor = calcFaixaGanhosValue(
    faixasPorTipo.CAMPGANHOS_MEN_2026_SUPER,
    ganhos_mes
  );

  return {
    ativo: true,
    estimativa_dia,
    estimativa_semana,
    comissao_mes_assessor,
    comissao_mes_supervisor,
    detalhes: { dias, semanas, ganhos_mes },
  };
}

// ============================================================
// Helper: buscar campanhas com filtros opcionais
//   - mes:   YYYY-MM
//   - grupo: 'gols' | 'assinados' | 'ganhos' | 'todos'
//   - tipo:  (sobrepõe o grupo)
// ============================================================
async function buscarCampanhas({ mes, grupo, tipo, somenteValidadas = false } = {}) {
  let query = `
    SELECT tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro
    FROM app_comissionamento.registro_campanhas
    WHERE 1=1
  `;
  const params = [];

  if (mes) {
    params.push(mes);
    query += ` AND TO_CHAR(data_publicacao::date, 'YYYY-MM') = $${params.length}`;
  }

  if (somenteValidadas) {
    query += ` AND validacao_financeiro = true`;
  }

  if (tipo) {
    params.push(String(tipo).toUpperCase());
    query += ` AND UPPER(tipo) = $${params.length}`;
  } else if (grupo && String(grupo).toLowerCase() !== 'todos') {
    const tiposDoGrupo = getTiposDoGrupo(grupo);
    if (!tiposDoGrupo) {
      const err = new Error(
        `Grupo inválido: ${grupo}. Use 'gols', 'assinados', 'ganhos' ou 'todos'.`
      );
      err.status = 400;
      throw err;
    }
    params.push(tiposDoGrupo);
    query += ` AND UPPER(tipo) = ANY($${params.length}::text[])`;
  }

  query += ` ORDER BY data_publicacao DESC, tipo`;

  const result = await db.query(query, params);
  return result.rows;
}

// ============================================================
// GET /api/campanhas
// Query params:
//   - mes: YYYY-MM
//   - grupo: 'gols' | 'assinados' | 'ganhos' | 'todos' (default: todos)
//   - tipo: (opcional, sobrepõe grupo)
// Retorna:
//   { success, data: [...], grupos: { gols, assinados, ganhos, outros } }
// ============================================================
router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await buscarCampanhas({
      mes: req.query.mes,
      grupo: req.query.grupo,
      tipo: req.query.tipo,
    });

    res.json({
      success: true,
      data: rows,
      grupos: agruparCampanhas(rows),
      grupoAplicado: req.query.tipo ? 'tipo' : (req.query.grupo || 'todos'),
    });
  } catch (err) {
    console.error('Erro ao buscar campanhas:', err);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET /api/campanhas/gols
// Somente campanhas de gols (GOLS, PROGRESSIVA).
// ============================================================
router.get('/gols', requireAuth, async (req, res) => {
  try {
    const rows = await buscarCampanhas({ mes: req.query.mes, grupo: 'gols' });
    res.json({ success: true, grupo: 'gols', data: rows });
  } catch (err) {
    console.error('Erro ao buscar campanhas de gols:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET /api/campanhas/assinados
// Somente campanhas de assinados (ASSINADOS).
// ============================================================
router.get('/assinados', requireAuth, async (req, res) => {
  try {
    const rows = await buscarCampanhas({ mes: req.query.mes, grupo: 'assinados' });
    res.json({ success: true, grupo: 'assinados', data: rows });
  } catch (err) {
    console.error('Erro ao buscar campanhas de assinados:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET /api/campanhas/ganhos
// Somente campanhas de ganhos (CAMPGANHOS_2026 + subtipos).
// ============================================================
router.get('/ganhos', requireAuth, async (req, res) => {
  try {
    const rows = await buscarCampanhas({ mes: req.query.mes, grupo: 'ganhos' });
    res.json({
      success: true,
      grupo: 'ganhos',
      data: rows,
      grupos: agruparCampanhas(rows),
    });
  } catch (err) {
    console.error('Erro ao buscar campanhas de ganhos:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /api/campanhas
// ============================================================
router.post('/', requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.userId;
    const role = await getUserRole(userEmail);

    const allowedRoles = [
      'coordenador', 'administrativo', 'super_admin', 'superadmin',
      'desenvolvedor', 'ceo', 'diretoria', 'admin',
    ];
    if (!allowedRoles.includes(role)) {
      return res.status(403).json({ success: false, error: 'Você não tem permissão para registrar campanhas.' });
    }

    const { tipo, multiplicador, produto, data_publicacao, descricao } = req.body;
    const tipoUp = String(tipo || '').toUpperCase();

    if (!tipo || !produto || !data_publicacao || !descricao) {
      return res.status(400).json({
        success: false,
        error: 'Campos obrigatórios: tipo, produto, data_publicacao, descricao',
      });
    }

    const grupo = getGrupoDoTipo(tipoUp);

    // ---------- Grupo GANHOS (CAMPGANHOS_2026 + subtipos) ----------
    if (grupo === 'ganhos') {
      const isParent = tipoUp === CAMPGANHOS_2026_PARENT;
      const faixaMin = Number(multiplicador);

      if (!isParent && !Number.isFinite(faixaMin)) {
        return res.status(400).json({
          success: false,
          error: 'Para faixas CAMPGANHOS_*, `multiplicador` deve conter o faixa_min.',
        });
      }
      if (!isParent && !parseFaixaDescricao(descricao)) {
        return res.status(400).json({
          success: false,
          error:
            'Descrição da faixa inválida. Use JSON {"valor": X, "max": Y}, "X|Y" ou "X".',
        });
      }

      const result = await db.query(
        `INSERT INTO app_comissionamento.registro_campanhas 
           (tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro)
         VALUES ($1, $2, $3, $4, $5, false)
         RETURNING tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro`,
        [tipo, Number.isFinite(faixaMin) ? faixaMin : 0, produto, data_publicacao, descricao]
      );

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
      return res.status(201).json({ success: true, grupo, data: result.rows[0] });
    }

    // ---------- Grupos GOLS / ASSINADOS ----------
    if (!['gols', 'assinados'].includes(grupo)) {
      return res.status(400).json({
        success: false,
        error: `Tipo inválido: ${tipo}. Aceitos: ${Object.values(GRUPOS_CAMPANHAS).flat().join(', ')}.`,
      });
    }

    const mult = Number(multiplicador);
    if (!mult || Number.isNaN(mult)) {
      return res.status(400).json({
        success: false,
        error: 'multiplicador é obrigatório para este tipo de campanha.',
      });
    }

    const result = await db.query(
      `INSERT INTO app_comissionamento.registro_campanhas 
         (tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro)
       VALUES ($1, $2, $3, $4, $5, false)
       RETURNING tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro`,
      [tipo, mult, produto, data_publicacao, descricao]
    );

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
    res.status(201).json({ success: true, grupo, data: result.rows[0] });
  } catch (err) {
    console.error('Erro ao registrar campanha:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// PATCH /api/campanhas/validacao
// ============================================================
router.patch('/validacao', requireAuth, async (req, res) => {
  try {
    const userEmail = req.session.userId;
    const role = await getUserRole(userEmail);
    const superAdminRoles = [
      'super_admin', 'superadmin', 'ceo', 'diretoria', 'desenvolvedor', 'admin',
    ];

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

    res.json({
      success: true,
      grupo: getGrupoDoTipo(tipo),
      data: result.rows[0],
    });
  } catch (err) {
    console.error('Erro ao atualizar validação:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// GET /api/campanhas/campganhos-2026/faixas?mes=YYYY-MM
// ============================================================
router.get('/campganhos-2026/faixas', requireAuth, async (req, res) => {
  try {
    const { mes } = req.query;
    const activeParams = [CAMPGANHOS_2026_PARENT];
    let activeQuery = `
      SELECT EXISTS (
        SELECT 1
        FROM app_comissionamento.registro_campanhas
        WHERE tipo = $1 AND validacao_financeiro = true
    `;
    if (mes) {
      activeParams.push(mes);
      activeQuery += ` AND TO_CHAR(data_publicacao::date, 'YYYY-MM') = $2`;
    }
    activeQuery += `) AS ativo`;
    const activeResult = await db.query(activeQuery, activeParams);

    if (!activeResult.rows[0]?.ativo) {
      const emptyFaixas = Object.fromEntries(CAMPGANHOS_2026_TIPOS.map(tipo => [tipo, []]));
      return res.json({ success: true, grupo: 'ganhos', ativo: false, data: emptyFaixas });
    }

    let query = `
      SELECT tipo, multiplicador, produto, data_publicacao, descricao, validacao_financeiro
      FROM app_comissionamento.registro_campanhas
      WHERE tipo = ANY($1::text[])
    `;
    const params = [CAMPGANHOS_2026_TIPOS];
    if (mes) {
      query += ` AND TO_CHAR(data_publicacao::date, 'YYYY-MM') = $2`;
      params.push(mes);
    }

    const result = await db.query(query, params);

    const faixasPorTipo = Object.fromEntries(CAMPGANHOS_2026_TIPOS.map(t => [t, []]));
    for (const tipo of CAMPGANHOS_2026_TIPOS) {
      faixasPorTipo[tipo] = extractFaixasFromRows(result.rows, tipo);
    }

    res.json({ success: true, grupo: 'ganhos', ativo: true, data: faixasPorTipo });
  } catch (err) {
    console.error('Erro ao buscar faixas CAMPGANHOS_2026:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// POST /api/campanhas/aplicar
// ------------------------------------------------------------
// Retorna três blocos separados (gols / assinados / ganhos) +
// campos antigos no topo para retrocompatibilidade.
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

    // Lê todas as faixas; a campanha-mãe controla a ativação das CAMPGANHOS.
    const rows = await buscarCampanhas({ mes });
    const campanhasValidadas = rows.filter(c => c.validacao_financeiro);

    // ---- Separa por grupo ----
    const campanhasGols = campanhasValidadas.filter(c => (c.tipo || '').toUpperCase() === 'GOLS');
    const campanhasProgressivas = campanhasValidadas.filter(c => (c.tipo || '').toUpperCase() === 'PROGRESSIVA');
    const campanhasAssinados = campanhasValidadas.filter(c => (c.tipo || '').toUpperCase() === 'ASSINADOS');

    const campGanhosAtiva = campanhasValidadas.some(
      c => (c.tipo || '').toUpperCase() === CAMPGANHOS_2026_PARENT
    );

    // ============================================================
    // 1) CÁLCULO DE GOLS
    // ============================================================
    function aplicarCampanhasGols(dailyData, campanhasGols, campanhasProgressivas, campanhasAssinados, metaGolsAssinados, metaGolsGanhos) {
      const golsMap = new Map();
      const assinadosMap = new Map();
      const progressivaMap = new Map();

      for (const camp of campanhasGols) {
        const dateKey = (camp.data_publicacao || '').split('T')[0];
        const atual = golsMap.get(dateKey);
        const mult = Number(camp.multiplicador) || 1;
        if (!atual || mult > atual) golsMap.set(dateKey, mult);
      }
      for (const camp of campanhasAssinados) {
        const dateKey = (camp.data_publicacao || '').split('T')[0];
        const quantidadePorGol = Number(camp.multiplicador) || 3;
        assinadosMap.set(dateKey, quantidadePorGol);
      }
      for (const camp of campanhasProgressivas) {
        const dateKey = (camp.data_publicacao || '').split('T')[0];
        progressivaMap.set(dateKey, Number(camp.multiplicador) || 0);
      }

      let totalGols = 0;
      const dailyGols = dailyData.map(day => {
        const assinados = Number(day.assinados) || 0;
        const ganhos = Number(day.ganhos) || 0;
        const dateKey = (day.date || '').slice(0, 10);

        let golsDoDia = Math.min(
          Math.floor(assinados / metaGolsAssinados),
          Math.floor(ganhos / metaGolsGanhos)
        );

        const mult = golsMap.get(dateKey);
        if (mult) golsDoDia = golsDoDia * mult;

        const quantidadePorGol = assinadosMap.get(dateKey);
        if (quantidadePorGol) golsDoDia += Math.floor(assinados / quantidadePorGol);

        const metaProgressiva = progressivaMap.get(dateKey);
        if (metaProgressiva !== undefined) {
          if (assinados >= metaProgressiva) golsDoDia = assinados;
          else golsDoDia = 0;
        }

        totalGols += golsDoDia;
        return { date: dateKey, gols: golsDoDia };
      });

      return { totalGols, dailyGols };
    }

    const resultadoGols = aplicarCampanhasGols(
      dailyData,
      campanhasGols,
      campanhasProgressivas,
      campanhasAssinados,
      metaGolsAssinados,
      metaGolsGanhos
    );

    // ============================================================
    // 2) CÁLCULO DE GANHOS (CAMPGANHOS_2026)
    // ============================================================
    let campGanhos2026 = null;
    if (campGanhosAtiva) {
      const faixasPorTipo = Object.fromEntries(CAMPGANHOS_2026_TIPOS.map(t => [t, []]));
      for (const tipo of CAMPGANHOS_2026_TIPOS) {
        faixasPorTipo[tipo] = extractFaixasFromRows(rows, tipo);
      }
      campGanhos2026 = calcularCampGanhos2026(dailyData, faixasPorTipo);
    }

    // ============================================================
    // 3) RESPOSTA — agrupada + compatibilidade
    // ============================================================
    res.json({
      success: true,
      data: {
        // ---------- BLOCO GOLS ----------
        gols: {
          totalGols: resultadoGols.totalGols,
          dailyGols: resultadoGols.dailyGols,
          campanhasAplicadas: {
            gols: campanhasGols.length,
            progressivas: campanhasProgressivas.length,
          },
        },

        // ---------- BLOCO ASSINADOS ----------
        assinados: {
          campanhasAplicadas: { assinados: campanhasAssinados.length },
          campanhas: campanhasAssinados,
        },

        // ---------- BLOCO GANHOS (CAMPGANHOS_2026) ----------
        ganhos: campGanhos2026 || {
          ativo: false,
          estimativa_dia: 0,
          estimativa_semana: 0,
          comissao_mes_assessor: 0,
          comissao_mes_supervisor: 0,
          detalhes: { dias: [], semanas: [], ganhos_mes: 0 },
        },

        // ---------- COMPATIBILIDADE (campos antigos no topo) ----------
        totalGols: resultadoGols.totalGols,
        dailyGols: resultadoGols.dailyGols,
        campGanhos2026,
        estimativa_dia: campGanhos2026?.estimativa_dia ?? 0,
        estimativa_semana: campGanhos2026?.estimativa_semana ?? 0,
        comissao_mes_assessor: campGanhos2026?.comissao_mes_assessor ?? 0,
        comissao_mes_supervisor: campGanhos2026?.comissao_mes_supervisor ?? 0,
        campanhasAplicadas: {
          gols: campanhasGols.length,
          assinados: campanhasAssinados.length,
          progressivas: campanhasProgressivas.length,
          campGanhos2026: campGanhosAtiva ? 1 : 0,
        },
      },
    });
  } catch (err) {
    console.error('Erro ao aplicar campanhas:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;