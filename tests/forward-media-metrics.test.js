// Cobre a instrumentação best-effort de métricas em api/forward-media.js
// (contador de encaminhamentos para Denise, usado por api/metrics.js).
//
// Fica em arquivo próprio, separado de tests/forward-media.test.js, porque
// aquele arquivo importa api/forward-media.js estaticamente para reaproveitar
// helpers puros (buildContextCaption etc.) — misturar esse import estático
// com ./helpers/harness.js no mesmo arquivo carregaria o pacote ioredis real
// antes do hook de mock ser registrado (harness.js só registra o hook em
// tempo de execução, depois que o grafo de imports estáticos já foi
// resolvido). Os demais testes que usam harness.js (ex.: webhook-pj-lunch)
// seguem o mesmo padrão: nunca importam um api/*.js diretamente.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  FakeRedis,
  rawClient,
  callForwardMedia,
  forceSetSession,
} from "./helpers/harness.js";

beforeEach(() => FakeRedis._reset());

function seedForwardableSession(phone, overrides = {}) {
  return forceSetSession(phone, (s) => Object.assign(s, {
    clientName: "Cliente Teste",
    history: [{
      role: "user",
      mediaType: "document",
      mediaMimeType: "application/pdf",
      mediaFilename: "comprovante.pdf",
      mediaData: Buffer.from("pdf original").toString("base64"),
      metaMessageId: "wamid_in_1",
    }],
    ...overrides,
  }));
}

test("encaminhamento bem-sucedido registra métrica best-effort para Denise", async () => {
  const phone = "5512900000501";
  await seedForwardableSession(phone);

  const { res } = await callForwardMedia({ sourcePhone: phone, historyIndex: 0, messageId: "wamid_in_1" });
  assert.equal(res._status, 200);

  const events = await rawClient.lrange("sartec:metrics:denise_forwards", 0, -1);
  assert.equal(events.length, 1);
  const parsed = JSON.parse(events[0]);
  assert.equal(parsed.mediaType, "document");
  assert.ok(parsed.at, "deve registrar o timestamp do encaminhamento");
});

test("encaminhamento rejeitado pela Meta NÃO registra métrica", async () => {
  const phone = "5512900000502";
  await seedForwardableSession(phone, {
    history: [{
      role: "user",
      mediaType: "document",
      mediaMimeType: "application/pdf",
      mediaFilename: "comprovante.pdf",
      mediaData: Buffer.from("pdf original").toString("base64"),
      metaMessageId: "wamid_in_2",
    }],
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith("/media")) {
      return { ok: false, status: 400, json: async () => ({ error: { code: 100, message: "Parâmetro inválido" } }) };
    }
    return originalFetch(url, opts);
  };

  try {
    const { res } = await callForwardMedia({ sourcePhone: phone, historyIndex: 0, messageId: "wamid_in_2" });
    assert.notEqual(res._status, 200);

    const events = await rawClient.lrange("sartec:metrics:denise_forwards", 0, -1);
    assert.equal(events.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mídia de áudio não é encaminhável para Denise (fora de escopo desta ação)", async () => {
  const phone = "5512900000503";
  await seedForwardableSession(phone, {
    history: [{
      role: "user",
      mediaType: "audio",
      mediaMimeType: "audio/ogg",
      mediaData: Buffer.from("audio original").toString("base64"),
      metaMessageId: "wamid_in_3",
    }],
  });

  const { res } = await callForwardMedia({ sourcePhone: phone, historyIndex: 0, messageId: "wamid_in_3" });
  assert.notEqual(res._status, 200);

  const events = await rawClient.lrange("sartec:metrics:denise_forwards", 0, -1);
  assert.equal(events.length, 0);
});
