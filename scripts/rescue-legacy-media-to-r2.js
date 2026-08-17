#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import Redis from "ioredis";
import { RedisCrmStore, normalizeSartecPhone } from "../lib/crm-store/index.js";
import {
  getMediaExtension,
  headMediaObject,
  putMediaObject,
} from "../api/_lib/media-storage.js";

const EXTENSION_TO_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  mp4: "video/mp4",
};

function normalizeMime(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : null;
}

export function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

export function extractLegacyBase64(message) {
  if (typeof message?.mediaData === "string" && message.mediaData.trim()) {
    return { encoded: message.mediaData, origin: "mediaData", sourceMime: null };
  }
  if (!Array.isArray(message?.content)) return null;
  for (const [index, part] of message.content.entries()) {
    if (typeof part?.source?.data === "string" && part.source.data.trim()) {
      return {
        encoded: part.source.data,
        origin: `content[${index}].source.data`,
        sourceMime: normalizeMime(part.source.media_type || part.source.mimeType),
      };
    }
  }
  return null;
}

export function decodeLegacyBase64(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("base64 ausente");
  }
  const trimmed = value.trim();
  const dataUrl = trimmed.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  const declaredMime = normalizeMime(dataUrl?.[1]);
  const encoded = (dataUrl?.[2] || trimmed).replace(/\s/g, "");
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("base64 inválido");
  }
  const buffer = Buffer.from(encoded, "base64");
  const canonicalInput = encoded.replace(/=+$/, "");
  const canonicalOutput = buffer.toString("base64").replace(/=+$/, "");
  if (!buffer.length || canonicalInput !== canonicalOutput) {
    throw new Error("base64 inválido");
  }
  return { buffer, declaredMime };
}

function mimeFromFilename(filename) {
  if (typeof filename !== "string") return null;
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? EXTENSION_TO_MIME[match[1]] || null : null;
}

export function determineLegacyMime(message, extracted, declaredMime = null) {
  const candidates = [
    normalizeMime(message?.mediaMimeType),
    normalizeMime(declaredMime),
    normalizeMime(extracted?.sourceMime),
    mimeFromFilename(message?.mediaFilename),
  ].filter(Boolean);
  const mimeType = candidates.find((candidate) => getMediaExtension(candidate)) || candidates[0] || null;
  return {
    mimeType,
    extension: getMediaExtension(mimeType),
    safeExtension: Boolean(getMediaExtension(mimeType)),
  };
}

function sanitizeKeyPart(value) {
  return String(value || "legacy")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 96);
}

export function buildLegacyMediaStorageKey({
  phone,
  legacyHistoryIndex,
  metaMessageId,
  sha256,
  extension,
}) {
  const identity = metaMessageId || `history-${legacyHistoryIndex}`;
  return `media/${normalizeSartecPhone(phone)}/legacy/${sanitizeKeyPart(identity)}-${sha256.slice(0, 16)}.${extension}`;
}

function mediaGroup(message, mimeType) {
  const explicit = String(message.mediaType || message.messageType || "").toLowerCase();
  if (explicit === "image" || String(mimeType || "").startsWith("image/")) return "image";
  if (explicit === "audio" || String(mimeType || "").startsWith("audio/")) return "audio";
  if (explicit === "document" || mimeType === "application/pdf" || /officedocument|msword|ms-excel|ms-powerpoint/.test(mimeType || "")) {
    return "document";
  }
  return "outros";
}

function hasValidR2(message) {
  return Boolean(message?.mediaStorageKey)
    && String(message?.mediaStorageProvider || "").toLowerCase() === "cloudflare-r2";
}

export function inspectLegacyMediaMessage({ phone, legacyHistoryIndex, message }) {
  const extracted = extractLegacyBase64(message);
  if (!extracted || hasValidR2(message)) return null;

  const base = {
    phone,
    maskedPhone: maskPhone(phone),
    legacyHistoryIndex,
    metaMessageId: message.metaMessageId || null,
    messageType: message.messageType || null,
    mediaType: message.mediaType || null,
    mediaMimeType: message.mediaMimeType || null,
    mediaFilename: message.mediaFilename || null,
    createdAt: message.createdAt || null,
    base64Origin: extracted.origin,
    hasAnyMediaStorageKey: Boolean(message.mediaStorageKey),
    existingMediaStorageKey: message.mediaStorageKey || null,
  };

  try {
    const decoded = decodeLegacyBase64(extracted.encoded);
    const sha256 = createHash("sha256").update(decoded.buffer).digest("hex");
    const mime = determineLegacyMime(message, extracted, decoded.declaredMime);
    const storageKey = mime.extension
      ? buildLegacyMediaStorageKey({
          phone,
          legacyHistoryIndex,
          metaMessageId: message.metaMessageId,
          sha256,
          extension: mime.extension,
        })
      : null;
    return {
      ...base,
      valid: Boolean(mime.extension),
      error: mime.extension ? null : "MIME sem extensão segura",
      bytes: decoded.buffer.length,
      sha256,
      resolvedMimeType: mime.mimeType,
      safeExtension: mime.safeExtension,
      extension: mime.extension,
      storageKey,
      group: mediaGroup(message, mime.mimeType),
    };
  } catch (error) {
    return {
      ...base,
      valid: false,
      error: error.message,
      bytes: null,
      sha256: null,
      resolvedMimeType: null,
      safeExtension: false,
      extension: null,
      storageKey: null,
      group: mediaGroup(message, message.mediaMimeType),
    };
  }
}

export function buildLegacyMediaRescuePlan(sessionEntries) {
  const items = [];
  for (const entry of sessionEntries) {
    if (entry.error || !entry.value || typeof entry.value !== "object" || Array.isArray(entry.value)) continue;
    const phone = normalizeSartecPhone(entry.key.slice("sartec:".length));
    const history = Array.isArray(entry.value.history) ? entry.value.history : [];
    for (const [legacyHistoryIndex, message] of history.entries()) {
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const inspected = inspectLegacyMediaMessage({ phone, legacyHistoryIndex, message });
      if (inspected) items.push(inspected);
    }
  }
  const validItems = items.filter((item) => item.valid);
  const groupStats = Object.fromEntries(["image", "audio", "document", "outros"].map((group) => {
    const grouped = items.filter((item) => item.group === group);
    return [group, {
      messages: grouped.length,
      bytes: grouped.reduce((total, item) => total + (item.bytes || 0), 0),
    }];
  }));
  return {
    mode: "DRY RUN",
    items,
    counters: {
      candidates: items.length,
      validCandidates: validItems.length,
      invalidCandidates: items.length - validItems.length,
      legacyBase64Bytes: validItems.reduce((total, item) => total + item.bytes, 0),
      largestLegacyBase64Bytes: validItems.reduce((max, item) => Math.max(max, item.bytes), 0),
      groups: groupStats,
      origins: {
        mediaData: items.filter((item) => item.base64Origin === "mediaData").length,
        contentSourceData: items.filter((item) => item.base64Origin !== "mediaData").length,
      },
    },
  };
}

function hashCurrentBase64(message) {
  const extracted = extractLegacyBase64(message);
  if (!extracted) throw new Error("base64 não encontrado na mensagem atual");
  const decoded = decodeLegacyBase64(extracted.encoded);
  return {
    ...decoded,
    extracted,
    sha256: createHash("sha256").update(decoded.buffer).digest("hex"),
  };
}

export function locatePlannedMessage(session, item) {
  const history = Array.isArray(session?.history) ? session.history : [];
  const matchesPlan = (message) => {
    if (!message || typeof message !== "object") return false;
    try { return hashCurrentBase64(message).sha256 === item.sha256; } catch { return false; }
  };

  const indexed = history[item.legacyHistoryIndex];
  if (item.metaMessageId) {
    if (indexed?.metaMessageId === item.metaMessageId && matchesPlan(indexed)) {
      return { message: indexed, index: item.legacyHistoryIndex };
    }
    const candidates = history
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message?.metaMessageId === item.metaMessageId && matchesPlan(message));
    if (candidates.length === 1) return candidates[0];
    throw new Error("mensagem atual não corresponde ao Meta ID/índice/SHA planejado");
  }
  if (indexed && matchesPlan(indexed)) return { message: indexed, index: item.legacyHistoryIndex };
  throw new Error("mensagem atual não corresponde ao índice/SHA planejado");
}

export async function withSessionLock(redis, phone, fn, options = {}) {
  const lockKey = `lock:sartec:${normalizeSartecPhone(phone)}`;
  const token = options.token || randomUUID();
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 150;
  const ttlSeconds = options.ttlSeconds ?? 15;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const acquired = await redis.set(lockKey, token, "NX", "EX", ttlSeconds);
    if (acquired) {
      try {
        return await fn();
      } finally {
        await redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lockKey,
          token
        );
      }
    }
    await sleep(delayMs);
  }
  throw new Error(`lock indisponível: ${lockKey}`);
}

async function readAndValidateCurrent(redis, item) {
  const key = `sartec:${item.phone}`;
  const raw = await redis.get(key);
  if (!raw) throw new Error("sessão não encontrada");
  const session = JSON.parse(raw);
  const located = locatePlannedMessage(session, item);
  if (located.message.mediaStorageKey) {
    return { key, session, located, alreadyReferenced: true };
  }
  const current = hashCurrentBase64(located.message);
  if (current.sha256 !== item.sha256 || current.buffer.length !== item.bytes) {
    throw new Error("base64 alterado desde o planejamento");
  }
  return { key, session, located, current, alreadyReferenced: false };
}

function assertExistingObjectMatches(head, item) {
  if (head.size !== item.bytes || normalizeMime(head.mimeType) !== normalizeMime(item.resolvedMimeType)) {
    throw new Error("objeto R2 existente não corresponde a tamanho/MIME planejados");
  }
  if (!head.sha256 || head.sha256 !== item.sha256) {
    throw new Error("objeto R2 existente não possui o SHA-256 planejado");
  }
}

export async function executeLegacyMediaRescue(plan, dependencies, { commit = false } = {}) {
  if (!commit) {
    return { mode: "DRY RUN", uploaded: 0, reused: 0, redisUpdated: 0, skipped: 0 };
  }
  if (plan.items.some((item) => !item.valid)) {
    throw new Error("resgate recusado: há base64 inválido ou MIME sem extensão segura");
  }
  const { redis, storage, lockOptions } = dependencies;
  const result = { mode: "COMMIT", uploaded: 0, reused: 0, redisUpdated: 0, skipped: 0 };

  for (const item of plan.items) {
    // A validação preliminar e todo o tráfego R2 ficam fora do lock Redis.
    // A sessão é obrigatoriamente relida e validada novamente sob lock antes da escrita.
    const preflight = await readAndValidateCurrent(redis, item);
    if (preflight.alreadyReferenced) {
      result.skipped += 1;
      continue;
    }

    let head = await storage.headObject(item.storageKey);
    if (head.exists) {
      assertExistingObjectMatches(head, item);
      result.reused += 1;
    } else {
      await storage.uploadObject({
        storageKey: item.storageKey,
        buffer: preflight.current.buffer,
        mimeType: item.resolvedMimeType,
        sha256: item.sha256,
      });
      head = await storage.headObject(item.storageKey);
      if (!head.exists) throw new Error("upload R2 não ficou disponível para validação");
      assertExistingObjectMatches(head, item);
      result.uploaded += 1;
    }

    const update = await withSessionLock(redis, item.phone, async () => {
      const current = await readAndValidateCurrent(redis, item);
      if (current.alreadyReferenced) return "skipped";
      const message = current.located.message;
      message.mediaStorageProvider = "cloudflare-r2";
      message.mediaStorageKey = item.storageKey;
      message.mediaMimeType = item.resolvedMimeType;
      message.mediaSize = item.bytes;
      if (!message.mediaType && item.group !== "outros") message.mediaType = item.group;
      await redis.set(current.key, JSON.stringify(current.session), "KEEPTTL");
      return "updated";
    }, lockOptions);
    if (update === "updated") result.redisUpdated += 1;
    else result.skipped += 1;
  }
  return result;
}

function publicItem(item) {
  return {
    telefone: item.maskedPhone,
    legacy_history_index: item.legacyHistoryIndex,
    metaMessageId: item.metaMessageId,
    messageType: item.messageType,
    mediaType: item.mediaType,
    mediaMimeType: item.resolvedMimeType || item.mediaMimeType,
    mediaFilename: item.mediaFilename,
    createdAt: item.createdAt,
    bytes: item.bytes,
    sha256: item.sha256,
    origemBase64: item.base64Origin,
    existeMediaStorageKey: item.hasAnyMediaStorageKey,
    extensaoSegura: item.safeExtension,
    grupo: item.group,
    valido: item.valid,
    erro: item.error,
  };
}

export function printLegacyMediaPlan(plan) {
  console.log(`\nResgate de mídia legada → Cloudflare R2 (${plan.mode})`);
  console.log("Nenhum upload ou alteração no Redis é feito sem --commit.\n");
  for (const [index, item] of plan.items.entries()) {
    console.log(`${index + 1}. ${JSON.stringify(publicItem(item))}`);
  }
  console.log(`\nAgregado: ${JSON.stringify(plan.counters)}`);
  console.log("Uploads R2: 0 | Escritas Redis: 0");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const allowedArgs = new Set(["--commit", "--help"]);
  const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));
  if (args.has("--help")) {
    console.log(`Uso:
  node scripts/rescue-legacy-media-to-r2.js           # dry-run obrigatório por padrão
  node scripts/rescue-legacy-media-to-r2.js --commit  # upload + atualização Redis explícitos`);
    return;
  }
  if (unknownArgs.length) throw new Error(`Argumento(s) desconhecido(s): ${unknownArgs.join(", ")}`);
  if (!process.env.REDIS_URL) throw new Error("REDIS_URL não configurada");
  const commit = args.has("--commit");
  const redis = new Redis(process.env.REDIS_URL, {
    connectTimeout: 5000,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  redis.on("error", (error) => console.error(`[redis/media-rescue] ${error.message}`));
  try {
    await redis.connect();
    const entries = await new RedisCrmStore(redis).sessionEntries();
    const plan = buildLegacyMediaRescuePlan(entries);
    printLegacyMediaPlan(plan);
    if (commit) {
      const result = await executeLegacyMediaRescue(plan, {
        redis,
        storage: { headObject: headMediaObject, uploadObject: putMediaObject },
      }, { commit: true });
      console.log(`Resultado: ${JSON.stringify(result)}`);
    }
  } finally {
    try { await redis.quit(); } catch { redis.disconnect(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Resgate interrompido: ${error.message}`);
    process.exitCode = 1;
  });
}
