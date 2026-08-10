// Module customization hook: redirects the two external SDKs the webhook
// depends on ("ioredis", "@anthropic-ai/sdk") to local in-memory fakes, so
// tests never touch a real Redis instance or the real Anthropic API.
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
  return nextResolve(specifier, context);
}
