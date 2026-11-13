// backend/services/redis.js
// ─────────────────────────────────────────────────────────────────────────────
// Conexão com Redis (ioredis). Exporta dois clientes:
//   • redis     → comandos gerais (set, get, publish, scan)
//   • redisSub  → subscribe (ioredis exige conexão dedicada para SUB)
//
// Se REDIS_URL não está configurada, tudo vira no-op gracioso:
// as funções de cache caem para memória local, o SSE funciona
// apenas por instância. Nada quebra.
// ─────────────────────────────────────────────────────────────────────────────

import Redis from 'ioredis';

const url = String(process.env.REDIS_URL || '').trim();

// Helper para log com prefixo
const log = (msg) => console.log(`[redis] ${msg}`);
const warn = (msg) => console.warn(`[redis] ${msg}`);

// ─── Configuração comum ──────────────────────────────────────────────────────
const commonOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy(times) {
    // Backoff até 3s. Depois disso, fica tentando a cada 3s.
    return Math.min(times * 200, 3000);
  },
  reconnectOnError(err) {
    // Reconecta em erros de "READONLY" (failover) mas não em auth
    const targetError = 'READONLY';
    if (err.message.includes(targetError)) return true;
    return false;
  },
};

// ─── Cliente para comandos gerais ────────────────────────────────────────────
export const redis = url
  ? new Redis(url, { ...commonOptions, lazyConnect: false })
  : null;

// ─── Cliente dedicado para subscribe ─────────────────────────────────────────
// ioredis exige uma conexão própria para SUB (não pode compartilhar
// com comandos de escrita/leitura normais).
export const redisSub = url
  ? new Redis(url, { ...commonOptions, lazyConnect: false })
  : null;

// ─── Logs de ciclo de vida ───────────────────────────────────────────────────
if (redis) {
  redis.on('connect', () => log('✅ conectado'));
  redis.on('ready', () => log('✅ pronto para comandos'));
  redis.on('error', (err) => warn(`erro: ${err.message}`));
  redis.on('close', () => warn('conexão fechada'));
  redis.on('reconnecting', (ms) => warn(`reconectando em ${ms}ms`));
} else {
  warn('REDIS_URL não configurada — cache local e SSE por instância');
}

if (redisSub) {
  redisSub.on('connect', () => log('✅ subscriber conectado'));
  redisSub.on('error', (err) => warn(`[sub] erro: ${err.message}`));
}

// ─── Graceful shutdown ──────────────────────────────────────────────────────
export async function closeRedis() {
  const tasks = [];
  if (redis) tasks.push(redis.quit().catch(() => {}));
  if (redisSub) tasks.push(redisSub.quit().catch(() => {}));
  await Promise.all(tasks);
  log('clientes encerrados');
}