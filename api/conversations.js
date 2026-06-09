// ============================================================
// Sartec Papelaria — Lista todas as conversas (ativas + resolvidas)
// GET /api/conversations?page=1&limit=30&search=nome
// Usado pela aba "Conversas" do painel
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/conversations] ❌", err.message));
  }
  return redisClient;
}

// Janela de 24h
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
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const page   = Math.max(1, parseInt(req.query.page  || "1",  10));
  const limit  = Math.min(50, parseInt(req.query.limit || "30", 10));
  const search = (req.query.search || "").toLowerCase().trim();

  try {
    const redis = getRedis();

    // SCAN — nunca usa KEYS em produção
    let cursor = "0";
    const allKeys = [];
    do {
      const [nextCursor, found] = await redis.scan(
        cursor, "MATCH", "sartec:*", "COUNT", 200
      );
      cursor = nextCursor;
      allKeys.push(...found.filter(k =>
        !k.includes(":archive:")      &&
        !k.includes(":contact:")      &&
        !k.includes(":settings:")     &&
        !k.includes(":pending_status:") &&
        k !== "sartec:pipelineOrder"
      ));
    } while (cursor !== "0");

    if (!allKeys.length) {
      return res.status(200).json({ conversations: [], total: 0, page, hasMore: false });
    }

    const values = await redis.mget(...allKeys);
    const conversations = [];

    for (let i = 0; i < allKeys.length; i++) {
      if (!values[i]) continue;
      let session;
      try { session = JSON.parse(values[i]); } catch { continue; }

      // Extrai phone: sartec:PHONE ou sartec:archive:PHONE:TIMESTAMP
      const isArchive  = allKeys[i].includes(":archive:");
      const phone      = isArchive
        ? allKeys[i].split(":")[2]          // sartec:archive:PHONE:TIMESTAMP → [2]
        : allKeys[i].replace("sartec:", "");
      const redisKey   = allKeys[i];
      const clientName = session.clientName || "—";

      // Filtro de busca
      if (search && !clientName.toLowerCase().includes(search) && !phone.includes(search)) continue;

      const lastMsg = [...(session.history || [])].reverse().find((m) => m.role === "user");
      let lastMessage =
        typeof lastMsg?.content === "string"
          ? lastMsg.content
          : (session.proactiveNote || "[mídia]");   // nota de template proativo
      if (lastMessage === "[áudio]") lastMessage = "Áudio recebido";
      if (!lastMessage && lastMsg?.mediaType === "image")    lastMessage = "Imagem";
      if (!lastMessage && lastMsg?.mediaType === "document") lastMessage = "Documento";

      const lastActivity =
        session.lastActivityAt || session.handoffAt || session.lastDate || null;

      conversations.push({
        phone,
        redisKey,    // chave Redis real (necessário para abrir archives corretamente)
        isArchive,   // true quando é uma conversa arquivada (leitura apenas)
        clientName,
        clientType: session.clientType || (session.demandType === "cotacao_pj" ? "pj" : "pf"),
        demandType:     session.demandType     || "outro",
        status:         session.status         || "ativo",
        pipelineStatus: session.pipelineStatus || "novo",
        cardTitle:      session.cardTitle      || "",
        lastMessage:    lastMessage.substring(0, 200),
        lastActivity,
        messageCount: (session.history || []).length,
        handoffAt:    session.handoffAt    || null,
        resolvedAt:   session.resolvedAt   || null,
        archivedAt:   session.archivedAt   || null,
        lastTemplateType:           session.lastTemplateType           || null,
        lastTemplateDeliveryStatus: session.lastTemplateDeliveryStatus || null,
        lastTemplateStatusAt:       session.lastTemplateStatusAt       || null,
        lastTemplateError:          session.lastTemplateError          || null,
        ...computeWindowInfo(session),
      });
    }

    // Ordena por atividade mais recente
    conversations.sort((a, b) => {
      const ta = a.lastActivity ? new Date(a.lastActivity) : new Date(0);
      const tb = b.lastActivity ? new Date(b.lastActivity) : new Date(0);
      return tb - ta;
    });

    const total   = conversations.length;
    const start   = (page - 1) * limit;
    const paged   = conversations.slice(start, start + limit);
    const hasMore = start + limit < total;

    return res.status(200).json({ conversations: paged, total, page, hasMore });
  } catch (err) {
    console.error("[conversations] ❌", err.message);
    return res.status(500).json({ error: "Erro ao listar conversas", detail: err.message });
  }
}
