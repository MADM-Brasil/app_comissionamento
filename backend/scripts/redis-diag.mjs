// backend/scripts/redis-diag.mjs
// Rodar de: backend/
//   node --env-file-if-exists=.env scripts/redis-diag.mjs
import { redis } from '../services/bd/redis.js';

async function main() {
  if (!redis) {
    console.error('redis é null — REDIS_URL não está em process.env');
    console.error('  process.env.REDIS_URL =', JSON.stringify(process.env.REDIS_URL ?? null));
    console.error('  cwd =', process.cwd());
    process.exit(1);
  }

  console.log('=== STATUS ===');
  console.log('ready:', redis.status);

  console.log('\n=== LATENCY (10 PINGs) ===');
  const lat = [];
  for (let i = 0; i < 10; i++) {
    const t0 = process.hrtime.bigint();
    await redis.ping();
    lat.push(Number(process.hrtime.bigint() - t0) / 1000);
  }
  lat.sort((a, b) => a - b);
  console.log('min/med/max (µs):', lat[0].toFixed(0), lat[5].toFixed(0), lat[lat.length - 1].toFixed(0));

  for (const section of ['stats', 'memory', 'clients', 'commandstats']) {
    console.log(`\n--- ${section.toUpperCase()} ---`);
    console.log((await redis.info(section)).trim());
  }

  console.log('\n=== SLOWLOG (últimas 20) ===');
  const slow = await redis.slowlog('get', 20);
  for (const entry of slow) {
    const [id, ts, durUs, cmdArr] = entry;
    const cmd = Array.isArray(cmdArr) ? cmdArr.join(' ') : String(cmdArr);
    console.log(`#${id}  ${new Date(ts * 1000).toISOString()}  ${durUs}µs  ${cmd.slice(0, 200)}`);
  }

  console.log('\n=== KEYS relevantes ===');
  for (const pattern of ['ganhos-v4:*', 'stale:ganhos-v4:*', 'inte-comerce-raw-v2:*', 'stale:inte-comerce-raw-v2:*']) {
    let cursor = '0';
    const keys = [];
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    console.log(`${pattern}  →  ${keys.length} key(s)`);
    for (const k of keys.slice(0, 10)) {
      const ttl = await redis.pttl(k);
      const len = await redis.strlen(k);
      console.log(`   ${k}   ttl=${ttl}ms   len=${len}B`);
    }
    if (keys.length > 10) console.log(`   ... +${keys.length - 10}`);
  }

  console.log('\n=== BIGKEYS (top 10) ===');
  const all = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'COUNT', 500);
    cursor = next;
    for (const k of batch) {
      const len = await redis.strlen(k);
      if (len > 0) all.push({ k, len });
    }
  } while (cursor !== '0');
  all.sort((a, b) => b.len - a.len);
  for (const { k, len } of all.slice(0, 10)) console.log(`${String(len).padStart(9)}B  ${k}`);

  await redis.quit();
}

main().catch((e) => { console.error(e); process.exit(1); });