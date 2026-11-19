// backend/PostgreSqlSessionStore.js
// ─────────────────────────────────────────────────────────────────────────────
// Session store PostgreSQL OTIMIZADO PARA CONCORRÊNCIA.
//
// PROBLEMA (versão anterior)
//   Com `rolling: true` + `resave: false`, o express-session chama, em TODA
//   requisição autenticada:
//     1) store.get()   → SELECT na view_app_sessoes
//     2) store.touch() → UPDATE em sessoes_app (e a resposta ESPERA o UPDATE)
//   Ou seja: 2 queries por request. O front abre ~5-10 requests em paralelo
//   por tela → 10-20 queries só de sessão por navegação, por usuário.
//
// SOLUÇÃO
//   • L1 em memória (LRU) com TTL curto → a maioria dos get() vira 0 I/O.
//   • L2 opcional no Redis (compartilhado entre instâncias) → miss de L1
//     em outra instância não vai ao banco.
//   • Deduplicação de leituras concorrentes (singleflight por sid) → 10
//     requests simultâneos do mesmo usuário = 1 leitura no máximo.
//   • touch() com throttle: só grava se a expiração avançou mais que
//     SESSION_TOUCH_INTERVAL_MS (padrão 5 min) desde a última gravação.
//   • touch() em LOTE: todos os touches pendentes viram 1 único UPDATE
//     a cada SESSION_TOUCH_FLUSH_MS (padrão 15 s), e a resposta HTTP não
//     espera mais pelo banco.
//   • Invalidação entre instâncias via Redis pub/sub em set()/destroy()
//     → logout vale na hora em todas as instâncias.
//   • Se o banco falhar momentaneamente, uma sessão válida que já está em
//     memória continua sendo servida (evita derrubar usuários no pico).
//
// Interface pública idêntica à anterior. O 2º parâmetro do construtor
// continua aceitando um número (cleanupIntervalMs) por compatibilidade.
// ─────────────────────────────────────────────────────────────────────────────
import session from 'express-session';
import crypto from 'crypto';

const DUMMY_USER_UUID = '00000000-0000-0000-0000-000000000000';
const DAY_MS = 24 * 60 * 60 * 1000;
const TOUCH_BATCH_SIZE = 500;

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resolveExpiry(sessionData) {
  if (sessionData?.cookie?.expires) return new Date(sessionData.cookie.expires);
  if (sessionData?.cookie?.maxAge) return new Date(Date.now() + sessionData.cookie.maxAge);
  return new Date(Date.now() + DAY_MS);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[SessionStore] ${label} timeout ${ms}ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class PostgreSqlSessionStore extends session.Store {
  constructor(pool, options = {}) {
    super();
    if (typeof options === 'number') options = { cleanupIntervalMs: options };

    this.pool = pool;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 30 * 60 * 1000;

    // ─── Configuração (tudo ajustável por env) ───────────────────────────
    this.l1TtlMs = options.l1TtlMs ?? envNum('SESSION_L1_TTL_MS', 30_000);
    this.l1MaxEntries = options.l1MaxEntries ?? envNum('SESSION_L1_MAX', 5_000);
    this.negativeTtlMs = options.negativeTtlMs ?? envNum('SESSION_NEGATIVE_TTL_MS', 5_000);
    this.redisTtlMs = options.redisTtlMs ?? envNum('SESSION_REDIS_TTL_MS', 5 * 60_000);
    this.redisTimeoutMs = options.redisTimeoutMs ?? envNum('SESSION_REDIS_TIMEOUT_MS', 300);
    this.touchIntervalMs = options.touchIntervalMs ?? envNum('SESSION_TOUCH_INTERVAL_MS', 5 * 60_000);
    this.touchFlushMs = options.touchFlushMs ?? envNum('SESSION_TOUCH_FLUSH_MS', 15_000);
    this.keyPrefix = options.keyPrefix ?? 'sess:';
    this.channel = options.invalidationChannel ?? 'sess:invalidate';

    this.redis = options.redis ?? null;
    this.redisSub = options.redisSub ?? null;
    this._instanceId = crypto.randomBytes(8).toString('hex');
    this._redisDownUntil = 0;

    // ─── Estado interno ──────────────────────────────────────────────────
    // L1: sid → { json: string|null, expiraEm: ms, cachedAt: ms }
    //     json === null significa "sessão não existe" (cache negativo curto)
    this._l1 = new Map();
    this._inflight = new Map();          // sid → { promise }
    this._persistedExpiry = new Map();   // sid → expira_em (ms) já gravado no banco
    this._pendingTouches = new Map();    // sid → nova expira_em (ms) a gravar
    this._flushing = null;
    this._closed = false;

    this._stats = {
      l1Hits: 0,
      l1NegativeHits: 0,
      redisHits: 0,
      redisErrors: 0,
      dbReads: 0,
      dbReadErrors: 0,
      staleServed: 0,
      dedupedLoads: 0,
      sets: 0,
      destroys: 0,
      touchCalls: 0,
      touchSkipped: 0,
      touchQueued: 0,
      touchFlushes: 0,
      touchRowsWritten: 0,
      touchFlushErrors: 0,
      invalidationsReceived: 0,
    };

    this.pool.on('error', (err) => {
      console.error('❌ Erro no pool PostgreSQL (store):', err);
    });
    this.pool.on('connect', () => {
      this.emit('connect');
    });

    this._subscribeInvalidations();
    this._startTimers();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TIMERS
  // ═══════════════════════════════════════════════════════════════════════
  _startTimers() {
    this._cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
      this._pruneMemory();
    }, this.cleanupIntervalMs);
    this._cleanupTimer.unref?.();

    this._bootCleanupTimer = setTimeout(() => this.cleanupExpiredSessions(), 5000);
    this._bootCleanupTimer.unref?.();

    this._flushTimer = setInterval(() => {
      this.flushTouches().catch(() => {});
    }, this.touchFlushMs);
    this._flushTimer.unref?.();
  }

  async cleanupExpiredSessions() {
    try {
      const query = `
        UPDATE app_comissionamento.sessoes_app
        SET status_sessao = 'EXPIRADA',
            encerrada_em = NOW(),
            motivo_encerramento = 'EXPIRACAO',
            duracao_segundos = EXTRACT(EPOCH FROM (NOW() - login_em))::bigint
        WHERE status_sessao = 'ATIVA'
          AND expira_em <= NOW()
        RETURNING sid
      `;
      const result = await this.pool.query(query);
      if (result.rows.length > 0) {
        for (const { sid } of result.rows) this._forgetLocal(sid);
        console.log(`🧹 [SessionStore] ${result.rows.length} sessão(ões) marcada(s) como EXPIRADA.`);
      }
    } catch (err) {
      console.error('❌ [SessionStore] Erro ao limpar sessões expiradas:', err);
    }
  }

  _pruneMemory() {
    const now = Date.now();
    for (const [sid, entry] of this._l1) {
      if (entry.json === null ? now - entry.cachedAt > this.negativeTtlMs : entry.expiraEm <= now) {
        this._l1.delete(sid);
      }
    }
    for (const [sid, exp] of this._persistedExpiry) {
      if (exp <= now) this._persistedExpiry.delete(sid);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // L1 (LRU)
  // ═══════════════════════════════════════════════════════════════════════
  _l1Peek(sid) {
    const entry = this._l1.get(sid);
    if (entry) {
      this._l1.delete(sid);
      this._l1.set(sid, entry);
    }
    return entry;
  }

  _l1Set(sid, json, expiraEm) {
    this._l1.delete(sid);
    this._l1.set(sid, { json, expiraEm, cachedAt: Date.now() });
    while (this._l1.size > this.l1MaxEntries) {
      const oldest = this._l1.keys().next().value;
      if (oldest === undefined) break;
      this._l1.delete(oldest);
    }
  }

  _rememberPersisted(sid, expiraEm) {
    this._persistedExpiry.delete(sid);
    this._persistedExpiry.set(sid, expiraEm);
    const max = this.l1MaxEntries * 4;
    while (this._persistedExpiry.size > max) {
      const oldest = this._persistedExpiry.keys().next().value;
      if (oldest === undefined) break;
      this._persistedExpiry.delete(oldest);
    }
  }

  _forgetLocal(sid) {
    this._l1.delete(sid);
    this._inflight.delete(sid); // leituras em voo não repopulam o cache
    this._persistedExpiry.delete(sid);
    this._pendingTouches.delete(sid);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REDIS (opcional) — nunca bloqueia: timeout curto + pausa se falhar
  // ═══════════════════════════════════════════════════════════════════════
  _redisUsable() {
    return Boolean(this.redis) && this.redis.status === 'ready' && Date.now() >= this._redisDownUntil;
  }

  _redisFailed(err) {
    this._stats.redisErrors++;
    if (Date.now() >= this._redisDownUntil) {
      console.warn(`[SessionStore] Redis indisponível, usando só memória/banco por 30s: ${err?.message || err}`);
    }
    this._redisDownUntil = Date.now() + 30_000;
  }

  async _redisGet(sid) {
    if (!this._redisUsable()) return null;
    try {
      const raw = await withTimeout(this.redis.get(this.keyPrefix + sid), this.redisTimeoutMs, 'redis get');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed?.d !== 'string' || typeof parsed?.e !== 'number') return null;
      return parsed;
    } catch (err) {
      this._redisFailed(err);
      return null;
    }
  }

  _redisSet(sid, json, expiraEm) {
    if (!this._redisUsable()) return;
    const ttl = Math.min(this.redisTtlMs, expiraEm - Date.now());
    if (ttl < 1000) return;
    this.redis
      .set(this.keyPrefix + sid, JSON.stringify({ d: json, e: expiraEm }), 'PX', Math.round(ttl))
      .catch((err) => this._redisFailed(err));
  }

  _redisDelAndPublish(sid) {
    if (!this.redis || this.redis.status !== 'ready') return;
    // Mesma conexão → DEL chega antes do PUBLISH.
    this.redis.del(this.keyPrefix + sid).catch((err) => this._redisFailed(err));
    this._publishInvalidation(sid);
  }

  _publishInvalidation(sid) {
    if (!this.redis || this.redis.status !== 'ready') return;
    this.redis
      .publish(this.channel, JSON.stringify({ sid, origin: this._instanceId }))
      .catch((err) => this._redisFailed(err));
  }

  _subscribeInvalidations() {
    if (!this.redisSub) return;
    this.redisSub.subscribe(this.channel).catch((err) => {
      console.warn('[SessionStore] não consegui assinar invalidações:', err?.message || err);
    });
    this.redisSub.on('message', (channel, message) => {
      if (channel !== this.channel) return;
      try {
        const { sid, origin } = JSON.parse(message);
        if (!sid || origin === this._instanceId) return;
        this._stats.invalidationsReceived++;
        this._l1.delete(sid);
        this._inflight.delete(sid);
        this._persistedExpiry.delete(sid);
      } catch {
        /* mensagem inválida — ignora */
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GET
  // ═══════════════════════════════════════════════════════════════════════
  get(sid, callback) {
    this._load(sid).then(
      (json) => {
        if (json == null) return callback(null, null);
        let data;
        try {
          // Cada request recebe um objeto NOVO (o cache guarda string):
          // requests paralelos do mesmo usuário não compartilham referência.
          data = JSON.parse(json);
        } catch (e) {
          this._forgetLocal(sid);
          return callback(e);
        }
        callback(null, data);
      },
      (err) => callback(err)
    );
  }

  _load(sid) {
    const now = Date.now();
    const entry = this._l1Peek(sid);
    if (entry) {
      if (entry.json === null) {
        if (now - entry.cachedAt < this.negativeTtlMs) {
          this._stats.l1NegativeHits++;
          return Promise.resolve(null);
        }
      } else if (entry.expiraEm > now && now - entry.cachedAt < this.l1TtlMs) {
        this._stats.l1Hits++;
        return Promise.resolve(entry.json);
      }
    }

    const inflight = this._inflight.get(sid);
    if (inflight) {
      this._stats.dedupedLoads++;
      return inflight.promise;
    }

    const token = {};
    this._inflight.set(sid, token);
    token.promise = this._loadSlow(sid, token, entry).finally(() => {
      if (this._inflight.get(sid) === token) this._inflight.delete(sid);
    });
    return token.promise;
  }

  async _loadSlow(sid, token, staleEntry) {
    const stillCurrent = () => this._inflight.get(sid) === token;

    // 1) Redis (compartilhado entre instâncias)
    const cached = await this._redisGet(sid);
    if (cached && cached.e > Date.now()) {
      this._stats.redisHits++;
      if (stillCurrent()) {
        const pending = this._pendingTouches.get(sid) ?? 0;
        this._l1Set(sid, cached.d, Math.max(cached.e, pending));
        if (!this._persistedExpiry.has(sid)) this._rememberPersisted(sid, cached.e);
      }
      return cached.d;
    }

    // 2) Banco
    this._stats.dbReads++;
    let rows;
    try {
      ({ rows } = await this.pool.query(
        `SELECT dados_sessao, expira_em, status_sessao
           FROM app_comissionamento.view_app_sessoes
          WHERE sid = $1
            AND status_sessao = 'ATIVA'
            AND expira_em > NOW()`,
        [sid]
      ));
    } catch (err) {
      this._stats.dbReadErrors++;
      // Banco instável: se já tínhamos uma cópia válida, mantém o usuário logado.
      if (staleEntry?.json && staleEntry.expiraEm > Date.now()) {
        this._stats.staleServed++;
        if (stillCurrent()) {
          // tenta o banco de novo em ~5s, não a cada request
          staleEntry.cachedAt = Date.now() - Math.max(0, this.l1TtlMs - 5_000);
          this._l1.set(sid, staleEntry);
        }
        return staleEntry.json;
      }
      throw err;
    }

    if (rows.length === 0) {
      if (stillCurrent()) this._l1Set(sid, null, 0);
      return null;
    }

    const row = rows[0];
    const json = typeof row.dados_sessao === 'string' ? row.dados_sessao : JSON.stringify(row.dados_sessao);
    const expiraEm = new Date(row.expira_em).getTime();

    if (stillCurrent()) {
      const pending = this._pendingTouches.get(sid) ?? 0;
      this._l1Set(sid, json, Math.max(expiraEm, pending));
      this._rememberPersisted(sid, expiraEm);
      this._redisSet(sid, json, expiraEm);
    }
    return json;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SET — só acontece quando a sessão muda (login, 2FA, reset de senha)
  // ═══════════════════════════════════════════════════════════════════════
  set(sid, sessionData, callback) {
    const now = new Date();
    const expiraEm = resolveExpiry(sessionData);
    const dadosSessao = JSON.stringify(sessionData);
    const ip = sessionData.ip || null;
    const userAgent = sessionData.userAgent || null;

    const query = `
      INSERT INTO app_comissionamento.sessoes_app
        (sid, usuario_id, dados_sessao, ip_address, user_agent,
         login_em, ultima_atividade_em, expira_em, status_sessao, criado_em)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ATIVA', $7)
      ON CONFLICT (sid) DO UPDATE SET
        usuario_id = EXCLUDED.usuario_id,
        dados_sessao = EXCLUDED.dados_sessao,
        ip_address = EXCLUDED.ip_address,
        user_agent = EXCLUDED.user_agent,
        ultima_atividade_em = EXCLUDED.ultima_atividade_em,
        expira_em = EXCLUDED.expira_em,
        status_sessao = 'ATIVA'
    `;
    const values = [sid, DUMMY_USER_UUID, dadosSessao, ip, userAgent, now, now, expiraEm];

    // Invalida antes de gravar: nenhuma leitura em voo pode repor a versão antiga.
    this._inflight.delete(sid);

    this.pool.query(query, values, (err) => {
      if (err) {
        this._forgetLocal(sid);
        return callback?.(err);
      }
      this._stats.sets++;
      const exp = expiraEm.getTime();
      this._inflight.delete(sid);
      this._pendingTouches.delete(sid);
      this._l1Set(sid, dadosSessao, exp);
      this._rememberPersisted(sid, exp);
      this._redisSet(sid, dadosSessao, exp);
      this._publishInvalidation(sid);
      callback?.(null);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // DESTROY — logout
  // ═══════════════════════════════════════════════════════════════════════
  destroy(sid, callback) {
    // Remove do cache ANTES de ir ao banco (seguro mesmo se o UPDATE falhar).
    this._forgetLocal(sid);
    this._redisDelAndPublish(sid);

    const query = `
      UPDATE app_comissionamento.sessoes_app
      SET status_sessao = 'LOGOUT',
          logout_em = NOW(),
          encerrada_em = NOW(),
          motivo_encerramento = 'LOGOUT_USUARIO',
          duracao_segundos = EXTRACT(EPOCH FROM (NOW() - login_em))::bigint
      WHERE sid = $1
    `;
    this.pool.query(query, [sid], (err) => {
      // Garante que nada repopulou o cache durante o UPDATE.
      this._forgetLocal(sid);
      if (err) {
        console.error('❌ [SessionStore] Erro ao destruir sessão:', err);
        return callback?.(err);
      }
      this._stats.destroys++;
      callback?.(null);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TOUCH — chamado em TODA request. Agora: 0 queries na grande maioria.
  // ═══════════════════════════════════════════════════════════════════════
  touch(sid, sessionData, callback) {
    this._stats.touchCalls++;
    const exp = resolveExpiry(sessionData).getTime();

    const entry = this._l1.get(sid);
    if (entry?.json) entry.expiraEm = Math.max(entry.expiraEm, exp);

    const persisted = this._persistedExpiry.get(sid);
    const queued = this._pendingTouches.get(sid);
    const reference = Math.max(persisted ?? 0, queued ?? 0);

    if (persisted !== undefined && exp - reference < this.touchIntervalMs) {
      this._stats.touchSkipped++;
    } else {
      this._pendingTouches.set(sid, Math.max(exp, queued ?? 0));
      this._stats.touchQueued++;
    }
    // Não espera o banco: a gravação sai no próximo lote.
    callback?.(null);
  }

  async flushTouches() {
    if (this._flushing) return this._flushing;
    if (this._pendingTouches.size === 0) return;

    this._flushing = (async () => {
      const batch = [...this._pendingTouches];
      this._pendingTouches.clear();

      for (let i = 0; i < batch.length; i += TOUCH_BATCH_SIZE) {
        const chunk = batch.slice(i, i + TOUCH_BATCH_SIZE);
        const sids = chunk.map(([sid]) => sid);
        const exps = chunk.map(([, exp]) => new Date(exp));
        try {
          // 1 UPDATE para N sessões. Nunca ressuscita sessão encerrada
          // e nunca encurta uma expiração.
          const result = await this.pool.query(
            `UPDATE app_comissionamento.sessoes_app AS s
                SET ultima_atividade_em = NOW(),
                    expira_em = v.expira_em
               FROM unnest($1::text[], $2::timestamptz[]) AS v(sid, expira_em)
              WHERE s.sid = v.sid
                AND s.status_sessao = 'ATIVA'
                AND s.expira_em < v.expira_em`,
            [sids, exps]
          );
          this._stats.touchFlushes++;
          this._stats.touchRowsWritten += result.rowCount ?? 0;
          for (const [sid, exp] of chunk) this._rememberPersisted(sid, exp);
        } catch (err) {
          this._stats.touchFlushErrors++;
          console.warn(`[SessionStore] falha ao gravar ${chunk.length} touch(es), nova tentativa no próximo lote:`, err?.message || err);
          for (const [sid, exp] of chunk) {
            const newer = this._pendingTouches.get(sid);
            if (newer === undefined || newer < exp) this._pendingTouches.set(sid, exp);
          }
        }
      }
    })().finally(() => {
      this._flushing = null;
    });

    return this._flushing;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SHUTDOWN / MONITORAMENTO
  // ═══════════════════════════════════════════════════════════════════════
  async close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._cleanupTimer);
    clearInterval(this._flushTimer);
    clearTimeout(this._bootCleanupTimer);
    if (this._flushing) await this._flushing.catch(() => {});
    await this.flushTouches();
  }

  stats() {
    const s = this._stats;
    const reads = s.l1Hits + s.l1NegativeHits + s.redisHits + s.dbReads + s.dedupedLoads;
    return {
      l1Size: this._l1.size,
      l1MaxEntries: this.l1MaxEntries,
      pendingTouches: this._pendingTouches.size,
      redis: Boolean(this.redis),
      redisPausedUntil: this._redisDownUntil > Date.now() ? new Date(this._redisDownUntil).toISOString() : null,
      readsAvoidedRatio: reads > 0 ? Number((1 - s.dbReads / reads).toFixed(4)) : null,
      touchWritesAvoidedRatio: s.touchCalls > 0
        ? Number((1 - s.touchFlushes / s.touchCalls).toFixed(4))
        : null,
      config: {
        l1TtlMs: this.l1TtlMs,
        redisTtlMs: this.redisTtlMs,
        touchIntervalMs: this.touchIntervalMs,
        touchFlushMs: this.touchFlushMs,
      },
      counters: { ...s },
    };
  }
}