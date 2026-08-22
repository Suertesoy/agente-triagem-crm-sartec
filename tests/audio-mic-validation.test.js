// Testa inspectRecordedAudio() (painel/index.html) — a validação real de
// container/codec/canais do áudio gravado pelo MediaRecorder, adicionada
// para corrigir o erro 131053 "Media upload error" da Meta: mono obrigatório
// para audio/ogg, e AAC (mp4a) comprovado — não apenas o container ftyp —
// para audio/mp4. Como painel/index.html não é um módulo ES (arquivo único
// sem bundler), o bloco de funções é extraído por regex do próprio arquivo
// fonte e avaliado isoladamente — garante que o código testado é exatamente
// o que roda no navegador, sem duplicar a lógica aqui.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildMinimalMp4, buildOggOpusPage } from "./helpers/audio-fixtures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, "..", "painel", "index.html"), "utf8");

// inspectRecordedAudio() chama detectMp4AacCodec(), que chama _walkMp4Boxes()
// — extrai o bloco inteiro (na ordem em que aparece no arquivo) para que as
// três funções fiquem no mesmo escopo ao serem avaliadas.
const match = html.match(/function _walkMp4Boxes\([\s\S]*?function inspectRecordedAudio\([\s\S]*?\n\}\r?\n/);
if (!match) throw new Error("Bloco _walkMp4Boxes..inspectRecordedAudio não encontrado em painel/index.html — verifique se as funções foram renomeadas/movidas");

const inspectRecordedAudio = new Function(`${match[0]}\nreturn inspectRecordedAudio;`)();

describe("inspectRecordedAudio — validação real de bytes (não apenas o mimeType escolhido)", () => {
  test("Ogg/Opus mono (1 canal) é aceito", () => {
    const page = buildOggOpusPage(1);
    const result = inspectRecordedAudio(page, "ogg");
    assert.equal(result.ok, true);
  });

  test("Ogg/Opus estéreo (2 canais) é rejeitado — exatamente a causa documentada do 131053 para audio/ogg", () => {
    const page = buildOggOpusPage(2);
    const result = inspectRecordedAudio(page, "ogg");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not-mono");
    assert.equal(result.channels, 2);
  });

  test("bytes que não começam com a assinatura OggS são rejeitados como container errado", () => {
    const garbage = new Uint8Array(40).fill(0x00);
    const result = inspectRecordedAudio(garbage, "ogg");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not-ogg");
  });

  test("MP4 com ftyp + sample entry mp4a (AAC) é aceito", () => {
    const bytes = buildMinimalMp4({ codec: "mp4a" });
    const result = inspectRecordedAudio(bytes, "mp4");
    assert.equal(result.ok, true);
  });

  test("MP4 com ftyp mas SEM sample entry mp4a é rejeitado — container sozinho não comprova o codec", () => {
    const bytes = buildMinimalMp4({ codec: "alac" }); // qualquer codec que não seja AAC
    const result = inspectRecordedAudio(bytes, "mp4");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-aac");
  });

  test("bytes sem assinatura ftyp são rejeitados para o container mp4 (nunca mascara o mimeType)", () => {
    const garbage = new Uint8Array(20).fill(0xff);
    const result = inspectRecordedAudio(garbage, "mp4");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "not-mp4");
  });

  test("container desconhecido é sempre rejeitado", () => {
    const result = inspectRecordedAudio(new Uint8Array(10), "webm");
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown-container");
  });
});
