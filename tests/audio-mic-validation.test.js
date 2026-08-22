// Testa inspectRecordedAudio() (painel/index.html) — a validação real de
// container/canais do áudio gravado pelo MediaRecorder, adicionada para
// corrigir o erro 131053 "Media upload error" da Meta (que exige mono para
// audio/ogg). Como painel/index.html não é um módulo ES (arquivo único sem
// bundler), a função é extraída por regex do próprio arquivo fonte e avaliada
// isoladamente — garante que o código testado é exatamente o que roda no
// navegador, sem duplicar a lógica aqui.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, "..", "painel", "index.html"), "utf8");

const match = html.match(/function inspectRecordedAudio\([\s\S]*?\n\}\r?\n/);
if (!match) throw new Error("inspectRecordedAudio não encontrada em painel/index.html — verifique se a função foi renomeada/movida");

const inspectRecordedAudio = new Function(`${match[0]}\nreturn inspectRecordedAudio;`)();

// Monta uma primeira página Ogg mínima e válida contendo um pacote OpusHead
// (RFC 7845) com o número de canais informado.
function buildOggOpusPage(channels) {
  const opusHead = new Uint8Array(19);
  opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  opusHead[8] = 1; // version
  opusHead[9] = channels;
  // demais bytes (pre-skip, sample rate, gain, mapping family) — valores não testados, zeros bastam

  const header = new Uint8Array(28); // OggS(4)+version(1)+headerType(1)+granule(8)+serial(4)+seq(4)+checksum(4)+pageSegments(1)+1 segment entry
  header.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  header[4] = 0; // version
  header[5] = 0x02; // header_type (BOS)
  // bytes 6-25 (granule/serial/seq/checksum) podem ficar zero para este teste
  header[26] = 1; // page_segments = 1
  header[27] = opusHead.length; // segment table: 1 entrada com o tamanho do pacote

  const page = new Uint8Array(header.length + opusHead.length);
  page.set(header, 0);
  page.set(opusHead, header.length);
  return page;
}

function buildMp4Ftyp() {
  const bytes = new Uint8Array(16);
  bytes.set([0x00, 0x00, 0x00, 0x10], 0); // box size (irrelevante para o teste)
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // "ftyp"
  return bytes;
}

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

  test("MP4 com assinatura ftyp válida é aceito", () => {
    const bytes = buildMp4Ftyp();
    const result = inspectRecordedAudio(bytes, "mp4");
    assert.equal(result.ok, true);
  });

  test("bytes sem assinatura ftyp são rejeitados para o container mp4", () => {
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
