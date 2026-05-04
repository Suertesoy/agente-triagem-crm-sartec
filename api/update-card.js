// ============================================================
// Sartec Papelaria — Atualizar campos do card
// PUT /api/update-card  { phone, ...campos }
// Merge parcial: só atualiza os campos enviados.
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/update-card] ❌", err.message));
  }
  return redisClient;
}

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 dias

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

// Campos aceitos — merge parcial
const ALLOWED_FIELDS = [
  "dataLimite",
  "formaEntrega",
  "endereco",
  "observacoes",
  "escola",
  "serie",
  // Editáveis inline no card
  "clientName",
  "cardTitle",
  "demandType",
  "clientType",
  "priorityManual",
];

export default async function handler(req, res) {
  if (req.method !== "PUT") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const body = req.body || {};
  const { phone } = body;

  if (!phone) {
    return res.status(400).json({ error: "Campo phone é obrigatório" });
  }

  try {
    const redis = getRedis();
    let notFound = false;
    let savedSession;
    let updated = [];
    await withSessionLock(redis, phone, async () => {
      const raw = await redis.get(`sartec:${phone}`);
      if (!raw) { notFound = true; return; }

      const session = JSON.parse(raw);

      for (const field of ALLOWED_FIELDS) {
        if (body[field] !== undefined) {
          session[field] = body[field];
          updated.push(field);
        }
      }

      await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);
      savedSession = session;
    });

    if (notFound) return res.status(404).json({ error: "Conversa não encontrada" });

    console.log(`[update-card] ✅ +${phone} | ${updated.join(", ")}`);
    return res.status(200).json({
      success: true,
      updated,
      // Retorna os campos atuais para o painel atualizar sem novo polling
      clientName:     savedSession.clientName     || "—",
      cardTitle:      savedSession.cardTitle      || "",
      demandType:     savedSession.demandType     || "outro",
      clientType:     savedSession.clientType     || "pf",
      pipelineStatus: savedSession.pipelineStatus || "novo",
    });
  } catch (err) {
    console.error("[update-card] ❌", err.message);
    return res.status(500).json({ error: "Erro ao atualizar card", detail: err.message });
  }
}
