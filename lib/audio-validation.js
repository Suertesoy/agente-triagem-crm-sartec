// ============================================================
// Validação de áudio outbound (atendente → cliente, api/send.js) antes do
// upload à Meta — defesa no backend, além da validação já feita no
// navegador (painel/index.html, inspectRecordedAudio). Nunca confia apenas
// no mimeType declarado pelo request: confere os bytes reais.
//
// Mesma lógica do navegador, duplicada de propósito (este projeto não tem
// bundler ligando painel/index.html a api/*.js — ver comentário equivalente
// lá):
//   - audio/ogg: assinatura "OggS" + pacote OpusHead (RFC 7845) com 1 canal
//     — a Cloud API documenta "mono input only" para audio/ogg.
//   - audio/mp4: assinatura "ftyp" + um sample entry "mp4a" (AAC) em algum
//     stsd na árvore moov > trak > mdia > minf > stbl. Não é um parser MP4
//     completo — só o suficiente para confirmar container + codec.
// ============================================================

function walkMp4Boxes(bytes, start, end, visit) {
  let offset = start;
  while (offset + 8 <= end) {
    const size = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    let boxSize = size;
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      const hi = ((bytes[offset + 8] << 24) | (bytes[offset + 9] << 16) | (bytes[offset + 10] << 8) | bytes[offset + 11]) >>> 0;
      const lo = ((bytes[offset + 12] << 24) | (bytes[offset + 13] << 16) | (bytes[offset + 14] << 8) | bytes[offset + 15]) >>> 0;
      boxSize = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size === 0) {
      boxSize = end - offset;
    }
    if (boxSize < headerSize || offset + boxSize > end) break; // malformado/truncado — para com segurança
    visit(type, offset + headerSize, offset + boxSize);
    offset += boxSize;
  }
}

const MP4_CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "edts", "udta"]);

function hasAacSampleEntry(bytes) {
  let found = false;
  function recurse(start, end) {
    walkMp4Boxes(bytes, start, end, (type, childStart, childEnd) => {
      if (found) return;
      if (type === "stsd") {
        const entryStart = childStart + 8; // fullbox header(4) + entry_count(4)
        if (entryStart + 8 <= childEnd) {
          const fmt = String.fromCharCode(bytes[entryStart + 4], bytes[entryStart + 5], bytes[entryStart + 6], bytes[entryStart + 7]);
          if (fmt === "mp4a") found = true;
        }
      } else if (MP4_CONTAINER_BOXES.has(type)) {
        recurse(childStart, childEnd);
      }
    });
  }
  recurse(0, bytes.length);
  return found;
}

/**
 * Confere os bytes reais de um áudio outbound antes do upload à Meta.
 * Retorna { ok:true } ou { ok:false, reason }. Tipos diferentes de
 * audio/mp4 e audio/ogg passam sem validação adicional — fora do escopo
 * desta correção (o navegador só produz mp4/ogg via MediaRecorder, e só
 * audio/ogg tem exigência de canal documentada pela Cloud API).
 */
export function inspectAudioBytes(bytes, mimeType) {
  if (mimeType === "audio/ogg") {
    if (bytes.length < 28 || bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53) {
      return { ok: false, reason: "not-ogg" };
    }
    const pageSegments = bytes[26];
    const packetStart = 27 + pageSegments;
    const channelsAt = packetStart + 9; // 8 bytes "OpusHead" + 1 byte versão
    if (bytes.length < channelsAt + 1) return { ok: false, reason: "truncated" };
    const magic = String.fromCharCode(
      bytes[packetStart], bytes[packetStart + 1], bytes[packetStart + 2], bytes[packetStart + 3],
      bytes[packetStart + 4], bytes[packetStart + 5], bytes[packetStart + 6], bytes[packetStart + 7]
    );
    if (magic !== "OpusHead") return { ok: false, reason: "not-opus" };
    const channels = bytes[channelsAt];
    if (channels !== 1) return { ok: false, reason: "not-mono", channels };
    return { ok: true };
  }
  if (mimeType === "audio/mp4") {
    if (bytes.length < 8 || String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) !== "ftyp") {
      return { ok: false, reason: "not-mp4" };
    }
    if (!hasAacSampleEntry(bytes)) return { ok: false, reason: "no-aac" };
    return { ok: true };
  }
  return { ok: true };
}

const AUDIO_FILENAME_BY_MIME = {
  "audio/mp4": "audio.m4a",
  "audio/ogg": "audio.ogg",
  "audio/mpeg": "audio.mp3",
  "audio/aac": "audio.aac",
  "audio/amr": "audio.amr",
};

export function inferAudioFilename(mimeType) {
  return AUDIO_FILENAME_BY_MIME[mimeType] || "audio";
}
