import {
  SHADOW_OUTBOX_INDEX_KEY,
  createShadowOutboxItem,
  shadowEntityMember,
  shadowOutboxKey,
} from "./redis-outbox.js";

export const SHADOW_REVISION_KEY = "crm-shadow:revision";

export const SHADOW_ATOMIC_COMMIT_SCRIPT = `-- crm-shadow:commit-v2
local function key_type(key)
  local result = redis.call('type', key)
  if type(result) == 'table' then return result.ok end
  return result
end
local function require_type(key, expected)
  local actual = key_type(key)
  if actual ~= 'none' and actual ~= expected then
    error('unexpected redis type for ' .. key)
  end
end

local entity_count = tonumber(ARGV[3])
if not entity_count or entity_count < 1 then error('entity count must be positive') end
require_type(KEYS[1], 'string')
require_type(KEYS[2], 'string')
require_type(KEYS[3], 'set')
local current_revision = redis.call('get', KEYS[1])
if current_revision and not tonumber(current_revision) then error('global revision is not numeric') end
local items = {}
for index = 1, entity_count do
  local key_offset = 3 + ((index - 1) * 2)
  require_type(KEYS[key_offset + 1], 'string')
  require_type(KEYS[key_offset + 2], 'string')
  items[index] = cjson.decode(ARGV[3 + ((index - 1) * 2) + 1])
end

local revision = redis.call('incr', KEYS[1])
if ARGV[2] == 'keep' then
  redis.call('set', KEYS[2], ARGV[1], 'keepttl')
elseif ARGV[2] ~= '' then
  redis.call('set', KEYS[2], ARGV[1], 'ex', tonumber(ARGV[2]))
else
  redis.call('set', KEYS[2], ARGV[1])
end
for index = 1, entity_count do
  local key_offset = 3 + ((index - 1) * 2)
  local argv_offset = 3 + ((index - 1) * 2)
  local item = items[index]
  item.shadowRevision = revision
  redis.call('set', KEYS[key_offset + 1], tostring(revision))
  redis.call('set', KEYS[key_offset + 2], cjson.encode(item))
  redis.call('sadd', KEYS[3], ARGV[argv_offset + 2])
end
return revision`;

export function shadowEntityRevisionKey(entityType, entityKey) {
  return `crm-shadow:entity-revision:${shadowEntityMember(entityType, entityKey)}`;
}

export async function readShadowEntityRevision(redis, entityType, entityKey) {
  const raw = await redis.get(shadowEntityRevisionKey(entityType, entityKey));
  const revision = Number(raw);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export async function commitAtomicShadowMutations(redis, {
  operationalKey,
  operationalValue,
  entities,
  ttlSeconds = null,
  keepTtl = false,
  createdAt,
}) {
  if (!operationalKey) throw new Error("Chave Redis operacional é obrigatória");
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new Error("Ao menos uma entidade shadow é obrigatória");
  }
  if (ttlSeconds != null && (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0)) {
    throw new Error("TTL operacional deve ser um inteiro positivo");
  }
  const prepared = entities.map(({ entityType, entityKey, payload }) => {
    const item = createShadowOutboxItem({ entityType, entityKey, payload, createdAt });
    return { item, member: shadowEntityMember(entityType, entityKey) };
  });
  const ttlArg = keepTtl ? "keep" : (ttlSeconds == null ? "" : String(ttlSeconds));
  const keys = [SHADOW_REVISION_KEY, operationalKey, SHADOW_OUTBOX_INDEX_KEY];
  const args = [String(operationalValue), ttlArg, String(prepared.length)];
  for (const { item, member } of prepared) {
    keys.push(
      shadowEntityRevisionKey(item.entityType, item.entityKey),
      shadowOutboxKey(item.entityType, item.entityKey)
    );
    args.push(JSON.stringify(item), member);
  }
  const revision = await redis.eval(
    SHADOW_ATOMIC_COMMIT_SCRIPT,
    keys.length,
    ...keys,
    ...args
  );
  return prepared.map(({ item }) => ({ ...item, shadowRevision: Number(revision) }));
}

export async function commitAtomicShadowMutation(redis, options) {
  const receipts = await commitAtomicShadowMutations(redis, {
    ...options,
    entities: [{
      entityType: options.entityType,
      entityKey: options.entityKey,
      payload: options.payload,
    }],
  });
  return receipts[0];
}
