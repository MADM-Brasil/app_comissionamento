// backend/services/bd/analyticsSemaphore.js
import { analyticsQuery as rawQuery } from './db.js';

const MAX_INFLIGHT = Number(process.env.ANALYTICS_MAX_INFLIGHT) || 4;
const MAX_QUEUE    = Number(process.env.ANALYTICS_MAX_QUEUE)    || 20;
const QUEUE_WAIT_MS = Number(process.env.ANALYTICS_QUEUE_WAIT_MS) || 5_000;

let inflight = 0;
const waiters = [];

function acquire() {
  if (inflight < MAX_INFLIGHT) {
    inflight++;
    return Promise.resolve();
  }
  if (waiters.length >= MAX_QUEUE) {
    return Promise.reject(Object.assign(
      new Error('[analytics] sobrecarga — fila cheia'),
      { code: 'ANALYTICS_OVERLOAD' },
    ));
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const i = waiters.indexOf(entry);
      if (i >= 0) waiters.splice(i, 1);
      reject(Object.assign(
        new Error(`[analytics] timeout na fila (${QUEUE_WAIT_MS}ms)`),
        { code: 'ANALYTICS_QUEUE_TIMEOUT' },
      ));
    }, QUEUE_WAIT_MS);
    const entry = () => { clearTimeout(t); inflight++; resolve(); };
    waiters.push(entry);
  });
}

function release() {
  inflight--;
  const next = waiters.shift();
  if (next) next();
}

export async function analyticsQuery(text, params) {
  await acquire();
  try {
    return await rawQuery(text, params);
  } finally {
    release();
  }
}

export function analyticsSemaphoreStats() {
  return { inflight, queued: waiters.length, maxInflight: MAX_INFLIGHT, maxQueue: MAX_QUEUE };
}