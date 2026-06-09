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

const SESSION_TTL = 60 * 60 * 24 * 90; // 90 dias — retenção mínima de histórico
const INATIVO_MS  = 30 * 60 * 1000;  // 30min sem atividade

// ── Gera resumo operacional derivado do histórico (sem chamar IA) ────────────
const _QUEUE_USELESS = /^(olá?|ola|oi+|hey|hi|bom\s+dia|boa\s+tarde|boa\s+noite|jurídica|juridica|pessoa\s+jurídica|pessoa\s+juridica|ainda\s+não|ainda\s+nao|só|so|somente\s+isso|ok|obrigad|valeu|sim|não|nao|pode|certo|entendi|por\s+favor)[\s!.,?]*$/i;
const _QUEUE_PROD    = /quadro\s+branco|caneta(?:\s+(?:para|p)\s+quadro)?|agenda|caderno|mochila|estojo|lápis|lapis|borracha|apontador|papel\s+sulfite|sulfite|impressão|impressao|xerox|pilot|bic|resma|bloco/i;
const _QUEUE_QTY     = /\d+\s*(?:unidades?|un\.?|pcs?|peças?|pecas?)/i;
const _QUEUE_MEAS    = /\d+\s*[x×]\s*\d+|\d+\s*m\s*[x×]\s*\d+/i;
const _QUEUE_URGENT  = /urgent|urgência|urgencia|o\s+quanto\s+antes|para\s+hoje|preciso.*hoje|rápido|rapido/i;
const _QUEUE_NOCAD   = /ainda\s+não|ainda\s+nao|não\s+(?:tenho|temos)\s+cadastro|nao\s+(?:tenho|temos)\s+cadastro|só\s+orçamento|so\s+orcamento|sem\s+cadastro/i;

function buildOperationalSummary(session) {
  if (session.cardTitle && session.cardTitle.trim().length > 5) return session.cardTitle.trim();

  const history = session.history || [];
  const isPJ = session.clientType === "pj" || session.demandType === "cotacao_pj";

  const userMsgs = history
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content.trim())
    .filter((m) => m.length > 8 && !_QUEUE_USELESS.test(m));

  if (!userMsgs.length) return null;

  const allText  = userMsgs.join(" ");
  const isUrgent = _QUEUE_URGENT.test(allText);
  const notCad   = isPJ && _QUEUE_NOCAD.test(allText);

  // Prefere mensagem com produto ou quantidade; senão usa a mais longa
  const bestMsg = [...userMsgs]
    .filter((m) => _QUEUE_PROD.test(m) || _QUEUE_QTY.test(m) || m.length > 20)
    .sort((a, b) => b.length - a.length)[0] || userMsgs[userMsgs.length - 1];

  const cleaned = bestMsg
    .replace(/^(quero|queria|gostaria\s+de|preciso\s+de|vim\s+pedir|olá?|oi|bom\s+dia|boa\s+tarde|boa\s+noite)[,!.\s]*/gi, "")
    .replace(/\s+/g, " ").trim();

  let summary = cleaned.substring(0, 60).trim();

  const measMatch = allText.match(_QUEUE_MEAS);
  if (measMatch && !summary.includes(measMatch[0])) summary += " " + measMatch[0];

  const urgPfx = isUrgent ? "urgente: " : "";
  const cadCtx = notCad   ? " · empresa não cadastrada" : "";
  const prefix  = isPJ ? `Cotação PJ ${urgPfx}` : "";

  return `${prefix}${summary}${cadCtx}`.trim().substring(0, 120) || null;
}

// ── Detalhes complementares (contexto + itens de pedido) ────────────────────
function buildOperationalDetails(session) {
  const history = session.history || [];
  const isPJ = session.clientType === "pj" || session.demandType === "cotacao_pj";

  const userMsgs = history
    .filter((m) => m.role === "user" && typeof m.content === "string")
    .map((m) => m.content.trim())
    .filter((m) => m.length > 5 && !_QUEUE_USELESS.test(m));

  if (!userMsgs.length) return { context: [], items: [] };

  const allText = userMsgs.join(" ");
  const context = [];

  if (isPJ && _QUEUE_NOCAD.test(allText))   context.push("Empresa não cadastrada");
  if (_QUEUE_URGENT.test(allText))           context.push("Pedido urgente");
  if (/quando.*entrega|prazo.*entrega|quando.*consegue|quando.*fica.*pronto|prazo\s+de\s+entrega/i.test(allText)) {
    context.push("Cliente quer prazo de entrega");
  }

  // Mensagens com produto, quantidade ou medida — como itens do pedido
  const items = userMsgs
    .filter((m) => _QUEUE_PROD.test(m) || _QUEUE_QTY.test(m) || _QUEUE_MEAS.test(m))
    .map((m) => m
      .replace(/^(quero|queria|gostaria\s+de|preciso\s+de|vim\s+pedir)[,!\s]+/gi, "")
      .replace(/\s+/g, " ").trim()
    )
    .filter((m) => m.length > 5)
    .slice(0, 4);

  return { context, items };
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
      allKeys.push(...found.filter((k) =>
        !k.includes(":archive:") &&
        !k.includes(":contact:") &&
        k !== "sartec:pipelineOrder"
      ));
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
      // Sessões ativas (sem handoff, sem resolução) paradas há >30min
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
      let lastMessage =
        typeof lastUserMsg?.content === "string"
          ? lastUserMsg.content
          : "[mídia]";
      if (lastMessage === "[áudio]") lastMessage = "Áudio recebido";
      if (!lastMessage && lastUserMsg?.mediaType === "image")    lastMessage = "Imagem";
      if (!lastMessage && lastUserMsg?.mediaType === "document") lastMessage = "Documento";

      const clientType =
        session.clientType ||
        (session.demandType === "cotacao_pj" ? "pj" : "pf");

      // Mapear "cadastro" (coluna removida) para "novo" sem alterar Redis
      let pipelineStatus = session.pipelineStatus || "novo";
      if (clientType === "pj" && pipelineStatus === "cadastro") pipelineStatus = "novo";

      conversations.push({
        phone,
        clientName:          session.clientName     || "—",
        demandType:          session.demandType      || "outro",
        clientType,
        pipelineStatus,
        status:              finalStatus,
        handoffAt:      session.handoffAt       || null,
        resolvedAt:     session.resolvedAt      || null,
        cardTitle:           session.cardTitle       || "",
        operationalSummary:  buildOperationalSummary(session),
        operationalDetails:  buildOperationalDetails(session),
        lastMessage:         lastMessage.substring(0, 200),
        messageCount:   (session.history || []).length,
        priorityManual: session.priorityManual  || null,
        dataLimite:     session.dataLimite      || null,
        formaEntrega:   session.formaEntrega    || null,
        endereco:       session.endereco        || null,
        observacoes:    session.observacoes     || null,
        escola:            session.escola             || null,
        serie:             session.serie              || null,
        activeAttendant:           session.activeAttendant           || null,
        activeAttendantAt:         session.activeAttendantAt         || null,
        lastTemplateType:           session.lastTemplateType           || null,
        lastTemplateDeliveryStatus: session.lastTemplateDeliveryStatus || null,
        lastTemplateStatusAt:       session.lastTemplateStatusAt       || null,
        lastTemplateError:          session.lastTemplateError          || null,
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

    let pipelineOrder = {};
    try {
      const rawOrder = await redis.get("sartec:pipelineOrder");
      if (rawOrder) pipelineOrder = JSON.parse(rawOrder);
    } catch {}

    return res.status(200).json({ conversations, pipelineOrder });
  } catch (err) {
    console.error("[queue] ❌", err.message);
    return res.status(500).json({ error: "Erro ao carregar fila", detail: err.message });
  }
}
