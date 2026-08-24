// Inspeção estrutural ISO-BMFF para áudio MP4.
//
// O parser caminha pelos headers size/type dos boxes; não procura strings
// soltas nos bytes. Ele reconhece os containers necessários para distinguir
// MP4 convencional de fragmented MP4 e lê os campos de duração usados pelo
// remux outbound.

const CONTAINER_BOXES = new Set([
  "moov", "trak", "mdia", "minf", "stbl", "dinf", "edts", "mvex",
  "moof", "traf", "mfra", "udta", "sinf", "schi", "iprp", "ipco",
]);

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new TypeError("bytes deve ser Buffer ou Uint8Array");
}

function readUint64(buffer, offset) {
  const value = buffer.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("valor uint64 excede Number.MAX_SAFE_INTEGER");
  }
  return Number(value);
}

function readBoxHeader(buffer, offset, end) {
  if (offset + 8 > end) return null;
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.toString("latin1", offset + 4, offset + 8);
  let size = size32;
  let headerSize = 8;

  if (size32 === 1) {
    if (offset + 16 > end) return null;
    size = readUint64(buffer, offset + 8);
    headerSize = 16;
  } else if (size32 === 0) {
    size = end - offset;
  }

  if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) {
    return null;
  }
  return { type, offset, size, headerSize, payloadStart: offset + headerSize, end: offset + size };
}

function readFullBox(buffer, box) {
  if (box.payloadStart + 4 > box.end) return null;
  return {
    version: buffer[box.payloadStart],
    flags: buffer.readUIntBE(box.payloadStart + 1, 3),
    dataStart: box.payloadStart + 4,
  };
}

function readMovieTiming(buffer, box) {
  const full = readFullBox(buffer, box);
  if (!full) return null;
  const p = box.payloadStart;
  try {
    const timescale = full.version === 1
      ? buffer.readUInt32BE(p + 20)
      : buffer.readUInt32BE(p + 12);
    const duration = full.version === 1
      ? readUint64(buffer, p + 24)
      : buffer.readUInt32BE(p + 16);
    return {
      version: full.version,
      timescale,
      duration,
      durationMs: timescale > 0 ? (duration * 1000) / timescale : null,
    };
  } catch {
    return null;
  }
}

function readTrex(buffer, box) {
  const full = readFullBox(buffer, box);
  if (!full || full.dataStart + 20 > box.end) return null;
  return {
    trackId: buffer.readUInt32BE(full.dataStart),
    defaultSampleDuration: buffer.readUInt32BE(full.dataStart + 8),
  };
}

function readTfhd(buffer, box) {
  const full = readFullBox(buffer, box);
  if (!full || full.dataStart + 4 > box.end) return null;
  let offset = full.dataStart;
  const trackId = buffer.readUInt32BE(offset);
  offset += 4;
  if (full.flags & 0x000001) offset += 8;
  if (full.flags & 0x000002) offset += 4;
  let defaultSampleDuration = null;
  if (full.flags & 0x000008) {
    if (offset + 4 > box.end) return null;
    defaultSampleDuration = buffer.readUInt32BE(offset);
  }
  return { trackId, defaultSampleDuration };
}

function readTrun(buffer, box, traf, trexDefaults) {
  const full = readFullBox(buffer, box);
  if (!full || full.dataStart + 4 > box.end) return null;
  let offset = full.dataStart;
  const sampleCount = buffer.readUInt32BE(offset);
  offset += 4;
  if (full.flags & 0x000001) offset += 4;
  if (full.flags & 0x000004) offset += 4;

  let durationUnits = 0;
  let sampleBytes = 0;
  const defaultDuration = traf.defaultSampleDuration
    ?? trexDefaults.get(traf.trackId)?.defaultSampleDuration
    ?? null;

  for (let i = 0; i < sampleCount; i += 1) {
    if (full.flags & 0x000100) {
      if (offset + 4 > box.end) return null;
      durationUnits += buffer.readUInt32BE(offset);
      offset += 4;
    } else if (defaultDuration != null) {
      durationUnits += defaultDuration;
    } else {
      durationUnits = null;
    }
    if (full.flags & 0x000200) {
      if (offset + 4 > box.end) return null;
      sampleBytes += buffer.readUInt32BE(offset);
      offset += 4;
    }
    if (full.flags & 0x000400) offset += 4;
    if (full.flags & 0x000800) offset += 4;
    if (offset > box.end) return null;
  }
  return { trackId: traf.trackId, sampleCount, durationUnits, sampleBytes };
}

export function inspectMp4Structure(bytes) {
  const buffer = asBuffer(bytes);
  const counts = Object.create(null);
  const topLevel = [];
  const tree = [];
  const errors = [];
  const movieTimings = [];
  const mediaTimings = [];
  const trexDefaults = new Map();
  const fragmentRuns = [];
  let hasMp4a = false;

  function record(type, depth, box, kind = "box") {
    counts[type] = (counts[type] || 0) + 1;
    tree.push({ type, depth, offset: box.offset, size: box.size, kind });
    if (depth === 0) topLevel.push({ type, offset: box.offset, size: box.size });
  }

  function parseSampleDescriptions(box, depth) {
    if (box.payloadStart + 8 > box.end) {
      errors.push(`stsd truncado em ${box.offset}`);
      return;
    }
    const entryCount = buffer.readUInt32BE(box.payloadStart + 4);
    let offset = box.payloadStart + 8;
    for (let index = 0; index < entryCount; index += 1) {
      const entry = readBoxHeader(buffer, offset, box.end);
      if (!entry) {
        errors.push(`sample entry inválido em ${offset}`);
        return;
      }
      record(entry.type, depth + 1, entry, "sample-entry");
      if (entry.type === "mp4a") {
        hasMp4a = true;
        if (entry.payloadStart + 28 <= entry.end) {
          const version = buffer.readUInt16BE(entry.payloadStart + 8);
          const extensionBytes = version === 1 ? 16 : version === 2 ? 36 : 0;
          parseRange(entry.payloadStart + 28 + extensionBytes, entry.end, depth + 2, null);
        }
      }
      offset = entry.end;
    }
  }

  function parseDataReferences(box, depth) {
    if (box.payloadStart + 8 > box.end) return;
    let offset = box.payloadStart + 8;
    while (offset + 8 <= box.end) {
      const entry = readBoxHeader(buffer, offset, box.end);
      if (!entry) return;
      record(entry.type, depth + 1, entry);
      offset = entry.end;
    }
  }

  function parseRange(start, end, depth, trafContext) {
    let offset = start;
    while (offset + 8 <= end) {
      const box = readBoxHeader(buffer, offset, end);
      if (!box) {
        errors.push(`box inválido/truncado em ${offset}`);
        return;
      }
      record(box.type, depth, box);

      if (box.type === "mvhd") {
        const timing = readMovieTiming(buffer, box);
        if (timing) movieTimings.push(timing);
      } else if (box.type === "mdhd") {
        const timing = readMovieTiming(buffer, box);
        if (timing) mediaTimings.push(timing);
      } else if (box.type === "trex") {
        const trex = readTrex(buffer, box);
        if (trex) trexDefaults.set(trex.trackId, trex);
      } else if (box.type === "tfhd" && trafContext) {
        const tfhd = readTfhd(buffer, box);
        if (tfhd) Object.assign(trafContext, tfhd);
      } else if (box.type === "trun" && trafContext) {
        const run = readTrun(buffer, box, trafContext, trexDefaults);
        if (run) fragmentRuns.push(run);
      }

      if (box.type === "traf") {
        parseRange(box.payloadStart, box.end, depth + 1, {
          trackId: null,
          defaultSampleDuration: null,
        });
      } else if (CONTAINER_BOXES.has(box.type)) {
        parseRange(box.payloadStart, box.end, depth + 1, trafContext);
      } else if (box.type === "meta") {
        parseRange(box.payloadStart + 4, box.end, depth + 1, trafContext);
      } else if (box.type === "stsd") {
        parseSampleDescriptions(box, depth);
      } else if (box.type === "dref") {
        parseDataReferences(box, depth);
      }
      offset = box.end;
    }
    if (offset !== end) errors.push(`${end - offset} bytes residuais após boxes em ${start}`);
  }

  try {
    parseRange(0, buffer.length, 0, null);
  } catch (error) {
    errors.push(error.message);
  }

  const firstMovie = movieTimings[0] || null;
  const firstMedia = mediaTimings[0] || null;
  const fragmentDurationUnits = fragmentRuns.length > 0 && fragmentRuns.every((run) => run.durationUnits != null)
    ? fragmentRuns.reduce((sum, run) => sum + run.durationUnits, 0)
    : null;
  const fragmentDurationMs = fragmentDurationUnits != null && firstMedia?.timescale > 0
    ? (fragmentDurationUnits * 1000) / firstMedia.timescale
    : null;
  const fragmented = Boolean(counts.mvex || counts.moof || counts.traf);
  const durationMs = fragmented && fragmentDurationMs != null && fragmentDurationMs > 0
    ? fragmentDurationMs
    : firstMovie?.durationMs ?? firstMedia?.durationMs ?? null;

  return {
    bytes: buffer.length,
    valid: errors.length === 0,
    errors,
    topLevel,
    tree,
    counts: { ...counts },
    hasFtyp: topLevel.some((box) => box.type === "ftyp"),
    hasMoov: topLevel.some((box) => box.type === "moov"),
    hasMdat: topLevel.some((box) => box.type === "mdat"),
    hasMp4a,
    hasMvex: Boolean(counts.mvex),
    hasMoof: Boolean(counts.moof),
    hasTraf: Boolean(counts.traf),
    fragmented,
    codec: hasMp4a ? "mp4a" : null,
    durationMs,
    movieTiming: firstMovie,
    mediaTiming: firstMedia,
    fragmentTiming: {
      timescale: firstMedia?.timescale ?? null,
      durationUnits: fragmentDurationUnits,
      durationMs: fragmentDurationMs,
      sampleCount: fragmentRuns.reduce((sum, run) => sum + run.sampleCount, 0),
      sampleBytes: fragmentRuns.reduce((sum, run) => sum + run.sampleBytes, 0),
    },
  };
}
