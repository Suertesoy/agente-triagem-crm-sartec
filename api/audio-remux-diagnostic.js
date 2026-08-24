// Rota de diagnóstico exclusiva de deployments Preview desta branch.
// Não aceita upload/body e retorna somente metadados estruturais/operacionais.
// Em Production responde 404 mesmo que este arquivo seja acidentalmente incluído.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import ffmpegPath from "ffmpeg-static";
import { inspectFfmpegRuntime, remuxFragmentedMp4 } from "../lib/audio-remux.js";
import { inspectMp4Structure } from "../lib/mp4-inspection.js";

const MODULE_LOADED_AT = Date.now();
let invocationCount = 0;
const DIAGNOSTIC_HEADER = "audio-remux-preview-v1";

function ffmpegVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-version"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg -version terminou com ${code}`));
      else resolve((stdout || stderr).split(/\r?\n/)[0]);
    });
  });
}

export default async function handler(req, res) {
  if (process.env.VERCEL_ENV !== "preview") {
    return res.status(404).json({ error: "Not Found" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  if (req.headers?.["x-sartec-preview-diagnostic"] !== DIAGNOSTIC_HEADER) {
    return res.status(404).json({ error: "Not Found" });
  }

  const handlerStartedAt = performance.now();
  invocationCount += 1;
  const fixtureText = await readFile(
    new URL("../tests/fixtures/synthetic-fmp4-aac.base64", import.meta.url),
    "utf8",
  );
  const input = Buffer.from(fixtureText.replaceAll(/\s/g, ""), "base64");
  const before = inspectMp4Structure(input);
  const remux = await remuxFragmentedMp4(input);
  const after = inspectMp4Structure(remux.bytes);
  const runtime = await inspectFfmpegRuntime();

  return res.status(200).json({
    previewOnly: true,
    invocationCount,
    moduleAgeMs: Date.now() - MODULE_LOADED_AT,
    handlerMs: performance.now() - handlerStartedAt,
    runtime: {
      ...runtime,
      version: await ffmpegVersion(),
    },
    remux: remux.metadata,
    tmpPeakBytesApprox: input.length + remux.bytes.length,
    before: {
      bytes: before.bytes,
      topLevel: before.topLevel.map((box) => box.type),
      durationMs: before.durationMs,
      mp4a: before.hasMp4a,
      mvex: before.hasMvex,
      moof: before.hasMoof,
      traf: before.hasTraf,
    },
    after: {
      bytes: after.bytes,
      topLevel: after.topLevel.map((box) => box.type),
      durationMs: after.durationMs,
      mp4a: after.hasMp4a,
      mvex: after.hasMvex,
      moof: after.hasMoof,
      traf: after.hasTraf,
    },
  });
}
