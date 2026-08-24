import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import handler from "../api/audio-remux-diagnostic.js";

const originalVercelEnv = process.env.VERCEL_ENV;

afterEach(() => {
  if (originalVercelEnv == null) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
});

function response() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("rota diagnóstica responde 404 fora de Preview", async () => {
  process.env.VERCEL_ENV = "production";
  const res = response();
  await handler({ method: "POST", headers: { "x-sartec-preview-diagnostic": "audio-remux-preview-v1" } }, res);
  assert.equal(res.statusCode, 404);
});

test("rota diagnóstica não aceita chamada Preview sem header explícito", async () => {
  process.env.VERCEL_ENV = "preview";
  const res = response();
  await handler({ method: "POST", headers: {} }, res);
  assert.equal(res.statusCode, 404);
});

test("rota Preview gera fixture internamente e não recebe arquivo arbitrário", async () => {
  process.env.VERCEL_ENV = "preview";
  const res = response();
  await handler({
    method: "POST",
    headers: { "x-sartec-preview-diagnostic": "audio-remux-preview-v1" },
    body: { ignored: "nenhum arquivo é aceito" },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.previewOnly, true);
  assert.equal(res.body.remux.audioCodecMode, "copy");
  assert.equal(res.body.remux.cleanupVerified, true);
  assert.equal(res.body.before.moof, true);
  assert.equal(res.body.after.moof, false);
  assert.equal(res.body.after.mvex, false);
  assert.equal(res.body.after.traf, false);
  assert.equal(res.body.runtime.executable, true);
});
