// In-memory fake of the tiny ioredis subset api/webhook.js and api/queue.js
// actually use (get/set/del/mget/scan/pipeline/on). Not a general-purpose
// ioredis mock — only the commands this project calls.
const store = new Map();

function globToRegExp(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

export default class FakeRedis {
  constructor(_url, _opts) {}
  on() {}

  async get(key) {
    return store.has(key) ? store.get(key) : null;
  }

  async set(key, value, ...flags) {
    const nx = flags.includes("NX");
    if (nx && store.has(key)) return null;
    store.set(key, value);
    return "OK";
  }

  async del(...keys) {
    let n = 0;
    for (const k of keys) if (store.delete(k)) n++;
    return n;
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
  }
}
