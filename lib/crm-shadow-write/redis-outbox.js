const ENTITY_TYPES = new Set(["customer", "conversation", "message", "pipeline", "setting"]);

export const SHADOW_OUTBOX_INDEX_KEY = "crm-shadow:outbox:index";
export const SHADOW_OUTBOX_REMOVE_SCRIPT = `-- crm-shadow:remove-v1
local raw = redis.call('get', KEYS[1])
if not raw then
  redis.call('srem', KEYS[2], ARGV[2])
  return 0
end
local item = cjson.decode(raw)
if tostring(item.shadowRevision) ~= ARGV[1] then return 0 end
redis.call('del', KEYS[1])
redis.call('srem', KEYS[2], ARGV[2])
return 1`;

export const SHADOW_OUTBOX_FAILURE_SCRIPT = `-- crm-shadow:failure-v1
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local item = cjson.decode(raw)
if tostring(item.shadowRevision) ~= ARGV[1] then return 0 end
item.attempts = (item.attempts or 0) + 1
item.lastError = ARGV[2]
redis.call('set', KEYS[1], cjson.encode(item))
return 1`;

export function assertShadowEntityType(entityType) {
  if (!ENTITY_TYPES.has(entityType)) throw new Error(`Tipo de entidade shadow inválido: ${entityType}`);
  return entityType;
}

export function shadowEntityMember(entityType, entityKey) {
  assertShadowEntityType(entityType);
  if (entityKey == null || entityKey === "") throw new Error("Chave da entidade shadow é obrigatória");
  return `${entityType}:${encodeURIComponent(String(entityKey))}`;
}

export function shadowOutboxKey(entityType, entityKey) {
  return `crm-shadow:outbox:${shadowEntityMember(entityType, entityKey)}`;
}

function inspectSanitized(value, path = "payload") {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    throw new Error(`${path} contém blob/binário`);
  }
  if (typeof value === "string") {
    if (/^data:[^;]+;base64,/i.test(value) || (value.length > 256 && /^[a-z0-9+/=\r\n]+$/i.test(value))) {
      throw new Error(`${path} contém base64`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectSanitized(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/(mediaData|base64|blob|secret|token|password|authorization)/i.test(key)) {
      throw new Error(`${path}.${key} não pode ser persistido na outbox`);
    }
    if (key === "data" && path.endsWith(".source")) {
      throw new Error(`${path}.data não pode ser persistido na outbox`);
    }
    inspectSanitized(item, `${path}.${key}`);
  }
}

export function assertSanitizedShadowPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload shadow deve ser um objeto mapeado");
  }
  inspectSanitized(payload);
  return payload;
}

export function createShadowOutboxItem({
  entityType,
  entityKey,
  payload,
  shadowRevision = 0,
  createdAt = new Date().toISOString(),
  attempts = 0,
  lastError = null,
}) {
  assertShadowEntityType(entityType);
  assertSanitizedShadowPayload(payload);
  return {
    entityType,
    entityKey: String(entityKey),
    shadowRevision,
    payload: structuredClone(payload),
    createdAt,
    attempts,
    lastError,
  };
}

export function summarizeShadowError(error) {
  const message = String(error?.message || error || "erro desconhecido")
    .replace(/\b\d{8,15}\b/g, "[redacted]")
    .replace(/(bearer|token|secret|password)\s*[:=]?\s*\S+/gi, "$1=[redacted]")
    .slice(0, 160);
  return `${error?.code ? `${error.code}: ` : ""}${message}`;
}

export async function enqueueShadowReceipt(redis, item) {
  const safe = createShadowOutboxItem(item);
  const member = shadowEntityMember(safe.entityType, safe.entityKey);
  await redis.set(shadowOutboxKey(safe.entityType, safe.entityKey), JSON.stringify(safe));
  await redis.sadd(SHADOW_OUTBOX_INDEX_KEY, member);
  return safe;
}

export async function listShadowOutbox(redis, { limit = 100 } = {}) {
  const members = (await redis.smembers(SHADOW_OUTBOX_INDEX_KEY)).sort().slice(0, limit);
  const items = [];
  for (const member of members) {
    const raw = await redis.get(`crm-shadow:outbox:${member}`);
    if (!raw) {
      await redis.srem(SHADOW_OUTBOX_INDEX_KEY, member);
      continue;
    }
    items.push(JSON.parse(raw));
  }
  return items;
}

export async function removeShadowReceiptCas(redis, receipt) {
  const member = shadowEntityMember(receipt.entityType, receipt.entityKey);
  return redis.eval(
    SHADOW_OUTBOX_REMOVE_SCRIPT,
    2,
    shadowOutboxKey(receipt.entityType, receipt.entityKey),
    SHADOW_OUTBOX_INDEX_KEY,
    String(receipt.shadowRevision),
    member
  );
}

export async function recordShadowFailureCas(redis, receipt, error) {
  return redis.eval(
    SHADOW_OUTBOX_FAILURE_SCRIPT,
    1,
    shadowOutboxKey(receipt.entityType, receipt.entityKey),
    String(receipt.shadowRevision),
    summarizeShadowError(error)
  );
}
