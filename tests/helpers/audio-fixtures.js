// Fixtures reutilizados pelos testes de validação de áudio outbound:
// - tests/audio-mic-validation.test.js (inspectRecordedAudio, extraída de
//   painel/index.html — validação no navegador)
// - tests/send-audio.test.js (lib/audio-validation.js — validação no backend)
//
// Constrói o mínimo de estrutura ISO-BMFF (MP4) e Ogg/Opus necessário para
// exercitar os detectores reais (assinatura + sample entry / OpusHead), sem
// precisar de arquivos de áudio de verdade.

function mkBox(type, payload = new Uint8Array(0)) {
  const size = 8 + payload.length;
  const box = new Uint8Array(size);
  box[0] = (size >>> 24) & 0xff;
  box[1] = (size >>> 16) & 0xff;
  box[2] = (size >>> 8) & 0xff;
  box[3] = size & 0xff;
  for (let i = 0; i < 4; i++) box[4 + i] = type.charCodeAt(i);
  box.set(payload, 8);
  return box;
}

function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

/**
 * MP4 mínimo: ftyp + moov > trak > mdia > minf > stbl > stsd > sample entry.
 * codec: "mp4a" (AAC — deve validar) ou qualquer outro 4CC (ex.: "alac") para
 * simular um container MP4 sem codec de áudio compatível com o WhatsApp.
 */
export function buildMinimalMp4({ codec = "mp4a" } = {}) {
  const ftyp = mkBox("ftyp", new TextEncoder().encode("isomiso2mp41"));
  const sampleEntry = mkBox(codec, new Uint8Array(8)); // campos reservados — não lidos pelo detector
  const stsdPayload = concatBytes([new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), sampleEntry]); // fullbox header + entry_count=1
  const stsd = mkBox("stsd", stsdPayload);
  const stbl = mkBox("stbl", stsd);
  const minf = mkBox("minf", stbl);
  const mdia = mkBox("mdia", minf);
  const trak = mkBox("trak", mdia);
  const moov = mkBox("moov", trak);
  return concatBytes([ftyp, moov]);
}

// Estrutura intencionalmente incompleta para testar falha segura do remux:
// o parser reconhece fMP4/AAC por moof/traf + stsd/mp4a, mas não há amostras
// nem mdat para o FFmpeg transformar. Nunca deve chegar ao R2/Meta.
export function buildBrokenFragmentedMp4() {
  return concatBytes([
    buildMinimalMp4({ codec: "mp4a" }),
    mkBox("moof", mkBox("traf")),
  ]);
}

/** Primeira página Ogg com um pacote OpusHead (RFC 7845) indicando `channels`. */
export function buildOggOpusPage(channels) {
  const opusHead = new Uint8Array(19);
  opusHead.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  opusHead[8] = 1; // version
  opusHead[9] = channels;

  const header = new Uint8Array(28);
  header.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  header[4] = 0;
  header[5] = 0x02;
  header[26] = 1; // page_segments
  header[27] = opusHead.length;

  return concatBytes([header, opusHead]);
}
