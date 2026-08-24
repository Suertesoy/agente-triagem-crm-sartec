// In-memory fake of the tiny ioredis subset api/webhook.js and api/queue.js
// actually use (get/set/del/mget/scan/pipeline/on). Not a general-purpose
// ioredis mock — only the commands this project calls.
const store = new Map();
const expiresAt = new Map();
const sets = new Map();
const lists = new Map();
const zsets = new Map();
let clockOffsetMs = 0;

function now() {
  return Date.now() + clockOffsetMs;
}

function purgeExpired(key) {
  if (expiresAt.has(key) && expiresAt.get(key) <= now()) {
    store.delete(key);
    lists.delete(key);
    expiresAt.delete(key);
  }
}

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export default class FakeRedis {
  constructor(_url, _opts) {}
  on() {}

  async get(key) {
    purgeExpired(key);
    return store.has(key) ? store.get(key) : null;
  }

  async set(key, value, ...flags) {
    purgeExpired(key);
    const nx = flags.includes("NX");
    if (nx && store.has(key)) return null;
    store.set(key, value);
    const exIndex = flags.indexOf("EX");
    if (exIndex >= 0) expiresAt.set(key, now() + Number(flags[exIndex + 1]) * 1000);
    else if (!flags.includes("KEEPTTL")) expiresAt.delete(key);
    return "OK";
  }

  async del(...keys) {
    let n = 0;
    for (const k of keys) {
      purgeExpired(k);
      if (store.delete(k)) n++;
      expiresAt.delete(k);
    }
    return n;
  }

  async incr(key) {
    const next = Number(await this.get(key) || 0) + 1;
    await this.set(key, String(next));
    return next;
  }

  async pexpire(key, ttlMs) {
    purgeExpired(key);
    if (!store.has(key)) return 0;
    expiresAt.set(key, now() + Number(ttlMs));
    return 1;
  }

  async sadd(key, ...members) {
    if (!sets.has(key)) sets.set(key, new Set());
    let added = 0;
    for (const member of members) {
      if (!sets.get(key).has(member)) added += 1;
      sets.get(key).add(member);
    }
    return added;
  }

  async smembers(key) {
    return [...(sets.get(key) || [])];
  }

  async srem(key, ...members) {
    let removed = 0;
    for (const member of members) if (sets.get(key)?.delete(member)) removed += 1;
    return removed;
  }

  async eval(script, numberOfKeys, ...args) {
    const keys = args.slice(0, numberOfKeys);
    const argv = args.slice(numberOfKeys);
    if (script.includes("crm-shadow:commit-v2")) {
      const revision = await this.incr(keys[0]);
      if (argv[1] === "keep") await this.set(keys[1], argv[0], "KEEPTTL");
      else if (argv[1]) await this.set(keys[1], argv[0], "EX", argv[1]);
      else await this.set(keys[1], argv[0]);
      const entityCount = Number(argv[2]);
      for (let index = 0; index < entityCount; index += 1) {
        const item = JSON.parse(argv[3 + index * 2]);
        const member = argv[4 + index * 2];
        item.shadowRevision = revision;
        await this.set(keys[3 + index * 2], String(revision));
        await this.set(keys[4 + index * 2], JSON.stringify(item));
        await this.sadd(keys[2], member);
      }
      return revision;
    }
    if (script.includes("crm-shadow:remove-v1")) {
      const raw = await this.get(keys[0]);
      if (!raw) {
        await this.srem(keys[1], argv[1]);
        return 0;
      }
      if (String(JSON.parse(raw).shadowRevision) !== argv[0]) return 0;
      await this.del(keys[0]);
      await this.srem(keys[1], argv[1]);
      return 1;
    }
    if (script.includes("crm-shadow:failure-v1")) {
      const raw = await this.get(keys[0]);
      if (!raw) return 0;
      const item = JSON.parse(raw);
      if (String(item.shadowRevision) !== argv[0]) return 0;
      item.attempts = (item.attempts || 0) + 1;
      item.lastError = argv[1];
      await this.set(keys[0], JSON.stringify(item));
      return 1;
    }
    if (script.includes("redis-lock:renew-v1")) {
      if (await this.get(keys[0]) !== argv[0]) return 0;
      return this.pexpire(keys[0], argv[1]);
    }
    if (numberOfKeys !== 1) throw new Error("FakeRedis.eval não reconheceu o script");
    if (await this.get(keys[0]) !== argv[0]) return 0;
    return this.del(keys[0]);
  }

  async mget(...keys) {
    return keys.map((k) => (store.has(k) ? store.get(k) : null));
  }

  async scan(_cursor, _matchKw, pattern, _countKw, _count) {
    const re = globToRegExp(pattern);
    // SCAN varre todo o keyspace (não só chaves string) — sorted sets também
    // precisam aparecer aqui para que os filtros de sartec:* em produção
    // (queue.js/conversations.js/metrics.js) sejam exercitados de verdade.
    const found = [...store.keys(), ...zsets.keys()].filter((k) => re.test(k));
    return ["0", found];
  }

  // ── Sorted set (subconjunto usado pela fila sartec:feedback:due) ──────────
  async zadd(key, score, member) {
    if (!zsets.has(key)) zsets.set(key, new Map());
    const isNew = !zsets.get(key).has(member);
    zsets.get(key).set(member, Number(score));
    return isNew ? 1 : 0;
  }

  async zscore(key, member) {
    const score = zsets.get(key)?.get(member);
    return score === undefined ? null : String(score);
  }

  async zcard(key) {
    return zsets.get(key)?.size ?? 0;
  }

  async zrange(key, start, stop) {
    const members = zsets.get(key);
    if (!members) return [];
    const sorted = [...members.entries()].sort((a, b) => a[1] - b[1]).map(([member]) => member);
    const len = sorted.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = Math.min(stop < 0 ? len + stop : stop, len - 1);
    return s > e || len === 0 ? [] : sorted.slice(s, e + 1);
  }

  pipeline() {
    const ops = [];
    return {
      del(key) { ops.push(key); return this; },
      async exec() {
        for (const k of ops) store.delete(k);
        return ops.map(() => [null, 1]);
      },
    };
  }

  // ── Lista (subconjunto usado pela métrica best-effort de encaminhamentos Denise) ──
  async lpush(key, ...values) {
    purgeExpired(key);
    if (!lists.has(key)) lists.set(key, []);
    const arr = lists.get(key);
    for (const v of values) arr.unshift(v);
    return arr.length;
  }

  async ltrim(key, start, stop) {
    purgeExpired(key);
    const arr = lists.get(key) || [];
    const len = arr.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = Math.min(stop < 0 ? len + stop : stop, len - 1);
    lists.set(key, s > e || len === 0 ? [] : arr.slice(s, e + 1));
    return "OK";
  }

  async lrange(key, start, stop) {
    purgeExpired(key);
    const arr = lists.get(key) || [];
    const len = arr.length;
    const s = start < 0 ? Math.max(len + start, 0) : start;
    const e = Math.min(stop < 0 ? len + stop : stop, len - 1);
    return s > e || len === 0 ? [] : arr.slice(s, e + 1);
  }

  async expire(key, seconds) {
    purgeExpired(key);
    if (!store.has(key) && !lists.has(key)) return 0;
    expiresAt.set(key, now() + Number(seconds) * 1000);
    return 1;
  }

  multi() {
    const ops = [];
    const self = this;
    const chain = {
      lpush(key, ...values) { ops.push(() => self.lpush(key, ...values)); return chain; },
      ltrim(key, start, stop) { ops.push(() => self.ltrim(key, start, stop)); return chain; },
      expire(key, seconds) { ops.push(() => self.expire(key, seconds)); return chain; },
      async exec() {
        const results = [];
        for (const op of ops) results.push([null, await op()]);
        return results;
      },
    };
    return chain;
  }

  // Test-only helpers — not part of the real ioredis API.
  static _reset() {
    store.clear();
    expiresAt.clear();
    sets.clear();
    lists.clear();
    zsets.clear();
    clockOffsetMs = 0;
  }

  static _advanceTime(ms) {
    clockOffsetMs += ms;
  }
}
