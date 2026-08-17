export class ShadowWriteTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`shadow write excedeu ${timeoutMs}ms`);
    this.name = "ShadowWriteTimeoutError";
    this.code = "SHADOW_TIMEOUT";
  }
}

export async function withCancelableTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutError = new ShadowWriteTimeoutError(timeoutMs);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
