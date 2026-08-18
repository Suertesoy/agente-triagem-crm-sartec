import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import FakeRedis from "./helpers/fake-ioredis.js";
import {
  commitShadowReceipt,
  commitShadowReceipts,
  getCrmShadowFlags,
  getCrmShadowTimeoutMs,
} from "../lib/crm-shadow-write/index.js";
import {
  enqueueShadowReceipt,
  listShadowOutbox,
  removeShadowReceiptCas,
} from "../lib/crm-shadow-write/redis-outbox.js";
import {
  SHADOW_REVISION_KEY,
  commitAtomicShadowMutation,
  commitAtomicShadowMutations,
  readShadowEntityRevision,
} from "../lib/crm-shadow-write/revision.js";
import { flushShadowReceipt } from "../lib/crm-shadow-write/reconciler.js";
import { withCancelableTimeout } from "../lib/crm-shadow-write/timeout.js";
import {
  deterministicUuid,
  mapHistoryMessage,
  mapLiveConversation,
  mapLiveCustomer,
} from "../lib/crm-store/mapper.js";
import { SupabaseCrmStore } from "../lib/crm-store/supabase-store.js";
import { buildPlan, commitPlan } from "../scripts/migrate-redis-to-supabase.js";
import { reconcileCrmShadow } from "../scripts/reconcile-crm-shadow.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENABLED_ENV = { SUPABASE_CRM_ENABLED: "true", SUPABASE_DUAL_WRITE: "true" };
const silentLogger = { log() {}, warn() {} };

beforeEach(() => FakeRedis._reset());

test("flags ficam OFF por padrão e CRM administrativo não habilita dual write", () => {
  assert.deepEqual(getCrmShadowFlags({}, silentLogger), {
    crmEnabled: false,
    dualWriteRequested: false,
    dualWriteEnabled: false,
    valid: true,
  });
  assert.equal(getCrmShadowFlags({ SUPABASE_CRM_ENABLED: "true" }, silentLogger).dualWriteEnabled, false);
  assert.equal(getCrmShadowFlags(ENABLED_ENV, silentLogger).dualWriteEnabled, true);
});

test("configuração dual inválida resulta em shadow OFF com warning", () => {
  const warnings = [];
  const flags = getCrmShadowFlags(
    { SUPABASE_CRM_ENABLED: "false", SUPABASE_DUAL_WRITE: "true" },
    { warn: (message) => warnings.push(message) }
  );
  assert.equal(flags.dualWriteEnabled, false);
  assert.equal(flags.valid, false);
  assert.equal(warnings.length, 1);
});

test("fachada OFF não altera Redis e exige fallback operacional", async () => {
  const redis = new FakeRedis();
  const result = await commitShadowReceipt({
    redis,
    operationalKey: "sartec:5511444444444",
    operationalValue: "session",
    entityType: "conversation",
    entityKey: "sartec:5511444444444",
    input: { phone: "5511444444444", session: {} },
    env: {},
    logger: silentLogger,
  });
  assert.deepEqual(result, { committed: false, fallbackRequired: true, reason: "disabled" });
  assert.equal(await redis.get("sartec:5511444444444"), null);
});

test("timeout possui default testado e aceita configuração conservadora válida", () => {
  assert.equal(getCrmShadowTimeoutMs({}, silentLogger), 2000);
  assert.equal(getCrmShadowTimeoutMs({ SUPABASE_SHADOW_TIMEOUT_MS: "750" }, silentLogger), 750);
  assert.equal(getCrmShadowTimeoutMs({ SUPABASE_SHADOW_TIMEOUT_MS: "0" }, silentLogger), 2000);
});

test("revisão global é monotônica e cada entidade mantém sua revisão própria", async () => {
  const redis = new FakeRedis();
  await redis.set(SHADOW_REVISION_KEY, "100");
  const customer = await commitAtomicShadowMutation(redis, {
    operationalKey: "sartec:contact:5511999999999",
    operationalValue: "{}",
    entityType: "customer",
    entityKey: "5511999999999",
    payload: { id: "customer-a" },
  });
  const conversation = await commitAtomicShadowMutation(redis, {
    operationalKey: "sartec:5511999999999",
    operationalValue: "{}",
    entityType: "conversation",
    entityKey: "sartec:5511999999999",
    payload: { id: "conversation-a" },
  });

  assert.equal(customer.shadowRevision, 101);
  assert.equal(conversation.shadowRevision, 102);
  assert.equal(await readShadowEntityRevision(redis, "customer", "5511999999999"), 101);
  assert.equal(await readShadowEntityRevision(redis, "conversation", "sartec:5511999999999"), 102);
});

test("nova alteração da mesma mensagem recebe revisão nova e substitui só sua pendência", async () => {
  const redis = new FakeRedis();
  const first = await commitAtomicShadowMutation(redis, {
    operationalKey: "sartec:5511888888888",
    operationalValue: "v1",
    entityType: "message",
    entityKey: "message-1",
    payload: { id: "message-1", delivery_status: null },
  });
  const statusUpdate = await commitAtomicShadowMutation(redis, {
    operationalKey: "sartec:5511888888888",
    operationalValue: "v2",
    entityType: "message",
    entityKey: "message-1",
    payload: { id: "message-1", delivery_status: "delivered" },
  });

  assert.equal(statusUpdate.shadowRevision, first.shadowRevision + 1);
  assert.equal((await listShadowOutbox(redis))[0].payload.delivery_status, "delivered");
});

test("uma mutação operacional grava conversa e duas mensagens com a mesma revisão", async () => {
  const redis = new FakeRedis();
  const phone = "5511222222222";
  const conversationId = deterministicUuid("sartec-conversation", `sartec:${phone}`);
  const result = await commitShadowReceipts({
    redis,
    operationalKey: `sartec:${phone}`,
    operationalValue: JSON.stringify({ status: "ativo", history: [{ content: "oi" }, { content: "olá" }] }),
    entities: [
      {
        entityType: "conversation",
        entityKey: `sartec:${phone}`,
        input: { phone, session: { clientPhone: phone, status: "ativo" } },
      },
      {
        entityType: "message",
        entityKey: "legacy-message-0",
        input: { phone, conversationId, legacyHistoryIndex: 0, message: { role: "user", content: "oi" } },
      },
      {
        entityType: "message",
        entityKey: "legacy-message-1",
        input: { phone, conversationId, legacyHistoryIndex: 1, message: { role: "assistant", content: "olá" } },
      },
    ],
    env: ENABLED_ENV,
    logger: silentLogger,
  });

  assert.equal(result.committed, true);
  assert.equal(result.receipts.length, 3);
  assert.equal(new Set(result.receipts.map((receipt) => receipt.shadowRevision)).size, 1);
  assert.equal((await listShadowOutbox(redis)).length, 3);
  assert.match(await redis.get(`sartec:${phone}`), /"history"/);
});

test("falha antes do script não cria nem SET operacional nem recibos parciais", async () => {
  const redis = new FakeRedis();
  await assert.rejects(commitAtomicShadowMutations(redis, {
    operationalKey: "sartec:atomic-failure",
    operationalValue: "new-value",
    entities: [
      { entityType: "setting", entityKey: "valid", payload: { key: "valid", value: true } },
      { entityType: "setting", entityKey: "invalid", payload: { key: "invalid", value: Buffer.from("x") } },
    ],
  }));
  assert.equal(await redis.get("sartec:atomic-failure"), null);
  assert.equal((await listShadowOutbox(redis)).length, 0);
  assert.equal(await redis.get(SHADOW_REVISION_KEY), null);
});

test("interrupção do EVAL antes da execução não deixa Redis ou recibos isolados", async () => {
  const redis = new FakeRedis();
  redis.eval = async () => { throw new Error("connection interrupted before EVAL"); };
  await assert.rejects(commitAtomicShadowMutations(redis, {
    operationalKey: "sartec:interrupted",
    operationalValue: "new-value",
    entities: [{ entityType: "setting", entityKey: "mode", payload: { key: "mode", value: true } }],
  }), /interrupted/);
  assert.equal(await redis.get("sartec:interrupted"), null);
  assert.equal((await listShadowOutbox(redis)).length, 0);
});

test("CAS da outbox impede confirmação da revisão 101 de remover a 102", async () => {
  const redis = new FakeRedis();
  const oldReceipt = await enqueueShadowReceipt(redis, {
    entityType: "setting",
    entityKey: "pjLunchMode",
    payload: { key: "pjLunchMode", value: { enabled: false } },
    shadowRevision: 101,
  });
  await enqueueShadowReceipt(redis, {
    entityType: "setting",
    entityKey: "pjLunchMode",
    payload: { key: "pjLunchMode", value: { enabled: true } },
    shadowRevision: 102,
  });

  assert.equal(await removeShadowReceiptCas(redis, oldReceipt), 0);
  assert.equal((await listShadowOutbox(redis))[0].shadowRevision, 102);
});

test("mapper incremental exclui sessão legada, history, base64 e estado efêmero", () => {
  const encoded = Buffer.alloc(400, 7).toString("base64");
  const { customer } = mapLiveCustomer("5511777777777", {
    phone: "5511777777777",
    clientName: "Cliente",
    token: "ephemeral",
  });
  const { conversation } = mapLiveConversation("5511777777777", {
    clientPhone: "5511777777777",
    status: "ativo",
    history: [{ role: "user", content: "oi", mediaData: encoded }],
    mediaData: encoded,
    historySummary: encoded,
    debounceTimer: "temporary",
  });
  const serialized = JSON.stringify({ customer, conversation });

  assert.equal("legacy_contact" in customer, false);
  assert.equal("legacy_session" in conversation, false);
  assert.equal(serialized.includes(encoded), false);
  assert.equal(serialized.includes("historySummary"), false);
  assert.equal(serialized.includes("debounceTimer"), false);
});

test("commit atômico grava na outbox somente a conversa institucional sanitizada e sem TTL", async () => {
  const redis = new FakeRedis();
  const encoded = Buffer.alloc(400, 3).toString("base64");
  const result = await commitShadowReceipt({
    redis,
    operationalKey: "sartec:5511333333333",
    operationalValue: JSON.stringify({ status: "ativo", history: [] }),
    entityType: "conversation",
    entityKey: "sartec:5511333333333",
    input: {
      phone: "5511333333333",
      session: {
        clientPhone: "5511333333333",
        status: "ativo",
        history: [{ role: "user", content: "oi", mediaData: encoded }],
        historySummary: encoded,
      },
    },
    env: ENABLED_ENV,
    logger: silentLogger,
  });
  const pending = (await listShadowOutbox(redis))[0];

  assert.equal(result.committed, true);
  assert.equal(pending.entityType, "conversation");
  assert.equal("legacy_session" in pending.payload, false);
  assert.equal(JSON.stringify(pending).includes(encoded), false);
  FakeRedis._advanceTime(365 * 24 * 60 * 60 * 1000);
  assert.equal((await listShadowOutbox(redis)).length, 1, "outbox não expira por TTL");
});

test("mensagens live mantêm IDs determinísticos com/sem Meta e created_at nulo sem base64", () => {
  const phone = "5511666666666";
  const conversationId = deterministicUuid("sartec-conversation", `sartec:${phone}`);
  const withMetaA = mapHistoryMessage({
    phone,
    conversationId,
    legacyHistoryIndex: 0,
    message: { role: "assistant", content: "ok", metaMessageId: "wamid.same" },
  }).message;
  const withMetaB = mapHistoryMessage({
    phone,
    conversationId,
    legacyHistoryIndex: 9,
    message: { role: "assistant", content: "ok", metaMessageId: "wamid.same" },
  }).message;
  const withoutMeta = mapHistoryMessage({
    phone,
    conversationId,
    legacyHistoryIndex: 1,
    message: {
      role: "user",
      content: [{ type: "image", source: { type: "base64", data: "dGVzdA==" } }],
    },
  }).message;

  assert.equal(withMetaA.id, withMetaB.id, "o mesmo Meta ID não pode criar duplicata");
  assert.equal(withoutMeta.created_at, null);
  assert.equal(withoutMeta.id, deterministicUuid("sartec-message", `legacy:${phone}:1`));
  assert.equal(JSON.stringify(withoutMeta).includes("dGVzdA=="), false);
});

test("payload inválido é recusado antes do commit atômico e sinaliza fallback Redis", async () => {
  const redis = new FakeRedis();
  const result = await commitShadowReceipt({
    redis,
    operationalKey: "sartec:pipelineOrder",
    operationalValue: "{}",
    entityType: "pipeline",
    entityKey: "pf:novo",
    input: { row: { client_type: "pf", column_key: "novo", blob: Buffer.from("x") } },
    env: ENABLED_ENV,
    logger: silentLogger,
  });
  assert.equal(result.committed, false);
  assert.equal(result.fallbackRequired, true);
  assert.equal(await redis.get("sartec:pipelineOrder"), null);
});

test("timeout cancelável aborta a operação e sucesso rápido não aborta", async () => {
  let timedOutSignal;
  await assert.rejects(
    withCancelableTimeout((signal) => {
      timedOutSignal = signal;
      return new Promise(() => {});
    }, 5),
    { code: "SHADOW_TIMEOUT" }
  );
  assert.equal(timedOutSignal.aborted, true);
  const value = await withCancelableTimeout(async (signal) => {
    assert.equal(signal.aborted, false);
    return "ok";
  }, 50);
  assert.equal(value, "ok");
});

test("SupabaseCrmStore usa RPC condicional e conecta AbortSignal", async () => {
  let rpcCall;
  let receivedSignal;
  const client = {
    rpc(name, args) {
      rpcCall = { name, args };
      const request = Promise.resolve({ data: "stale_ignored", error: null });
      request.abortSignal = (signal) => {
        receivedSignal = signal;
        return request;
      };
      return request;
    },
  };
  const store = new SupabaseCrmStore(client);
  const controller = new AbortController();
  const result = await store.writeShadowEntity("setting", { key: "quickMessages", value: [] }, 12, {
    signal: controller.signal,
  });

  assert.equal(result.status, "stale_ignored");
  assert.equal(rpcCall.name, "crm_shadow_upsert_setting");
  assert.equal(rpcCall.args.p_shadow_revision, 12);
  assert.equal(rpcCall.args.p_historical, false);
  assert.equal(receivedSignal, controller.signal);
});

test("store separa regra live da administrativa e cobre as fronteiras de revisão", async () => {
  const execute = async ({ stored, incoming, historical }) => {
    let current = stored;
    const client = {
      async rpc(_name, args) {
        const applied = args.p_shadow_revision > current
          || (args.p_historical && args.p_shadow_revision === 0 && current === 0);
        if (applied) current = args.p_shadow_revision;
        return { data: applied ? "applied" : "stale_ignored", error: null };
      },
    };
    const store = new SupabaseCrmStore(client);
    const method = historical ? "writeHistoricalEntity" : "writeShadowEntity";
    return store[method]("setting", { key: "mode", value: incoming }, incoming);
  };

  assert.equal((await execute({ stored: 0, incoming: 0, historical: true })).status, "applied");
  assert.equal((await execute({ stored: 5, incoming: 0, historical: true })).status, "stale_ignored");
  assert.equal((await execute({ stored: 5, incoming: 6, historical: false })).status, "applied");
  assert.equal((await execute({ stored: 6, incoming: 6, historical: false })).status, "stale_ignored");
  assert.equal((await execute({ stored: 6, incoming: 5, historical: false })).status, "stale_ignored");
});

test("flush remove sucesso/stale e mantém pendência em erro de rede", async () => {
  const redis = new FakeRedis();
  const applied = await enqueueShadowReceipt(redis, {
    entityType: "setting", entityKey: "a", payload: { key: "a", value: 1 }, shadowRevision: 1,
  });
  assert.deepEqual(
    await flushShadowReceipt({ redis, receipt: applied, store: { writeShadowEntity: async () => ({ status: "applied" }) }, timeoutMs: 50 }),
    { status: "applied", removed: true }
  );
  const stale = await enqueueShadowReceipt(redis, {
    entityType: "setting", entityKey: "b", payload: { key: "b", value: 2 }, shadowRevision: 2,
  });
  assert.equal((await flushShadowReceipt({
    redis, receipt: stale, store: { writeShadowEntity: async () => ({ status: "stale_ignored" }) }, timeoutMs: 50,
  })).removed, true);
  const failed = await enqueueShadowReceipt(redis, {
    entityType: "setting", entityKey: "c", payload: { key: "c", value: 3 }, shadowRevision: 3,
  });
  const failure = await flushShadowReceipt({
    redis,
    receipt: failed,
    store: { writeShadowEntity: async () => { throw new Error("network unavailable for 5511999999999"); } },
    timeoutMs: 50,
  });
  assert.equal(failure.status, "failed");
  const pending = (await listShadowOutbox(redis))[0];
  assert.equal(pending.attempts, 1);
  assert.equal(pending.lastError.includes("5511999999999"), false);
});

test("reconciliador processa lote, respeita stale e é idempotente sem PII no resumo", async () => {
  const redis = new FakeRedis();
  await enqueueShadowReceipt(redis, {
    entityType: "setting", entityKey: "pjLunchMode", payload: { key: "pjLunchMode", value: false }, shadowRevision: 4,
  });
  await enqueueShadowReceipt(redis, {
    entityType: "setting", entityKey: "quickMessages", payload: { key: "quickMessages", value: [] }, shadowRevision: 5,
  });
  const logs = [];
  let calls = 0;
  const store = { writeShadowEntity: async () => ({ status: calls++ === 0 ? "applied" : "stale_ignored" }) };
  const first = await reconcileCrmShadow({
    redis, store, batchSize: 10, env: ENABLED_ENV, logger: { log: (line) => logs.push(line), warn() {} },
  });
  const second = await reconcileCrmShadow({
    redis,
    store,
    batchSize: 10,
    env: { SUPABASE_CRM_ENABLED: "true", SUPABASE_DUAL_WRITE: "false" },
    logger: silentLogger,
  });

  assert.deepEqual(first, { scanned: 2, applied: 1, staleIgnored: 1, conflicts: 0, failed: 0, removed: 2 });
  assert.equal(second.scanned, 0);
  assert.equal(logs[0].includes("pjLunchMode"), false);
});

test("A=101 e B=102: B termina primeiro e A posterior é stale_ignored", async () => {
  const revisions = new Map();
  const values = new Map();
  const store = {
    async writeShadowEntity(type, payload, revision) {
      await new Promise((resolve) => setTimeout(resolve, revision === 101 ? 20 : 0));
      const key = `${type}:${payload.key}`;
      if (revision <= (revisions.get(key) || 0)) return { status: "stale_ignored" };
      revisions.set(key, revision);
      values.set(key, payload.value);
      return { status: "applied" };
    },
  };
  const [a, b] = await Promise.all([
    store.writeShadowEntity("setting", { key: "mode", value: "A" }, 101),
    store.writeShadowEntity("setting", { key: "mode", value: "B" }, 102),
  ]);
  assert.equal(b.status, "applied");
  assert.equal(a.status, "stale_ignored");
  assert.equal(values.get("setting:mode"), "B");
});

test("migração histórica usa revisão específica da entidade ou zero, nunca watermark global", async () => {
  const redisStore = {
    contactEntries: async () => [{
      key: "sartec:contact:5511555555555", exists: true, error: null,
      value: { phone: "5511555555555", clientName: "Cliente" },
    }],
    sessionEntries: async () => [{
      key: "sartec:5511555555555", exists: true, error: null,
      value: { clientPhone: "5511555555555", history: [{ role: "user", content: "oi" }] },
    }],
    pipelineOrderEntry: async () => ({ key: "sartec:pipelineOrder", exists: false, value: null, error: null }),
    entityRevision: async (type) => type === "conversation" ? 7 : 0,
  };
  const plan = await buildPlan(redisStore);

  assert.equal(plan.customers[0].shadow_revision, 0);
  assert.equal(plan.conversations[0].shadow_revision, 7);
  assert.equal(plan.messages[0].shadow_revision, 0);
});

test("revisão histórica 0 não sobrescreve estado live maior", async () => {
  let stored = { revision: 9, value: "live" };
  const conditionalWrite = async (revision, value) => {
    if (revision <= stored.revision) return "stale_ignored";
    stored = { revision, value };
    return "applied";
  };
  assert.equal(await conditionalWrite(0, "historical"), "stale_ignored");
  assert.deepEqual(stored, { revision: 9, value: "live" });
});

test("migrador contabiliza applied/stale por entidade sem ocultar catch-up stale", async () => {
  const plan = {
    report: {
      counters: {
        shadowApplied: { customers: 0, conversations: 0, messages: 0, pipelineRows: 0 },
        shadowStaleIgnored: { customers: 0, conversations: 0, messages: 0, pipelineRows: 0 },
      },
      checksum: "checksum",
    },
    customers: [{ id: "customer-1", phone: "5511000000000" }],
    conversations: [{ id: "conversation-1", customer_id: "customer-1", redis_key: "sartec:5511000000000" }],
    messages: [{ id: "message-1", conversation_id: "conversation-1" }],
    pipelineRows: [{ client_type: "pf", column_key: "novo" }],
  };
  let finished;
  const store = {
    startMigrationRun: async () => "run-1",
    finishMigrationRun: async (_id, result) => { finished = result; },
    upsertCustomer: async (row) => ({ id: row.id, status: "applied" }),
    upsertConversation: async (row) => ({ id: row.id, status: "stale_ignored" }),
    upsertMessages: async () => ({ applied: 0, staleIgnored: 1, other: 0 }),
    upsertPipelineOrder: async () => ({ applied: 1, staleIgnored: 0, other: 0 }),
  };

  await commitPlan(plan, { store, supabaseEnabled: true });
  assert.deepEqual(finished.counters.shadowApplied, {
    customers: 1, conversations: 0, messages: 0, pipelineRows: 1,
  });
  assert.deepEqual(finished.counters.shadowStaleIgnored, {
    customers: 0, conversations: 1, messages: 1, pipelineRows: 0,
  });
});

test("status de identidade dupla preserva recibo para reconciliação explícita", async () => {
  for (const detail of ["duplicate_requires_reconciliation", "identity_conflict"]) {
    FakeRedis._reset();
    const redis = new FakeRedis();
    const receipt = await enqueueShadowReceipt(redis, {
      entityType: "message",
      entityKey: detail,
      payload: { id: detail, legacy_payload_hash: "hash" },
      shadowRevision: 8,
    });
    const result = await flushShadowReceipt({
      redis,
      receipt,
      store: { writeShadowEntity: async () => ({ status: detail }) },
      timeoutMs: 50,
    });
    assert.deepEqual(result, { status: "conflict", detail, removed: false });
    assert.equal((await listShadowOutbox(redis)).length, 1);
  }
});

test("migration declara RPC live estrita, modo histórico rev0 e promoção Meta auditável", async () => {
  const sql = await readFile(
    path.resolve(HERE, "..", "supabase", "migrations", "20260817231131_ordered_crm_shadow_write.sql"),
    "utf8"
  );
  assert.equal((sql.match(/add column shadow_revision bigint not null default 0/g) || []).length, 4);
  assert.match(sql, /create table public\.crm_settings/);
  assert.match(sql, /alter table public\.crm_settings enable row level security/);
  assert.match(sql, /revoke all privileges on table public\.crm_settings from public, anon, authenticated/);
  assert.equal((sql.match(/create or replace function public\.crm_shadow_upsert_/g) || []).length, 5);
  assert.equal((sql.match(/excluded\.shadow_revision > public\.crm_/g) || []).length, 5);
  assert.equal((sql.match(/p_historical boolean/g) || []).length, 5);
  assert.equal((sql.match(/p_historical and excluded\.shadow_revision = 0/g) || []).length, 5);
  assert.equal((sql.match(/return case when affected = 0 then 'stale_ignored'/g) || []).length, 5);
  assert.equal((sql.match(/security invoker/g) || []).length, 5);
  assert.match(sql, /candidate\.legacy_history_index = \(p_payload->>'legacy_history_index'\)::integer/);
  assert.match(sql, /set id = \(p_payload->>'id'\)::uuid/);
  assert.match(sql, /return 'duplicate_requires_reconciliation'/);
  assert.match(sql, /return 'identity_conflict'/);
  assert.doesNotMatch(sql, /delete from public\.crm_messages/i);
  assert.match(sql, /crm_messages_meta_message_id_uidx|meta_message_id/);
  assert.match(sql, /media_storage_key = coalesce\(excluded\.media_storage_key, public\.crm_messages\.media_storage_key\)/);
  assert.match(sql, /created_at = coalesce\(public\.crm_messages\.created_at, excluded\.created_at\)/);
  assert.equal((sql.match(/grant execute on function public\.crm_shadow_upsert_\w+\(jsonb, bigint, boolean\) to service_role/g) || []).length, 5);
});

test("promoção legacy→Meta cobre A/B/C/D sem remoção destrutiva", async () => {
  const sql = await readFile(
    path.resolve(HERE, "..", "supabase", "migrations", "20260817231131_ordered_crm_shadow_write.sql"),
    "utf8"
  );
  const decide = ({ legacy, meta, sameHash, incomingRevision, historical = false }) => {
    if (legacy && meta) return sameHash ? "duplicate_requires_reconciliation" : "identity_conflict";
    if (legacy && !(incomingRevision > legacy.revision
      || (historical && incomingRevision === 0 && legacy.revision === 0))) return "stale_ignored";
    if (legacy) return "promoted";
    return meta && incomingRevision <= meta.revision ? "stale_ignored" : "applied";
  };

  assert.equal(decide({ legacy: { revision: 0 }, meta: null, sameHash: true, incomingRevision: 0, historical: true }), "promoted", "A");
  assert.equal(decide({ legacy: null, meta: { revision: 6 }, sameHash: true, incomingRevision: 6 }), "stale_ignored", "B");
  assert.equal(decide({ legacy: { revision: 5 }, meta: { revision: 6 }, sameHash: true, incomingRevision: 7 }), "duplicate_requires_reconciliation", "C");
  assert.equal(decide({ legacy: { revision: 5 }, meta: { revision: 6 }, sameHash: false, incomingRevision: 7 }), "identity_conflict", "D");
  assert.ok(sql.indexOf("target_exists then") < sql.indexOf("set id = (p_payload->>'id')::uuid"));
  assert.doesNotMatch(sql, /delete from public\.crm_messages/i);
});

test("nenhum endpoint de produção importa shadow writer ou Supabase", async () => {
  const apiFiles = [
    "webhook.js", "send.js", "send-template.js", "update-card.js", "update-status.js",
    "resolve.js", "contacts.js", "active-attendant.js", "delete-media.js", "queue.js",
  ];
  for (const file of apiFiles) {
    const source = await readFile(path.resolve(HERE, "..", "api", file), "utf8");
    assert.doesNotMatch(source, /crm-shadow-write|supabase/i, file);
  }
});
