import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import ffmpegPath from "ffmpeg-static";

import {
  AudioRemuxError,
  MAX_AUDIO_INPUT_BYTES,
  createAudioRemuxer,
  remuxFragmentedMp4,
} from "../lib/audio-remux.js";
import { inspectMp4Structure } from "../lib/mp4-inspection.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixtureBase64 = await readFile(path.join(HERE, "fixtures", "synthetic-fmp4-aac.base64"), "utf8");
const FRAGMENTED_MP4 = Buffer.from(fixtureBase64.replaceAll(/\s/g, ""), "base64");
let CONVENTIONAL_MP4;
let REAL_REMUX_METADATA;

function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

async function packetHash(bytes) {
  const filePath = path.join(tmpdir(), `${randomUUID()}-packet-hash.mp4`);
  await writeFile(filePath, bytes, { flag: "wx" });
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        "-i", filePath,
        "-map", "0:a:0",
        "-c:a", "copy",
        "-f", "hash",
        "-hash", "sha256",
        "-",
      ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) reject(new Error(stderr || `packet hash exit ${code}`));
        else resolve(stdout.trim());
      });
    });
  } finally {
    await unlink(filePath);
  }
}

before(async () => {
  const result = await remuxFragmentedMp4(FRAGMENTED_MP4);
  CONVENTIONAL_MP4 = result.bytes;
  REAL_REMUX_METADATA = result.metadata;
});

describe("inspeção ISO-BMFF", () => {
  test("fixture AAC fragmentada contém mvex/moof/traf e sample entry mp4a", () => {
    const structure = inspectMp4Structure(FRAGMENTED_MP4);
    assert.equal(structure.valid, true);
    assert.deepEqual(structure.topLevel.map((box) => box.type), ["ftyp", "moov", "moof", "mdat", "mfra"]);
    assert.equal(structure.hasMp4a, true);
    assert.equal(structure.hasMvex, true);
    assert.equal(structure.hasMoof, true);
    assert.equal(structure.hasTraf, true);
    assert.equal(structure.fragmented, true);
    assert.ok(structure.durationMs > 0);
  });
});

describe("remux fMP4/AAC → MP4 convencional/AAC", () => {
  test("FFmpeg produz output convencional válido e preserva duração", () => {
    const after = inspectMp4Structure(CONVENTIONAL_MP4);
    assert.equal(REAL_REMUX_METADATA.remuxed, true);
    assert.equal(REAL_REMUX_METADATA.audioCodecMode, "copy");
    assert.equal(REAL_REMUX_METADATA.cleanupVerified, true);
    assert.equal(after.hasFtyp, true);
    assert.equal(after.hasMoov, true);
    assert.equal(after.hasMdat, true);
    assert.equal(after.hasMp4a, true);
    assert.equal(after.hasMvex, false);
    assert.equal(after.hasMoof, false);
    assert.equal(after.hasTraf, false);
    assert.equal(after.fragmented, false);
    assert.ok(Math.abs(REAL_REMUX_METADATA.durationAfterMs - REAL_REMUX_METADATA.durationBeforeMs) <= 250);
  });

  test("hash dos pacotes AAC é idêntico antes/depois — nenhum reencode", async () => {
    assert.equal(await packetHash(CONVENTIONAL_MP4), await packetHash(FRAGMENTED_MP4));
  });

  test("MP4 convencional retorna exatamente o mesmo Buffer sem spawn", async () => {
    let spawnCount = 0;
    const remux = createAudioRemuxer({
      spawnImpl() {
        spawnCount += 1;
        throw new Error("spawn não deveria ocorrer");
      },
    });
    const result = await remux(CONVENTIONAL_MP4);
    assert.strictEqual(result.bytes, CONVENTIONAL_MP4);
    assert.equal(result.metadata.remuxed, false);
    assert.equal(spawnCount, 0);
  });

  test("spawn usa argumentos fixos, -c:a copy e shell:false", async () => {
    let observed;
    const tempRoot = await mkdtemp(path.join(tmpdir(), "sartec-remux-args-"));
    const remux = createAudioRemuxer({
      tempRoot,
      spawnImpl(binary, args, options) {
        observed = { binary, args, options };
        const child = fakeChild();
        void writeFile(args.at(-1), CONVENTIONAL_MP4).then(() => child.emit("close", 0, null));
        return child;
      },
    });
    try {
      await remux(FRAGMENTED_MP4);
      assert.equal(observed.options.shell, false);
      assert.deepEqual(observed.args.slice(observed.args.indexOf("-c:a"), observed.args.indexOf("-c:a") + 2), ["-c:a", "copy"]);
      assert.deepEqual(observed.args.slice(observed.args.indexOf("-f"), observed.args.indexOf("-f") + 2), ["-f", "mp4"]);
      assert.equal(observed.args.includes("-ac"), false);
      assert.equal(observed.args.includes("-ar"), false);
      assert.equal(observed.args.includes("-b:a"), false);
      assert.deepEqual(await readdir(tempRoot), []);
    } finally {
      await rm(tempRoot, { recursive: true });
    }
  });

  test("timeout mata o processo, aborta e limpa input/output em /tmp", async () => {
    let killed = false;
    const tempRoot = await mkdtemp(path.join(tmpdir(), "sartec-remux-timeout-"));
    const remux = createAudioRemuxer({
      tempRoot,
      timeoutMs: 10,
      spawnImpl() {
        const child = fakeChild();
        child.kill = () => {
          killed = true;
          queueMicrotask(() => child.emit("close", null, "SIGKILL"));
          return true;
        };
        return child;
      },
    });
    try {
      await assert.rejects(remux(FRAGMENTED_MP4), (error) => {
        assert.ok(error instanceof AudioRemuxError);
        assert.equal(error.code, "AUDIO_REMUX_TIMEOUT");
        return true;
      });
      assert.equal(killed, true);
      assert.deepEqual(await readdir(tempRoot), []);
    } finally {
      await rm(tempRoot, { recursive: true });
    }
  });

  test("falha do FFmpeg aborta e limpa os temporários", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "sartec-remux-failure-"));
    const remux = createAudioRemuxer({
      tempRoot,
      spawnImpl() {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from("simulated failure"));
          child.emit("close", 1, null);
        });
        return child;
      },
    });
    try {
      await assert.rejects(remux(FRAGMENTED_MP4), (error) => {
        assert.equal(error.code, "AUDIO_REMUX_FFMPEG_FAILED");
        return true;
      });
      assert.deepEqual(await readdir(tempRoot), []);
    } finally {
      await rm(tempRoot, { recursive: true });
    }
  });

  test("entrada acima do limite é rejeitada antes de criar temporários/spawn", async () => {
    let spawnCount = 0;
    const remux = createAudioRemuxer({
      spawnImpl() {
        spawnCount += 1;
        throw new Error("não deveria executar");
      },
    });
    await assert.rejects(remux(Buffer.alloc(MAX_AUDIO_INPUT_BYTES + 1)), (error) => {
      assert.equal(error.code, "AUDIO_REMUX_INPUT_TOO_LARGE");
      return true;
    });
    assert.equal(spawnCount, 0);
  });
});
