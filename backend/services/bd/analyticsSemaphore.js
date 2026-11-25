// backend/services/bd/analyticsSemaphore.js
import { analyticsQuery as rawQuery } from './db.js';

const HIGH_MAX_INFLIGHT = Number(process.env.ANALYTICS_MAX_INFLIGHT)      || 3;
const HIGH_MAX_QUEUE    = Number(process.env.ANALYTICS_MAX_QUEUE)         || 15;
const LOW_MAX_INFLIGHT  = Number(process.env.ANALYTICS_LOW_MAX_INFLIGHT)  || 1;
const LOW_MAX_QUEUE     = Number(process.env.ANALYTICS_LOW_MAX_QUEUE)     || 10;
const QUEUE_WAIT_MS     = Number(process.env.ANALYTICS_QUEUE_WAIT_MS)     || 5_000;

function makeLane(maxInflight, maxQueue) {
  return { maxInflight, maxQueue, inflight: 0, waiters: [] };
}

const HIGH = makeLane(HIGH_MAX_INFLIGHT, HIGH_MAX_QUEUE);
const LOW  = makeLane(LOW_MAX_INFLIGHT,  LOW_MAX_QUEUE);

function acquire(lane) {
  if (lane.inflight < lane.maxInflight) {
    lane.inflight++;
    return Promise.resolve();
  }
  if (lane.waiters.length >= lane.maxQueue) {
    return Promise.reject(Object.assign(
      new Error('[analytics] sobrecarga — fila cheia'),
      { code: 'ANALYTICS_OVERLOAD' },
    ));
  }
  return new Promise((resolve, reject) => {
    const entry = () => {
      clearTimeout(t);
      lane.inflight++;
      resolve();
    };
    const t = setTimeout(() => {
      const i = lane.waiters.indexOf(entry);
      if (i >= 0) lane.waiters.splice(i, 1);
      reject(Object.assign(
        new Error(`[analytics] timeout na fila (${QUEUE_WAIT_MS}ms)`),
        { code: 'ANALYTICS_QUEUE_TIMEOUT' },
      ));
    }, QUEUE_WAIT_MS);
    lane.waiters.push(entry);
  });
}

function release(lane) {
  lane.inflight--;
  const next = lane.waiters.shift();
  if (next) next();
}

/**
 * @param {string} text
 * @param {any[]} params
 * @param {'high'|'low'} [priority='high']
 *   high → telas ativas (dashboard, colaboradores)
 *   low  → warmup, comissões, geração de relatório, backfill
 */
export async function analyticsQuery(text, params, priority = 'high') {
  const lane = priority === 'low' ? LOW : HIGH;
  await acquire(lane);
  try {
    return await rawQuery(text, params);
  } finally {
    release(lane);
  }
}

export function analyticsSemaphoreStats() {
  return {
    high: { inflight: HIGH.inflight, queued: HIGH.waiters.length,
            maxInflight: HIGH.maxInflight, maxQueue: HIGH.maxQueue },
    low:  { inflight: LOW.inflight,  queued: LOW.waiters.length,
            maxInflight: LOW.maxInflight,  maxQueue: LOW.maxQueue },
  };
}