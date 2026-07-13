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

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
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
  // Documentos Office
  "application/msword":                                                          "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":    "docx",
  "application/vnd.ms-excel":                                                   "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":          "xlsx",
  "application/vnd.ms-powerpoint":                                              "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":  "pptx",
  // Outros formatos comuns
  "text/plain":       "txt",
  "text/csv":         "csv",
  "application/zip":  "zip",
  "application/x-zip-compressed": "zip",
  "image/gif":        "gif",
  "image/heic":       "heic",
  "image/heif":       "heif",
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
    const ep       = Boolean(process.env.R2_ENDPOINT);
    const key      = Boolean(process.env.R2_ACCESS_KEY_ID);
    const secret   = Boolean(process.env.R2_SECRET_ACCESS_KEY);
    const bucket   = Boolean(process.env.R2_BUCKET);
    const disabled = process.env.R2_DISABLED === "true";
    if (!ep || !key || !secret || !bucket) {
      console.error(`[R2] config missing endpoint=${ep} accessKey=${key} secret=${secret} bucket=${bucket} disabled=${disabled}`);
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

/**
 * Baixa um objeto do R2 direto pelo backend (sem URL presigned/CORS).
 * Usado pelo parser de orçamento para ler o PDF enviado pelo atendente.
 *
 * @param {string} storageKey  chave do objeto (deve começar com "media/")
 * @returns {Promise<Buffer>}
 */
export async function downloadMedia(storageKey) {
  if (!storageKey || !String(storageKey).startsWith("media/")) {
    throw new Error("storageKey inválida — deve começar com media/");
  }
  const result = await getS3().send(new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key:    storageKey,
  }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Apaga um objeto do Cloudflare R2.
 *
 * @param {string} storageKey  chave do objeto (deve começar com "media/")
 * @returns {Promise<{deleted: true, storageKey: string}>}
 */
export async function deleteMedia(storageKey) {
  if (process.env.R2_DISABLED === "true") {
    throw new Error("R2_DISABLED — operação de deleção não disponível");
  }
  if (!storageKey || !String(storageKey).startsWith("media/")) {
    throw new Error("storageKey inválida — deve começar com media/");
  }
  await getS3().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key:    storageKey,
  }));
  console.log(`[R2] deleted key=${storageKey}`);
  return { deleted: true, storageKey };
}
