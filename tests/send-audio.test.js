import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  FakeRedis,
  callSend,
  forceSetSession,
  getSession,
} from "./helpers/harness.js";
import { buildMinimalMp4, buildOggOpusPage } from "./helpers/audio-fixtures.js";

beforeEach(() => FakeRedis._reset());

function baseSession(overrides = {}) {
  return { history: [], status: "aguardando_humano", clientType: "pf", ...overrides };
}

// Fixtures válidas — desde que api/send.js passou a validar os bytes reais
// antes de subir para a Meta (lib/audio-validation.js), placeholders como
// "x"/"audio binario" não bastam mais para os testes que esperam sucesso.
const VALID_MP4_AAC_B64 = Buffer.from(buildMinimalMp4({ codec: "mp4a" })).toString("base64");
const VALID_OGG_MONO_B64 = Buffer.from(buildOggOpusPage(1)).toString("base64");

test("envia áudio audio/mp4 (AAC real) — upload, envio, histórico persistido sem legenda/voice", async () => {
  const phone = "5512900000301";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { res, calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: VALID_MP4_AAC_B64,
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

test("filename multipart do upload MP4 termina em .m4a (nunca 'audio' genérico)", async () => {
  const phone = "5512900000308";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: VALID_MP4_AAC_B64,
    mimeType: "audio/mp4",
  });

  const uploadCall = calls.find((c) => String(c.url).endsWith("/media"));
  const fileEntry = uploadCall.opts.body.get("file");
  assert.ok(fileEntry, "campo file deve existir no FormData de upload");
  assert.equal(fileEntry.name, "audio.m4a");
});

test("filename multipart do upload OGG termina em .ogg", async () => {
  const phone = "5512900000309";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: VALID_OGG_MONO_B64,
    mimeType: "audio/ogg",
  });

  const uploadCall = calls.find((c) => String(c.url).endsWith("/media"));
  const fileEntry = uploadCall.opts.body.get("file");
  assert.equal(fileEntry.name, "audio.ogg");
});

test("MP4 com ftyp mas sem sample entry mp4a (AAC) é rejeitado com 422 antes de chamar a Meta", async () => {
  const phone = "5512900000310";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const invalidMp4 = Buffer.from(buildMinimalMp4({ codec: "alac" })).toString("base64");
  const { res, calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: invalidMp4,
    mimeType: "audio/mp4",
  });

  assert.equal(res._status, 422);
  assert.match(res._body.error, /não gerou um áudio compatível/i);
  assert.equal(res._body.detail, "no-aac");
  assert.equal(calls.length, 0, "não deve nem tentar o upload para a Meta");

  const session = await getSession(phone);
  assert.equal(session.history.length, 0);
});

test("bytes que não são MP4 de verdade, declarados mimeType audio/mp4, são rejeitados com 422", async () => {
  const phone = "5512900000311";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { res, calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: Buffer.from("isto nao e um arquivo mp4 de verdade").toString("base64"),
    mimeType: "audio/mp4",
  });

  assert.equal(res._status, 422);
  assert.equal(res._body.detail, "not-mp4");
  assert.equal(calls.length, 0);
});

test("OGG mono continua válido (regra da rodada anterior preservada)", async () => {
  const phone = "5512900000312";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { res, calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: VALID_OGG_MONO_B64,
    mimeType: "audio/ogg",
  });

  assert.equal(res._status, 200);
  const sentPayload = JSON.parse(calls[1].opts.body);
  assert.equal(sentPayload.audio.voice, true);
});

test("OGG estéreo continua inválido (regra da rodada anterior preservada) — 422 antes da Meta", async () => {
  const phone = "5512900000313";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const stereoOgg = Buffer.from(buildOggOpusPage(2)).toString("base64");
  const { res, calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: stereoOgg,
    mimeType: "audio/ogg",
  });

  assert.equal(res._status, 422);
  assert.equal(res._body.detail, "not-mono");
  assert.equal(calls.length, 0);
});

test("replyToMessageId é repassado como context.message_id", async () => {
  const phone = "5512900000303";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const { calls } = await callSend({
    to: phone, type: "audio",
    mediaBase64: VALID_MP4_AAC_B64,
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
      mediaBase64: VALID_MP4_AAC_B64,
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
      mediaBase64: VALID_MP4_AAC_B64,
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
    mediaBase64: VALID_MP4_AAC_B64,
    mimeType: "audio/mp4",
    attendantId: "denise", attendantName: "Denise",
  });

  const session = await getSession(phone);
  assert.equal(session.activeAttendant.id, "denise");
  assert.equal(session.handoffDone, true);
});
