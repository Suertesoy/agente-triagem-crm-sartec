// ============================================================
// Sartec Papelaria — Biblioteca de mensagens rápidas (texto livre)
// GET  /api/quick-messages  → lista (ordenada por `order`)
// POST /api/quick-messages  → cria { title, text, updatedBy? }
//      ação especial via body.action, seguindo o padrão de api/update-card.js:
//      { action: "delete",  id }
//      { action: "reorder", order: [id, id, ...] }
// PUT  /api/quick-messages  → edita { id, title, text, updatedBy? }
//
// Não são templates aprovados pela Meta — apenas texto livre reaproveitável,
// só pode ser usado com a janela de 24h aberta (regra aplicada no painel).
// Compartilhado entre toda a equipe via Redis (sem TTL — some junto com a
// mensagem sendo editada/excluída, nunca por expiração).
// ============================================================

import Redis from "ioredis";
import crypto from "crypto";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/quick-messages] ❌", err.message));
  }
  return redisClient;
}

const KEY       = "sartec:settings:quickMessages";
const LOCK_KEY  = "lock:sartec:settings:quickMessages";
const MAX_TITLE = 80;
const MAX_TEXT  = 4000;
const MAX_ITEMS = 50;

async function withLock(redis, fn) {
  for (let i = 0; i < 20; i++) {
    const ok = await redis.set(LOCK_KEY, "1", "NX", "EX", 15);
    if (ok) {
      try { return await fn(); }
      finally { await redis.del(LOCK_KEY); }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.warn("[Lock] ⚠️ Timeout quickMessages");
  return fn();
}

async function readList(redis) {
  const raw = await redis.get(KEY);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function writeList(redis, list) {
  await redis.set(KEY, JSON.stringify(list)); // sem EX — persiste até edição/exclusão manual
}

function normalizeTitle(raw) {
  if (typeof raw !== "string") return null;
  const title = raw.trim();
  if (!title) return null;
  if (title.length > MAX_TITLE) return null;
  return title;
}

function normalizeText(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  if (text.length > MAX_TEXT) return null;
  return text;
}

function sortByOrder(list) {
  return [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

async function handleDelete(redis, body) {
  const id = body.id;
  if (!id) return { status: 400, body: { error: "Campo id é obrigatório" } };

  let notFound = false;
  await withLock(redis, async () => {
    const list = await readList(redis);
    const idx = list.findIndex((it) => it.id === id);
    if (idx === -1) { notFound = true; return; }
    list.splice(idx, 1);
    await writeList(redis, list);
  });
  if (notFound) return { status: 404, body: { error: "Mensagem não encontrada" } };

  console.log(`[quick-messages] ✅ excluída ${id}`);
  return { status: 200, body: { success: true } };
}

async function handleReorder(redis, body) {
  const order = body.order;
  if (!Array.isArray(order) || !order.length || order.some((v) => typeof v !== "string")) {
    return { status: 400, body: { error: "Campo order deve ser uma lista de ids" } };
  }

  let result;
  await withLock(redis, async () => {
    const list = await readList(redis);
    const currentIds  = new Set(list.map((it) => it.id));
    const incomingIds = new Set(order);
    const sameSet = currentIds.size === incomingIds.size &&
      [...currentIds].every((id) => incomingIds.has(id));
    if (!sameSet) {
      result = { status: 400, body: { error: "Lista de ordenação inválida", detail: "A lista enviada não corresponde às mensagens cadastradas." } };
      return;
    }
    const byId = new Map(list.map((it) => [it.id, it]));
    const now  = new Date().toISOString();
    order.forEach((id, idx) => {
      const item = byId.get(id);
      item.order     = idx;
      item.updatedAt = now;
    });
    await writeList(redis, list);
    result = { status: 200, body: { success: true, messages: sortByOrder(list) } };
  });
  return result;
}

async function handleCreate(redis, body) {
  const title = normalizeTitle(body.title);
  const text  = normalizeText(body.text);
  if (!title) return { status: 400, body: { error: "Título obrigatório", detail: `Informe um título de até ${MAX_TITLE} caracteres.` } };
  if (!text)  return { status: 400, body: { error: "Texto obrigatório",  detail: `Informe um texto de até ${MAX_TEXT} caracteres.` } };

  let created;
  const failure = await withLock(redis, async () => {
    const list = await readList(redis);
    if (list.length >= MAX_ITEMS) {
      return { error: "Limite de mensagens atingido", detail: `A biblioteca já tem ${MAX_ITEMS} mensagens — exclua alguma para criar outra.` };
    }
    const now = new Date().toISOString();
    const maxOrder = list.reduce((m, it) => Math.max(m, it.order ?? 0), -1);
    created = {
      id: crypto.randomUUID(),
      title,
      text,
      order: maxOrder + 1,
      createdAt: now,
      updatedAt: now,
      updatedBy: typeof body.updatedBy === "string" ? body.updatedBy.slice(0, 80) : null,
    };
    list.push(created);
    await writeList(redis, list);
    return null;
  });
  if (failure) return { status: 400, body: failure };

  console.log(`[quick-messages] ✅ criada "${created.title}"`);
  return { status: 200, body: { success: true, message: created } };
}

export default async function handler(req, res) {
  const redis = getRedis();

  try {
    if (req.method === "GET") {
      const list = await readList(redis);
      return res.status(200).json({ messages: sortByOrder(list) });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      let result;
      if (body.action === "delete")       result = await handleDelete(redis, body);
      else if (body.action === "reorder") result = await handleReorder(redis, body);
      else                                 result = await handleCreate(redis, body);
      return res.status(result.status).json(result.body);
    }

    if (req.method === "PUT") {
      const body = req.body || {};
      const { id } = body;
      if (!id) return res.status(400).json({ error: "Campo id é obrigatório" });
      const title = normalizeTitle(body.title);
      const text  = normalizeText(body.text);
      if (!title) return res.status(400).json({ error: "Título obrigatório", detail: `Informe um título de até ${MAX_TITLE} caracteres.` });
      if (!text)  return res.status(400).json({ error: "Texto obrigatório",  detail: `Informe um texto de até ${MAX_TEXT} caracteres.` });

      let updated;
      let notFound = false;
      await withLock(redis, async () => {
        const list = await readList(redis);
        const item = list.find((it) => it.id === id);
        if (!item) { notFound = true; return; }
        item.title     = title;
        item.text      = text;
        item.updatedAt = new Date().toISOString();
        item.updatedBy = typeof body.updatedBy === "string" ? body.updatedBy.slice(0, 80) : item.updatedBy || null;
        updated = item;
        await writeList(redis, list);
      });
      if (notFound) return res.status(404).json({ error: "Mensagem não encontrada" });

      console.log(`[quick-messages] ✅ editada "${updated.title}"`);
      return res.status(200).json({ success: true, message: updated });
    }

    res.setHeader("Allow", "GET, POST, PUT");
    return res.status(405).json({ error: "Method Not Allowed" });
  } catch (err) {
    console.error("[quick-messages] ❌", err.message);
    return res.status(500).json({ error: "Erro ao processar mensagens rápidas", detail: err.message });
  }
}
