// ============================================================
// Sartec Papelaria — Endpoint de Métricas do CRM
// GET /api/metrics?period=hoje|7d|30d|tudo
//                 &customerType=all|pf|pj
//                 &attendant=all|<id_normalizado>
//                 &category=all|lista|cotacao_pj|xerox|produto|duvida|outro
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

  if (!lastUserAt) return { conversationWindowStatus: "closed", windowRemainingMs: 0 };

  if (expiresAt && now < expiresAt) return {
    conversationWindowStatus: "open", windowRemainingMs: expiresAt - now };

  if (session.templateSentAt) {
    const templateAt = new Date(session.templateSentAt).getTime();
    if (templateAt > lastUserAt) return {
      conversationWindowStatus: "waiting_template_reply", windowRemainingMs: 0 };
  }

  return { conversationWindowStatus: "closed", windowRemainingMs: 0 };
}

// Obtém o timestamp representativo da conversa de forma segura
function getConversationTimestamp(session) {
  if (session.lastActivityAt) {
    const t = new Date(session.lastActivityAt).getTime();
    if (!isNaN(t)) return t;
  }
  const fallbacks = [
    session.resolvedAt, session.archivedAt, session.handoffAt,
    session.lastUserMessageAt, session.lastDate
  ];
  for (const f of fallbacks) {
    if (f) { const t = new Date(f).getTime(); if (!isNaN(t)) return t; }
  }
  if (session.history && session.history.length > 0) {
    for (let i = session.history.length - 1; i >= 0; i--) {
      const m = session.history[i];
      if (m.createdAt) { const t = new Date(m.createdAt).getTime(); if (!isNaN(t)) return t; }
    }
  }
  return null;
}

// Verifica se o timestamp está dentro do período selecionado
function matchesPeriod(timestamp, period, now) {
  if (period === "tudo") return true;
  if (!timestamp) return false;
  const diffMs = now - timestamp;
  if (period === "hoje") return diffMs <= 24 * 60 * 60 * 1000;
  if (period === "7d")   return diffMs <= 7  * 24 * 60 * 60 * 1000;
  if (period === "30d")  return diffMs <= 30 * 24 * 60 * 60 * 1000;
  return true;
}

// Normaliza nome/id de atendente para comparação
function normAtt(s) { return (s || "").toLowerCase().trim().replace(/\s+/g, "_"); }

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  const period = (req.query.period || "30d").toLowerCase().trim();
  if (!["hoje", "7d", "30d", "tudo"].includes(period)) {
    return res.status(400).json({ error: "Período inválido. Use hoje, 7d, 30d ou tudo." });
  }

  const customerType     = (req.query.customerType || "all").toLowerCase().trim();
  const attendantFilter  = (req.query.attendant    || "all").toLowerCase().trim();
  const categoryFilter   = (req.query.category     || "all").toLowerCase().trim();
  const validDemands     = ["lista", "cotacao_pj", "xerox", "produto", "duvida", "outro"];

  const emptyFunnel = {
    pf: { novo: 0, em_atendimento: 0, orcamento_enviado: 0, confirmado: 0, finalizado: 0, resolvido: 0 },
    pj: { novo: 0, em_cotacao: 0, proposta_enviada: 0, confirmado: 0, entregue: 0, resolvido: 0 }
  };
  const emptyAlerts = {
    idle30m: 0, windowClosed: 0, waitingTemplate: 0, failedTemplate: 0,
    missingName: 0, triageIncomplete: 0, triageIncomplete15m: 0, noAttendant: 0
  };
  const emptyPfVsPj = {
    pf: { total: 0, resolved: 0, triageIncomplete: 0, avgResolutionMs: null, avgFirstResponseMs: null },
    pj: { total: 0, resolved: 0, triageIncomplete: 0, avgResolutionMs: null, avgFirstResponseMs: null }
  };

  try {
    const redis = getRedis();

    // SCAN — nunca usa KEYS em produção
    let cursor = "0";
    const allKeys = [];
    do {
      const [nextCursor, found] = await redis.scan(cursor, "MATCH", "sartec:*", "COUNT", 250);
      cursor = nextCursor;
      allKeys.push(...found.filter(k => !k.includes(":contact:") && k !== "sartec:pipelineOrder"));
    } while (cursor !== "0");

    if (!allKeys.length) {
      return res.status(200).json({
        period, customerType, attendantFilter, categoryFilter,
        summary: { totalChats: 0, waitingChats: 0, resolvedChats: 0, triageIncompleteCount: 0,
          avgResolutionTimeMs: null, avgFirstResponseTimeMs: null, failedTemplatesCount: 0,
          windowClosedCount: 0, windowWaitingTemplateCount: 0, windowOpenCount: 0 },
        attendants: [], funnel: emptyFunnel,
        demands: { lista: 0, cotacao_pj: 0, xerox: 0, produto: 0, duvida: 0, outro: 0 },
        pfvspj: emptyPfVsPj, alerts: emptyAlerts, alertsList: [], volumeByDay: []
      });
    }

    // Busca em lotes de 200 para evitar sobrecarga no Redis
    const values = [];
    for (let i = 0; i < allKeys.length; i += 200) {
      const chunkValues = await redis.mget(...allKeys.slice(i, i + 200));
      values.push(...chunkValues);
    }

    const now = Date.now();

    // Acumuladores principais
    let totalChats = 0, waitingChats = 0, resolvedChats = 0, triageIncompleteCount = 0;
    let resTimeSum = 0, resTimeCount = 0;
    let firstRespSum = 0, firstRespCount = 0;
    const tmplCounts = { accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
    let winOpen = 0, winClosed = 0, winWaiting = 0;

    const attendantsMap = {};
    const demandsMap = { lista: 0, cotacao_pj: 0, xerox: 0, produto: 0, duvida: 0, outro: 0 };
    const funnel = {
      pf: { novo: 0, em_atendimento: 0, orcamento_enviado: 0, confirmado: 0, finalizado: 0, resolvido: 0 },
      pj: { novo: 0, em_cotacao: 0, proposta_enviada: 0, confirmado: 0, entregue: 0, resolvido: 0 }
    };

    // Acumuladores para comparativo PF vs PJ
    const pvp = {
      pf: { total: 0, resolved: 0, triageIncomplete: 0, resMs: 0, resN: 0, frMs: 0, frN: 0 },
      pj: { total: 0, resolved: 0, triageIncomplete: 0, resMs: 0, resN: 0, frMs: 0, frN: 0 }
    };

    // Alertas
    let idle30m = 0, winClosedAlert = 0, winWaitingAlert = 0;
    let failedTmpl = 0, missingName = 0, triage15m = 0, noAtt = 0;
    const alertsList = [];
    const volumeByDayMap = {};

    for (let i = 0; i < allKeys.length; i++) {
      if (!values[i]) continue;
      let session;
      try { session = JSON.parse(values[i]); } catch { continue; }

      // 1. Filtro por período
      const convTs = getConversationTimestamp(session);
      if (!convTs || !matchesPeriod(convTs, period, now)) continue;

      // Variáveis base
      const status     = session.status || "ativo";
      const isResolved = status === "resolvido";
      const clientType = session.clientType || (session.demandType === "cotacao_pj" ? "pj" : "pf");
      const clientName = session.clientName || "—";
      const phone      = allKeys[i].includes(":archive:")
        ? allKeys[i].split(":")[2] : allKeys[i].replace("sartec:", "");
      const dType      = session.demandType || "outro";
      const resolvedDT = validDemands.includes(dType) ? dType : "outro";

      // 2. Filtros de segmento
      if (customerType !== "all" && clientType !== customerType) continue;
      if (categoryFilter !== "all" && resolvedDT !== categoryFilter) continue;
      if (attendantFilter !== "all") {
        const hist = session.history || [];
        const has = hist.some(m => m.sentByHuman === true && (
          normAtt(m.attendantId)   === attendantFilter ||
          normAtt(m.attendantName) === attendantFilter
        ));
        if (!has) continue;
      }

      totalChats++;

      // 3. Status geral
      if (isResolved)                       resolvedChats++;
      else if (status === "aguardando_humano") waitingChats++;
      else if (status === "triagem_incompleta") triageIncompleteCount++;

      const history       = session.history || [];
      const hasAnyHuman   = history.some(m => m.sentByHuman === true);
      const ctKey         = clientType === "pj" ? "pj" : "pf";

      // 4. Comparativo PF vs PJ
      pvp[ctKey].total++;
      if (isResolved)                         pvp[ctKey].resolved++;
      if (status === "triagem_incompleta")     pvp[ctKey].triageIncomplete++;

      // 5. Tempo de resolução
      if (isResolved && session.resolvedAt) {
        const startStr = session.handoffAt || session.lastUserMessageAt;
        if (startStr) {
          const s = new Date(startStr).getTime(), e = new Date(session.resolvedAt).getTime();
          if (!isNaN(s) && !isNaN(e) && e >= s) {
            const d = e - s;
            resTimeSum += d; resTimeCount++;
            pvp[ctKey].resMs += d; pvp[ctKey].resN++;
          }
        }
      }

      // 6. Tempo até primeira resposta humana
      let firstClient = null, firstHuman = null;
      for (const m of history) {
        if (m.role === "user" && !firstClient) firstClient = m;
        else if (m.sentByHuman === true && firstClient && !firstHuman) firstHuman = m;
      }
      if (firstClient?.createdAt && firstHuman?.createdAt) {
        const s = new Date(firstClient.createdAt).getTime();
        const e = new Date(firstHuman.createdAt).getTime();
        if (!isNaN(s) && !isNaN(e) && e >= s) {
          const d = e - s;
          firstRespSum += d; firstRespCount++;
          pvp[ctKey].frMs += d; pvp[ctKey].frN++;
        }
      }

      // 7. Produtividade por atendente
      for (const m of history) {
        if (m.sentByHuman === true) {
          const mTime = m.createdAt ? new Date(m.createdAt).getTime() : convTs;
          if (mTime && matchesPeriod(mTime, period, now)) {
            const attName = m.attendantName || "Desconhecido";
            const attId   = m.attendantId   || normAtt(attName);
            if (!attendantsMap[attId]) {
              attendantsMap[attId] = { id: attId, name: attName, messagesSent: 0,
                conversationsActed: new Set(), resolvedConversations: new Set() };
            }
            attendantsMap[attId].messagesSent++;
            attendantsMap[attId].conversationsActed.add(phone);
            if (isResolved) attendantsMap[attId].resolvedConversations.add(phone);
          }
        }
      }

      // 8. Templates
      if (session.lastTemplateDeliveryStatus) {
        const ts = session.lastTemplateDeliveryStatus.toLowerCase();
        if (tmplCounts.hasOwnProperty(ts)) tmplCounts[ts]++;
      }

      // 9. Janela de 24h
      const win = computeWindowInfo(session);
      if      (win.conversationWindowStatus === "open")                  winOpen++;
      else if (win.conversationWindowStatus === "closed")                winClosed++;
      else if (win.conversationWindowStatus === "waiting_template_reply") winWaiting++;

      // 10. Funil do Pipeline
      if (funnel.hasOwnProperty(clientType)) {
        if (isResolved) {
          funnel[clientType].resolvido++;
        } else {
          const ps = session.pipelineStatus || "novo";
          if (funnel[clientType].hasOwnProperty(ps)) funnel[clientType][ps]++;
        }
      }

      // 11. Distribuição de demanda
      if (demandsMap.hasOwnProperty(dType)) demandsMap[dType]++;
      else demandsMap.outro++;

      // 12. Alertas de saúde operacional
      let hasAlert = false;
      const reasons = [];

      if (!isResolved && session.lastActivityAt) {
        const lastAct = new Date(session.lastActivityAt).getTime();
        if (!isNaN(lastAct) && (now - lastAct) > 30 * 60 * 1000) {
          idle30m++; reasons.push("Parada há +30m"); hasAlert = true;
        }
      }
      if (!isResolved && win.conversationWindowStatus === "closed") {
        winClosedAlert++; reasons.push("Janela fechada"); hasAlert = true;
      }
      if (!isResolved && win.conversationWindowStatus === "waiting_template_reply") {
        winWaitingAlert++; reasons.push("Aguardando template"); hasAlert = true;
      }
      if (session.lastTemplateDeliveryStatus === "failed") {
        failedTmpl++; reasons.push("Template falhou"); hasAlert = true;
      }
      if (clientName === "—" || !session.clientName) {
        missingName++; reasons.push("Sem nome cliente"); hasAlert = true;
      }
      // Triagem incompleta parada há >15min
      if (status === "triagem_incompleta" && session.lastActivityAt) {
        const lastAct = new Date(session.lastActivityAt).getTime();
        if (!isNaN(lastAct) && (now - lastAct) > 15 * 60 * 1000) {
          triage15m++; reasons.push("Triagem parada >15m"); hasAlert = true;
        }
      }
      // Handoff feito mas nenhuma mensagem humana encontrada (sem atendente)
      if (session.handoffDone && !hasAnyHuman && !isResolved) {
        noAtt++; reasons.push("Sem atendente"); hasAlert = true;
      }

      if (hasAlert && alertsList.length < 20) {
        alertsList.push({
          phone, clientName, clientType,
          reasons,
          lastActivity: session.lastActivityAt
            ? new Date(session.lastActivityAt).toISOString() : "—"
        });
      }

      // 13. Volume por dia
      const dayStr = new Date(convTs).toISOString().split("T")[0];
      volumeByDayMap[dayStr] = (volumeByDayMap[dayStr] || 0) + 1;
    }

    const volumeByDay = Object.keys(volumeByDayMap)
      .map(date => ({ date, count: volumeByDayMap[date] }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const attendants = Object.values(attendantsMap).map(att => ({
      id: att.id,
      name: att.name,
      messagesSent: att.messagesSent,
      conversationsActed: att.conversationsActed.size,
      resolvedCount: att.resolvedConversations.size
    })).sort((a, b) => b.messagesSent - a.messagesSent);

    return res.status(200).json({
      period, customerType, attendantFilter, categoryFilter,
      summary: {
        totalChats, waitingChats, resolvedChats, triageIncompleteCount,
        avgResolutionTimeMs:     resTimeCount  > 0 ? Math.round(resTimeSum  / resTimeCount)  : null,
        avgFirstResponseTimeMs:  firstRespCount > 0 ? Math.round(firstRespSum / firstRespCount) : null,
        failedTemplatesCount: tmplCounts.failed,
        windowClosedCount: winClosed, windowWaitingTemplateCount: winWaiting, windowOpenCount: winOpen,
      },
      attendants,
      funnel,
      demands: demandsMap,
      pfvspj: {
        pf: {
          total: pvp.pf.total, resolved: pvp.pf.resolved, triageIncomplete: pvp.pf.triageIncomplete,
          avgResolutionMs:    pvp.pf.resN > 0 ? Math.round(pvp.pf.resMs / pvp.pf.resN) : null,
          avgFirstResponseMs: pvp.pf.frN  > 0 ? Math.round(pvp.pf.frMs  / pvp.pf.frN)  : null
        },
        pj: {
          total: pvp.pj.total, resolved: pvp.pj.resolved, triageIncomplete: pvp.pj.triageIncomplete,
          avgResolutionMs:    pvp.pj.resN > 0 ? Math.round(pvp.pj.resMs / pvp.pj.resN) : null,
          avgFirstResponseMs: pvp.pj.frN  > 0 ? Math.round(pvp.pj.frMs  / pvp.pj.frN)  : null
        }
      },
      alerts: {
        idle30m, windowClosed: winClosedAlert, waitingTemplate: winWaitingAlert,
        failedTemplate: failedTmpl, missingName, triageIncomplete: triageIncompleteCount,
        triageIncomplete15m: triage15m, noAttendant: noAtt
      },
      alertsList,
      volumeByDay
    });
  } catch (err) {
    console.error("[metrics] ❌", err.message);
    return res.status(500).json({ error: "Erro ao calcular métricas", detail: err.message });
  }
}
