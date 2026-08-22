// ============================================================
// Sartec Papelaria — Fechamento do burst PF (agregação/debounce)
// Vercel Serverless Function: /api/agent-burst-sweep.js
//
// Disparado por um Vercel Cron Job de 1 em 1 minuto (ver "crons" em
// vercel.json). Não guarda nenhuma lógica de negócio própria — só decide
// QUANDO um turno pendente já pode ser respondido e delega a geração da
// resposta a runAgentCompletion() (api/webhook.js), a mesma função usada
// para a resposta imediata (ex.: dúvida operacional PF pós-handoff).
//
// Segurança: se CRON_SECRET estiver configurado no projeto Vercel, exige o
// header Authorization: Bearer <CRON_SECRET> — enviado automaticamente pelo
// Vercel em toda invocação de cron (ver docs oficiais de Cron Jobs). Sem a
// env var configurada, o endpoint aceita chamadas sem header (necessário
// para os testes de integração chamarem o handler diretamente).
// ============================================================

import {
  getPendingBurstPhones,
  getBurstRecord,
  clearBurst,
} from "../lib/agent-burst.js";
import { withSessionLock } from "../lib/redis-lock.js";
import { getRedis, loadSession, runAgentCompletion, sendTextMessage } from "./webhook.js";

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // sem secret configurado — não bloqueia (ver nota acima)
  const header = req.headers?.authorization || req.headers?.Authorization;
  return header === `Bearer ${secret}`;
}

/**
 * Processa um único telefone com burst pendente. Sempre roda por baixo do
 * lock de sessão — se uma mensagem nova chegou entre o SMEMBERS e o lock,
 * relê o registro fresco e desiste (generation/dueAt mudaram) em vez de
 * responder com contexto desatualizado ou duplicar uma resposta que outra
 * invocação já está gerando.
 */
async function processPendingPhone(redis, phone, now) {
  await withSessionLock(redis, phone, async () => {
    const fresh = await getBurstRecord(redis, phone);
    if (!fresh) return; // já consumido por outra invocação/trigger imediato

    if (fresh.dueAt > now) return; // uma mensagem nova estendeu o turno — próxima passada do cron cuida

    // Consome ANTES de gerar a resposta: se uma mensagem nova chegar durante a
    // chamada à Anthropic (pode levar alguns segundos), ela inicia um burst
    // NOVO (novo firstMessageAt) em vez de ser silenciosamente engolida por
    // este fechamento.
    await clearBurst(redis, phone);

    const session = await loadSession(phone);
    if (session.handoffDone) return; // virou irrelevante nesse meio-tempo (ex.: PJ instantâneo)

    const reply = await runAgentCompletion(phone, session);
    if (reply) await sendTextMessage(phone, reply);
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const redis = getRedis();
  const now = Date.now();
  const phones = await getPendingBurstPhones(redis);

  let processed = 0;
  let skipped = 0;
  const errors = [];

  for (const phone of phones) {
    try {
      const before = await getBurstRecord(redis, phone);
      if (!before || before.dueAt > now) { skipped++; continue; }
      await processPendingPhone(redis, phone, now);
      processed++;
    } catch (err) {
      console.error(`[BurstSweep] ❌ +${phone}: ${err.message}`);
      errors.push({ phone, error: err.message });
    }
  }

  console.log(`[BurstSweep] ✅ pendentes=${phones.length} processados=${processed} adiados=${skipped} erros=${errors.length}`);
  return res.status(200).json({ ok: true, pending: phones.length, processed, skipped, errors });
}
