import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import FakeRedis from "./helpers/fake-ioredis.js";
import {
  acquireRedisLock,
  releaseRedisLock,
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

test("timeout mantém o fallback legado explícito de executar sem lock", async () => {
  const redis = new FakeRedis();
  await acquireRedisLock(redis, LOCK_KEY, { token: "busy", ttlSeconds: 15 });
  const warnings = [];
  let calls = 0;

  const result = await withRedisLock(redis, LOCK_KEY, async () => {
    calls += 1;
    return "fallback";
  }, {
    attempts: 2,
    delayMs: 0,
    sleep: async () => {},
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(result, "fallback");
  assert.equal(calls, 1);
  assert.equal(warnings.length, 1);
  assert.equal(await redis.get(LOCK_KEY), "busy");
});
