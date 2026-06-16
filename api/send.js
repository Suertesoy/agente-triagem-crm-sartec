// ============================================================
// Sartec Papelaria — Envio de mensagem pelo atendente humano
// POST /api/send
//   Texto:    { to, message, type: "text" }
//   Imagem:   { to, type: "image",    mediaBase64, mimeType, caption? }
//   Documento:{ to, type: "document", mediaBase64, mimeType, filename, caption? }
// ============================================================

import Redis from "ioredis";
import { uploadMedia } from "./media-storage.js";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/send] ❌", err.message));
  }
  return redisClient;
}

const SESSION_TTL = 60 * 60 * 24 * 90; // 90 dias — retenção mínima de histórico

// ── Meta API retry helpers ────────────────────────────────
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 131000]);
const RETRY_DELAYS_MS = [400, 1200, 2500];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransientMetaError(httpStatus, data) {
  if (httpStatus != null && [500, 502, 503, 504].includes(httpStatus)) return true;
  const err = data?.error;
  if (!err) return false;
  if (err.is_transient === true) return true;
  return TRANSIENT_CODES.has(err.code);
}

/**
 * Chama a Meta API com retry automático para erros transitórios.
 * optionsOrFactory: objeto (body JSON reutilizável) ou função (necessário para FormData).
 */
async function callMetaWithRetry(url, optionsOrFactory, context) {
  const getOpts = typeof optionsOrFactory === "function" ? optionsOrFactory : () => optionsOrFactory;
  let lastStatus = null;
  let lastData   = null;
  let lastError  = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const fetchRes = await fetch(url, getOpts());
      lastStatus = fetchRes.status;

      let data;
      try { data = await fetchRes.json(); } catch { data = null; }
      lastData = data;

      if (fetchRes.ok) {
        return { ok: true, status: lastStatus, data, attempts: attempt, transient: false };
      }

      const transient = isTransientMetaError(lastStatus, data);
      const e = data?.error || {};
      console.error(
        `[${context}] ❌ Meta erro — attempt=${attempt} http=${lastStatus}` +
        ` code=${e.code} subcode=${e.error_subcode} type=${e.type}` +
        ` is_transient=${e.is_transient ?? transient} fbtrace_id=${e.fbtrace_id}` +
        ` message="${e.message}"`
      );

      if (!transient || attempt === 3) {
        return { ok: false, status: lastStatus, data, attempts: attempt, transient };
      }
    } catch (networkErr) {
      lastError = networkErr.message;
      console.error(`[${context}] ❌ Network error — attempt=${attempt}: ${networkErr.message}`);
      if (attempt === 3) {
        return { ok: false, status: null, data: null, attempts: attempt, transient: true, lastError };
      }
    }

    await wait(RETRY_DELAYS_MS[attempt - 1]);
  }

  return { ok: false, status: lastStatus, data: lastData, attempts: 3, transient: false };
}

function metaErrRes(res, errorLabel, result) {
  const e      = result.data?.error || {};
  const detail = result.transient
    ? "A Meta/WhatsApp retornou uma falha temporária no envio. Tente novamente em instantes."
    : (e.message || "Erro desconhecido da Meta API");
  return res.status(502).json({
    error:        errorLabel,
    detail,
    code:         e.code          ?? null,
    subcode:      e.error_subcode ?? null,
    fbtrace_id:   e.fbtrace_id    ?? null,
    is_transient: result.transient ?? false,
    attempts:     result.attempts  ?? 1,
  });
}

// Vercel: aceita body até 10 MB para suportar imagens em base64
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const body = req.body || {};
  const { to, type = "text" } = body;

  if (!to) {
    return res.status(400).json({ error: "Campo to é obrigatório" });
  }

  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    return res.status(500).json({ error: "Variáveis de ambiente do WhatsApp ausentes" });
  }

  try {
    if (type === "image") {
      return await sendImage(req, res, body, PHONE_NUMBER_ID, ACCESS_TOKEN);
    }
    if (type === "document") {
      return await sendDocument(req, res, body, PHONE_NUMBER_ID, ACCESS_TOKEN);
    }
    return await sendText(req, res, body, PHONE_NUMBER_ID, ACCESS_TOKEN);
  } catch (err) {
    console.error("[send] ❌", err.message);
    return res.status(500).json({ error: "Erro interno ao enviar mensagem", detail: err.message });
  }
}

// ── Envio de texto ────────────────────────────────────────
async function sendText(req, res, body, PHONE_NUMBER_ID, ACCESS_TOKEN) {
  const { to, message, replyToMessageId } = body;

  if (!message) {
    return res.status(400).json({ error: "Campo message é obrigatório para type text" });
  }

  const msgPayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: message },
  };
  if (replyToMessageId && typeof replyToMessageId === "string") {
    msgPayload.context = { message_id: replyToMessageId };
  }

  const result = await callMetaWithRetry(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(msgPayload),
    },
    "send/text"
  );

  if (!result.ok) {
    return metaErrRes(res, "Erro ao enviar mensagem pela Meta API", result);
  }

  const metaMessageId = result.data?.messages?.[0]?.id || null;
  console.log(`[send/text] ✅ ID: ${metaMessageId}${replyToMessageId ? " (reply)" : ""} attempts=${result.attempts}`);

  const historyEntry = {
    role: "assistant",
    content: message,
    sentByHuman:     true,
    attendantId:     body.attendantId   || null,
    attendantName:   body.attendantName || null,
    metaMessageId,
    deliveryStatus:  "sent",
    deliveryStatusAt: new Date().toISOString(),
  };
  if (replyToMessageId) historyEntry.replyToMsgId = replyToMessageId;

  const textSaved = await saveToHistory(to, historyEntry);
  if (!textSaved) console.warn(`[send/text] ⚠️ Mensagem entregue à Meta mas não persistida no Redis (+${to})`);

  return res.status(200).json({ success: true, historyPersisted: textSaved });
}

// ── Envio de imagem ───────────────────────────────────────
async function sendImage(req, res, body, PHONE_NUMBER_ID, ACCESS_TOKEN) {
  const { to, mediaBase64, mimeType, caption, replyToMessageId } = body;

  if (!mediaBase64 || !mimeType) {
    return res.status(400).json({ error: "Campos mediaBase64 e mimeType são obrigatórios para type image" });
  }

  // 1. Faz upload da imagem para a Meta (necessário antes de enviar)
  const binaryData = Buffer.from(mediaBase64, "base64");

  const uploadResult = await callMetaWithRetry(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/media`,
    () => {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", mimeType);
      form.append("file", new Blob([binaryData], { type: mimeType }), "image");
      return { method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, body: form };
    },
    "send/image-upload"
  );

  if (!uploadResult.ok) {
    return metaErrRes(res, "Erro ao fazer upload da imagem para a Meta API", uploadResult);
  }

  const mediaId = uploadResult.data.id;
  console.log(`[send/image] ✅ Upload OK — media_id: ${mediaId} attempts=${uploadResult.attempts}`);

  // 2. Envia a imagem para o cliente usando o media_id
  const msgPayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: { id: mediaId },
  };
  if (caption) msgPayload.image.caption = caption;
  if (replyToMessageId && typeof replyToMessageId === "string") {
    msgPayload.context = { message_id: replyToMessageId };
  }

  const metaResult = await callMetaWithRetry(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(msgPayload),
    },
    "send/image"
  );

  if (!metaResult.ok) {
    return metaErrRes(res, "Erro ao enviar imagem pela Meta API", metaResult);
  }

  const metaMessageId = metaResult.data?.messages?.[0]?.id || null;
  console.log(`[send/image] ✅ ID: ${metaMessageId}${replyToMessageId ? " (reply)" : ""} attempts=${metaResult.attempts}`);

  // 3. Upload para R2 (best-effort; falha não cancela envio já realizado)
  let r2Result = null;
  try {
    r2Result = await uploadMedia(binaryData, mimeType, to, metaMessageId || `img_${Date.now()}`);
  } catch (r2Err) {
    console.warn(`[send/image] ⚠️ R2 upload falhou: ${String(r2Err.message || "").substring(0, 80)}`);
  }

  // 4. Salva no histórico — sem base64 para não estourar Redis
  const imgEntry = {
    role: "assistant",
    content:          caption || "",
    sentByHuman:      true,
    mediaType:        "image",
    sentMedia:        true,
    mediaMimeType:    mimeType,
    attendantId:      body.attendantId   || null,
    attendantName:    body.attendantName || null,
    metaMessageId,
    deliveryStatus:   "sent",
    deliveryStatusAt: new Date().toISOString(),
  };
  if (r2Result) {
    imgEntry.mediaStorageKey      = r2Result.storageKey;
    imgEntry.mediaStorageProvider = "cloudflare-r2";
  } else {
    imgEntry.mediaStorageFailed   = true;
  }
  if (replyToMessageId) imgEntry.replyToMsgId = replyToMessageId;
  const imgSaved = await saveToHistory(to, imgEntry);
  if (!imgSaved) console.warn(`[send/image] ⚠️ Mensagem entregue à Meta mas não persistida no Redis (+${to})`);

  return res.status(200).json({ success: true, historyPersisted: imgSaved });
}

// ── Envio de documento (PDF) ──────────────────────────────
async function sendDocument(req, res, body, PHONE_NUMBER_ID, ACCESS_TOKEN) {
  const { to, mediaBase64, mimeType, filename = "documento.pdf", caption, replyToMessageId } = body;

  if (!mediaBase64 || !mimeType) {
    return res.status(400).json({ error: "Campos mediaBase64 e mimeType são obrigatórios para type document" });
  }

  // 1. Upload para a Meta
  const binaryData = Buffer.from(mediaBase64, "base64");
  console.log(`[send/document] upload start filename=${filename} mime=${mimeType} size=${binaryData.length}`);

  const uploadResult = await callMetaWithRetry(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/media`,
    () => {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", mimeType);
      form.append("file", new Blob([binaryData], { type: mimeType }), filename);
      return { method: "POST", headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, body: form };
    },
    "send/document-upload"
  );

  if (!uploadResult.ok) {
    const _ue = uploadResult.data?.error || {};
    console.error(`[send/document] falha upload meta code=${_ue.code} msg="${_ue.message}"`);
    return metaErrRes(res, "Erro ao fazer upload do documento para a Meta API", uploadResult);
  }

  const mediaId = uploadResult.data.id;
  console.log(`[send/document] upload ok media_id=${mediaId} attempts=${uploadResult.attempts}`);

  // 2. Envia o documento via media_id
  const msgPayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "document",
    document: { id: mediaId, filename },
  };
  if (caption) msgPayload.document.caption = caption;
  if (replyToMessageId && typeof replyToMessageId === "string") {
    msgPayload.context = { message_id: replyToMessageId };
  }

  const metaResult = await callMetaWithRetry(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(msgPayload),
    },
    "send/document"
  );

  if (!metaResult.ok) {
    const _se = metaResult.data?.error || {};
    console.error(`[send/document] falha send code=${_se.code} msg="${_se.message}"`);
    return metaErrRes(res, "Erro ao enviar documento pela Meta API", metaResult);
  }

  const metaMessageId = metaResult.data?.messages?.[0]?.id || null;
  console.log(`[send/document] send ok metaMessageId=${metaMessageId}${replyToMessageId ? " (reply)" : ""} attempts=${metaResult.attempts}`);

  // 3. Upload para R2 (best-effort; falha não cancela envio já realizado)
  let r2DocResult = null;
  try {
    r2DocResult = await uploadMedia(binaryData, mimeType, to, metaMessageId || `doc_${Date.now()}`);
  } catch (r2Err) {
    console.warn(`[send/document] ⚠️ R2 upload falhou: ${String(r2Err.message || "").substring(0, 80)}`);
  }

  // 4. Salva no histórico — sem base64 para não estourar Redis
  const docEntry = {
    role:             "assistant",
    content:          caption || "",
    sentByHuman:      true,
    mediaType:        "document",
    sentMedia:        true,
    mediaMimeType:    mimeType,
    mediaFilename:    filename,
    attendantId:      body.attendantId   || null,
    attendantName:    body.attendantName || null,
    metaMessageId,
    deliveryStatus:   "sent",
    deliveryStatusAt: new Date().toISOString(),
  };
  if (r2DocResult) {
    docEntry.mediaStorageKey      = r2DocResult.storageKey;
    docEntry.mediaStorageProvider = "cloudflare-r2";
  } else {
    docEntry.mediaStorageFailed   = true;
  }
  if (replyToMessageId) docEntry.replyToMsgId = replyToMessageId;
  const docSaved = await saveToHistory(to, docEntry);
  if (!docSaved) console.warn(`[send/document] ⚠️ Documento entregue à Meta mas não persistido no Redis (+${to})`);

  return res.status(200).json({ success: true, historyPersisted: docSaved });
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

// ── Aplica status pendente de entrega se houver (race condition fix) ─────
async function applyPendingStatusIfExists(redis, metaMessageId, historyEntry) {
  if (!metaMessageId) return;
  const pendingKey = `sartec:pending_status:${metaMessageId}`;
  try {
    const raw = await redis.get(pendingKey);
    if (raw) {
      const pending = JSON.parse(raw);
      historyEntry.deliveryStatus   = pending.status;
      historyEntry.deliveryStatusAt = pending.deliveryStatusAt || new Date().toISOString();
      if (pending.status === "failed" && pending.deliveryError) {
        historyEntry.deliveryError = pending.deliveryError;
      }
      await redis.del(pendingKey);
      console.log(`[send] ✅ Status pendente aplicado: ${pending.status} → ${metaMessageId}`);
    }
  } catch (err) {
    console.warn(`[send] ⚠️ Erro ao aplicar status pendente para ${metaMessageId}: ${err.message}`);
  }
}

// ── Salvar no Redis ───────────────────────────────────────
// Retorna true se persistiu com sucesso, false se falhou (ex: OOM)
async function saveToHistory(phone, message) {
  try {
    const redis = getRedis();
    let saved = false;
    await withSessionLock(redis, phone, async () => {
      const raw = await redis.get(`sartec:${phone}`);
      if (!raw) return;

      const session = JSON.parse(raw);
      if (!message.createdAt) message.createdAt = new Date().toISOString();

      // Verifica e aplica status pendente (concorrência com webhook)
      await applyPendingStatusIfExists(redis, message.metaMessageId, message);

      session.history.push(message);
      const now = new Date().toISOString();
      session.lastHumanReply = now;
      session.lastDate       = now.slice(0, 10);
      session.lastActivityAt = now;

      // Mensagem humana via CRM: marca tomada de controle para silenciar o bot.
      // Não altera lastUserMessageAt/windowExpiresAt — janela de 24h é do cliente.
      if (message.sentByHuman) {
        session.handoffDone          = true;
        session.postHandoffReplySent = true;
        if (!session.handoffAt) session.handoffAt = now;
        if (session.status !== "resolvido") session.status = "aguardando_humano";
        if (!session.pipelineStatus) {
          const isPJ = session.clientType === "pj" || session.demandType === "cotacao_pj";
          session.pipelineStatus = isPJ ? "novo" : "em_atendimento";
        }
        // Enviar mensagem = assumir atendimento; atualiza atendente ativo no Redis.
        if (message.attendantId) {
          const attName = message.attendantName || message.attendantId;
          session.activeAttendant = {
            id:       message.attendantId,
            name:     attName,
            initials: attName.slice(0, 2).toUpperCase(),
            color:    "#3b82f6",
          };
          session.activeAttendantAt = now;
        }
      }

      await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);
      saved = true;
    });
    return saved;
  } catch (err) {
    console.error("[send/saveToHistory] ❌", err.message);
    return false;
  }
}
