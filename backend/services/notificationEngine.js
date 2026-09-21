// backend/services/notificationEngine.js
import { pool } from './db.js';
import { broadcastNotification } from '../routes/notificacoes.js';

// Conjunto para evitar notificações duplicadas (chave = email|condicao|data)
const sentNotifications = new Set();

function buildKey(email, condition, date) {
  return `${email}|${condition}|${date}`;
}

/**
 * Verifica periodicamente se algum assessor está próximo de:
 * - Fazer 1 gol (diário)
 * - Bater a meta diária
 * - Alcançar a próxima faixa de comissão (mensal)
 * Quando detectado, envia uma notificação direcionada via SSE.
 */
export async function checkIncentiveNotifications() {
  try {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);
    const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    const monthEnd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;

    // 1. Buscar colaboradores ativos com suas metas
    const usersQuery = `
      SELECT 
        a.email,
        a.colaborador AS nome,
        c.nome_equipe,
        c.cargo,
        a.peso_meta_assinados_diario,
        a.peso_meta_ganho_diario,
        a.peso_meta_assinados_semanal,
        a.peso_meta_ganho_semanal,
        a.peso_meta_assinados_mensal,
        a.peso_meta_ganho_mensal,
        a.meta_gols_assinados,
        a.meta_gols_ganhos
      FROM app_comissionamento.metricas_assessores a
      JOIN core.view_app_colaboradores c ON a.email = c.email
      WHERE c.status = 'ativo'
        AND c.cargo NOT IN ('supervisor', 'coordenador', 'administrativo', 'desativado')
        AND a.data_metrica::date = CURRENT_DATE
    `;
    const usersResult = await pool.query(usersQuery);
    const users = usersResult.rows;

    if (users.length === 0) return;

    // 2. Métricas diárias por colaborador (assinados e ganhos de hoje)
    const dailyMetricsQuery = `
      SELECT 
        colaborador,
        SUM(assinados) AS assinados,
        SUM(ganhos) AS ganhos
      FROM (
        -- Assinados
        SELECT consultor_responsavel_assinatura AS colaborador, 1 AS tipo, COUNT(*) AS assinados, 0 AS ganhos
        FROM madm.view_app_emitidos_e_assinados
        WHERE data_assinatura::date = CURRENT_DATE
        GROUP BY consultor_responsavel_assinatura

        UNION ALL

        -- Ganhos
        SELECT lead_usuario_responsavel AS colaborador, 2 AS tipo, 0 AS assinados, COUNT(*) AS ganhos
        FROM madm.view_app_kommo_leads
        WHERE data_ganho::date = CURRENT_DATE
          AND etapa_lead IN ('PROTOCOLADO', 'AG PROTOCOLO', 'Venda ganha')
        GROUP BY lead_usuario_responsavel
      ) sub
      GROUP BY colaborador
    `;
    const dailyMetricsResult = await pool.query(dailyMetricsQuery);
    const dailyMetricsMap = new Map();
    dailyMetricsResult.rows.forEach(row => {
      dailyMetricsMap.set(row.colaborador, {
        assinados: Number(row.assinados) || 0,
        ganhos: Number(row.ganhos) || 0,
      });
    });

    // 3. Totais mensais de assinados para verificar próxima faixa
    const monthlyAssinadosQuery = `
      SELECT consultor_responsavel_assinatura AS colaborador, COUNT(*) AS assinados
      FROM madm.view_app_emitidos_e_assinados
      WHERE data_assinatura::date BETWEEN $1::date AND $2::date
      GROUP BY consultor_responsavel_assinatura
    `;
    const monthlyResult = await pool.query(monthlyAssinadosQuery, [monthStart, monthEnd]);
    const monthlyAssinadosMap = new Map();
    monthlyResult.rows.forEach(row => {
      monthlyAssinadosMap.set(row.colaborador, Number(row.assinados) || 0);
    });

    // 4. Buscar tabela de comissões para faixas
    const faixasQuery = `
      SELECT tipo, valor_comissao, faixa_min, faixa_max
      FROM app_comissionamento.tabela_comissoes
    `;
    const faixasResult = await pool.query(faixasQuery);
    const faixas = faixasResult.rows;

    // 5. Avaliar cada usuário
    for (const user of users) {
      const email = user.email;
      const nome = user.nome || email;
      const daily = dailyMetricsMap.get(nome) || { assinados: 0, ganhos: 0 };
      const monthlyAss = monthlyAssinadosMap.get(nome) || 0;

      // --- Condição 1: Prestes a fazer 1 gol (diário) ---
      const metaGolAss = Number(user.meta_gols_assinados) || 3;
      const metaGolGan = Number(user.meta_gols_ganhos) || 3;
      const nearGoal =
        (daily.assinados === metaGolAss - 1 && daily.ganhos >= metaGolGan) ||
        (daily.ganhos === metaGolGan - 1 && daily.assinados >= metaGolAss);
      if (nearGoal) {
        const key = buildKey(email, 'near_goal', dateStr);
        if (!sentNotifications.has(key)) {
          broadcastNotification({
            tipo: 'info',
            titulo: '🔥 Você está a 1 passo do gol!',
            mensagem: `Faltam 1 ${daily.assinados < metaGolAss ? 'assinado' : 'ganho'} para completar um gol hoje!`,
            destinatario: email,
            data: new Date().toISOString(),
          });
          sentNotifications.add(key);
        }
      }

      // --- Condição 2: Próximo da próxima faixa (mensal) ---
      // Determina o tipo de produto para faixas (simplificado: AUXILIO ACIDENTE)
      const productType = 'AUXILIO ACIDENTE';
      const userFaixas = faixas
        .filter(f => f.tipo === productType && f.faixa_min > monthlyAss)
        .sort((a, b) => a.faixa_min - b.faixa_min);
      if (userFaixas.length > 0) {
        const nextFaixa = userFaixas[0];
        const diff = nextFaixa.faixa_min - monthlyAss;
        if (diff <= 2) {
          const key = buildKey(email, 'near_faixa', dateStr);
          if (!sentNotifications.has(key)) {
            broadcastNotification({
              tipo: 'info',
              titulo: '📈 Próximo da próxima faixa!',
              mensagem: `Faltam ${diff} assinado(s) para alcançar a faixa de ${nextFaixa.faixa_min} assinados.`,
              destinatario: email,
              data: new Date().toISOString(),
            });
            sentNotifications.add(key);
          }
        }
      }

      // --- Condição 3: Perto de bater metas (diário) ---
      const metaDiarioAss = Number(user.peso_meta_assinados_diario) || 3;
      const metaDiarioGan = Number(user.peso_meta_ganho_diario) || 3;
      const progressAss = metaDiarioAss > 0 ? daily.assinados / metaDiarioAss : 0;
      const progressGan = metaDiarioGan > 0 ? daily.ganhos / metaDiarioGan : 0;
      if (
        (progressAss >= 0.8 && progressAss < 1) ||
        (progressGan >= 0.8 && progressGan < 1)
      ) {
        const key = buildKey(email, 'near_meta_diaria', dateStr);
        if (!sentNotifications.has(key)) {
          broadcastNotification({
            tipo: 'info',
            titulo: '🎯 Meta diária quase lá!',
            mensagem: `Você está a ${Math.max(metaDiarioAss - daily.assinados, 0)} assinados e ${Math.max(metaDiarioGan - daily.ganhos, 0)} ganhos de bater a meta de hoje.`,
            destinatario: email,
            data: new Date().toISOString(),
          });
          sentNotifications.add(key);
        }
      }
    }
  } catch (err) {
    console.error('Erro no notificationEngine:', err);
  }
}

/**
 * Inicia o motor de notificações, executando a verificação periodicamente.
 * @param {number} intervalMs - Intervalo em milissegundos (padrão: 5 minutos)
 */
export function startNotificationEngine(intervalMs = 5 * 60 * 1000) {
  setInterval(checkIncentiveNotifications, intervalMs);
  console.log('🔔 NotificationEngine iniciado (a cada 5 min)');
}