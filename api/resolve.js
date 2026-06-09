// ============================================================
// Sartec Papelaria — Marcar conversa como resolvida
// POST /api/resolve  { phone }
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/resolve] ❌", err.message));
  }
  return redisClient;
}

const SESSION_TTL = 60 * 60 * 24 * 90; // 90 dias — retenção mínima de histórico

async function withSessionLock(redis, phone, fn) {
  const lockKey = `lock:sartec:${phone}`;
  for (let i = 0; i < 20; i++) {
    const ok = await redis.set(lockKey, "1", "NX", "EX", 15);
    if (ok) {
      try { return await fn(); }
      finally { await redis.del(lockKey); }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.warn(`[Lock] ⚠️ Timeout +${phone}`);
  return fn();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { phone } = req.body || {};

  if (!phone) {
    return res.status(400).json({ error: "Campo phone é obrigatório" });
  }

  try {
    const redis = getRedis();
    let notFound = false;
    let resolvedAt;
    await withSessionLock(redis, phone, async () => {
      const raw = await redis.get(`sartec:${phone}`);
      if (!raw) { notFound = true; return; }

      const session      = JSON.parse(raw);
      session.status     = "resolvido";
      session.resolvedAt = new Date().toISOString();
      resolvedAt         = session.resolvedAt;

      await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);
    });

    if (notFound) return res.status(404).json({ error: "Conversa não encontrada" });

    console.log(`[resolve] ✅ +${phone} marcado como resolvido`);
    return res.status(200).json({ success: true, resolvedAt });
  } catch (err) {
    console.error("[resolve] ❌", err.message);
    return res.status(500).json({ error: "Erro ao resolver conversa", detail: err.message });
  }
}
