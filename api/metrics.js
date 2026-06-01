// ============================================================
// Sartec Papelaria — Endpoint de Métricas do CRM
// GET /api/metrics?period=hoje|7d|30d|tudo
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/metrics] ❌", err.message));
  }
  return redisClient;
}

// Janela de 24h (mesmo padrão de conversations.js)
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

// Obtém o timestamp representativo da conversa de forma segura (sem inventar datas)
function getConversationTimestamp(session) {
  if (session.lastActivityAt) {
    const t = new Date(session.lastActivityAt).getTime();
    if (!isNaN(t)) return t;
  }
  
  const fallbacks = [
    session.resolvedAt,
    session.archivedAt,
    session.handoffAt,
    session.lastUserMessageAt,
    session.lastDate
  ];
  for (const f of fallbacks) {
    if (f) {
      const t = new Date(f).getTime();
      if (!isNaN(t)) return t;
    }
  }

  if (session.history && session.history.length > 0) {
    for (let i = session.history.length - 1; i >= 0; i--) {
      const m = session.history[i];
      if (m.createdAt) {
        const t = new Date(m.createdAt).getTime();
        if (!isNaN(t)) return t;
      }
    }
  }

  return null;
}

// Verifica se o timestamp está dentro do período selecionado
function matchesPeriod(timestamp, period, now) {
  if (period === "tudo") return true;
  if (!timestamp) return false;
  
  const diffMs = now - timestamp;
  if (period === "hoje") {
    return diffMs <= 24 * 60 * 60 * 1000;
  }
  if (period === "7d") {
    return diffMs <= 7 * 24 * 60 * 60 * 1000;
  }
  if (period === "30d") {
    return diffMs <= 30 * 24 * 60 * 60 * 1000;
  }
  return true;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const period = (req.query.period || "30d").toLowerCase().trim();
  const validPeriods = ["hoje", "7d", "30d", "tudo"];
  if (!validPeriods.includes(period)) {
    return res.status(400).json({ error: "Período inválido. Use hoje, 7d, 30d ou tudo." });
  }

  try {
    const redis = getRedis();

    // SCAN — Nunca usa KEYS em produção
    let cursor = "0";
    const allKeys = [];
    do {
      const [nextCursor, found] = await redis.scan(
        cursor, "MATCH", "sartec:*", "COUNT", 250
      );
      cursor = nextCursor;
      // Filtra chaves de contato e pipelineOrder
      allKeys.push(...found.filter(k => !k.includes(":contact:") && k !== "sartec:pipelineOrder"));
    } while (cursor !== "0");

    if (!allKeys.length) {
      return res.status(200).json({
        period,
        summary: {
          totalChats: 0,
          waitingChats: 0,
          resolvedChats: 0,
          avgResolutionTimeMs: null,
          avgFirstResponseTimeMs: null,
          failedTemplatesCount: 0,
          windowClosedCount: 0,
          windowWaitingTemplateCount: 0,
          windowOpenCount: 0,
        },
        attendants: [],
        funnel: {
          pf: { novo: 0, em_atendimento: 0, orcamento_enviado: 0, confirmado: 0, finalizado: 0, resolvido: 0 },
          pj: { novo: 0, em_cotacao: 0, proposta_enviada: 0, confirmado: 0, entregue: 0, resolvido: 0 }
        },
        demands: { lista: 0, cotacao_pj: 0, xerox: 0, produto: 0, duvida: 0, outro: 0 },
        alerts: { idle30m: 0, windowClosed: 0, waitingTemplate: 0, failedTemplate: 0, missingName: 0 },
        alertsList: [],
        volumeByDay: []
      });
    }

    // Busca dados em lotes (chunks) de 200 para evitar sobrecarga no Redis
    const values = [];
    for (let i = 0; i < allKeys.length; i += 200) {
      const chunk = allKeys.slice(i, i + 200);
      const chunkValues = await redis.mget(...chunk);
      values.push(...chunkValues);
    }

    const now = Date.now();

    let totalChats = 0;
    let waitingChats = 0;
    let resolvedChats = 0;

    let resolutionTimeSum = 0;
    let resolutionTimeCount = 0;

    let firstResponseTimeSum = 0;
    let firstResponseTimeCount = 0;

    const templateDeliveryCounts = { accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0 };

    let windowOpenCount = 0;
    let windowClosedCount = 0;
    let windowWaitingTemplateCount = 0;

    const attendantsMap = {};
    const demandsMap = { lista: 0, cotacao_pj: 0, xerox: 0, produto: 0, duvida: 0, outro: 0 };

    const funnel = {
      pf: { novo: 0, em_atendimento: 0, orcamento_enviado: 0, confirmado: 0, finalizado: 0, resolvido: 0 },
      pj: { novo: 0, em_cotacao: 0, proposta_enviada: 0, confirmado: 0, entregue: 0, resolvido: 0 }
    };

    let idle30mCount = 0;
    let windowClosedAlertCount = 0;
    let waitingTemplateAlertCount = 0;
    let failedTemplateAlertCount = 0;
    let missingNameAlertCount = 0;

    const alertsList = [];
    const volumeByDayMap = {};

    for (let i = 0; i < allKeys.length; i++) {
      if (!values[i]) continue;
      
      let session;
      try {
        session = JSON.parse(values[i]);
      } catch {
        continue;
      }

      // 1. Extração de Data e Filtragem por Período
      const convTimestamp = getConversationTimestamp(session);
      if (!convTimestamp || !matchesPeriod(convTimestamp, period, now)) {
        continue; // Fora do período filtrado
      }

      totalChats++;

      // Extração de variáveis base da sessão
      const status = session.status || "ativo";
      const isResolved = status === "resolvido";
      const clientType = session.clientType || (session.demandType === "cotacao_pj" ? "pj" : "pf");
      const clientName = session.clientName || "—";
      const phone = allKeys[i].includes(":archive:") 
        ? allKeys[i].split(":")[2] 
        : allKeys[i].replace("sartec:", "");

      // 2. Status Geral
      if (isResolved) {
        resolvedChats++;
      } else if (status === "aguardando_humano") {
        waitingChats++;
      }

      // 3. Tempo até Resolução
      if (isResolved && session.resolvedAt) {
        const startStr = session.handoffAt || session.lastUserMessageAt;
        if (startStr) {
          const startMs = new Date(startStr).getTime();
          const endMs = new Date(session.resolvedAt).getTime();
          if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
            resolutionTimeSum += (endMs - startMs);
            resolutionTimeCount++;
          }
        }
      }

      // 4. Tempo até Primeira Resposta Humana (no histórico)
      const history = session.history || [];
      let firstClientMsg = null;
      let firstHumanMsgAfterClient = null;

      for (const m of history) {
        if (m.role === "user" && !firstClientMsg) {
          firstClientMsg = m;
        } else if (m.sentByHuman === true && firstClientMsg && !firstHumanMsgAfterClient) {
          firstHumanMsgAfterClient = m;
        }
      }

      if (firstClientMsg && firstHumanMsgAfterClient && firstClientMsg.createdAt && firstHumanMsgAfterClient.createdAt) {
        const startMs = new Date(firstClientMsg.createdAt).getTime();
        const endMs = new Date(firstHumanMsgAfterClient.createdAt).getTime();
        if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
          firstResponseTimeSum += (endMs - startMs);
          firstResponseTimeCount++;
        }
      }

      // 5. Contagem de Mensagens / Produtividade por Atendente
      for (const m of history) {
        if (m.sentByHuman === true) {
          const msgTime = m.createdAt ? new Date(m.createdAt).getTime() : convTimestamp;
          if (msgTime && matchesPeriod(msgTime, period, now)) {
            const attName = m.attendantName || "Desconhecido";
            const attId = m.attendantId || attName.toLowerCase().trim().replace(/\s+/g, "_");

            if (!attendantsMap[attId]) {
              attendantsMap[attId] = {
                id: attId,
                name: attName,
                messagesSent: 0,
                conversationsActed: new Set()
              };
            }
            attendantsMap[attId].messagesSent++;
            attendantsMap[attId].conversationsActed.add(phone);
          }
        }
      }

      // 6. Templates
      if (session.lastTemplateDeliveryStatus) {
        const tStatus = session.lastTemplateDeliveryStatus.toLowerCase();
        if (templateDeliveryCounts.hasOwnProperty(tStatus)) {
          templateDeliveryCounts[tStatus]++;
        }
      }

      // 7. Janela de 24h
      const winInfo = computeWindowInfo(session);
      if (winInfo.conversationWindowStatus === "open") {
        windowOpenCount++;
      } else if (winInfo.conversationWindowStatus === "closed") {
        windowClosedCount++;
      } else if (winInfo.conversationWindowStatus === "waiting_template_reply") {
        windowWaitingTemplateCount++;
      }

      // 8. Funil do Pipeline
      if (funnel.hasOwnProperty(clientType)) {
        if (isResolved) {
          funnel[clientType].resolvido++;
        } else {
          const pipeStatus = session.pipelineStatus || "novo";
          if (funnel[clientType].hasOwnProperty(pipeStatus)) {
            funnel[clientType][pipeStatus]++;
          }
        }
      }

      // 9. Distribuição de Demanda
      const dType = session.demandType || "outro";
      if (demandsMap.hasOwnProperty(dType)) {
        demandsMap[dType]++;
      } else {
        demandsMap.outro++;
      }

      // 10. Alertas de Saúde Operacional
      let hasAlert = false;
      const alertReasons = [];

      // Parada há mais de 30 minutos sem atividade (não resolvida)
      if (!isResolved && session.lastActivityAt) {
        const lastActMs = new Date(session.lastActivityAt).getTime();
        if (!isNaN(lastActMs) && (now - lastActMs) > 30 * 60 * 1000) {
          idle30mCount++;
          alertReasons.push("Parada há +30m");
          hasAlert = true;
        }
      }

      // Janela fechada (não resolvida)
      if (!isResolved && winInfo.conversationWindowStatus === "closed") {
        windowClosedAlertCount++;
        alertReasons.push("Janela fechada");
        hasAlert = true;
      }

      // Aguardando resposta de template
      if (!isResolved && winInfo.conversationWindowStatus === "waiting_template_reply") {
        waitingTemplateAlertCount++;
        alertReasons.push("Aguardando template");
        hasAlert = true;
      }

      // Templates falhou
      if (session.lastTemplateDeliveryStatus === "failed") {
        failedTemplateAlertCount++;
        alertReasons.push("Template falhou");
        hasAlert = true;
      }

      // Nome sem preenchimento ou com "—"
      if (clientName === "—" || !session.clientName) {
        missingNameAlertCount++;
        alertReasons.push("Sem nome cliente");
        hasAlert = true;
      }

      if (hasAlert && alertsList.length < 10) {
        alertsList.push({
          phone,
          clientName,
          reasons: alertReasons,
          lastActivity: session.lastActivityAt ? new Date(session.lastActivityAt).toISOString() : "—"
        });
      }

      // 11. Agrupamento por dia (Volume por Dia)
      const dateObj = new Date(convTimestamp);
      const dayStr = dateObj.toISOString().split("T")[0]; // YYYY-MM-DD
      volumeByDayMap[dayStr] = (volumeByDayMap[dayStr] || 0) + 1;
    }

    // Formata o mapa de volume por dia para uma array ordenada cronologicamente
    const volumeByDay = Object.keys(volumeByDayMap)
      .map(date => ({ date, count: volumeByDayMap[date] }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Formata a lista de atendentes
    const attendants = Object.values(attendantsMap).map(att => ({
      id: att.id,
      name: att.name,
      messagesSent: att.messagesSent,
      conversationsActed: att.conversationsActed.size
    })).sort((a, b) => b.messagesSent - a.messagesSent);

    return res.status(200).json({
      period,
      summary: {
        totalChats,
        waitingChats,
        resolvedChats,
        avgResolutionTimeMs: resolutionTimeCount > 0 ? Math.round(resolutionTimeSum / resolutionTimeCount) : null,
        avgFirstResponseTimeMs: firstResponseTimeCount > 0 ? Math.round(firstResponseTimeSum / firstResponseTimeCount) : null,
        failedTemplatesCount: templateDeliveryCounts.failed,
        windowClosedCount,
        windowWaitingTemplateCount,
        windowOpenCount
      },
      attendants,
      funnel,
      demands: demandsMap,
      alerts: {
        idle30m: idle30mCount,
        windowClosed: windowClosedAlertCount,
        waitingTemplate: waitingTemplateAlertCount,
        failedTemplate: failedTemplateAlertCount,
        missingName: missingNameAlertCount
      },
      alertsList,
      volumeByDay
    });
  } catch (err) {
    console.error("[metrics] ❌", err.message);
    return res.status(500).json({ error: "Erro ao calcular métricas", detail: err.message });
  }
}
