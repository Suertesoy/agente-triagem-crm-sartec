import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import FakeRedis from "./helpers/fake-ioredis.js";
import {
  acquireRedisLock,
  releaseRedisLock,
  renewRedisLock,
  withRedisLock,
} from "../lib/redis-lock.js";

const LOCK_KEY = "lock:test:crm";

beforeEach(() => FakeRedis._reset());

test("adquire lock com token UUID e libera após a seção crítica", async () => {
  const redis = new FakeRedis();
  const result = await withRedisLock(redis, LOCK_KEY, async () => {
    const token = await redis.get(LOCK_KEY);
    assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(await redis.get(LOCK_KEY), null);
});

test("lock expirado pode ser adquirido por outro processo", async () => {
  const redis = new FakeRedis();
  const tokenA = await acquireRedisLock(redis, LOCK_KEY, { token: "process-a", ttlSeconds: 1 });
  assert.equal(tokenA, "process-a");

  FakeRedis._advanceTime(1001);
  const tokenB = await acquireRedisLock(redis, LOCK_KEY, { token: "process-b", ttlSeconds: 1 });

  assert.equal(tokenB, "process-b");
  assert.equal(await redis.get(LOCK_KEY), "process-b");
});

test("processo A atrasado não remove o lock já pertencente ao processo B", async () => {
  const redis = new FakeRedis();
  await acquireRedisLock(redis, LOCK_KEY, { token: "process-a", ttlSeconds: 1 });
  FakeRedis._advanceTime(1001);
  await acquireRedisLock(redis, LOCK_KEY, { token: "process-b", ttlSeconds: 15 });

  assert.equal(await releaseRedisLock(redis, LOCK_KEY, "process-a"), 0);
  assert.equal(await redis.get(LOCK_KEY), "process-b");
});

test("release compare-and-delete é idempotente", async () => {
  const redis = new FakeRedis();
  await acquireRedisLock(redis, LOCK_KEY, { token: "owner", ttlSeconds: 15 });

  assert.equal(await releaseRedisLock(redis, LOCK_KEY, "owner"), 1);
  assert.equal(await releaseRedisLock(redis, LOCK_KEY, "owner"), 0);
  assert.equal(await redis.get(LOCK_KEY), null);
});

test("renovação compare-token mantém B bloqueado enquanto A trabalha", async () => {
  const redis = new FakeRedis();
  const scheduled = [];
  let finishA;
  const criticalA = new Promise((resolve) => { finishA = resolve; });
  const runningA = withRedisLock(redis, LOCK_KEY, async () => criticalA, {
    token: "process-a",
    ttlSeconds: 1,
    renewalIntervalMs: 10,
    setTimer: (callback) => { scheduled.push(callback); return callback; },
    clearTimer: (callback) => {
      const index = scheduled.indexOf(callback);
      if (index >= 0) scheduled.splice(index, 1);
    },
  });
  await Promise.resolve();

  assert.equal(await redis.get(LOCK_KEY), "process-a");
  FakeRedis._advanceTime(600);
  const renew = scheduled.shift();
  await renew();
  FakeRedis._advanceTime(600);
  assert.equal(await acquireRedisLock(redis, LOCK_KEY, { token: "process-b", ttlSeconds: 1 }), null);

  finishA("done");
  assert.equal(await runningA, "done");
  assert.equal(await acquireRedisLock(redis, LOCK_KEY, { token: "process-b", ttlSeconds: 1 }), "process-b");
});

test("token perdido não é renovado nem reagendado", async () => {
  const redis = new FakeRedis();
  await acquireRedisLock(redis, LOCK_KEY, { token: "process-a", ttlSeconds: 15 });
  await redis.del(LOCK_KEY);
  await acquireRedisLock(redis, LOCK_KEY, { token: "process-b", ttlSeconds: 15 });

  assert.equal(await renewRedisLock(redis, LOCK_KEY, "process-a", 15), 0);
  assert.equal(await redis.get(LOCK_KEY), "process-b");
});

test("callback concluído cancela renovação e não deixa timer pendente", async () => {
  const redis = new FakeRedis();
  const scheduled = new Set();
  const result = await withRedisLock(redis, LOCK_KEY, async () => "ok", {
    setTimer: (callback) => { scheduled.add(callback); return callback; },
    clearTimer: (callback) => scheduled.delete(callback),
  });

  assert.equal(result, "ok");
  assert.equal(scheduled.size, 0);
  assert.equal(await redis.get(LOCK_KEY), null);
});

test("timeout é explícito e nunca executa a seção crítica sem lock", async () => {
  const redis = new FakeRedis();
  await acquireRedisLock(redis, LOCK_KEY, { token: "busy", ttlSeconds: 15 });
  const warnings = [];
  let calls = 0;

  await assert.rejects(
    withRedisLock(redis, LOCK_KEY, async () => {
      calls += 1;
    }, {
      attempts: 2,
      delayMs: 0,
      sleep: async () => {},
      logger: { warn: (message) => warnings.push(message) },
    }),
    { code: "REDIS_LOCK_TIMEOUT", lockKey: LOCK_KEY }
  );

  assert.equal(calls, 0);
  assert.equal(warnings.length, 1);
  assert.equal(await redis.get(LOCK_KEY), "busy");
});
