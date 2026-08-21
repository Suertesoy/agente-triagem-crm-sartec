import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  FakeRedis,
  callSend,
  forceSetSession,
  getSession,
} from "./helpers/harness.js";

beforeEach(() => FakeRedis._reset());

function baseSession(overrides = {}) {
  return { history: [], status: "aguardando_humano", clientType: "pf", ...overrides };
}

test("envia áudio audio/mp4 — upload, envio, histórico persistido sem legenda/voice", async () => {
  const phone = "5512900000301";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { res, calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: Buffer.from("audio binario").toString("base64"),
    mimeType: "audio/mp4",
    attendantId: "lucas", attendantName: "Lucas",
  });

  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.historyPersisted, true);

  assert.equal(calls.length, 2);
  assert.ok(calls[0].url.endsWith("/media"), "1ª chamada deve ser o upload de mídia");
  assert.ok(calls[1].url.includes("/messages"), "2ª chamada deve ser o envio da mensagem");
  const sentPayload = JSON.parse(calls[1].opts.body);
  assert.equal(sentPayload.type, "audio");
  assert.equal(sentPayload.audio.id, "media_upload_1");
  assert.equal(sentPayload.audio.voice, undefined, "mp4 não deve marcar voice:true");
  assert.equal(sentPayload.audio.caption, undefined, "Meta não aceita legenda em áudio");

  const session = await getSession(phone);
  assert.equal(session.history.length, 1);
  const entry = session.history[0];
  assert.equal(entry.role, "assistant");
  assert.equal(entry.sentByHuman, true);
  assert.equal(entry.mediaType, "audio");
  assert.equal(entry.mediaMimeType, "audio/mp4");
  assert.equal(entry.attendantId, "lucas");
  assert.equal(entry.attendantName, "Lucas");
  assert.equal(entry.deliveryStatus, "sent");
  assert.ok(entry.metaMessageId);
  // R2_DISABLED=true no harness — best-effort deve cair no fallback sem derrubar o envio já confirmado.
  assert.equal(entry.mediaStorageFailed, true);
  assert.equal(entry.mediaStorageKey, undefined);
});

test("envia áudio audio/ogg como nota de voz nativa (voice:true)", async () => {
  const phone = "5512900000302";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: Buffer.from("ogg binario").toString("base64"),
    mimeType: "audio/ogg",
  });

  const sentPayload = JSON.parse(calls[1].opts.body);
  assert.equal(sentPayload.audio.voice, true);
});

test("replyToMessageId é repassado como context.message_id", async () => {
  const phone = "5512900000303";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: Buffer.from("x").toString("base64"),
    mimeType: "audio/mp4",
    replyToMessageId: "wamid_original_123",
  });

  const sentPayload = JSON.parse(calls[1].opts.body);
  assert.equal(sentPayload.context.message_id, "wamid_original_123");

  const session = await getSession(phone);
  assert.equal(session.history[0].replyToMsgId, "wamid_original_123");
});

test("mediaBase64/mimeType ausentes retornam 400 sem chamar a Meta", async () => {
  const phone = "5512900000304";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { res, calls } = await callSend({ to: phone, type: "audio" });

  assert.equal(res._status, 400);
  assert.equal(calls.length, 0);
});

test("upload de áudio rejeitado pela Meta não persiste histórico", async () => {
  const phone = "5512900000305";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith("/media")) {
      return { ok: false, status: 400, json: async () => ({ error: { code: 100, message: "Parâmetro inválido" } }) };
    }
    return originalFetch(url, opts);
  };

  try {
    const { res } = await callSend({
      to: phone, type: "audio",
      mediaBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/mp4",
    });
    assert.equal(res._status, 502);
    assert.match(res._body.error, /upload/i);

    const session = await getSession(phone);
    assert.equal(session.history.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("envio de áudio rejeitado pela Meta (após upload OK) não persiste histórico", async () => {
  const phone = "5512900000306";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith("/media")) return originalFetch(url, opts);
    if (String(url).includes("/messages")) {
      return { ok: false, status: 400, json: async () => ({ error: { code: 131047, message: "Janela de 24h fechada" } }) };
    }
    return originalFetch(url, opts);
  };

  try {
    const { res } = await callSend({
      to: phone, type: "audio",
      mediaBase64: Buffer.from("x").toString("base64"),
      mimeType: "audio/mp4",
    });
    assert.equal(res._status, 502);

    const session = await getSession(phone);
    assert.equal(session.history.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("enviar mensagem = assumir atendimento (activeAttendant atualizado)", async () => {
  const phone = "5512900000307";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  await callSend({
    to: phone, type: "audio",
    mediaBase64: Buffer.from("x").toString("base64"),
    mimeType: "audio/mp4",
    attendantId: "denise", attendantName: "Denise",
  });

  const session = await getSession(phone);
  assert.equal(session.activeAttendant.id, "denise");
  assert.equal(session.handoffDone, true);
});
