import {
  SHADOW_OUTBOX_INDEX_KEY,
  createShadowOutboxItem,
  shadowEntityMember,
  shadowOutboxKey,
} from "./redis-outbox.js";

export const SHADOW_REVISION_KEY = "crm-shadow:revision";

export const SHADOW_ATOMIC_COMMIT_SCRIPT = `-- crm-shadow:commit-v1
local revision = redis.call('incr', KEYS[1])
if ARGV[3] == 'keep' then
  redis.call('set', KEYS[2], ARGV[1], 'keepttl')
elseif ARGV[3] ~= '' then
  redis.call('set', KEYS[2], ARGV[1], 'ex', tonumber(ARGV[3]))
else
  redis.call('set', KEYS[2], ARGV[1])
end
redis.call('set', KEYS[3], tostring(revision))
local item = cjson.decode(ARGV[2])
item.shadowRevision = revision
redis.call('set', KEYS[4], cjson.encode(item))
redis.call('sadd', KEYS[5], ARGV[4])
return revision`;

export function shadowEntityRevisionKey(entityType, entityKey) {
  return `crm-shadow:entity-revision:${shadowEntityMember(entityType, entityKey)}`;
}

export async function readShadowEntityRevision(redis, entityType, entityKey) {
  const raw = await redis.get(shadowEntityRevisionKey(entityType, entityKey));
  const revision = Number(raw);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export async function commitAtomicShadowMutation(redis, {
  operationalKey,
  operationalValue,
  entityType,
  entityKey,
  payload,
  ttlSeconds = null,
  keepTtl = false,
  createdAt,
}) {
  if (!operationalKey) throw new Error("Chave Redis operacional é obrigatória");
  if (ttlSeconds != null && (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
    throw new Error("TTL operacional deve ser um inteiro positivo");
  }
  const item = createShadowOutboxItem({ entityType, entityKey, payload, createdAt });
  const member = shadowEntityMember(entityType, entityKey);
  const ttlArg = keepTtl ? "keep" : (ttlSeconds == null ? "" : String(ttlSeconds));
  const revision = await redis.eval(
    SHADOW_ATOMIC_COMMIT_SCRIPT,
    5,
    SHADOW_REVISION_KEY,
    operationalKey,
    shadowEntityRevisionKey(entityType, entityKey),
    shadowOutboxKey(entityType, entityKey),
    SHADOW_OUTBOX_INDEX_KEY,
    String(operationalValue),
    JSON.stringify(item),
    ttlArg,
    member
  );
  return { ...item, shadowRevision: Number(revision) };
}
