// ============================================================
// Sartec Papelaria — Histórico de conversa
// GET /api/conversation?phone=5512999990000
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/conversation] ❌", err.message));
  }
  return redisClient;
}

// Janela de 24h — mesma lógica do webhook.js (duplicada intencionalmente, sem módulo compartilhado)
function computeWindowInfo(session) {
  const now        = Date.now();
  const lastUserAt = session.lastUserMessageAt
    ? new Date(session.lastUserMessageAt).getTime() : null;
  const expiresAt  = session.windowExpiresAt
    ? new Date(session.windowExpiresAt).getTime()  : null;

  if (!lastUserAt) return { lastUserMessageAt: null, windowExpiresAt: null,
    conversationWindowStatus: "closed", windowRemainingMs: 0 };

  if (expiresAt && now < expiresAt) return {
    lastUserMessageAt: session.lastUserMessageAt, windowExpiresAt: session.windowExpiresAt,
    conversationWindowStatus: "open", windowRemainingMs: expiresAt - now };

  if (session.templateSentAt) {
    const templateAt = new Date(session.templateSentAt).getTime();
    if (templateAt > lastUserAt) return {
      lastUserMessageAt: session.lastUserMessageAt, windowExpiresAt: session.windowExpiresAt,
      conversationWindowStatus: "waiting_template_reply", windowRemainingMs: 0 };
  }

  return { lastUserMessageAt: session.lastUserMessageAt, windowExpiresAt: session.windowExpiresAt,
    conversationWindowStatus: "closed", windowRemainingMs: 0 };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { phone, key } = req.query;

  // Aceita ?key=sartec:archive:... (para archives) ou ?phone=... (sessão ativa)
  if (!phone && !key) {
    return res.status(400).json({ error: "Parâmetro phone ou key obrigatório" });
  }

  // Extrai phone da chave de arquivo quando necessário
  const resolvedPhone = phone || (key ? key.split(":")[2] : null);

  try {
    const redisKey = key || `sartec:${phone}`;
    const raw = await getRedis().get(redisKey);

    if (!raw) {
      return res.status(404).json({ error: "Conversa não encontrada" });
    }

    const session = JSON.parse(raw);

    // Normaliza history preservando mídia (imagens e documentos/PDF)
    const history = (session.history || []).map((m) => {
      let content       = m.content;
      let mediaType     = m.mediaType     || null;
      let mediaData     = m.mediaData     || null;
      let mediaMimeType = m.mediaMimeType || null;
      let mediaFilename = m.mediaFilename || null;   // ← campo para PDF

      // Mensagens com array de partes (Claude multipart — imagem/documento do cliente)
      if (Array.isArray(content)) {
        const textPart  = content.find((c) => c.type === "text");
        const imagePart = content.find((c) => c.type === "image");
        const docPart   = content.find((c) => c.type === "document");

        content = textPart?.text || "";

        if (imagePart?.source?.data) {
          mediaType     = "image";
          mediaData     = imagePart.source.data;
          mediaMimeType = imagePart.source.media_type || "image/jpeg";
        } else if (docPart?.source?.data) {
          mediaType     = "document";
          mediaData     = docPart.source.data;
          mediaMimeType = docPart.source.media_type || "application/pdf";
          mediaFilename = docPart.source.filename   || "documento.pdf";
        }
      }

      // Fallback: detecta PDF pelo mimeType mesmo sem campo mediaType
      if (!mediaType && mediaMimeType === "application/pdf" && mediaData) {
        mediaType = "document";
      }

      const item = {
        role:          m.role,
        content:       content || "",
        sentByHuman:   m.sentByHuman   || false,
        attendantId:   m.attendantId   || null,
        attendantName: m.attendantName || null,
      };

      if (m.metaMessageId) item.metaMessageId = m.metaMessageId;
      if (m.replyToMsgId)  item.replyToMsgId  = m.replyToMsgId;
      if (m.replyToFrom)   item.replyToFrom   = m.replyToFrom;

      if (mediaType) {
        item.mediaType     = mediaType;
        item.mediaData     = mediaData;
        item.mediaMimeType = mediaMimeType;
        if (mediaFilename) item.mediaFilename = mediaFilename;
      }

      if (m.transcription)      item.transcription      = m.transcription;
      if (m.transcriptionError) item.transcriptionError = m.transcriptionError;

      return item;
    });

    const windowInfo = computeWindowInfo(session);

    return res.status(200).json({
      phone:          resolvedPhone,
      redisKey:       redisKey,
      isArchive:      !!(key && key.includes(":archive:")),
      clientName:     session.clientName     || "—",
      clientType:     session.clientType     || (session.demandType === "cotacao_pj" ? "pj" : "pf"),
      demandType:     session.demandType     || "outro",
      pipelineStatus: session.pipelineStatus || "novo",
      handoffAt:      session.handoffAt      || null,
      status:         session.status         || "ativo",
      // Campos do card
      dataLimite:     session.dataLimite     || "",
      formaEntrega:   session.formaEntrega   || "",
      endereco:       session.endereco       || "",
      observacoes:    session.observacoes    || "",
      escola:         session.escola         || "",
      serie:          session.serie          || "",
      // Janela de 24h
      ...windowInfo,
      // Atendente ativo
      activeAttendant:   session.activeAttendant   || null,
      activeAttendantAt: session.activeAttendantAt || null,
      history,
    });
  } catch (err) {
    console.error("[conversation] ❌", err.message);
    return res.status(500).json({ error: "Erro ao carregar conversa", detail: err.message });
  }
}
