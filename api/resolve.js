// ============================================================
// Sartec Papelaria — Marcar conversa como resolvida
// POST /api/resolve  { phone }
// ============================================================

import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { withSessionLock } from "../lib/redis-lock.js";
import {
  resolveClientTypeForFeedback,
  isEligibleForFeedback,
  ensureFeedbackForResolution,
  addPendingPostSaleFeedback,
} from "./_lib/feedback-service.js";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/resolve] ❌", err.message));
  }
  return redisClient;
}

const SESSION_TTL = 60 * 60 * 24 * 90; // 90 dias — retenção mínima de histórico

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { phone } = req.body || {};

  if (!phone) {
    return res.status(400).json({ error: "Campo phone é obrigatório" });
  }

  try {
    const redis = getRedis();
    let notFound = false;
    let resolvedAt;

    // Intenção durável de pós-venda: resolutionId + marcador "pending" são
    // decididos e persistidos no MESMO write que marca a sessão como
    // resolvida, dentro do lock. Isso fecha a janela onde uma falha entre
    // "resolução salva" e "feedback criado" perdia o agendamento — a partir
    // daqui a elegibilidade fica registrada na própria sessão, sobrevivendo
    // a qualquer falha da materialização (que acontece fora do lock, abaixo).
    let resolutionId = null;
    let isRetry = false;
    let materializeContext = null;
    let orphanedPending = []; // pendências de ciclos anteriores ainda não recuperadas

    await withSessionLock(redis, phone, async () => {
      const raw = await redis.get(`sartec:${phone}`);
      if (!raw) { notFound = true; return; }

      const session = JSON.parse(raw);
      const wasAlreadyResolved = session.status === "resolvido";

      // resolvedAt marca o instante da resolução — só muda numa transição
      // real. Um retry (sessão que já estava resolvida) nunca deve reescrevê-lo.
      if (!wasAlreadyResolved) {
        session.resolvedAt = new Date().toISOString();
      }
      session.status = "resolvido";
      resolvedAt      = session.resolvedAt;

      if (!wasAlreadyResolved) {
        // Nova transição para resolvido: se for uma venda elegível, gera um
        // resolutionId novo agora — nunca reaproveita um marcador antigo
        // (ex.: de uma compra anterior do mesmo telefone já materializada).
        const clientType     = resolveClientTypeForFeedback(session);
        const pipelineStatus = session.pipelineStatus || "novo";

        if (isEligibleForFeedback({ clientType, pipelineStatus })) {
          // O marcador atual pode referenciar uma intenção de uma venda
          // anterior que ainda não foi recuperada — preserva-a numa lista de
          // pendências antigas antes de substituí-la. Nunca é descartada.
          if (session.postSaleFeedback?.state === "pending" && session.postSaleFeedback?.resolutionId) {
            addPendingPostSaleFeedback(session, {
              resolutionId:    session.postSaleFeedback.resolutionId,
              saleCompletedAt: session.postSaleFeedback.createdAt,
              createdAt:       session.postSaleFeedback.createdAt,
            }, phone);
          }

          resolutionId = randomUUID();
          session.postSaleFeedback = {
            state: "pending",
            resolutionId,
            createdAt: session.resolvedAt,
          };
          // saleCompletedAt fica ancorado ao momento desta transição — nunca
          // recalculado em retries futuros, para o horário agendado não derivar.
          materializeContext = {
            clientType, clientName: session.clientName, demandType: session.demandType,
            saleCompletedAt: session.resolvedAt,
          };
        }
      } else if (session.postSaleFeedback?.state === "pending" && session.postSaleFeedback?.resolutionId) {
        // Retry manual: sessão já resolvida com um pós-venda pendente de
        // recuperação — reusa exatamente o mesmo resolutionId, nunca cria um
        // novo, e ancora no createdAt ORIGINAL do marcador (não em "agora").
        resolutionId = session.postSaleFeedback.resolutionId;
        isRetry = true;
        materializeContext = {
          clientType: resolveClientTypeForFeedback(session),
          clientName: session.clientName,
          demandType: session.demandType,
          saleCompletedAt: session.postSaleFeedback.createdAt,
        };
      }

      // Snapshot tirado DEPOIS do possível push acima, então inclui qualquer
      // intenção recém-orfanada — permite tentar recuperá-la neste mesmo call.
      orphanedPending = Array.isArray(session.pendingPostSaleFeedbacks)
        ? session.pendingPostSaleFeedbacks.slice()
        : [];

      await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);
    });

    if (notFound) return res.status(404).json({ error: "Conversa não encontrada" });

    console.log(`[resolve] ✅ +${phone} marcado como resolvido`);

    // Fora do lock — não estende o tempo de bloqueio por telefone. A sessão já
    // está durável nesse ponto, então uma segunda chamada concorrente a
    // /api/resolve só entra na seção crítica acima depois de ver status já
    // atualizado. Aguardamos aqui (em vez de fire-and-forget) porque o
    // processo serverless pode ser congelado assim que a resposta HTTP for
    // enviada — uma promise pendente não teria garantia de concluir depois
    // disso. Falha aqui nunca derruba a resolução, que já foi persistida com
    // sucesso acima: o marcador "pending" (e a lista de pendências antigas)
    // sobrevivem para um retry futuro.
    if (resolutionId || orphanedPending.length > 0) {
      let currentRecord = null;
      let currentSucceeded = false;

      if (resolutionId) {
        try {
          const { record } = await ensureFeedbackForResolution(redis, {
            resolutionId, phone, ...materializeContext,
          });
          currentRecord = record;
          currentSucceeded = true;
        } catch (err) {
          console.warn(`[feedback] ⚠️ +${phone} resolução concluída; feedback pendente de recuperação`);
        }
      }

      // Best-effort: além da resolução atual, tenta recuperar pendências de
      // ciclos anteriores que nunca foram materializadas. Já estão em memória
      // (vieram da própria sessão) — não é uma varredura, só iteração local
      // sobre uma lista pequena (protegida por MAX_PENDING_POST_SALE_FEEDBACKS).
      const recoveredIds = new Set();
      for (const pending of orphanedPending) {
        if (pending.resolutionId === resolutionId) continue;
        try {
          await ensureFeedbackForResolution(redis, {
            resolutionId: pending.resolutionId, phone, saleCompletedAt: pending.saleCompletedAt,
          });
          recoveredIds.add(pending.resolutionId);
        } catch (err) {
          console.warn(`[feedback] ⚠️ +${phone} pendência antiga (resolutionId=${pending.resolutionId}) continua pendente de recuperação`);
        }
      }

      if (currentSucceeded || recoveredIds.size > 0) {
        // Sob lock de novo, só para não sobrescrever alterações concorrentes
        // na sessão — recarrega, confirma que a resolução atual ainda é a
        // mesma (uma venda nova pode ter substituído o marcador nesse meio
        // tempo) e remove da lista só as pendências que de fato recuperamos.
        await withSessionLock(redis, phone, async () => {
          const raw = await redis.get(`sartec:${phone}`);
          if (!raw) return;
          const session = JSON.parse(raw);
          let changed = false;

          if (currentSucceeded && session.postSaleFeedback?.resolutionId === resolutionId) {
            session.postSaleFeedback = {
              state: "scheduled",
              resolutionId,
              feedbackId: resolutionId,
              createdAt: session.postSaleFeedback.createdAt,
              scheduledAt: currentRecord.scheduledAt,
            };
            changed = true;
          }

          if (recoveredIds.size > 0 && Array.isArray(session.pendingPostSaleFeedbacks)) {
            const before = session.pendingPostSaleFeedbacks.length;
            session.pendingPostSaleFeedbacks = session.pendingPostSaleFeedbacks.filter(
              (p) => !recoveredIds.has(p.resolutionId)
            );
            if (session.pendingPostSaleFeedbacks.length !== before) changed = true;
          }

          if (changed) {
            await redis.set(`sartec:${phone}`, JSON.stringify(session), "EX", SESSION_TTL);
          }
        });
      }

      if (currentSucceeded) {
        if (isRetry) console.log(`[feedback] 🔄 +${phone} feedback pendente recuperado`);
        else console.log(`[feedback] 📅 +${phone} agendado para ${currentRecord.scheduledAt}`);
      }
      for (const id of recoveredIds) {
        console.log(`[feedback] 🔄 +${phone} pendência antiga recuperada (resolutionId=${id})`);
      }
    }

    return res.status(200).json({ success: true, resolvedAt });
  } catch (err) {
    console.error("[resolve] ❌", err.message);
    return res.status(500).json({ error: "Erro ao resolver conversa", detail: err.message });
  }
}
