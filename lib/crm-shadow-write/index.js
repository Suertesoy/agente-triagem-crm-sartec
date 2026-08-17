import {
  mapHistoryMessage,
  mapLiveConversation,
  mapLiveCustomer,
} from "../crm-store/index.js";
import { SupabaseCrmStore } from "../crm-store/supabase-store.js";
import { getCrmShadowFlags, getCrmShadowTimeoutMs } from "./flags.js";
import { commitAtomicShadowMutation } from "./revision.js";
import { assertSanitizedShadowPayload } from "./redis-outbox.js";
import {
  drainShadowOutbox as drainOutbox,
  flushShadowReceipt as flushReceipt,
} from "./reconciler.js";

function mapShadowPayload(entityType, input) {
  if (entityType === "customer") return mapLiveCustomer(input.phone, input.contact).customer;
  if (entityType === "conversation") return mapLiveConversation(input.phone, input.session).conversation;
  if (entityType === "message") {
    return mapHistoryMessage({
      phone: input.phone,
      conversationId: input.conversationId,
      message: input.message,
      legacyHistoryIndex: input.legacyHistoryIndex,
    }).message;
  }
  if (entityType === "pipeline") return structuredClone(input.row);
  if (entityType === "setting") return { key: String(input.key), value: structuredClone(input.value) };
  throw new Error(`Tipo de entidade shadow inválido: ${entityType}`);
}

export async function commitShadowReceipt({
  redis,
  operationalKey,
  operationalValue,
  entityType,
  entityKey,
  input,
  ttlSeconds,
  keepTtl,
  env = process.env,
  logger = console,
}) {
  const flags = getCrmShadowFlags(env, logger);
  if (!flags.dualWriteEnabled) {
    return { committed: false, fallbackRequired: true, reason: "disabled" };
  }
  let payload;
  try {
    payload = mapShadowPayload(entityType, input);
    assertSanitizedShadowPayload(payload);
  } catch (error) {
    logger?.warn?.("[crm-shadow] payload recusado; operação deve usar o SET Redis normal.");
    return { committed: false, fallbackRequired: true, reason: "payload_invalid", error };
  }
  const receipt = await commitAtomicShadowMutation(redis, {
    operationalKey,
    operationalValue,
    entityType,
    entityKey,
    payload,
    ttlSeconds,
    keepTtl,
  });
  return { committed: true, fallbackRequired: false, receipt };
}

export async function flushShadowReceipt({
  redis,
  receipt,
  store,
  env = process.env,
  logger = console,
}) {
  const flags = getCrmShadowFlags(env, logger);
  if (!flags.crmEnabled || !flags.valid) return { status: "disabled", removed: false };
  return flushReceipt({
    redis,
    receipt,
    store: store || new SupabaseCrmStore(),
    timeoutMs: getCrmShadowTimeoutMs(env, logger),
  });
}

export async function drainShadowOutbox({
  redis,
  store,
  batchSize,
  env = process.env,
  logger = console,
}) {
  const flags = getCrmShadowFlags(env, logger);
  if (!flags.crmEnabled || !flags.valid) {
    return { scanned: 0, applied: 0, staleIgnored: 0, failed: 0, removed: 0, disabled: true };
  }
  return drainOutbox({
    redis,
    store: store || new SupabaseCrmStore(),
    timeoutMs: getCrmShadowTimeoutMs(env, logger),
    batchSize,
    logger,
  });
}

export { getCrmShadowFlags, getCrmShadowTimeoutMs } from "./flags.js";
export * from "./redis-outbox.js";
export * from "./revision.js";
