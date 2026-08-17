import { randomUUID } from "node:crypto";

export const REDIS_LOCK_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export async function acquireRedisLock(redis, lockKey, { token = randomUUID(), ttlSeconds = 15 } = {}) {
  const acquired = await redis.set(lockKey, token, "NX", "EX", ttlSeconds);
  return acquired ? token : null;
}

export async function releaseRedisLock(redis, lockKey, token) {
  if (!token) return 0;
  return redis.eval(REDIS_LOCK_RELEASE_SCRIPT, 1, lockKey, token);
}

export async function withRedisLock(redis, lockKey, fn, options = {}) {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 150;
  const ttlSeconds = options.ttlSeconds ?? 15;
  const token = options.token || randomUUID();
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const acquiredToken = await acquireRedisLock(redis, lockKey, { token, ttlSeconds });
    if (acquiredToken) {
      try {
        return await fn();
      } finally {
        await releaseRedisLock(redis, lockKey, acquiredToken);
      }
    }
    await sleep(delayMs);
  }

  const timeoutMessage = options.timeoutMessage || `[Lock] ⚠️ Timeout ${lockKey}`;
  if (options.onTimeout === "throw") throw new Error(`lock indisponível: ${lockKey}`);
  (options.logger || console).warn(timeoutMessage);
  return fn();
}

export function withSessionLock(redis, phone, fn, options = {}) {
  return withRedisLock(redis, `lock:sartec:${phone}`, fn, {
    ...options,
    timeoutMessage: options.timeoutMessage || `[Lock] ⚠️ Timeout +${phone}`,
  });
}
