// ============================================================
// Sartec — encaminhamento interno de mídia para Denise (financeiro)
// POST /api/forward-media
//   { sourcePhone, sourceKey?, historyIndex, messageId? }
//
// Esta rota não chama saveToHistory e não altera a sessão do cliente.
// ============================================================

import Redis from "ioredis";
import { downloadMedia, getMediaExtension } from "./_lib/media-storage.js";

const DENISE_PHONE = process.env.DENISE_WHATSAPP_PHONE || "5512981294546";
const GRAPH_VERSION = "v19.0"; // mantém a mesma versão já usada por api/send.js
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 131000]);
const forwardingNow = new Set();

// Contador de métricas — best-effort, nunca bloqueia nem afeta o encaminhamento em si.
// Lista capada usada só pela aba Métricas (api/metrics.js) para medir volume desde a implementação.
const DENISE_FORWARD_METRICS_KEY = "sartec:metrics:denise_forwards";
const DENISE_FORWARD_METRICS_CAP = 19999;
const DENISE_FORWARD_METRICS_TTL = 60 * 60 * 24 * 90; // 90 dias — mesma janela de retenção do restante do histórico

function recordDeniseForwardMetric(redis, mediaType) {
  redis.multi()
    .lpush(DENISE_FORWARD_METRICS_KEY, JSON.stringify({ at: new Date().toISOString(), mediaType }))
    .ltrim(DENISE_FORWARD_METRICS_KEY, 0, DENISE_FORWARD_METRICS_CAP)
    .expire(DENISE_FORWARD_METRICS_KEY, DENISE_FORWARD_METRICS_TTL)
    .exec()
    .catch((err) => console.warn("[forward-media] métrica não persistida:", err.message));
}

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[forward-media/redis]", err.message));
  }
  return redisClient;
}

function cleanPhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function resolveSourceKey(sourcePhone, sourceKey) {
  const phone = cleanPhone(sourcePhone);
  if (!phone) throw new Error("Telefone de origem inválido");
  const activeKey = `sartec:${phone}`;
  if (!sourceKey) return activeKey;
  const key = String(sourceKey);
  if (key === activeKey || key.startsWith(`sartec:archive:${phone}:`)) return key;
  throw new Error("Referência de conversa inválida");
}

function decodeLegacyBase64(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const comma = raw.indexOf(",");
  const base64 = raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64.replace(/\s/g, ""))) return null;
  return Buffer.from(base64, "base64");
}

function sanitizeFilename(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return cleaned || fallback;
}

function fallbackFilename(mimeType, mediaType, createdAt) {
  const day = (() => {
    try { return new Date(createdAt || Date.now()).toISOString().slice(0, 10); }
    catch { return new Date().toISOString().slice(0, 10); }
  })();
  const ext = getMediaExtension(mimeType) || (mediaType === "image" ? "jpg" : "bin");
  return `${mediaType === "image" ? "imagem-recebida" : "arquivo-recebido"}-${day}.${ext}`;
}

export function resolveHistoryMedia(message) {
  if (!message || message.mediaDeleted || message.mediaUnavailable || message.mediaDataRemoved) {
    return { available: false };
  }

  let mediaType = message.mediaType || null;
  let mimeType = message.mediaMimeType || null;
  let mediaData = message.mediaData || null;
  let filename = message.mediaFilename || null;

  if (Array.isArray(message.content)) {
    const imagePart = message.content.find((part) => part?.type === "image" && part.source?.data);
    const documentPart = message.content.find((part) => part?.type === "document" && part.source?.data);
    if (!mediaData && imagePart) {
      mediaType = "image";
      mediaData = imagePart.source.data;
      mimeType = imagePart.source.media_type || mimeType || "image/jpeg";
    } else if (!mediaData && documentPart) {
      mediaType = "document";
      mediaData = documentPart.source.data;
      mimeType = documentPart.source.media_type || mimeType || "application/pdf";
      filename = documentPart.source.filename || filename;
    }
  }

  if (!mediaType && mimeType === "application/pdf") mediaType = "document";
  if (mediaType !== "image" && mediaType !== "document") return { available: false };
  if (!message.mediaStorageKey && !mediaData) return { available: false };

  const finalMime = mimeType || (mediaType === "image" ? "image/jpeg" : "application/octet-stream");
  const finalFilename = sanitizeFilename(
    filename,
    fallbackFilename(finalMime, mediaType, message.createdAt)
  );

  return {
    available: true,
    mediaType,
    mimeType: finalMime,
    filename: finalFilename,
    storageKey: message.mediaStorageKey || null,
    mediaData,
  };
}

function formatPhone(value) {
  const n = cleanPhone(value);
  if (n.startsWith("55") && n.length >= 12) {
    const local = n.slice(4);
    return `+55 ${n.slice(2, 4)} ${local.length === 9 ? `${local.slice(0, 5)} ${local.slice(5)}` : `${local.slice(0, 4)} ${local.slice(4)}`}`;
  }
  return n ? `+${n}` : "telefone não informado";
}

export function buildContextCaption(session, sourcePhone) {
  const rawName = String(session?.clientName || session?.whatsappName || "").trim();
  const hasName = rawName && rawName !== "—" && rawName !== sourcePhone && !rawName.startsWith("+");
  return hasName
    ? `Arquivo recebido de ${rawName} — ${formatPhone(sourcePhone)}`
    : `Arquivo recebido do cliente ${formatPhone(sourcePhone)}`;
}

export function humanizeMetaForwardError(metaError) {
  const code = metaError?.code ?? null;
  const details = metaError?.error_data?.details || metaError?.message || "";
  if (code === 131047 || /24\s*hours|24\s*horas|re-engagement/i.test(details)) {
    return {
      status: 409,
      code: "DENISE_WINDOW_CLOSED",
      error: "Não foi possível enviar para Denise porque a janela de 24 horas está fechada.",
      detail: "Peça para Denise enviar uma mensagem ao número oficial da Sartec e tente novamente.",
      metaCode: code,
    };
  }
  return {
    status: 502,
    code: "META_FORWARD_FAILED",
    error: "Não foi possível enviar o arquivo para Denise.",
    detail: details || "A Meta recusou o envio. Tente novamente em instantes.",
    metaCode: code,
  };
}

function isTransientMetaError(status, error) {
  return [500, 502, 503, 504].includes(status) || error?.is_transient === true || TRANSIENT_META_CODES.has(error?.code);
}

async function callMeta(url, optionsFactory, context) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, optionsFactory());
      const data = await response.json().catch(() => null);
      if (response.ok) return { ok: true, data, attempts: attempt };
      const error = data?.error || {};
      last = { ok: false, status: response.status, error, attempts: attempt };
      console.error(`[forward-media/${context}] Meta http=${response.status} code=${error.code} subcode=${error.error_subcode}`);
      if (!isTransientMetaError(response.status, error) || attempt === 3) return last;
    } catch (error) {
      last = { ok: false, status: 502, error: { message: error.message, is_transient: true }, attempts: attempt };
      if (attempt === 3) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 400 : 1200));
  }
  return last;
}

async function loadOriginalBytes(media) {
  if (media.storageKey) return downloadMedia(media.storageKey);
  const buffer = decodeLegacyBase64(media.mediaData);
  if (!buffer?.length) throw new Error("Mídia legada inválida ou vazia");
  return buffer;
}

async function uploadToMeta(buffer, media, phoneNumberId, accessToken) {
  return callMeta(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/media`,
    () => {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", media.mimeType);
      form.append("file", new Blob([buffer], { type: media.mimeType }), media.filename);
      return { method: "POST", headers: { Authorization: `Bearer ${accessToken}` }, body: form };
    },
    "upload"
  );
}

async function sendUploadedMedia(mediaId, media, caption, phoneNumberId, accessToken) {
  const type = media.mediaType === "image" ? "image" : "document";
  const mediaPayload = { id: mediaId, caption };
  if (type === "document") mediaPayload.filename = media.filename;
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: DENISE_PHONE,
    type,
    [type]: mediaPayload,
  };
  return callMeta(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    () => ({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
    }),
    "send"
  );
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  const { sourcePhone, sourceKey, historyIndex, messageId } = req.body || {};
  const phone = cleanPhone(sourcePhone);
  const index = Number(historyIndex);
  if (!phone || !Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: "Referência da mídia inválida." });
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    return res.status(500).json({ error: "Configuração do WhatsApp ausente no servidor." });
  }

  let redisKey;
  try { redisKey = resolveSourceKey(phone, sourceKey); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const dedupeKey = `${redisKey}:${index}:${messageId || "sem-id"}`;
  if (forwardingNow.has(dedupeKey)) {
    return res.status(409).json({ error: "Este arquivo já está sendo enviado para Denise." });
  }
  forwardingNow.add(dedupeKey);

  try {
    const raw = await getRedis().get(redisKey);
    if (!raw) return res.status(404).json({ error: "Conversa de origem não encontrada." });
    const session = JSON.parse(raw);
    const message = Array.isArray(session.history) ? session.history[index] : null;
    if (!message || (messageId && message.metaMessageId !== messageId)) {
      return res.status(409).json({ error: "A conversa mudou. Reabra o menu da mídia e tente novamente." });
    }
    if (message.role !== "user") {
      return res.status(400).json({ error: "Somente arquivos recebidos do cliente podem ser enviados para Denise." });
    }

    const media = resolveHistoryMedia(message);
    if (!media.available) return res.status(410).json({ error: "Esta mídia não está mais disponível." });

    const originalBytes = await loadOriginalBytes(media);
    const caption = buildContextCaption(session, phone);
    const upload = await uploadToMeta(originalBytes, media, phoneNumberId, accessToken);
    if (!upload.ok) {
      const human = humanizeMetaForwardError(upload.error);
      return res.status(human.status).json(human);
    }

    const sent = await sendUploadedMedia(upload.data?.id, media, caption, phoneNumberId, accessToken);
    if (!sent.ok) {
      const human = humanizeMetaForwardError(sent.error);
      return res.status(human.status).json(human);
    }

    console.log(`[forward-media] enviado para Denise source=+${phone} idx=${index} type=${media.mediaType} size=${originalBytes.length}`);
    recordDeniseForwardMetric(getRedis(), media.mediaType);
    return res.status(200).json({ success: true, message: "Enviado para Denise" });
  } catch (error) {
    console.error("[forward-media]", error.message);
    return res.status(500).json({ error: "Não foi possível preparar o arquivo original para Denise.", detail: error.message });
  } finally {
    forwardingNow.delete(dedupeKey);
  }
}
