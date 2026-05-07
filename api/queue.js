// ============================================================
// Sartec Papelaria — Fila de atendimento humano
// GET /api/queue
// Retorna: aguardando_humano + resolvido + triagem_incompleta
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/queue] ❌", err.message));
  }
  return redisClient;
}

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 dias — alinhado com ARCHIVE_TTL
const INATIVO_MS  = 24 * 60 * 60 * 1000; // 24h sem atividade

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
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const redis = getRedis();

    // SCAN — evita KEYS bloqueante
    let cursor = "0";
    const allKeys = [];
    do {
      const [nextCursor, found] = await redis.scan(
        cursor, "MATCH", "sartec:*", "COUNT", 200
      );
      cursor = nextCursor;
      allKeys.push(...found.filter((k) => !k.includes(":archive:")));
    } while (cursor !== "0");

    if (!allKeys.length) return res.status(200).json({ conversations: [] });

    const values = await redis.mget(...allKeys);

    const conversations = [];
    const toUpdate = []; // sessões que precisam ser marcadas lazily

    const now = Date.now();

    for (let i = 0; i < allKeys.length; i++) {
      if (!values[i]) continue;

      let session;
      try { session = JSON.parse(values[i]); } catch { continue; }

      const phone      = allKeys[i].replace("sartec:", "");
      const status     = session.status || "ativo";

      // ── Marcação lazy de triagem_incompleta ──
      // Sessões ativas (sem handoff, sem resolução) paradas há >24h
      if (status === "ativo" && !session.handoffDone) {
        const lastAct = session.lastActivityAt
          ? new Date(session.lastActivityAt).getTime()
          : null;
        if (lastAct && (now - lastAct) > INATIVO_MS) {
          session.status = "triagem_incompleta";
          toUpdate.push({ key: allKeys[i], session });
        }
      }

      // Inclui no pipeline: handoff pendente, resolvidos e triagem incompleta
      const finalStatus = session.status || "ativo";
      if (
        finalStatus !== "aguardando_humano" &&
        finalStatus !== "resolvido" &&
        finalStatus !== "triagem_incompleta"
      ) continue;

      const lastUserMsg = [...(session.history || [])]
        .reverse()
        .find((m) => m.role === "user");
      const lastMessage =
        typeof lastUserMsg?.content === "string"
          ? lastUserMsg.content
          : "[mídia]";

      const clientType =
        session.clientType ||
        (session.demandType === "cotacao_pj" ? "pj" : "pf");

      conversations.push({
        phone,
        clientName:     session.clientName     || "—",
        demandType:     session.demandType      || "outro",
        clientType,
        pipelineStatus: session.pipelineStatus  || "novo",
        status:         finalStatus,
        handoffAt:      session.handoffAt       || null,
        resolvedAt:     session.resolvedAt      || null,
        cardTitle:      session.cardTitle       || "",
        lastMessage:    lastMessage.substring(0, 200),
        messageCount:   (session.history || []).length,
        priorityManual: session.priorityManual  || null,
        dataLimite:     session.dataLimite      || null,
        formaEntrega:   session.formaEntrega    || null,
        endereco:       session.endereco        || null,
        observacoes:    session.observacoes     || null,
        escola:         session.escola          || null,
        serie:          session.serie           || null,
        ...computeWindowInfo(session),
      });
    }

    // Persiste marcações lazy em background (sem await para não atrasar resposta)
    if (toUpdate.length) {
      Promise.all(
        toUpdate.map(({ key, session }) =>
          redis.set(key, JSON.stringify(session), "EX", SESSION_TTL)
        )
      ).catch((err) => console.error("[queue/lazy] ❌", err.message));
    }

    // Mais antigos aparecem primeiro dentro de cada coluna
    conversations.sort((a, b) => {
      if (!a.handoffAt) return 1;
      if (!b.handoffAt) return -1;
      return new Date(a.handoffAt) - new Date(b.handoffAt);
    });

    return res.status(200).json({ conversations });
  } catch (err) {
    console.error("[queue] ❌", err.message);
    return res.status(500).json({ error: "Erro ao carregar fila", detail: err.message });
  }
}
