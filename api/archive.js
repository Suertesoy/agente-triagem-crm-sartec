// ============================================================
// Sartec Papelaria — Arquivo permanente de conversas
// GET  /api/archive?phone=xxx — lista conversas arquivadas
// POST /api/archive { phone } — arquiva conversa ativa
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/archive] ❌", err.message));
  }
  return redisClient;
}

// 90 dias — retenção mínima de histórico
const ARCHIVE_TTL = 60 * 60 * 24 * 90;

export default async function handler(req, res) {
  if (req.method === "GET")  return handleGet(req, res);
  if (req.method === "POST") return handlePost(req, res);
  return res.status(405).json({ error: "Method Not Allowed" });
}

// ── GET /api/archive?phone=xxx ────────────────────────────
async function handleGet(req, res) {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "Parâmetro phone obrigatório" });

  try {
    const redis = getRedis();

    // SCAN para evitar KEYS bloqueante em produção
    let cursor = "0";
    const keys = [];
    do {
      const [nextCursor, found] = await redis.scan(
        cursor, "MATCH", `sartec:archive:${phone}:*`, "COUNT", 100
      );
      cursor = nextCursor;
      keys.push(...found);
    } while (cursor !== "0");

    if (!keys.length) return res.status(200).json({ archives: [] });

    const values = await redis.mget(...keys);
    const archives = values
      .filter(Boolean)
      .map((v) => { try { return JSON.parse(v); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => new Date(b.resolvedAt || 0) - new Date(a.resolvedAt || 0));

    return res.status(200).json({ archives });
  } catch (err) {
    console.error("[archive/get] ❌", err.message);
    return res.status(500).json({ error: "Erro ao buscar arquivos", detail: err.message });
  }
}

// Remove base64 de mídia antes de arquivar — preserva metadados e texto
// Evita duplicar blobs pesados (imagens/PDFs) que já foram enviados à Meta
function stripMediaData(session) {
  if (!session?.history) return session;
  return {
    ...session,
    history: session.history.map(m => {
      if (!m.mediaData) return m;
      const { mediaData: _dropped, ...rest } = m;
      return rest;
    }),
  };
}

// ── POST /api/archive { phone } ───────────────────────────
async function handlePost(req, res) {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "Campo phone obrigatório" });
  // Arquivamento desativado: histórico preservado na sessão principal por 90 dias.
  console.log(`[archive/post] ℹ️ arquivamento desativado para +${phone}`);
  return res.status(200).json({
    success: true,
    message: "Arquivamento desativado. Histórico preservado na sessão principal por 90 dias.",
  });
}

// ── Exportado para compatibilidade — arquivamento desativado ─
export async function archiveSession(phone) {
  // Não cria mais chaves sartec:archive:*. Histórico permanece na sessão principal por 90 dias.
  console.log(`[archive] ℹ️ arquivamento automático desativado para +${phone}`);
}
