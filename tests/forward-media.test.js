import test from "node:test";
import assert from "node:assert/strict";

import {
  buildContextCaption,
  humanizeMetaForwardError,
  resolveHistoryMedia,
} from "../api/forward-media.js";

test("resolveHistoryMedia preserva referência R2, MIME e filename originais", () => {
  const media = resolveHistoryMedia({
    role: "user",
    mediaType: "document",
    mediaMimeType: "application/pdf",
    mediaFilename: "comprovante pix.pdf",
    mediaStorageKey: "media/5512999990000/202608/wamid.pdf",
  });

  assert.equal(media.available, true);
  assert.equal(media.storageKey, "media/5512999990000/202608/wamid.pdf");
  assert.equal(media.mimeType, "application/pdf");
  assert.equal(media.filename, "comprovante pix.pdf");
});

test("resolveHistoryMedia reutiliza documento multipart legado", () => {
  const media = resolveHistoryMedia({
    role: "user",
    content: [{
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from("pdf original").toString("base64"),
        filename: "lista.pdf",
      },
    }],
  });

  assert.equal(media.available, true);
  assert.equal(media.mediaType, "document");
  assert.equal(media.filename, "lista.pdf");
  assert.ok(media.mediaData);
});

test("resolveHistoryMedia bloqueia mídia removida", () => {
  assert.deepEqual(resolveHistoryMedia({
    mediaType: "image",
    mediaData: "YWJj",
    mediaDeleted: true,
  }), { available: false });
});

test("contexto para Denise identifica nome e telefone sem alterar sessão", () => {
  const session = { clientName: "João Silva", pipelineStatus: "novo" };
  const before = structuredClone(session);
  assert.equal(
    buildContextCaption(session, "5512981294546"),
    "Arquivo recebido de João Silva — +55 12 98129 4546"
  );
  assert.deepEqual(session, before);
});

test("erro 131047 vira orientação operacional da janela de Denise", () => {
  const result = humanizeMetaForwardError({
    code: 131047,
    message: "Re-engagement message",
    error_data: { details: "More than 24 hours have passed" },
  });
  assert.equal(result.status, 409);
  assert.equal(result.code, "DENISE_WINDOW_CLOSED");
  assert.match(result.error, /janela de 24 horas/i);
});
