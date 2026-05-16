// ============================================================
// Sartec Papelaria — Reset de dados de teste (APENAS DESENVOLVIMENTO)
//
// GET /api/dev-reset?reset=TOKEN&phone=+55NUMERO
//     → apaga sartec:{phone} (sessão ativa apenas)
//
// GET /api/dev-reset?reset=TOKEN&phone=+55NUMERO&hard=1
//     → apaga sessão + archives + contato do número
//
// GET /api/dev-reset?reset=TOKEN&phone=+55NUMERO&hard=1&dryRun=1
//     → lista o que seria apagado, sem apagar
//
// GET /api/dev-reset?reset=TOKEN&all=1&dryRun=1
//     → lista TODAS as chaves sartec:* no Redis, sem apagar
//
// GET /api/dev-reset?reset=TOKEN&all=1
//     → apaga TODAS as chaves sartec:* (CUIDADO — use só em ambiente de teste)
//
// NUNCA apaga chaves fora do namespace sartec:
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/dev-reset] ❌", err.message));
  }
  return redisClient;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { reset, phone, hard, all, dryRun } = req.query;

  // ── Autenticação obrigatória ──────────────────────────────────────────────
  if (!reset || reset !== process.env.WHATSAPP_VERIFY_TOKEN) {
    console.warn("[dev-reset] ❌ Token inválido");
    return res.status(403).json({ error: "Forbidden — token inválido" });
  }

  const redis    = getRedis();
  const isDryRun = dryRun === "1" || dryRun === "true";

  // ── Opção 1: reset por número ─────────────────────────────────────────────
  if (phone && !all) {
    try {
      const sessionKey = `sartec:${phone}`;
      const contactKey = `sartec:contact:${phone}`;

      // Buscar archives do número
      const archiveKeys = [];
      let cursor = "0";
      do {
        const [nextCursor, found] = await redis.scan(
          cursor, "MATCH", `sartec:archive:${phone}:*`, "COUNT", 100
        );
        cursor = nextCursor;
        archiveKeys.push(...found);
      } while (cursor !== "0");

      // Montar lista de chaves a apagar
      const keysToDelete = [sessionKey, ...archiveKeys];
      if (hard === "1") keysToDelete.push(contactKey);

      if (isDryRun) {
        return res.status(200).json({
          dryRun: true,
          phone,
          hard: hard === "1",
          keysToDelete,
          count: keysToDelete.length,
        });
      }

      // Executar deleção
      const deleted = [];
      for (const key of keysToDelete) {
        const n = await redis.del(key);
        if (n > 0) deleted.push(key);
      }

      console.log(`[dev-reset] ✅ Reset +${phone}: ${deleted.length} chave(s) removida(s)`);
      return res.status(200).json({ ok: true, phone, deleted, count: deleted.length });

    } catch (err) {
      console.error("[dev-reset/phone] ❌", err.message);
      return res.status(500).json({ error: "Erro ao resetar número", detail: err.message });
    }
  }

  // ── Opção 2: reset geral de todos os dados sartec:* ───────────────────────
  if (all === "1") {
    try {
      const allKeys = [];
      let cursor = "0";
      do {
        const [nextCursor, found] = await redis.scan(
          cursor, "MATCH", "sartec:*", "COUNT", 200
        );
        cursor = nextCursor;
        allKeys.push(...found);
      } while (cursor !== "0");

      const sessions = allKeys.filter(k => !k.includes(":archive:") && !k.includes(":contact:"));
      const archives = allKeys.filter(k => k.includes(":archive:"));
      const contacts = allKeys.filter(k => k.includes(":contact:"));

      if (isDryRun) {
        console.log(`[dev-reset] 🔍 Dry-run all: ${allKeys.length} chave(s) encontrada(s)`);
        return res.status(200).json({
          dryRun: true,
          total: allKeys.length,
          sessions: { count: sessions.length, sample: sessions.slice(0, 30) },
          archives: { count: archives.length, sample: archives.slice(0, 10) },
          contacts: { count: contacts.length, sample: contacts.slice(0, 10) },
          ...(sessions.length > 30 && { note: `... e mais ${sessions.length - 30} sessões omitidas` }),
        });
      }

      if (allKeys.length === 0) {
        return res.status(200).json({ ok: true, deleted: 0, message: "Nada a apagar — Redis já está vazio no namespace sartec:" });
      }

      // Deleção em pipeline para evitar múltiplos round-trips
      const pipeline = redis.pipeline();
      for (const key of allKeys) pipeline.del(key);
      await pipeline.exec();

      console.log(`[dev-reset] ✅ Reset geral: ${allKeys.length} chave(s) removida(s) | sessões=${sessions.length} archives=${archives.length} contatos=${contacts.length}`);
      return res.status(200).json({
        ok: true,
        deleted: allKeys.length,
        breakdown: { sessions: sessions.length, archives: archives.length, contacts: contacts.length },
      });

    } catch (err) {
      console.error("[dev-reset/all] ❌", err.message);
      return res.status(500).json({ error: "Erro ao executar reset geral", detail: err.message });
    }
  }

  // ── Ajuda: parâmetros inválidos ───────────────────────────────────────────
  return res.status(400).json({
    error: "Parâmetros inválidos — veja usage",
    usage: {
      "reset simples":    "GET /api/dev-reset?reset=TOKEN&phone=+55NUMERO",
      "reset hard":       "GET /api/dev-reset?reset=TOKEN&phone=+55NUMERO&hard=1",
      "dry-run número":   "GET /api/dev-reset?reset=TOKEN&phone=+55NUMERO&hard=1&dryRun=1",
      "dry-run geral":    "GET /api/dev-reset?reset=TOKEN&all=1&dryRun=1",
      "reset geral":      "GET /api/dev-reset?reset=TOKEN&all=1  (CUIDADO)",
    },
  });
}
