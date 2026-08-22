// Module customization hook: redirects the external SDKs the webhook/send
// routes depend on ("ioredis", "@anthropic-ai/sdk", "@aws-sdk/client-s3",
// "@aws-sdk/s3-request-presigner") to local in-memory fakes, so tests never
// touch a real Redis instance, the real Anthropic API, or a real R2/S3
// bucket. R2 stays disabled by default in tests (R2_DISABLED=true, set in
// harness.js) — the S3 fakes only matter for the handful of tests that
// temporarily flip R2_DISABLED=false to exercise the audio-via-R2-link path.
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const DIR = path.dirname(fileURLToPath(import.meta.url));

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "ioredis") {
    return { url: pathToFileURL(path.join(DIR, "fake-ioredis.js")).href, shortCircuit: true };
  }
  if (specifier === "@anthropic-ai/sdk") {
    return { url: pathToFileURL(path.join(DIR, "fake-anthropic.js")).href, shortCircuit: true };
  }
  if (specifier === "@aws-sdk/client-s3") {
    return { url: pathToFileURL(path.join(DIR, "fake-s3.js")).href, shortCircuit: true };
  }
  if (specifier === "@aws-sdk/s3-request-presigner") {
    return { url: pathToFileURL(path.join(DIR, "fake-s3-presigner.js")).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
