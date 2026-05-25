// ============================================================
// Sartec Papelaria — Base de contatos persistente
// GET  /api/contacts?search=...&limit=20
// POST /api/contacts  { phone, action: "reopen" }
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

// ── GET /api/contacts ──────────────────────────────────────
async function handleGet(req, res) {
  const { search = "", limit = "20" } = req.query;
  const limitN = Math.min(parseInt(limit, 10) || 20, 50);

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
    console.error("[contacts/get] ❌", err.message);
    return res.status(500).json({ error: "Erro ao buscar contatos", detail: err.message });
  }
}

// ── POST /api/contacts  { phone, action: "reopen" } ────────
async function handleReopen(req, res) {
  const { phone, action } = req.body || {};

  if (!phone)             return res.status(400).json({ error: "Campo phone obrigatório" });
  if (action !== "reopen") return res.status(400).json({ error: "action inválida" });

  const redis = getRedis();
  const now   = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    // 1. Buscar contato persistente
    const rawContact = await redis.get(`sartec:contact:${phone}`);
    if (!rawContact) return res.status(404).json({ error: "Contato não encontrado" });
    const contact    = JSON.parse(rawContact);

    const clientType = contact.clientType || "pf";
    const isPJ       = clientType === "pj";
    const targetPipeline = isPJ ? "novo" : "em_atendimento";

    let finalSession;

    // 2. Verificar / criar sessão
    await withSessionLock(redis, phone, async () => {
      const rawSession = await redis.get(`sartec:${phone}`);

      if (rawSession) {
        // Sessão existente — reabrir sem sobrescrever histórico
        const session = JSON.parse(rawSession);
        const needsReopen = !session.status ||
          session.status === "resolvido" ||
          session.status === "triagem_incompleta";

        if (needsReopen) {
          session.status         = "aguardando_humano";
          session.pipelineStatus = targetPipeline;
          session.resolvedAt     = null;
        }

        session.lastDate       = today;
        session.lastActivityAt = now;
        await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);
        finalSession = session;
      } else {
        // Sessão inexistente — criar sessão mínima
        const session = {
          history:              [],
          handoffDone:          true,
          postHandoffReplySent: false,
          status:               "aguardando_humano",
          pipelineStatus:       "novo",
          clientType,
          clientName:           contact.clientName || contact.whatsappName || "—",
          demandType:           contact.demandType || "outro",
          lastDate:             today,
          lastActivityAt:       now,
          handoffAt:            now,
          lastUserMessageAt:    null,
          windowExpiresAt:      null,
          createdFromContact:   true,
        };
        await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);
        finalSession = session;
      }
    });

    // 3. Atualizar contato
    try {
      contact.lastConversationStatus = "aguardando_humano";
      contact.lastPipelineStatus     = finalSession.pipelineStatus;
      contact.lastActivityAt         = now;
      contact.lastSeenAt             = now;
      contact.updatedAt              = now;
      await redis.set(`sartec:contact:${phone}`, JSON.stringify(contact));
    } catch (err) {
      console.error("[contacts/reopen] ❌ Erro ao atualizar contato:", err.message);
    }

    console.log(`[contacts/reopen] ✅ +${phone} → ${finalSession.pipelineStatus} (${clientType})`);
    return res.status(200).json({
      success:        true,
      pipelineStatus: finalSession.pipelineStatus,
      clientType,
      conversation: {
        phone,
        status:         finalSession.status,
        pipelineStatus: finalSession.pipelineStatus,
        clientType,
        clientName:     finalSession.clientName,
      },
    });
  } catch (err) {
    console.error("[contacts/reopen] ❌", err.message);
    return res.status(500).json({ error: "Erro ao reabrir contato", detail: err.message });
  }
}

const VALID_DEMAND_TYPES = new Set(["outro", "lista", "cotacao_pj", "xerox", "produto", "duvida"]);

// ── POST /api/contacts  { phone, action: "update", clientName?, clientType?, demandType?, contactNotes? } ──
async function handleUpdate(req, res) {
  const { phone, clientName, clientType, demandType, contactNotes } = req.body || {};

  if (!phone) return res.status(400).json({ error: "Campo phone obrigatório" });
  if (clientType && clientType !== "pf" && clientType !== "pj") {
    return res.status(400).json({ error: "clientType deve ser pf ou pj" });
  }
  if (demandType !== undefined && demandType !== "" && !VALID_DEMAND_TYPES.has(demandType)) {
    return res.status(400).json({ error: `demandType inválido: "${demandType}"`, valid: [...VALID_DEMAND_TYPES] });
  }

  const redis = getRedis();
  const now   = new Date().toISOString();

  try {
    const rawContact = await redis.get(`sartec:contact:${phone}`);
    if (!rawContact) return res.status(404).json({ error: "Contato não encontrado" });

    const contact = JSON.parse(rawContact);

    if (clientName   !== undefined) contact.clientName   = String(clientName).trim().slice(0, 120) || contact.clientName;
    if (clientType   !== undefined) contact.clientType   = clientType;
    // demandType vazio ("") preserva valor anterior — merge seguro
    if (demandType)                 contact.demandType   = demandType;
    if (contactNotes !== undefined) contact.contactNotes = String(contactNotes).trim().slice(0, 500);
    contact.updatedAt = now;

    await redis.set(`sartec:contact:${phone}`, JSON.stringify(contact));

    // Propaga clientName, clientType e demandType para a sessão ativa, sem tocar em status/pipeline/histórico
    if (clientName !== undefined || clientType !== undefined || demandType) {
      await withSessionLock(redis, phone, async () => {
        const rawSession = await redis.get(`sartec:${phone}`);
        if (!rawSession) return;
        const session = JSON.parse(rawSession);
        if (clientName !== undefined) session.clientName = String(clientName).trim().slice(0, 120) || session.clientName;
        if (clientType !== undefined) session.clientType = clientType;
        if (demandType)               session.demandType = demandType;
        await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);
      });
    }

    console.log(`[contacts/update] ✅ +${phone}`);
    return res.status(200).json({ success: true, phone, contact });
  } catch (err) {
    console.error("[contacts/update] ❌", err.message);
    return res.status(500).json({ error: "Erro ao atualizar contato", detail: err.message });
  }
}

// ── Dispatcher ─────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method === "GET") return handleGet(req, res);
  if (req.method === "POST") {
    const { action } = req.body || {};
    if (action === "reopen") return handleReopen(req, res);
    if (action === "update") return handleUpdate(req, res);
    return res.status(400).json({ error: "action inválida. Use 'reopen' ou 'update'" });
  }
  return res.status(405).json({ error: "Method Not Allowed" });
}
