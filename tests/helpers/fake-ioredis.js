// In-memory fake of the tiny ioredis subset api/webhook.js and api/queue.js
// actually use (get/set/del/mget/scan/pipeline/on). Not a general-purpose
// ioredis mock — only the commands this project calls.
const store = new Map();
const expiresAt = new Map();
let clockOffsetMs = 0;

function now() {
  return Date.now() + clockOffsetMs;
}

function purgeExpired(key) {
  if (expiresAt.has(key) && expiresAt.get(key) <= now()) {
    store.delete(key);
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

  async eval(_script, numberOfKeys, key, token) {
    if (numberOfKeys !== 1) throw new Error("FakeRedis.eval suporta exatamente uma chave");
    if (await this.get(key) !== token) return 0;
    return this.del(key);
  }

  async mget(...keys) {
    return keys.map((k) => (store.has(k) ? store.get(k) : null));
  }

  async scan(_cursor, _matchKw, pattern, _countKw, _count) {
    const re = globToRegExp(pattern);
    const found = [...store.keys()].filter((k) => re.test(k));
    return ["0", found];
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

  // Test-only helpers — not part of the real ioredis API.
  static _reset() {
    store.clear();
    expiresAt.clear();
    clockOffsetMs = 0;
  }

  static _advanceTime(ms) {
    clockOffsetMs += ms;
  }
}
