import { beforeEach, describe, before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FakeRedis,
  FakeS3Client,
  callSend,
  forceSetSession,
  getSession,
} from "./helpers/harness.js";
import { buildBrokenFragmentedMp4, buildMinimalMp4, buildOggOpusPage } from "./helpers/audio-fixtures.js";
import { inspectMp4Structure } from "../lib/mp4-inspection.js";

before(() => {
  process.env.R2_DISABLED = "false";
  process.env.R2_ENDPOINT = "https://fake-r2.example.com";
  process.env.R2_ACCESS_KEY_ID = "fake-key-id";
  process.env.R2_SECRET_ACCESS_KEY = "fake-secret";
  process.env.R2_BUCKET = "fake-bucket";
});
after(() => {
  process.env.R2_DISABLED = "true";
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET;
});
beforeEach(() => {
  FakeRedis._reset();
  FakeS3Client._reset();
});

function baseSession(overrides = {}) {
  return { history: [], status: "aguardando_humano", clientType: "pf", ...overrides };
}

// Fixtures válidas — desde que api/send.js passou a validar os bytes reais
// antes de subir para a Meta (lib/audio-validation.js), placeholders como
// "x"/"audio binario" não bastam mais para os testes que esperam sucesso.
const VALID_MP4_AAC_B64 = Buffer.from(buildMinimalMp4({ codec: "mp4a" })).toString("base64");
const VALID_OGG_MONO_B64 = Buffer.from(buildOggOpusPage(1)).toString("base64");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAGMENTED_MP4 = Buffer.from(
  readFileSync(path.join(HERE, "fixtures", "synthetic-fmp4-aac.base64"), "utf8").replaceAll(/\s/g, ""),
  "base64",
);

test("envia MP4/AAC convencional somente por R2 + audio.link", async () => {
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

  assert.equal(calls.length, 1);
  assert.equal(calls.find((call) => call.url.endsWith("/media")), undefined);
  assert.ok(calls[0].url.includes("/messages"));
  const sentPayload = JSON.parse(calls[0].opts.body);
  assert.equal(sentPayload.type, "audio");
  assert.ok(sentPayload.audio.link);
  assert.equal(sentPayload.audio.id, undefined);
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
  assert.equal(entry.mediaStorageProvider, "cloudflare-r2");
  assert.ok(entry.mediaStorageKey);
  assert.ok(FakeS3Client._getObject(entry.mediaStorageKey));
});

test("objeto R2 de MP4 termina em .m4a", async () => {
  const phone = "5512900000308";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  await callSend({
    to: phone, type: "audio",
    mediaBase64: VALID_MP4_AAC_B64,
    mimeType: "audio/mp4",
  });

  const session = await getSession(phone);
  assert.match(session.history[0].mediaStorageKey, /\.m4a$/);
});

test("objeto R2 de OGG termina em .ogg", async () => {
  const phone = "5512900000309";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  await callSend({
    to: phone, type: "audio",
    mediaBase64: VALID_OGG_MONO_B64,
    mimeType: "audio/ogg",
  });

  const session = await getSession(phone);
  assert.match(session.history[0].mediaStorageKey, /\.ogg$/);
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
  const sentPayload = JSON.parse(calls[0].opts.body);
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

  const sentPayload = JSON.parse(calls[0].opts.body);
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

test("falha do R2 aborta sem fallback multipart e sem histórico", async () => {
  const phone = "5512900000305";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const originalSend = FakeS3Client.prototype.send;
  FakeS3Client.prototype.send = async function (command) {
    if (command?.constructor?.name === "PutObjectCommand") throw new Error("simulated R2 outage");
    return originalSend.call(this, command);
  };

  try {
    const { res, calls } = await callSend({
      to: phone, type: "audio",
      mediaBase64: VALID_MP4_AAC_B64,
      mimeType: "audio/mp4",
    });
    assert.equal(res._status, 503);
    assert.equal(res._body.detail, "audio-storage-unavailable");
    assert.equal(calls.length, 0);

    const session = await getSession(phone);
    assert.equal(session.history.length, 0);
  } finally {
    FakeS3Client.prototype.send = originalSend;
  }
});

test("envio de áudio rejeitado pela Meta (após upload OK) não persiste histórico", async () => {
  const phone = "5512900000306";
  await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
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

describe("envio de áudio somente por R2 + audio.link", () => {

  test("áudio é salvo no R2 ANTES do envio (mesma storage key usada na Meta e no histórico)", async () => {
    const phone = "5512900000320";
    await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

    const { res, calls } = await callSend({
      to: phone, type: "audio",
      mediaBase64: VALID_MP4_AAC_B64,
      mimeType: "audio/mp4",
    });

    assert.equal(res._status, 200);
    // Nenhum upload multipart /media — o caminho por link não usa media_id.
    assert.equal(calls.find((c) => String(c.url).endsWith("/media")), undefined, "não deve chamar /media para áudio via link");
    const sendCall = calls.find((c) => String(c.url).includes("/messages"));
    const sentPayload = JSON.parse(sendCall.opts.body);
    assert.ok(sentPayload.audio.link, "deve enviar audio.link, não audio.id");
    assert.equal(sentPayload.audio.id, undefined);

    const session = await getSession(phone);
    const entry = session.history[0];
    assert.equal(entry.mediaStorageProvider, "cloudflare-r2");
    assert.ok(entry.mediaStorageKey);
    assert.ok(FakeS3Client._getObject(entry.mediaStorageKey), "objeto deve existir no R2 com a mesma storage key salva no histórico");
    assert.equal(FakeS3Client._getPutCount(), 1, "upload para o R2 deve acontecer exatamente 1 vez (antes da Meta, não duplicado depois)");
  });

  test("fMP4 real sintético é remuxado e somente o MP4 convencional final chega ao R2", async () => {
    const phone = "5512900000327";
    await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

    const { res, calls } = await callSend({
      to: phone,
      type: "audio",
      mediaBase64: FRAGMENTED_MP4.toString("base64"),
      mimeType: "audio/mp4",
    });

    assert.equal(res._status, 200);
    assert.equal(calls.find((call) => String(call.url).endsWith("/media")), undefined);
    const session = await getSession(phone);
    const stored = FakeS3Client._getObject(session.history[0].mediaStorageKey).body;
    assert.notDeepEqual(stored, FRAGMENTED_MP4, "R2 não pode receber o fMP4 original");
    const structure = inspectMp4Structure(stored);
    assert.equal(structure.hasMp4a, true);
    assert.equal(structure.hasMoof, false);
    assert.equal(structure.hasMvex, false);
    assert.equal(structure.hasTraf, false);
  });

  test("falha do remux nunca envia nem salva o fMP4 original", async () => {
    const phone = "5512900000328";
    await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

    const { res, calls } = await callSend({
      to: phone,
      type: "audio",
      mediaBase64: Buffer.from(buildBrokenFragmentedMp4()).toString("base64"),
      mimeType: "audio/mp4",
    });

    assert.equal(res._status, 502);
    assert.match(res._body.detail, /^AUDIO_REMUX_/);
    assert.equal(FakeS3Client._getPutCount(), 0);
    assert.equal(calls.length, 0);
    assert.equal((await getSession(phone)).history.length, 0);
  });

  test("headMediaObject confirma o Content-Type salvo antes de gerar o link — recusa se não bater", async () => {
    const phone = "5512900000321";
    await forceSetSession(phone, (s) => Object.assign(s, baseSession()));
    FakeS3Client._forceMismatchedContentType(true);

    const { res, calls } = await callSend({
      to: phone, type: "audio",
      mediaBase64: VALID_MP4_AAC_B64,
      mimeType: "audio/mp4",
    });

    assert.equal(res._status, 502);
    assert.equal(calls.filter((c) => String(c.url).includes("/messages")).length, 0, "nunca deve chegar a enviar para a Meta sem o Content-Type confirmado");

    const session = await getSession(phone);
    assert.equal(session.history.length, 0);
  });

  test("MP4 via link não envia voice:true", async () => {
    const phone = "5512900000322";
    await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

    const { calls } = await callSend({
      to: phone, type: "audio",
      mediaBase64: VALID_MP4_AAC_B64,
      mimeType: "audio/mp4",
    });

    const sentPayload = JSON.parse(calls.find((c) => String(c.url).includes("/messages")).opts.body);
    assert.equal(sentPayload.audio.voice, undefined);
  });

  test("OGG válido (mono) via link preserva voice:true", async () => {
    const phone = "5512900000323";
    await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

    const { calls } = await callSend({
      to: phone, type: "audio",
      mediaBase64: VALID_OGG_MONO_B64,
      mimeType: "audio/ogg",
    });

    const sentPayload = JSON.parse(calls.find((c) => String(c.url).includes("/messages")).opts.body);
    assert.equal(sentPayload.audio.voice, true);
    assert.ok(sentPayload.audio.link);
    const session = await getSession(phone);
    const stored = FakeS3Client._getObject(session.history[0].mediaStorageKey).body;
    assert.deepEqual(stored, Buffer.from(buildOggOpusPage(1)), "OGG deve permanecer byte a byte intacto");
  });

  test("replyToMessageId continua preservado como context.message_id no caminho por link", async () => {
    const phone = "5512900000324";
    await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

    const { calls } = await callSend({
      to: phone, type: "audio",
      mediaBase64: VALID_MP4_AAC_B64,
      mimeType: "audio/mp4",
      replyToMessageId: "wamid_original_456",
    });

    const sentPayload = JSON.parse(calls.find((c) => String(c.url).includes("/messages")).opts.body);
    assert.equal(sentPayload.context.message_id, "wamid_original_456");

    const session = await getSession(phone);
    assert.equal(session.history[0].replyToMsgId, "wamid_original_456");
  });

  test("falha da Meta ao enviar por link não gera novo upload no R2 nem persiste histórico", async () => {
    const phone = "5512900000325";
    await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("/messages")) {
        return { ok: false, status: 400, json: async () => ({ error: { code: 131053, message: "Media processing error" } }) };
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
      assert.equal(FakeS3Client._getPutCount(), 1, "upload ao R2 já tinha acontecido antes da tentativa de envio — não deve tentar de novo");

      const session = await getSession(phone);
      assert.equal(session.history.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("R2 indisponível aborta e nunca chama o multipart /media", async () => {
    const phone = "5512900000326";
    await forceSetSession(phone, (s) => Object.assign(s, baseSession()));

    // Simula R2 fora do ar mesmo com envs presentes — ex.: falha de rede real.
    const originalSend = FakeS3Client.prototype.send;
    FakeS3Client.prototype.send = async function (command) {
      if (command?.constructor?.name === "PutObjectCommand") throw new Error("simulated R2 outage");
      return originalSend.call(this, command);
    };

    try {
      const { res, calls } = await callSend({
        to: phone, type: "audio",
        mediaBase64: VALID_MP4_AAC_B64,
        mimeType: "audio/mp4",
      });
      assert.equal(res._status, 503);
      assert.equal(res._body.detail, "audio-storage-unavailable");
      assert.equal(calls.length, 0);
      assert.equal((await getSession(phone)).history.length, 0);
    } finally {
      FakeS3Client.prototype.send = originalSend;
    }
  });
});
