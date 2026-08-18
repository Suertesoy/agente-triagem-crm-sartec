import { randomUUID } from "node:crypto";

export const REDIS_LOCK_RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export const REDIS_LOCK_RENEW_SCRIPT = `-- redis-lock:renew-v1
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0`;

export class RedisLockTimeoutError extends Error {
  constructor(lockKey) {
    super(`lock indisponível: ${lockKey}`);
    this.name = "RedisLockTimeoutError";
    this.code = "REDIS_LOCK_TIMEOUT";
    this.lockKey = lockKey;
  }
}

export async function acquireRedisLock(redis, lockKey, { token = randomUUID(), ttlSeconds = 15 } = {}) {
  const acquired = await redis.set(lockKey, token, "NX", "EX", ttlSeconds);
  return acquired ? token : null;
}

export async function releaseRedisLock(redis, lockKey, token) {
  if (!token) return 0;
  return redis.eval(REDIS_LOCK_RELEASE_SCRIPT, 1, lockKey, token);
}

export async function renewRedisLock(redis, lockKey, token, ttlSeconds = 15) {
  if (!token) return 0;
  const ttlMs = Math.round(ttlSeconds * 1000);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("TTL do lock deve ser positivo");
  return redis.eval(REDIS_LOCK_RENEW_SCRIPT, 1, lockKey, token, String(ttlMs));
}

export async function withRedisLock(redis, lockKey, fn, options = {}) {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 150;
  const ttlSeconds = options.ttlSeconds ?? 15;
  const renewalIntervalMs = options.renewalIntervalMs ?? Math.max(100, Math.floor(ttlSeconds * 1000 / 3));
  const token = options.token || randomUUID();
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const logger = options.logger || console;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const acquiredToken = await acquireRedisLock(redis, lockKey, { token, ttlSeconds });
    if (acquiredToken) {
      let stopped = false;
      let renewalTimer = null;
      let renewalPromise = Promise.resolve();

      const scheduleRenewal = () => {
        renewalTimer = setTimer(() => {
          renewalTimer = null;
          renewalPromise = renewRedisLock(redis, lockKey, acquiredToken, ttlSeconds)
            .then((renewed) => {
              if (!stopped && renewed === 1) scheduleRenewal();
              return renewed;
            })
            .catch((error) => {
              logger?.error?.(`[Lock] Falha ao renovar ${lockKey}: ${error.message}`);
              return 0;
            });
          return renewalPromise;
        }, renewalIntervalMs);
      };

      scheduleRenewal();
      try {
        return await fn();
      } finally {
        stopped = true;
        if (renewalTimer != null) clearTimer(renewalTimer);
        await renewalPromise;
        await releaseRedisLock(redis, lockKey, acquiredToken);
      }
    }
    if (attempt + 1 < attempts) await sleep(delayMs);
  }

  const timeoutMessage = options.timeoutMessage || `[Lock] ⚠️ Timeout ${lockKey}`;
  logger?.warn?.(timeoutMessage);
  throw new RedisLockTimeoutError(lockKey);
}

export function withSessionLock(redis, phone, fn, options = {}) {
  return withRedisLock(redis, `lock:sartec:${phone}`, fn, {
    ...options,
    timeoutMessage: options.timeoutMessage || `[Lock] ⚠️ Timeout +${phone}`,
  });
}
