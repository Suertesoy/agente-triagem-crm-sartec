// ============================================================
// Sartec Papelaria — Pós-venda (Gate 1: fundação de dados + agendamento)
//
// Subsistema separado do atendimento normal. Neste gate NÃO envia WhatsApp,
// NÃO chama a Meta API e NÃO consome a fila — apenas cria o registro de
// feedback e agenda o próximo dia útil às 10h (America/Sao_Paulo) num
// sorted set. Quem consome essa fila é responsabilidade de um gate futuro.
//
// A intenção de criar o pós-venda (resolutionId + marcador "pending") é
// persistida por resolve.js no MESMO write da resolução da sessão — este
// módulo só materializa (ensureFeedbackForResolution), de forma idempotente
// e chaveada pelo resolutionId, para que uma falha entre resolver a conversa
// e criar o feedback nunca perca o agendamento permanentemente.
// ============================================================

import { randomUUID } from "node:crypto";

// Retenção dos registros de feedback — usados futuramente para métricas e
// relatórios históricos. Independente do TTL das sessões operacionais.
export const FEEDBACK_TTL_SECONDS = 60 * 60 * 24 * 365; // ~365 dias

export const FEEDBACK_KEY_PREFIX  = "sartec:feedback:";
export const FEEDBACK_DUE_ZSET_KEY = "sartec:feedback:due"; // ZADD score = ms epoch (UTC)

const TIMEZONE            = "America/Sao_Paulo";
const SCHEDULE_HOUR_LOCAL = 10; // 10h no horário de São Paulo

export function feedbackKey(feedbackId) {
  return `${FEEDBACK_KEY_PREFIX}${feedbackId}`;
}

// Mesmo fallback de clientType já usado em queue.js/conversations.js/metrics.js —
// mantém o comportamento atual do CRM para sessões sem clientType explícito.
export function resolveClientTypeForFeedback(session) {
  return session.clientType || (session.demandType === "cotacao_pj" ? "pj" : "pf");
}

// Regra de elegibilidade aprovada: venda concluída = status terminal do
// pipeline certo para o tipo de cliente.
export function isEligibleForFeedback({ clientType, pipelineStatus }) {
  if (clientType === "pf") return pipelineStatus === "finalizado";
  if (clientType === "pj") return pipelineStatus === "entregue";
  return false;
}

// ── Cálculo do próximo dia útil às 10h em America/Sao_Paulo ────────────────
// (Brasil não tem mais horário de verão desde 2019, mas o cálculo abaixo não
// depende disso — ele lê o offset real da IANA tz db para o instante alvo.)

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  return {
    year:    Number(parts.year),
    month:   Number(parts.month),
    day:     Number(parts.day),
    hour:    parts.hour === "24" ? 0 : Number(parts.hour),
    minute:  Number(parts.minute),
    second:  Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

// Offset (ms) de timeZone no instante `date` — ex.: -3h para America/Sao_Paulo.
function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - date.getTime();
}

// Instante UTC correspondente a hour:minute:second no horário local de
// timeZone, para o ano/mês/dia informados.
function zonedInstant(year, month, day, hour, minute, second, timeZone) {
  const guess  = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = tzOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

function isWeekend(weekday) {
  return weekday === 0 || weekday === 6;
}

// Retorna um Date (instante UTC) representando o próximo dia útil às 10h de
// São Paulo, a partir de `fromDate`. Considera apenas segunda a sexta —
// feriados não são tratados neste gate.
export function getNextFeedbackSchedule(fromDate = new Date()) {
  const today = zonedParts(fromDate, TIMEZONE);

  // Avança em passos de calendário puro (Date.UTC + getUTCDay) — não depende
  // de timezone, só do triplo ano/mês/dia obtido acima para "hoje" em SP.
  let cursor  = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  let weekday = cursor.getUTCDay();
  while (isWeekend(weekday)) {
    cursor  = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    weekday = cursor.getUTCDay();
  }

  return zonedInstant(
    cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(),
    SCHEDULE_HOUR_LOCAL, 0, 0, TIMEZONE
  );
}

// ── Criação do registro + agendamento na fila ───────────────────────────────

function buildFeedbackRecord({
  id, phone, clientName, clientType, demandType, saleCompletedAtISO, scheduledAtISO,
}) {
  const now = new Date().toISOString();
  return {
    id,
    phone,
    clientName: clientName || null,
    clientType: clientType || null,
    demandType: demandType || null,

    saleCompletedAt: saleCompletedAtISO,
    scheduledAt: scheduledAtISO,

    status: "scheduled",

    templateSentAt: null,

    storeRating: null,
    agentRating: null,
    improvementComment: null,

    answeredAt: null,
    completedAt: null,

    googleInviteSentAt: null,

    createdAt: now,
    updatedAt: now,
  };
}

export async function createScheduledFeedback(redis, {
  phone, clientName, clientType, demandType, saleCompletedAt, feedbackId,
} = {}) {
  if (!phone) throw new Error("phone é obrigatório para criar feedback");

  const saleDate = saleCompletedAt instanceof Date
    ? saleCompletedAt
    : new Date(saleCompletedAt || Date.now());
  const scheduledAt = getNextFeedbackSchedule(saleDate);
  const id = feedbackId || randomUUID();

  const record = buildFeedbackRecord({
    id, phone, clientName, clientType, demandType,
    saleCompletedAtISO: saleDate.toISOString(),
    scheduledAtISO: scheduledAt.toISOString(),
  });

  await redis.set(feedbackKey(id), JSON.stringify(record), "EX", FEEDBACK_TTL_SECONDS);
  await redis.zadd(FEEDBACK_DUE_ZSET_KEY, scheduledAt.getTime(), id);

  return record;
}

// ── Materialização idempotente, chaveada pelo resolutionId ─────────────────
//
// Chamada por resolve.js fora do lock da sessão, tanto na primeira tentativa
// quanto em retries. `resolutionId` é o `feedbackId`: como a chave do registro
// e o membro do ZSET são o próprio resolutionId, duas chamadas concorrentes ou
// repetidas para a MESMA resolução convergem para 1 registro + 1 membro na
// fila (SET sobrescreve com o mesmo conteúdo; ZADD é um upsert por membro).
//
// Também repara os dois desalinhamentos possíveis de uma falha parcial:
//   - registro existe, membro ausente no ZSET → só repara a fila.
//   - membro existe no ZSET, registro ausente → recria o registro usando o
//     score já comprometido como scheduledAt (nunca recalcula, para não
//     divergir do horário já anunciado pela fila).
//
// Não engole erros: se o redis.set/zadd falhar aqui, a exceção propaga para
// quem chamou decidir (resolve.js loga e mantém a sessão em "pending").
export async function ensureFeedbackForResolution(redis, {
  resolutionId, phone, clientName, clientType, demandType, saleCompletedAt,
} = {}) {
  if (!resolutionId) throw new Error("resolutionId é obrigatório para materializar feedback");
  if (!phone) throw new Error("phone é obrigatório para materializar feedback");

  const key = feedbackKey(resolutionId);
  const [raw, score] = await Promise.all([
    redis.get(key),
    redis.zscore(FEEDBACK_DUE_ZSET_KEY, resolutionId),
  ]);

  if (raw && score !== null) {
    return { record: JSON.parse(raw), repaired: false };
  }

  if (raw && score === null) {
    const record = JSON.parse(raw);
    await redis.zadd(FEEDBACK_DUE_ZSET_KEY, new Date(record.scheduledAt).getTime(), resolutionId);
    return { record, repaired: true };
  }

  if (!raw && score !== null) {
    const saleDate = saleCompletedAt instanceof Date
      ? saleCompletedAt
      : new Date(saleCompletedAt || Date.now());
    const record = buildFeedbackRecord({
      id: resolutionId, phone, clientName, clientType, demandType,
      saleCompletedAtISO: saleDate.toISOString(),
      scheduledAtISO: new Date(Number(score)).toISOString(),
    });
    await redis.set(key, JSON.stringify(record), "EX", FEEDBACK_TTL_SECONDS);
    return { record, repaired: true };
  }

  const record = await createScheduledFeedback(redis, {
    phone, clientName, clientType, demandType, saleCompletedAt, feedbackId: resolutionId,
  });
  return { record, repaired: false };
}

// ── Pendências de ciclos anteriores (Gate 1.1) ──────────────────────────────
//
// session.postSaleFeedback guarda só a resolução ATUAL (ciclo em curso). Se
// uma nova venda elegível chega enquanto a anterior ainda está "pending" (fez
// a transição para resolvido, mas nunca terminou de materializar), substituir
// esse marcador direto apagaria a única referência durável à intenção antiga.
// Em vez disso, ela é movida para esta lista antes da substituição — leve de
// propósito: só o suficiente para um retry futuro (resolutionId +
// saleCompletedAt), nunca o registro de feedback completo.
export const MAX_PENDING_POST_SALE_FEEDBACKS = 20;

export function addPendingPostSaleFeedback(session, entry, phone) {
  const list = Array.isArray(session.pendingPostSaleFeedbacks) ? session.pendingPostSaleFeedbacks : [];
  if (list.length >= MAX_PENDING_POST_SALE_FEEDBACKS) {
    // Cenário extremo (haveria de ter havido 20+ vendas elegíveis do mesmo
    // telefone sem nenhum retry bem-sucedido). Preferimos um alerta acionável
    // a descartar silenciosamente uma intenção durável — por isso a lista
    // pode, deliberadamente, crescer além do limite em vez de perder dados.
    console.error(
      `[feedback] 🚨 +${phone} acumulou ${list.length} pendências de pós-venda não recuperadas ` +
      `(limite de ${MAX_PENDING_POST_SALE_FEEDBACKS} atingido) — investigar recuperação manual; nada foi descartado`
    );
  }
  list.push(entry);
  session.pendingPostSaleFeedbacks = list;
  return list;
}
