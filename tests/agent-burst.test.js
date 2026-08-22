// Testes unitários de lib/agent-burst.js — estado puro em Redis (generation,
// firstMessageAt/lastMessageAt/dueAt). Não depende do webhook nem de tempo
// real: scheduleBurst aceita `now` explícito, então os testes são determinísticos.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const { scheduleBurst, getBurstRecord, clearBurst, getPendingBurstPhones, getBurstConfig } =
  await import(pathToFileURL(path.join(REPO_ROOT, "lib", "agent-burst.js")).href);
const FakeRedis = (await import(pathToFileURL(path.join(HERE, "helpers", "fake-ioredis.js")).href)).default;

describe("lib/agent-burst.js", () => {
  let redis;

  before(() => {
    redis = new FakeRedis();
  });
  after(() => {
    delete process.env.AGENT_BURST_QUIET_MS;
    delete process.env.AGENT_BURST_MAX_MS;
  });

  test("defaults: quietMs=60000 maxMs=180000 quando env não configurada", () => {
    delete process.env.AGENT_BURST_QUIET_MS;
    delete process.env.AGENT_BURST_MAX_MS;
    const cfg = getBurstConfig();
    assert.equal(cfg.quietMs, 60000);
    assert.equal(cfg.maxMs, 180000);
  });

  test("env inválida (0, negativo, NaN) cai no default seguro", () => {
    process.env.AGENT_BURST_QUIET_MS = "0";
    process.env.AGENT_BURST_MAX_MS = "not-a-number";
    const cfg = getBurstConfig();
    assert.equal(cfg.quietMs, 60000);
    assert.equal(cfg.maxMs, 180000);
    delete process.env.AGENT_BURST_QUIET_MS;
    delete process.env.AGENT_BURST_MAX_MS;
  });

  test("1ª mensagem do turno: generation=1, dueAt = now + quietMs", async () => {
    process.env.AGENT_BURST_QUIET_MS = "60000";
    process.env.AGENT_BURST_MAX_MS = "180000";
    const now = 1_000_000;
    const rec = await scheduleBurst(redis, "+5511900000001", now);
    assert.equal(rec.generation, 1);
    assert.equal(rec.firstMessageAt, now);
    assert.equal(rec.lastMessageAt, now);
    assert.equal(rec.dueAt, now + 60000);

    const stored = await getBurstRecord(redis, "+5511900000001");
    assert.deepEqual(stored, rec);

    const pending = await getPendingBurstPhones(redis);
    assert.ok(pending.includes("+5511900000001"));
  });

  test("2ª mensagem 30s depois: generation=2, dueAt reinicia a partir da nova mensagem", async () => {
    const phone = "+5511900000002";
    const t0 = 2_000_000;
    await scheduleBurst(redis, phone, t0);
    const rec2 = await scheduleBurst(redis, phone, t0 + 30_000);
    assert.equal(rec2.generation, 2);
    assert.equal(rec2.firstMessageAt, t0, "firstMessageAt não deve mudar entre mensagens do mesmo turno");
    assert.equal(rec2.lastMessageAt, t0 + 30_000);
    assert.equal(rec2.dueAt, t0 + 30_000 + 60000);
  });

  test("hard cap: dueAt nunca ultrapassa firstMessageAt + maxMs, mesmo com mensagens seguidas", async () => {
    const phone = "+5511900000003";
    const t0 = 3_000_000;
    await scheduleBurst(redis, phone, t0);
    // Mensagens a cada 40s mantêm o quiet period sempre adiante do hard cap
    let rec;
    for (let i = 1; i <= 6; i++) {
      rec = await scheduleBurst(redis, phone, t0 + i * 40_000);
    }
    // t0 + 6*40s = t0 + 240s; quietDue seria t0+240s+60s=t0+300s, mas hard cap é t0+180s
    assert.equal(rec.dueAt, t0 + 180_000, "dueAt deve ser limitado pelo hard cap a partir da 1ª mensagem");
  });

  test("clearBurst remove o registro e a associação ao conjunto pendente", async () => {
    const phone = "+5511900000004";
    await scheduleBurst(redis, phone, 4_000_000);
    await clearBurst(redis, phone);
    assert.equal(await getBurstRecord(redis, phone), null);
    const pending = await getPendingBurstPhones(redis);
    assert.ok(!pending.includes(phone));
  });
});
