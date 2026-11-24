// scripts/scan-ganhos.mjs
import { redis } from '../services/bd/redis.js';
for (const p of ['ganhos:*', 'stale:ganhos:*', 'inte-comerce-raw*:*', 'stale:inte-comerce-raw*:*']) {
  let cursor = '0', keys = [];
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', p, 'COUNT', 500);
    cursor = next; keys.push(...batch);
  } while (cursor !== '0');
  console.log(`${p}  →  ${keys.length} key(s)`);
  for (const k of keys.slice(0, 5)) console.log(`   ${k}   ttl=${await redis.pttl(k)}ms  len=${await redis.strlen(k)}B`);
}
await redis.quit();