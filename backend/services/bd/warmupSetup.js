// backend/services/bd/warmupSetup.js
// ─────────────────────────────────────────────────────────────────────────────
// Registra os jobs de warmup. Objetivo: manter as combinações "quentes"
// (mês atual, semana atual, hoje, mês anterior × todos × Todos) sempre
// no cache Redis. O usuário nunca paga uma query lenta.
//

import { registerWarmup } from './warmup.js';
import {
  loadEmitidos,
  loadAssinados,
  loadProtocolados,
  loadGanhos,
  loadPerdidos,
  loadLeadsRecebidosGran,
  loadLeadsRecebidosAgg,
  loadLigacoes,
  loadLeadsStages,
  metricCacheKey,
} from './metricsLoaders.js';

// ═════════════════════════════════════════════════════════════════════════════
// CONFIGURAÇÃO
// ═════════════════════════════════════════════════════════════════════════════

const ENV_ENABLED = (name, def) => {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return def;
};

const CONFIG = {
  // ── Grupos de warmup ──────────────────────────────────────────────────────
  enableMainMetrics: ENV_ENABLED('WARMUP_MAIN_METRICS', true),   // 35 jobs
  enableLeads:       ENV_ENABLED('WARMUP_LEADS', true),          // 3 jobs
  enableLigacoes:    ENV_ENABLED('WARMUP_LIGACOES', true),       // 2 jobs
  enableLeadsStages: ENV_ENABLED('WARMUP_LEADS_STAGES', false),  // 2 jobs (opt-in)

  // ── Filtros warmados (extensível) ─────────────────────────────────────────
  // Se log mostrar que os usuários filtram por equipe frequentemente, adicione
  // nomes reais aqui. Cada item multiplica o número de jobs.
  // Ex.: ['todas', 'Equipe A', 'Equipe B'] → 3× mais jobs.
  EQUIPES:  ['todas'],
  PRODUTOS: ['Todos'],

  // ── Granularidades a warmar ───────────────────────────────────────────────
  // 'none'  → agregado por colaborador (Home, Visão Geral)
  // 'daily' → série diária (Analytics, Funil, gráficos)
  // Não warmamos 'weekly' / 'monthly' por padrão — se a Analytics usar muito,
  // adicione aqui.
  GRANULARITIES: ['none', 'daily'],
};

// ═════════════════════════════════════════════════════════════════════════════
// KEY BUILDERS espelhando routes/metrics.js
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ Estes formatos DEVEM casar com metrics.js. Se mudar um, mude o outro.
// ═════════════════════════════════════════════════════════════════════════════

const routeKeyBuilders = {
  leadsRecebidosGran: ({ start, end, equipe, produto, granularity }) =>
    `leads-recebidos:gran:${start}:${end}:${equipe || 'todas'}:${produto || 'Todos'}:${granularity}`,

  leadsRecebidosAgg: ({ start, end, equipe, produto }) =>
    `leads-recebidos:agg:${start}:${end}:${equipe || 'todas'}:${produto || 'Todos'}`,

  ligacoes: ({ start, end, granularity }) =>
    `ligacoes:${start}:${end}:${granularity || 'none'}`,

  leadsStages: ({ start, end, equipe, produto }) =>
    `leads-stages:${start}:${end}:${equipe || 'todas'}:${produto || 'Todos'}`,
};

// ═════════════════════════════════════════════════════════════════════════════
// CÁLCULO DE PERÍODOS
// ═════════════════════════════════════════════════════════════════════════════

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function computePeriods(reference = new Date()) {
  const y = reference.getFullYear();
  const m = reference.getMonth();
  const d = reference.getDate();

  // today: [00:00 de hoje, 00:00 de amanhã)
  const todayStart = new Date(y, m, d);
  const todayEnd = new Date(y, m, d + 1);

  // currentWeek: [segunda desta semana, segunda da semana seguinte)
  const dow = reference.getDay(); // 0=dom, 1=seg...
  const offsetToMonday = dow === 0 ? -6 : 1 - dow;
  const currentWeekStart = new Date(y, m, d + offsetToMonday);
  const currentWeekEnd = new Date(y, m, d + offsetToMonday + 7);

  // currentMonth: [1º deste mês, 1º do próximo)
  const currentMonthStart = new Date(y, m, 1);
  const currentMonthEnd = new Date(y, m + 1, 1);

  // previousMonth: [1º do mês passado, 1º deste mês)
  const previousMonthStart = new Date(y, m - 1, 1);
  const previousMonthEnd = new Date(y, m, 1);

  return {
    today: {
      start: toISODate(todayStart),
      end: toISODate(todayEnd),
      granularities: ['none'],                 // daily de 1 dia é redundante
      ttlMs: 90_000,
      intervalMs: 60_000,
    },
    currentWeek: {
      start: toISODate(currentWeekStart),
      end: toISODate(currentWeekEnd),
      granularities: ['none', 'daily'],
      ttlMs: 120_000,
      intervalMs: 60_000,
    },
    currentMonth: {
      start: toISODate(currentMonthStart),
      end: toISODate(currentMonthEnd),
      granularities: ['none', 'daily'],
      ttlMs: 120_000,
      intervalMs: 90_000,
    },
    previousMonth: {
      start: toISODate(previousMonthStart),
      end: toISODate(previousMonthEnd),
      granularities: ['none', 'daily'],
      ttlMs: 1_800_000,                        // 30min — mês fechado, muda pouco
      intervalMs: 1_800_000,
    },
  };
}

function periodSignature(periods) {
  return Object.entries(periods)
    .map(([name, p]) => `${name}:${p.start}|${p.end}`)
    .sort()
    .join(';');
}

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS DE REGISTRO
// ═════════════════════════════════════════════════════════════════════════════

function registerMainMetricsJob({ tipo, loader, period, granularity, equipe, produto }) {
  const params = {
    start: period.start,
    end: period.end,
    equipe: equipe === 'todas' ? undefined : equipe,
    produto: produto === 'Todos' ? undefined : produto,
    granularity: granularity === 'none' ? undefined : granularity,
  };
  const key = metricCacheKey(tipo, params);
  const name = `${tipo}:${equipe}:${produto}:${granularity}:${period.start}`;
  registerWarmup(name, {
    key,
    loader: () => loader({
      start: period.start,
      end: period.end,
      equipe: params.equipe,
      produto: params.produto,
      granularity: params.granularity,
    }),
    ttlMs: period.ttlMs,
    staleMs: period.ttlMs * 5,
    intervalMs: period.intervalMs,
  });
  return name;
}

function registerSimpleJob({ name, key, loader, ttlMs, intervalMs }) {
  registerWarmup(name, {
    key,
    loader,
    ttlMs,
    staleMs: ttlMs * 5,
    intervalMs,
  });
  return name;
}

// ═════════════════════════════════════════════════════════════════════════════
// VALIDAÇÃO (detecta divergência entre warmupSetup e metrics.js)
// ─────────────────────────────────────────────────────────────────────────────
// Roda no boot. Se alguma key não bater com o formato esperado, loga AVISO.
// Não bloqueia o boot — só avisa cedo para você não descobrir depois de horas.
// ═════════════════════════════════════════════════════════════════════════════

function validateWarmupKeysAgainstRoutes() {
  const fakePeriod = { start: '2026-01-01', end: '2026-02-01' };
  const checks = [
    {
      name: 'metricCacheKey(emitidos)',
      produced: metricCacheKey('emitidos', { start: fakePeriod.start, end: fakePeriod.end }),
      expected: /^emitidos:end=2026-02-01:start=2026-01-01$/,
    },
    {
      name: 'leadsRecebidosGran',
      produced: routeKeyBuilders.leadsRecebidosGran({ ...fakePeriod, equipe: 'todas', produto: 'Todos', granularity: 'daily' }),
      expected: /^leads-recebidos:gran:2026-01-01:2026-02-01:todas:Todos:daily$/,
    },
    {
      name: 'leadsRecebidosAgg',
      produced: routeKeyBuilders.leadsRecebidosAgg({ ...fakePeriod, equipe: 'todas', produto: 'Todos' }),
      expected: /^leads-recebidos:agg:2026-01-01:2026-02-01:todas:Todos$/,
    },
    {
      name: 'ligacoes',
      produced: routeKeyBuilders.ligacoes({ ...fakePeriod, granularity: 'none' }),
      expected: /^ligacoes:2026-01-01:2026-02-01:none$/,
    },
    {
      name: 'leadsStages',
      produced: routeKeyBuilders.leadsStages({ ...fakePeriod, equipe: 'todas', produto: 'Todos' }),
      expected: /^leads-stages:2026-01-01:2026-02-01:todas:Todos$/,
    },
  ];

  let failures = 0;
  for (const check of checks) {
    if (!check.expected.test(check.produced)) {
      console.error(`[warmupSetup] ⚠️ key divergente em ${check.name}: "${check.produced}"`);
      failures++;
    }
  }
  if (failures > 0) {
    console.error(
      `[warmupSetup] ⚠️ ${failures} key(s) divergentes. Compare os builders deste arquivo ` +
      `com os de routes/metrics.js. O warmup NÃO vai acertar o cache enquanto isso.`
    );
  } else {
    console.log('[warmupSetup] ✅ todos os key builders estão consistentes');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SETUP PRINCIPAL
// ═════════════════════════════════════════════════════════════════════════════

let lastPeriodSignature = null;

/**
 * Registra (ou re-registra) todos os jobs de warmup.
 *
 * Idempotente: chamar de novo substitui os jobs existentes (registerWarmup
 * cancela o timer antigo e cria um novo). Chame no boot e, opcionalmente,
 * à meia-noite para "rotacionar" o período.
 *
 * @param {{ silent?: boolean }} [opts]
 */
export function setupWarmups({ silent = false } = {}) {
  const periods = computePeriods();
  const sig = periodSignature(periods);

  if (sig === lastPeriodSignature && silent === false) {
    // Setup idempotente: se já rodamos com o mesmo período e não foi silent,
    // ainda assim re-registra (pode ser chamado para forçar reconfig).
    // Não pulamos.
  }
  lastPeriodSignature = sig;

  validateWarmupKeysAgainstRoutes();

  const registered = [];
  let skipped = 0;

  // ── GRUPO 1: main 5 metrics ──────────────────────────────────────────────
  const mainLoaders = {
    emitidos:     loadEmitidos,
    assinados:    loadAssinados,
    protocolados: loadProtocolados,
    ganhos:       loadGanhos,
    perdidos:     loadPerdidos,
  };

  if (CONFIG.enableMainMetrics) {
    for (const [tipo, loader] of Object.entries(mainLoaders)) {
      for (const [periodName, period] of Object.entries(periods)) {
        for (const granularity of period.granularities) {
          if (!CONFIG.GRANULARITIES.includes(granularity)) { skipped++; continue; }
          for (const equipe of CONFIG.EQUIPES) {
            for (const produto of CONFIG.PRODUTOS) {
              const name = registerMainMetricsJob({
                tipo, loader, period, granularity, equipe, produto,
              });
              registered.push(name);
            }
          }
        }
      }
    }
  }

  // ── GRUPO 2: leads-recebidos ─────────────────────────────────────────────
  if (CONFIG.enableLeads) {
    const { currentWeek, currentMonth } = periods;
    for (const period of [currentWeek, currentMonth]) {
      for (const equipe of CONFIG.EQUIPES) {
        for (const produto of CONFIG.PRODUTOS) {
          // série diária
          const granularity = 'daily';
          const nameGran = `leads-recebidos:gran:${equipe}:${produto}:${period.start}`;
          registerSimpleJob({
            name: nameGran,
            key: routeKeyBuilders.leadsRecebidosGran({
              start: period.start, end: period.end, equipe, produto, granularity,
            }),
            loader: () => loadLeadsRecebidosGran({
              start: period.start, end: period.end, equipe, produto, granularity,
            }),
            ttlMs: 90_000,
            intervalMs: 90_000,
          });
          registered.push(nameGran);

          // agregado (só no mês atual, cobre Home)
          if (period === currentMonth) {
            const nameAgg = `leads-recebidos:agg:${equipe}:${produto}:${period.start}`;
            registerSimpleJob({
              name: nameAgg,
              key: routeKeyBuilders.leadsRecebidosAgg({
                start: period.start, end: period.end, equipe, produto,
              }),
              loader: () => loadLeadsRecebidosAgg({
                start: period.start, end: period.end, equipe, produto,
              }),
              ttlMs: 180_000,
              intervalMs: 180_000,
            });
            registered.push(nameAgg);
          }
        }
      }
    }
  }

  // ── GRUPO 3: ligações ────────────────────────────────────────────────────
  if (CONFIG.enableLigacoes) {
    const { currentWeek, currentMonth } = periods;
    for (const period of [currentWeek, currentMonth]) {
      const granularity = 'none';
      const name = `ligacoes:${period.start}`;
      registerSimpleJob({
        name,
        key: routeKeyBuilders.ligacoes({
          start: period.start, end: period.end, granularity,
        }),
        loader: () => loadLigacoes({
          start: period.start, end: period.end, granularity,
        }),
        ttlMs: 300_000,
        intervalMs: 300_000,
      });
      registered.push(name);
    }
  }

  // ── GRUPO 4: leads/stages (opcional) ─────────────────────────────────────
  if (CONFIG.enableLeadsStages) {
    const { currentWeek, currentMonth } = periods;
    for (const period of [currentWeek, currentMonth]) {
      for (const equipe of CONFIG.EQUIPES) {
        for (const produto of CONFIG.PRODUTOS) {
          const name = `leads-stages:${equipe}:${produto}:${period.start}`;
          registerSimpleJob({
            name,
            key: routeKeyBuilders.leadsStages({
              start: period.start, end: period.end, equipe, produto,
            }),
            loader: () => loadLeadsStages({
              start: period.start, end: period.end, equipe, produto,
            }),
            ttlMs: 180_000,
            intervalMs: 180_000,
          });
          registered.push(name);
        }
      }
    }
  }

  if (!silent) {
    console.log(
      `[warmupSetup] ✅ ${registered.length} jobs registrados ` +
      `(${skipped} ignorados por filtro) | período=${sig}`
    );

    // Distribuição por tipo (útil para validar que os grupos corretos estão ativos)
    const byGroup = {};
    for (const name of registered) {
      const group = name.split(':')[0];
      byGroup[group] = (byGroup[group] || 0) + 1;
    }
    console.log('[warmupSetup] distribuição:', byGroup);

    // Guardrail de carga
    const MAX_JOBS = 80;
    if (registered.length > MAX_JOBS) {
      console.warn(
        `[warmupSetup] ⚠️ ${registered.length} jobs (> ${MAX_JOBS}). ` +
        `Considere reduzir CONFIG.EQUIPES/PRODUTOS ou desabilitar grupos. ` +
        `Cada job = 1 query periódica. Verifique WARMUP_* env vars.`
      );
    }
  }

  // Agenda próxima rotação (00:01 do dia seguinte)
  schedulePeriodRotation();

  return registered.length;
}

// ═════════════════════════════════════════════════════════════════════════════
// ROTAÇÃO DE PERÍODO
// ─────────────────────────────────────────────────────────────────────────────
// À meia-noite, "today" muda, "currentWeek" pode mudar, "currentMonth" pode
// mudar. Sem rotação, os jobs continuariam escrevendo no período antigo,
// enquanto o frontend pede o novo → cache miss em toda troca de filtro.
// ═════════════════════════════════════════════════════════════════════════════

let periodRotationTimer = null;

function schedulePeriodRotation() {
  if (periodRotationTimer) clearTimeout(periodRotationTimer);

  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0);
  const delayMs = nextMidnight.getTime() - now.getTime();

  periodRotationTimer = setTimeout(() => {
    console.log('[warmupSetup] 🌅 rotacionando períodos (novo dia)');
    try {
      setupWarmups({ silent: true });
    } catch (err) {
      console.error('[warmupSetup] falha na rotação:', err.message);
    }
    schedulePeriodRotation();
  }, delayMs);

  if (periodRotationTimer.unref) periodRotationTimer.unref();
}

/**
 * Cancela a rotação de período (chamado no shutdown gracioso).
 */
export function stopPeriodRotation() {
  if (periodRotationTimer) {
    clearTimeout(periodRotationTimer);
    periodRotationTimer = null;
  }
}