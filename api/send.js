// ============================================================
// Sartec Papelaria — Envio de mensagem pelo atendente humano
// POST /api/send
//   Texto:    { to, message, type: "text" }
//   Imagem:   { to, type: "image",    mediaBase64, mimeType, caption? }
//   Documento:{ to, type: "document", mediaBase64, mimeType, filename, caption? }
// ============================================================

import Redis from "ioredis";

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

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 dias

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
  const { to, message } = body;

  if (!message) {
    return res.status(400).json({ error: "Campo message é obrigatório para type text" });
  }

  const metaRes = await fetch(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: message },
      }),
    }
  );

  const metaData = await metaRes.json();

  if (!metaRes.ok) {
    console.error(`[send/text] ❌ Meta erro ${metaData?.error?.code}: ${metaData?.error?.message}`);
    return res.status(502).json({
      error: "Erro ao enviar mensagem pela Meta API",
      detail: metaData?.error?.message,
    });
  }

  console.log(`[send/text] ✅ ID: ${metaData?.messages?.[0]?.id}`);

  await saveToHistory(to, {
    role: "assistant",
    content: message,
    sentByHuman: true,
  });

  return res.status(200).json({ success: true });
}

// ── Envio de imagem ───────────────────────────────────────
async function sendImage(req, res, body, PHONE_NUMBER_ID, ACCESS_TOKEN) {
  const { to, mediaBase64, mimeType, caption } = body;

  if (!mediaBase64 || !mimeType) {
    return res.status(400).json({ error: "Campos mediaBase64 e mimeType são obrigatórios para type image" });
  }

  // 1. Faz upload da imagem para a Meta (necessário antes de enviar)
  const binaryData = Buffer.from(mediaBase64, "base64");
  const blob       = new Blob([binaryData], { type: mimeType });
  const uploadForm = new FormData();
  uploadForm.append("messaging_product", "whatsapp");
  uploadForm.append("type", mimeType);
  uploadForm.append("file", blob, "image");

  const uploadRes = await fetch(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      body: uploadForm,
    }
  );

  const uploadData = await uploadRes.json();

  if (!uploadRes.ok) {
    console.error(`[send/image] ❌ Upload falhou: ${uploadData?.error?.message}`);
    return res.status(502).json({
      error: "Erro ao fazer upload da imagem para a Meta API",
      detail: uploadData?.error?.message,
    });
  }

  const mediaId = uploadData.id;
  console.log(`[send/image] ✅ Upload OK — media_id: ${mediaId}`);

  // 2. Envia a imagem para o cliente usando o media_id
  const msgPayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: { id: mediaId },
  };
  if (caption) msgPayload.image.caption = caption;

  const metaRes = await fetch(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(msgPayload),
    }
  );

  const metaData = await metaRes.json();

  if (!metaRes.ok) {
    console.error(`[send/image] ❌ Meta erro ${metaData?.error?.code}: ${metaData?.error?.message}`);
    return res.status(502).json({
      error: "Erro ao enviar imagem pela Meta API",
      detail: metaData?.error?.message,
    });
  }

  console.log(`[send/image] ✅ ID: ${metaData?.messages?.[0]?.id}`);

  // 3. Salva no histórico com a referência da mídia
  await saveToHistory(to, {
    role: "assistant",
    content: caption || "",
    sentByHuman: true,
    mediaType: "image",
    mediaData: mediaBase64,
    mediaMimeType: mimeType,
  });

  return res.status(200).json({ success: true });
}

// ── Envio de documento (PDF) ──────────────────────────────
async function sendDocument(req, res, body, PHONE_NUMBER_ID, ACCESS_TOKEN) {
  const { to, mediaBase64, mimeType, filename = "documento.pdf", caption } = body;

  if (!mediaBase64 || !mimeType) {
    return res.status(400).json({ error: "Campos mediaBase64 e mimeType são obrigatórios para type document" });
  }

  // 1. Upload para a Meta
  const binaryData = Buffer.from(mediaBase64, "base64");
  const blob       = new Blob([binaryData], { type: mimeType });
  const uploadForm = new FormData();
  uploadForm.append("messaging_product", "whatsapp");
  uploadForm.append("type", mimeType);
  uploadForm.append("file", blob, filename);

  const uploadRes = await fetch(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      body: uploadForm,
    }
  );

  const uploadData = await uploadRes.json();

  if (!uploadRes.ok) {
    console.error(`[send/document] ❌ Upload falhou: ${uploadData?.error?.message}`);
    return res.status(502).json({
      error: "Erro ao fazer upload do documento para a Meta API",
      detail: uploadData?.error?.message,
    });
  }

  const mediaId = uploadData.id;
  console.log(`[send/document] ✅ Upload OK — media_id: ${mediaId}`);

  // 2. Envia o documento via media_id
  const msgPayload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "document",
    document: { id: mediaId, filename },
  };
  if (caption) msgPayload.document.caption = caption;

  const metaRes = await fetch(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify(msgPayload),
    }
  );

  const metaData = await metaRes.json();

  if (!metaRes.ok) {
    console.error(`[send/document] ❌ Meta erro ${metaData?.error?.code}: ${metaData?.error?.message}`);
    return res.status(502).json({
      error: "Erro ao enviar documento pela Meta API",
      detail: metaData?.error?.message,
    });
  }

  console.log(`[send/document] ✅ ID: ${metaData?.messages?.[0]?.id}`);

  // 3. Salva no histórico com base64 para exibição no painel
  await saveToHistory(to, {
    role:         "assistant",
    content:      caption || "",
    sentByHuman:  true,
    mediaType:    "document",
    mediaData:    mediaBase64,
    mediaMimeType: mimeType,
    mediaFilename: filename,
  });

  return res.status(200).json({ success: true });
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

// ── Salvar no Redis ───────────────────────────────────────
async function saveToHistory(phone, message) {
  try {
    const redis = getRedis();
    await withSessionLock(redis, phone, async () => {
      const raw = await redis.get(`sartec:${phone}`);
      if (!raw) return;

      const session = JSON.parse(raw);
      session.history.push(message);
      session.lastHumanReply = new Date().toISOString();
      session.lastDate       = new Date().toISOString().slice(0, 10);

      await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);
    });
  } catch (err) {
    console.error("[send/saveToHistory] ❌", err.message);
  }
}
