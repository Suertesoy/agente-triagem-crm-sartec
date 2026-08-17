import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildLegacyMediaRescuePlan,
  buildLegacyMediaStorageKey,
  decodeLegacyBase64,
  determineLegacyMime,
  executeLegacyMediaRescue,
  extractLegacyBase64,
  inspectLegacyMediaMessage,
} from "../scripts/rescue-legacy-media-to-r2.js";

const PHONE = "5512999990000";
const SESSION_KEY = `sartec:${PHONE}`;
const BINARY = Buffer.from("mídia legada de teste", "utf8");
const BASE64 = BINARY.toString("base64");

function legacyMessage(overrides = {}) {
  return {
    role: "user",
    content: "[arquivo]",
    createdAt: "2026-08-17T12:00:00.000Z",
    metaMessageId: "wamid.legacy-media",
    messageType: "document",
    mediaType: "document",
    mediaMimeType: "application/pdf",
    mediaFilename: "arquivo.pdf",
    mediaData: BASE64,
    ...overrides,
  };
}

function sessionEntries(message = legacyMessage()) {
  return [{
    key: SESSION_KEY,
    exists: true,
    value: { status: "ativo", history: [message] },
    error: null,
  }];
}

class FakeRedis {
  constructor(session) {
    this.data = new Map([[SESSION_KEY, JSON.stringify(session)]]);
    this.sessionWrites = 0;
    this.lockAttempts = [];
  }

  async get(key) {
    return this.data.get(key) ?? null;
  }

  async set(key, value, ...args) {
    if (args[0] === "NX") {
      this.lockAttempts.push(key);
      if (this.data.has(key)) return null;
      this.data.set(key, value);
      return "OK";
    }
    this.data.set(key, value);
    if (key === SESSION_KEY) this.sessionWrites += 1;
    return "OK";
  }

  async eval(_script, _keys, key, token) {
    if (this.data.get(key) === token) {
      this.data.delete(key);
      return 1;
    }
    return 0;
  }
}

class FakeStorage {
  constructor() {
    this.objects = new Map();
    this.uploadCalls = 0;
    this.onUpload = null;
  }

  async headObject(key) {
    const object = this.objects.get(key);
    if (!object) return { exists: false, size: null, mimeType: null, sha256: null };
    return {
      exists: true,
      size: object.buffer.length,
      mimeType: object.mimeType,
      sha256: object.sha256,
    };
  }

  async uploadObject({ storageKey, buffer, mimeType, sha256 }) {
    this.uploadCalls += 1;
    this.objects.set(storageKey, { buffer: Buffer.from(buffer), mimeType, sha256 });
    if (this.onUpload) await this.onUpload();
  }
}

function executionFixture(message = legacyMessage()) {
  const session = { status: "ativo", history: [structuredClone(message)] };
  const redis = new FakeRedis(session);
  const storage = new FakeStorage();
  const plan = buildLegacyMediaRescuePlan(sessionEntries(message));
  return { session, redis, storage, plan };
}

test("dry-run nunca consulta upload nem escreve no Redis", async () => {
  const { redis, storage, plan } = executionFixture();
  const before = await redis.get(SESSION_KEY);
  const result = await executeLegacyMediaRescue(plan, { redis, storage }, { commit: false });
  assert.equal(result.mode, "DRY RUN");
  assert.equal(storage.uploadCalls, 0);
  assert.equal(redis.sessionWrites, 0);
  assert.equal(await redis.get(SESSION_KEY), before);
});

test("chave R2 legada é determinística e depende do hash", () => {
  const sha256 = createHash("sha256").update(BINARY).digest("hex");
  const input = {
    phone: PHONE,
    legacyHistoryIndex: 4,
    metaMessageId: "wamid:unsafe/id",
    sha256,
    extension: "pdf",
  };
  assert.equal(buildLegacyMediaStorageKey(input), buildLegacyMediaStorageKey({ ...input }));
  assert.match(buildLegacyMediaStorageKey(input), /^media\/5512999990000\/legacy\/wamid_unsafe_id-[a-f0-9]{16}\.pdf$/);
  assert.notEqual(
    buildLegacyMediaStorageKey(input),
    buildLegacyMediaStorageKey({ ...input, sha256: "f".repeat(64) })
  );
});

test("objeto já existente e validado é reutilizado sem upload duplicado", async () => {
  const { redis, storage, plan } = executionFixture();
  const item = plan.items[0];
  storage.objects.set(item.storageKey, {
    buffer: Buffer.from(BINARY),
    mimeType: item.resolvedMimeType,
    sha256: item.sha256,
  });
  const result = await executeLegacyMediaRescue(plan, { redis, storage }, { commit: true });
  assert.equal(result.reused, 1);
  assert.equal(storage.uploadCalls, 0);
  assert.equal(result.redisUpdated, 1);
});

test("hash é preservado antes/depois e base64 continua no Redis", async () => {
  const { redis, storage, plan } = executionFixture();
  const item = plan.items[0];
  await executeLegacyMediaRescue(plan, { redis, storage }, { commit: true });
  const saved = JSON.parse(await redis.get(SESSION_KEY)).history[0];
  const decodedAfter = decodeLegacyBase64(saved.mediaData).buffer;
  assert.equal(createHash("sha256").update(decodedAfter).digest("hex"), item.sha256);
  assert.equal(saved.mediaData, BASE64);
  assert.equal(saved.mediaStorageProvider, "cloudflare-r2");
  assert.equal(saved.mediaStorageKey, item.storageKey);
  assert.equal(saved.mediaSize, BINARY.length);
});

test("mensagem já migrada para R2 é ignorada no planejamento", () => {
  const plan = buildLegacyMediaRescuePlan(sessionEntries(legacyMessage({
    mediaStorageProvider: "cloudflare-r2",
    mediaStorageKey: "media/existing.pdf",
  })));
  assert.equal(plan.items.length, 0);
});

test("mensagem alterada depois do planejamento é recusada antes do upload", async () => {
  const { redis, storage, plan } = executionFixture();
  const changed = JSON.parse(await redis.get(SESSION_KEY));
  changed.history[0].mediaData = Buffer.from("conteúdo alterado").toString("base64");
  await redis.set(SESSION_KEY, JSON.stringify(changed));
  redis.sessionWrites = 0;
  await assert.rejects(
    executeLegacyMediaRescue(plan, { redis, storage }, { commit: true }),
    /índice\/SHA|Meta ID/
  );
  assert.equal(storage.uploadCalls, 0);
  assert.equal(redis.sessionWrites, 0);
});

test("lock e releitura preservam uma sessão atualizada durante o upload", async () => {
  const { redis, storage, plan } = executionFixture();
  storage.onUpload = async () => {
    const newer = JSON.parse(await redis.get(SESSION_KEY));
    newer.concurrentField = "preservado";
    newer.history.push({ role: "user", content: "mensagem concorrente" });
    await redis.set(SESSION_KEY, JSON.stringify(newer));
  };
  await executeLegacyMediaRescue(plan, { redis, storage }, { commit: true });
  const saved = JSON.parse(await redis.get(SESSION_KEY));
  assert.equal(saved.concurrentField, "preservado");
  assert.equal(saved.history.length, 2);
  assert.ok(redis.lockAttempts.every((key) => key === `lock:sartec:${PHONE}`));
  assert.ok(redis.lockAttempts.length >= 2);
});

test("referência R2 que aparece durante o upload nunca é sobrescrita", async () => {
  const { redis, storage, plan } = executionFixture();
  storage.onUpload = async () => {
    const concurrent = JSON.parse(await redis.get(SESSION_KEY));
    concurrent.history[0].mediaStorageProvider = "cloudflare-r2";
    concurrent.history[0].mediaStorageKey = "media/concurrent/reference.pdf";
    await redis.set(SESSION_KEY, JSON.stringify(concurrent));
  };
  const result = await executeLegacyMediaRescue(plan, { redis, storage }, { commit: true });
  const saved = JSON.parse(await redis.get(SESSION_KEY)).history[0];
  assert.equal(saved.mediaStorageKey, "media/concurrent/reference.pdf");
  assert.equal(result.redisUpdated, 0);
  assert.equal(result.skipped, 1);
});

test("reexecução após atualização Redis não duplica upload", async () => {
  const { redis, storage, plan } = executionFixture();
  await executeLegacyMediaRescue(plan, { redis, storage }, { commit: true });
  const firstUploads = storage.uploadCalls;
  const result = await executeLegacyMediaRescue(plan, { redis, storage }, { commit: true });
  assert.equal(storage.uploadCalls, firstUploads);
  assert.equal(result.skipped, 1);
});

test("MIME e extensão segura são determinados por data URL ou filename", () => {
  const pdf = Buffer.from("%PDF-1.7 teste").toString("base64");
  const message = legacyMessage({
    mediaMimeType: null,
    mediaFilename: null,
    mediaData: `data:application/pdf;base64,${pdf}`,
  });
  const extracted = extractLegacyBase64(message);
  const decoded = decodeLegacyBase64(extracted.encoded);
  assert.deepEqual(
    determineLegacyMime(message, extracted, decoded.declaredMime),
    { mimeType: "application/pdf", extension: "pdf", safeExtension: true }
  );
  const inspected = inspectLegacyMediaMessage({ phone: PHONE, legacyHistoryIndex: 0, message });
  assert.equal(inspected.group, "document");
  assert.equal(inspected.safeExtension, true);
  const plan = buildLegacyMediaRescuePlan(sessionEntries(message));
  assert.deepEqual(plan.counters.groups.document, { messages: 1, bytes: Buffer.from(pdf, "base64").length });
});

test("base64 inválido bloqueia a operação real sem tocar R2/Redis", async () => {
  const invalid = legacyMessage({ mediaData: "***base64 inválido***" });
  const { redis, storage, plan } = executionFixture(invalid);
  assert.equal(plan.items[0].valid, false);
  await assert.rejects(
    executeLegacyMediaRescue(plan, { redis, storage }, { commit: true }),
    /base64 inválido/
  );
  assert.equal(storage.uploadCalls, 0);
  assert.equal(redis.sessionWrites, 0);
});
