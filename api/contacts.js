// ============================================================
// Sartec Papelaria — Base de contatos persistente
// GET /api/contacts?search=...&limit=30
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/contacts] ❌", err.message));
  }
  return redisClient;
}

async function scanContactKeys(redis) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", "sartec:contact:*", "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { search = "", limit = "30" } = req.query;
  const limitN = Math.min(parseInt(limit, 10) || 30, 100);

  try {
    const redis = getRedis();
    const keys  = await scanContactKeys(redis);

    const contacts = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      try { contacts.push(JSON.parse(raw)); } catch {}
    }

    const q = search.toLowerCase();
    const filtered = q
      ? contacts.filter(c =>
          (c.phone        || "").includes(q) ||
          (c.clientName   || "").toLowerCase().includes(q) ||
          (c.whatsappName || "").toLowerCase().includes(q)
        )
      : contacts;

    filtered.sort((a, b) =>
      (b.lastSeenAt || "").localeCompare(a.lastSeenAt || "")
    );

    return res.status(200).json({
      contacts: filtered.slice(0, limitN),
      total:    filtered.length,
    });
  } catch (err) {
    console.error("[contacts] ❌", err.message);
    return res.status(500).json({ error: "Erro ao buscar contatos", detail: err.message });
  }
}
