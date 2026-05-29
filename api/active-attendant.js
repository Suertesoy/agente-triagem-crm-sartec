// ============================================================
// Sartec Papelaria — Registrar atendente ativo na conversa
// POST /api/active-attendant  { phone, attendant: { id, name, initials, color } }
// POST /api/active-attendant  { action: "setPjLunchMode", enabled: bool, updatedBy? }
// GET  /api/active-attendant?action=getPjLunchMode
// ============================================================

import Redis from "ioredis";

let redisClient = null;

const SESSION_TTL = 60 * 60 * 24 * 90; // 90 dias — retenção mínima de histórico

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/active-attendant] ❌", err.message));
  }
  return redisClient;
}

export default async function handler(req, res) {
  if (req.method === "GET")  return handleGet(req, res);
  if (req.method === "POST") return handlePost(req, res);
  return res.status(405).json({ error: "Method Not Allowed" });
}

// ── GET /api/active-attendant?action=getPjLunchMode ───────
async function handleGet(req, res) {
  const { action } = req.query;
  if (action !== "getPjLunchMode") {
    return res.status(400).json({ error: "action inválida. Use getPjLunchMode" });
  }
  try {
    const raw = await getRedis().get("sartec:settings:pjLunchMode");
    if (!raw) return res.status(200).json({ enabled: false, updatedAt: null, updatedBy: null });
    const data = JSON.parse(raw);
    return res.status(200).json({
      enabled:   data.enabled   || false,
      updatedAt: data.updatedAt || null,
      updatedBy: data.updatedBy || null,
    });
  } catch (err) {
    console.error("[active-attendant/getPjLunchMode] ❌", err.message);
    return res.status(500).json({ error: "Erro ao buscar estado de almoço PJ", detail: err.message });
  }
}

// ── POST /api/active-attendant ────────────────────────────
async function handlePost(req, res) {
  const body = req.body || {};

  // ── action: setPjLunchMode ─────────────────────────────────────────────────
  if (body.action === "setPjLunchMode") {
    const { enabled, updatedBy } = body;
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Campo enabled deve ser boolean" });
    }
    try {
      const now  = new Date().toISOString();
      const data = { enabled, updatedAt: now, updatedBy: updatedBy || null };
      await getRedis().set("sartec:settings:pjLunchMode", JSON.stringify(data));
      console.log(`[active-attendant] 🍽️  pjLunchMode=${enabled} por ${updatedBy || "?"}`);
      return res.status(200).json({ success: true, ...data });
    } catch (err) {
      console.error("[active-attendant/setPjLunchMode] ❌", err.message);
      return res.status(500).json({ error: "Erro ao salvar estado de almoço PJ", detail: err.message });
    }
  }

  // ── Comportamento original: registrar atendente ativo ─────────────────────
  const { phone, attendant } = body;

  if (!phone)               return res.status(400).json({ error: "Campo phone obrigatório" });
  if (!attendant?.id)       return res.status(400).json({ error: "Campo attendant.id obrigatório" });
  if (!attendant?.name)     return res.status(400).json({ error: "Campo attendant.name obrigatório" });

  try {
    const redis = getRedis();
    const raw   = await redis.get(`sartec:${phone}`);

    if (!raw) return res.status(404).json({ error: "Conversa não encontrada" });

    const session = JSON.parse(raw);

    session.activeAttendant   = {
      id:       attendant.id,
      name:     attendant.name,
      initials: attendant.initials || attendant.name.slice(0, 2).toUpperCase(),
      color:    attendant.color    || "#3b82f6",
    };
    session.activeAttendantAt = new Date().toISOString();

    await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);

    console.log(`[active-attendant] ✅ +${phone} → ${attendant.name}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("[active-attendant] ❌", err.message);
    return res.status(500).json({ error: "Erro ao registrar atendente", detail: err.message });
  }
}
