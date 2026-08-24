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
//   - audio/mp4: boxes ISO-BMFF caminhados por size/type + sample entry mp4a.
// ============================================================

import { inspectMp4Structure } from "./mp4-inspection.js";

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
    const structure = inspectMp4Structure(bytes);
    if (!structure.valid || !structure.hasFtyp || !structure.hasMoov) return { ok: false, reason: "not-mp4" };
    if (!structure.hasMp4a) return { ok: false, reason: "no-aac" };
    return {
      ok: true,
      codec: "mp4a",
      fragmented: structure.fragmented,
      durationMs: structure.durationMs,
    };
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
