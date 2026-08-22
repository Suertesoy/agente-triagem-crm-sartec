// ============================================================
// Agregação/debounce de turno PF pré-handoff (burst).
//
// Problema: o webhook da Meta precisa responder rápido — não dá para segurar
// a função serverless esperando 60s (quiet period) nem depender de
// setTimeout/setInterval em memória (a função pode ser reciclada a qualquer
// momento). Este módulo só guarda o ESTADO do turno em Redis; quem decide
// "está na hora de responder" é o sweep (api/agent-burst-sweep.js), disparado
// por um Vercel Cron Job de 1 em 1 minuto — a menor solução confiável que não
// exige nenhuma infraestrutura nova (Cron Jobs já faz parte do plano Vercel
// Pro deste projeto).
//
// Cada mensagem do cliente que precisa esperar o turno chama scheduleBurst(),
// que grava/atualiza um registro por telefone com:
//   generation     — incrementa a cada mensagem (observabilidade/testes)
//   firstMessageAt — início do turno (base do hard cap)
//   lastMessageAt  — última mensagem (base do quiet period)
//   dueAt          — min(lastMessageAt + quietMs, firstMessageAt + maxMs)
//
// O sweep só processa um telefone quando dueAt já passou, e sempre relê o
// registro por baixo do lock de sessão (lib/redis-lock.js) antes de consumir
// — se uma mensagem nova chegou entre o scan e o lock, dueAt já foi
// empurrado para frente e o sweep desiste (a próxima passada do cron cuida).
// Isso evita a resposta duplicada A / A+B / A+B+C descrita no pedido.
// ============================================================

const BURST_KEY_PREFIX = "sartec:burst:";
const BURST_PENDING_SET = "sartec:burst:pending";

export function getBurstConfig() {
  const quietMs = Number(process.env.AGENT_BURST_QUIET_MS);
  const maxMs = Number(process.env.AGENT_BURST_MAX_MS);
  return {
    quietMs: Number.isFinite(quietMs) && quietMs > 0 ? quietMs : 60000,
    maxMs: Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 180000,
  };
}

export function burstKey(phone) {
  return `${BURST_KEY_PREFIX}${phone}`;
}

/**
 * Registra (ou estende) o turno pendente do telefone. Cada chamada reinicia
 * o quiet period a partir de agora, sem nunca ultrapassar o hard cap contado
 * da primeira mensagem do turno.
 */
export async function scheduleBurst(redis, phone, now = Date.now()) {
  const { quietMs, maxMs } = getBurstConfig();
  const key = burstKey(phone);
  const raw = await redis.get(key);
  const prev = raw ? JSON.parse(raw) : null;

  const firstMessageAt = prev?.firstMessageAt || now;
  const generation = (prev?.generation || 0) + 1;
  const dueAt = Math.min(now + quietMs, firstMessageAt + maxMs);

  const record = { phone, generation, firstMessageAt, lastMessageAt: now, dueAt };
  const ttlSeconds = Math.ceil(maxMs / 1000) + 120; // margem de segurança sobre o hard cap
  await redis.set(key, JSON.stringify(record), "EX", ttlSeconds);
  await redis.sadd(BURST_PENDING_SET, phone);
  return record;
}

export async function getBurstRecord(redis, phone) {
  const raw = await redis.get(burstKey(phone));
  return raw ? JSON.parse(raw) : null;
}

export async function clearBurst(redis, phone) {
  await redis.del(burstKey(phone));
  await redis.srem(BURST_PENDING_SET, phone);
}

export async function getPendingBurstPhones(redis) {
  return redis.smembers(BURST_PENDING_SET);
}
