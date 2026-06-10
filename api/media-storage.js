// ============================================================
// Sartec — Armazenamento de mídia no Cloudflare R2
// Compatível com S3 API (endpoint R2)
//
// Env vars obrigatórias:
//   R2_ENDPOINT          → https://{account_id}.r2.cloudflarestorage.com
//   R2_ACCESS_KEY_ID     → API Token R2 (Object Read & Write)
//   R2_SECRET_ACCESS_KEY → Segredo do token
//   R2_BUCKET            → Nome do bucket (ex: sartec-crm-media)
//   R2_ACCOUNT_ID        → ID da conta Cloudflare (para referência)
//
// Rollback: definir R2_DISABLED=true na Vercel → uploadMedia retorna null
//           → webhook cai no fallback base64 no Redis (comportamento anterior)
// ============================================================

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Mapa de mimeType → extensão de arquivo
const MIME_TO_EXT = {
  "image/jpeg":       "jpg",
  "image/jpg":        "jpg",
  "image/png":        "png",
  "image/webp":       "webp",
  "application/pdf":  "pdf",
  "audio/ogg":        "ogg",
  "audio/mpeg":       "mp3",
  "audio/mp3":        "mp3",
  "video/mp4":        "mp4",
};

function getExt(mimeType) {
  return MIME_TO_EXT[(mimeType || "").toLowerCase()] || "bin";
}

// Remove caracteres perigosos do messageId antes de usar como parte da chave
function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, "_").substring(0, 128);
}

// Gera a storage key no formato: media/{phone}/{yyyyMM}/{messageId}.{ext}
function buildStorageKey(phone, messageId, mimeType) {
  const yyyyMM = new Date().toISOString().substring(0, 7).replace("-", "");
  const safeId = sanitizeId(messageId);
  const ext    = getExt(mimeType);
  return `media/${phone}/${yyyyMM}/${safeId}.${ext}`;
}

// Singleton lazy — mesmo padrão do cliente Redis no projeto
let _s3Client = null;

function getS3() {
  if (!_s3Client) {
    const configured = Boolean(
      process.env.R2_ENDPOINT &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET
    );
    if (!configured) {
      throw new Error("R2 não configurado — verifique R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET na Vercel");
    }
    _s3Client = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _s3Client;
}

/**
 * Faz upload de um Buffer para o Cloudflare R2.
 *
 * Retorna null quando R2_DISABLED=true (caller deve usar fallback base64).
 * Lança erro se o upload falhar — o caller captura e usa fallback.
 *
 * @param {Buffer}  buffer
 * @param {string}  mimeType
 * @param {string}  phone      número do cliente (ex: "5511999887766")
 * @param {string}  messageId  ID da mensagem Meta (usado para unicidade da chave)
 * @returns {Promise<{storageProvider, storageKey, bucket, mimeType, size}|null>}
 */
export async function uploadMedia(buffer, mimeType, phone, messageId) {
  if (process.env.R2_DISABLED === "true") {
    return null;
  }

  const storageKey = buildStorageKey(phone, messageId, mimeType);
  const bucket     = process.env.R2_BUCKET;

  await getS3().send(new PutObjectCommand({
    Bucket:      bucket,
    Key:         storageKey,
    Body:        buffer,
    ContentType: mimeType,
  }));

  console.log(`[R2] upload ok type=${(mimeType || "").split("/")[0]} size=${buffer.byteLength} key=${storageKey}`);

  return {
    storageProvider: "cloudflare-r2",
    storageKey,
    bucket,
    mimeType,
    size: buffer.byteLength,
  };
}

/**
 * Gera uma URL presigned para acesso temporário a um objeto R2.
 *
 * @param {string} storageKey  chave do objeto no bucket
 * @param {number} expiresIn   TTL em segundos (painel: 86400, contexto Claude: 300)
 * @returns {Promise<string>}  URL presigned
 */
export async function getMediaUrl(storageKey, expiresIn = 3600) {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key:    storageKey,
  });
  return getSignedUrl(getS3(), command, { expiresIn });
}
