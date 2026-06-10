// ============================================================
// Sartec — Remoção manual de mídia pelo painel
// POST /api/delete-media
//
// Remove o arquivo do armazenamento (R2 e/ou mediaData no Redis)
// sem apagar a mensagem, conversa, contato ou histórico textual.
//
// Payload: { phone, historyIndex, reason?, attendantName? }
// ============================================================

import Redis from "ioredis";
import { deleteMedia as r2Delete } from "./media-storage.js";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/delete-media] ❌", err.message));
  }
  return redisClient;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { phone, historyIndex, reason, attendantName } = req.body || {};

  // ── Validações de entrada ───────────────────────────────────────────────────
  if (!phone || !/^\d{10,15}$/.test(String(phone))) {
    return res.status(400).json({ error: "phone inválido" });
  }
  const idx = Number(historyIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    return res.status(400).json({ error: "historyIndex deve ser inteiro não negativo" });
  }

  const deletedBy   = String(attendantName || "painel").slice(0, 50);
  const cleanReason = String(reason || "manual_panel_cleanup").slice(0, 100);

  console.log(`[delete-media] request phone=${phone} idx=${idx} by=${deletedBy}`);

  // ── Carregar sessão ──────────────────────────────────────────────────────────
  const redisKey = `sartec:${phone}`;
  const redis    = getRedis();

  let raw, ttl;
  try {
    [raw, ttl] = await Promise.all([redis.get(redisKey), redis.ttl(redisKey)]);
  } catch (redisErr) {
    console.error("[delete-media] redis error:", redisErr.message);
    return res.status(503).json({ error: "Erro ao conectar ao banco de dados" });
  }

  if (!raw)   return res.status(404).json({ error: "Sessão não encontrada" });
  if (ttl === -2) return res.status(404).json({ error: "Sessão expirada" });

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return res.status(500).json({ error: "Sessão com formato inválido" });
  }

  const history = session.history;
  if (!Array.isArray(history)) {
    return res.status(500).json({ error: "Histórico ausente na sessão" });
  }
  if (idx >= history.length) {
    return res.status(400).json({ error: `historyIndex ${idx} fora do intervalo (total=${history.length})` });
  }

  const msg = history[idx];

  // ── Validar que a mensagem possui mídia ─────────────────────────────────────
  const hasMedia = msg.mediaStorageKey || msg.mediaData || msg.mediaType || msg.mediaMimeType;
  if (!hasMedia) {
    return res.status(400).json({ error: "Mensagem não possui mídia" });
  }
  if (msg.mediaDeleted) {
    return res.status(409).json({ error: "Mídia já foi removida anteriormente" });
  }

  // ── Remoção ─────────────────────────────────────────────────────────────────
  const now = new Date().toISOString();
  let mediaDataFreed       = 0;
  let mediaStorageDeleted  = false;

  // 1. Apagar objeto R2 se tiver storageKey
  if (msg.mediaStorageKey) {
    try {
      await r2Delete(msg.mediaStorageKey);
      console.log(`[delete-media] deleted R2 key=${msg.mediaStorageKey}`);
      msg.mediaStorageDeleted   = true;
      msg.mediaStorageDeletedAt = now;
      mediaStorageDeleted = true;
    } catch (r2Err) {
      const safeErr = String(r2Err.message || "erro desconhecido").substring(0, 120);
      console.error(`[delete-media] failed R2 delete reason=${safeErr}`);
      // Se R2 falhar, interromper sem marcar como deletado — evita inconsistência
      return res.status(502).json({
        error: "Não foi possível remover o arquivo do armazenamento R2. Tente novamente.",
        detail: safeErr,
      });
    }
  }

  // 2. Remover mediaData (base64 legado)
  if (msg.mediaData) {
    mediaDataFreed = typeof msg.mediaData === "string"
      ? Math.round(msg.mediaData.length * 0.75 / 1024)
      : 0;
    console.log(`[delete-media] removed mediaData size=~${mediaDataFreed}KB`);
    delete msg.mediaData;
    msg.mediaDataRemoved       = true;
    msg.mediaDataRemovedAt     = now;
    msg.mediaDataRemovedReason = cleanReason;
  }

  // 3. Remover mediaUrl se existir no objeto Redis (não é URL persistente — era transitório)
  if (msg.mediaUrl) {
    delete msg.mediaUrl;
  }

  // 4. Registrar deleção
  msg.mediaDeleted       = true;
  msg.mediaDeletedAt     = now;
  msg.mediaDeletedBy     = deletedBy;
  msg.mediaDeletedReason = cleanReason;

  // ── Salvar sessão preservando TTL ───────────────────────────────────────────
  const updated = JSON.stringify(session);
  try {
    if (ttl > 0) {
      await redis.setex(redisKey, ttl, updated);
    } else {
      await redis.set(redisKey, updated);
    }
  } catch (saveErr) {
    console.error("[delete-media] failed to save session:", saveErr.message);
    return res.status(500).json({ error: "Erro ao salvar sessão após remoção" });
  }

  console.log(`[delete-media] done phone=${phone} idx=${idx} freedKB=${mediaDataFreed} r2=${mediaStorageDeleted}`);

  return res.status(200).json({
    ok:                  true,
    phone,
    historyIndex:        idx,
    mediaDeleted:        true,
    mediaDataRemoved:    msg.mediaDataRemoved    || false,
    mediaStorageDeleted: mediaStorageDeleted,
    freedKB:             mediaDataFreed,
    deletedBy,
    deletedAt:           now,
  });
}
