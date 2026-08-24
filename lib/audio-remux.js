import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import ffmpegPath from "ffmpeg-static";

import { inspectMp4Structure } from "./mp4-inspection.js";

export const MAX_AUDIO_INPUT_BYTES = 3 * 1024 * 1024;
export const AUDIO_REMUX_TIMEOUT_MS = 15_000;
const MAX_FFMPEG_STDERR_BYTES = 64 * 1024;

export class AudioRemuxError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "AudioRemuxError";
    this.code = code;
  }
}

function fixedFfmpegArgs(inputPath, outputPath) {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel", "error",
    "-i", inputPath,
    "-map", "0:a:0",
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-f", "mp4",
    outputPath,
  ];
}

function runFfmpeg({ binaryPath, inputPath, outputPath, timeoutMs, spawnImpl }) {
  const args = fixedFfmpegArgs(inputPath, outputPath);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(binaryPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    let spawnError = null;

    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_FFMPEG_STDERR_BYTES) {
        stderr += chunk.toString("utf8").slice(0, MAX_FFMPEG_STDERR_BYTES - stderr.length);
      }
    });
    child.once("error", (error) => {
      spawnError = error;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new AudioRemuxError(
          "AUDIO_REMUX_TIMEOUT",
          `FFmpeg excedeu o timeout de ${timeoutMs}ms`,
        ));
        return;
      }
      if (spawnError) {
        reject(new AudioRemuxError("AUDIO_REMUX_SPAWN_FAILED", "Não foi possível iniciar o FFmpeg", { cause: spawnError }));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim().replaceAll(inputPath, "<input>").replaceAll(outputPath, "<output>");
        reject(new AudioRemuxError(
          "AUDIO_REMUX_FFMPEG_FAILED",
          `FFmpeg terminou com code=${code} signal=${signal || "none"}${detail ? `: ${detail}` : ""}`,
        ));
        return;
      }
      resolve({ args });
    });
  });
}

function validateInput(structure) {
  if (!structure.valid || !structure.hasFtyp || !structure.hasMoov || !structure.hasMp4a) {
    throw new AudioRemuxError("AUDIO_REMUX_INVALID_INPUT", "MP4/AAC de entrada estruturalmente inválido");
  }
}

function validateOutput(structure) {
  if (
    structure.bytes <= 0
    || !structure.valid
    || !structure.hasFtyp
    || !structure.hasMoov
    || !structure.hasMdat
    || !structure.hasMp4a
    || structure.hasMvex
    || structure.hasMoof
    || structure.hasTraf
  ) {
    throw new AudioRemuxError("AUDIO_REMUX_INVALID_OUTPUT", "FFmpeg não produziu MP4/AAC convencional válido");
  }
  if (!Number.isFinite(structure.durationMs) || structure.durationMs <= 0) {
    throw new AudioRemuxError("AUDIO_REMUX_INVALID_DURATION", "MP4 remuxado não possui duração válida");
  }
}

function validateDuration(beforeMs, afterMs) {
  if (!Number.isFinite(beforeMs) || beforeMs <= 0) {
    throw new AudioRemuxError("AUDIO_REMUX_INVALID_DURATION", "MP4 de entrada não possui duração válida");
  }
  const toleranceMs = Math.max(250, beforeMs * 0.05);
  if (Math.abs(afterMs - beforeMs) > toleranceMs) {
    throw new AudioRemuxError(
      "AUDIO_REMUX_DURATION_MISMATCH",
      `Duração divergente após remux (${beforeMs.toFixed(2)}ms → ${afterMs.toFixed(2)}ms)`,
    );
  }
}

async function cleanupTempFiles(paths) {
  const failures = [];
  for (const filePath of paths) {
    try {
      await unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AudioRemuxError("AUDIO_REMUX_CLEANUP_FAILED", "Falha ao remover arquivos temporários", { cause: failures[0] });
  }
}

export function createAudioRemuxer({
  binaryPath = ffmpegPath,
  spawnImpl = spawn,
  tempRoot = tmpdir(),
  timeoutMs = AUDIO_REMUX_TIMEOUT_MS,
  uuidFactory = randomUUID,
  maxInputBytes = MAX_AUDIO_INPUT_BYTES,
} = {}) {
  return async function remuxFragmentedMp4(inputBytes) {
    const input = Buffer.isBuffer(inputBytes) ? inputBytes : Buffer.from(inputBytes);
    if (input.length === 0) {
      throw new AudioRemuxError("AUDIO_REMUX_EMPTY_INPUT", "Áudio MP4 vazio");
    }
    if (input.length > maxInputBytes) {
      throw new AudioRemuxError(
        "AUDIO_REMUX_INPUT_TOO_LARGE",
        `Áudio excede o limite de ${maxInputBytes} bytes`,
      );
    }

    const before = inspectMp4Structure(input);
    validateInput(before);
    if (!before.fragmented) {
      return {
        bytes: input,
        metadata: {
          remuxed: false,
          inputBytes: input.length,
          outputBytes: input.length,
          durationBeforeMs: before.durationMs,
          durationAfterMs: before.durationMs,
          processingMs: 0,
          codec: "mp4a",
          fragmentedBefore: false,
          fragmentedAfter: false,
          audioCodecMode: "unchanged",
          cleanupVerified: true,
        },
      };
    }

    const id = uuidFactory();
    const inputPath = path.join(tempRoot, `${id}-input.mp4`);
    const outputPath = path.join(tempRoot, `${id}-output.m4a`);
    const startedAt = performance.now();
    let result;
    let operationError = null;

    try {
      await writeFile(inputPath, input, { flag: "wx" });
      const execution = await runFfmpeg({ binaryPath, inputPath, outputPath, timeoutMs, spawnImpl });
      const output = await readFile(outputPath);
      const after = inspectMp4Structure(output);
      validateOutput(after);
      validateDuration(before.durationMs, after.durationMs);
      result = {
        bytes: output,
        metadata: {
          remuxed: true,
          inputBytes: input.length,
          outputBytes: output.length,
          durationBeforeMs: before.durationMs,
          durationAfterMs: after.durationMs,
          processingMs: performance.now() - startedAt,
          codec: "mp4a",
          fragmentedBefore: true,
          fragmentedAfter: false,
          audioCodecMode: execution.args.includes("copy") ? "copy" : "unknown",
          cleanupVerified: false,
        },
      };
    } catch (error) {
      operationError = error;
    }

    try {
      await cleanupTempFiles([inputPath, outputPath]);
    } catch (cleanupError) {
      throw cleanupError;
    }
    if (operationError) throw operationError;
    result.metadata.cleanupVerified = true;
    return result;
  };
}

export const remuxFragmentedMp4 = createAudioRemuxer();

export async function inspectFfmpegRuntime() {
  const info = await stat(ffmpegPath);
  let executable = true;
  try {
    await access(ffmpegPath, fsConstants.X_OK);
  } catch {
    executable = false;
  }
  return {
    path: ffmpegPath,
    bytes: info.size,
    mode: info.mode,
    executable,
    platform: process.platform,
    arch: process.arch,
  };
}
