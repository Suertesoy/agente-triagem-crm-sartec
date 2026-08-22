// ============================================================
// Sartec — Diagnóstico do caminho de áudio outbound via link do R2
//
// Confirma que uma URL presigned gerada por getMediaUrl() é exatamente o que
// a Meta precisaria buscar via `audio.link`: HTTP 200, Content-Type correto,
// Content-Length coerente, bytes idênticos ao objeto enviado.
//
// Sem flags:
//   Apenas valida existência das envs R2 (true/false, sem imprimir valores)
//
// Com --confirm-r2-test:
//   Faz upload de um MP4/AAC mínimo de diagnóstico
//   Confirma o Content-Type salvo via HEAD
//   Gera URL presigned e faz um GET real nela
//   Compara os bytes baixados com os enviados (SHA-256)
//   Deleta o objeto de teste ao final
//
// NUNCA:
//   - imprime a URL presigned completa (ela carrega credenciais temporárias)
//   - imprime credenciais, tokens ou segredos
//   - usa dados de clientes
//   - altera dados de produção
// ============================================================

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const RUN_TEST = process.argv.includes("--confirm-r2-test");

const envCheck = {
  R2_ACCOUNT_ID:        Boolean(process.env.R2_ACCOUNT_ID),
  R2_ACCESS_KEY_ID:     Boolean(process.env.R2_ACCESS_KEY_ID),
  R2_SECRET_ACCESS_KEY: Boolean(process.env.R2_SECRET_ACCESS_KEY),
  R2_BUCKET:            Boolean(process.env.R2_BUCKET),
  R2_ENDPOINT:          Boolean(process.env.R2_ENDPOINT),
  R2_DISABLED:          Boolean(process.env.R2_DISABLED),
};
const allRequired = envCheck.R2_ACCESS_KEY_ID && envCheck.R2_SECRET_ACCESS_KEY &&
                    envCheck.R2_BUCKET && envCheck.R2_ENDPOINT;

console.log("\n══════════════════════════════════════════════════════════════");
console.log("  Sartec — Diagnóstico do áudio via link do R2");
console.log(RUN_TEST
  ? "  MODO: TESTE REAL — upload + HEAD + GET presigned + comparação de bytes"
  : "  MODO: APENAS VALIDAÇÃO DE ENVS (sem upload)");
console.log("══════════════════════════════════════════════════════════════\n");

for (const [key, present] of Object.entries(envCheck)) {
  console.log(`    ${present ? "✅" : "❌"} ${key.padEnd(22)}: ${present}`);
}
console.log();

if (!RUN_TEST) {
  if (!allRequired) console.log("  ❌ Envs obrigatórias ausentes — R2 está desconfigurado.");
  else console.log("  ✅ Envs presentes. Rode com --confirm-r2-test para o teste real.");
  console.log("\n    node scripts/r2-audio-link-diagnostic.js --confirm-r2-test\n");
  process.exit(allRequired ? 0 : 1);
}

if (!allRequired) {
  console.error("  ❌ Não é possível testar: envs obrigatórias ausentes.");
  process.exit(1);
}
if (process.env.R2_DISABLED === "true") {
  console.log("  ⚠️  R2_DISABLED=true — o caminho por link cai automaticamente para o legado media_id em produção.");
  console.log("     Este diagnóstico testa o R2 em si mesmo assim (upload direto).");
}

const { uploadMedia, headMediaObject, getMediaUrl, deleteMedia } =
  await import(pathToFileURL(path.join(REPO_ROOT, "api", "_lib", "media-storage.js")).href);

// MP4 mínimo com sample entry "mp4a" (AAC) — mesmo formato que
// tests/helpers/audio-fixtures.js usa, para bater com o que
// lib/audio-validation.js espera de um audio/mp4 válido.
function mkBox(type, payload = new Uint8Array(0)) {
  const size = 8 + payload.length;
  const box = new Uint8Array(size);
  box[0] = (size >>> 24) & 0xff; box[1] = (size >>> 16) & 0xff;
  box[2] = (size >>> 8) & 0xff;  box[3] = size & 0xff;
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
const ftyp = mkBox("ftyp", new TextEncoder().encode("isomiso2mp41"));
const sampleEntry = mkBox("mp4a", new Uint8Array(8));
const stsd = mkBox("stsd", concatBytes([new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]), sampleEntry]));
const stbl = mkBox("stbl", stsd);
const minf = mkBox("minf", stbl);
const mdia = mkBox("mdia", minf);
const trak = mkBox("trak", mdia);
const moov = mkBox("moov", trak);
const TEST_BUFFER = Buffer.from(concatBytes([ftyp, moov]));
const TEST_MIME = "audio/mp4";
const TEST_PHONE = "_diagnostic_audio_link"; // claramente não é um telefone real de cliente
const TEST_ID = `diag_${Date.now()}`;

async function run() {
  let storageKey = null;
  let uploadOk = false, headOk = false, getOk = false, bytesMatchOk = false, deleteOk = false;

  try {
    console.log("  [1/4] Upload do MP4/AAC de diagnóstico para o R2...");
    const up = await uploadMedia(TEST_BUFFER, TEST_MIME, TEST_PHONE, TEST_ID);
    if (!up) throw new Error("uploadMedia retornou null (R2_DISABLED?)");
    storageKey = up.storageKey;
    uploadOk = true;
    console.log(`        ✅ key=${storageKey} size=${up.size}`);
    console.log();

    console.log("  [2/4] Confirmando Content-Type via HEAD...");
    const head = await headMediaObject(storageKey);
    if (!head.exists) throw new Error("HEAD reportou objeto inexistente logo após upload");
    if (head.mimeType !== TEST_MIME) throw new Error(`Content-Type inesperado: ${head.mimeType}`);
    headOk = true;
    console.log(`        ✅ mimeType=${head.mimeType} size=${head.size}`);
    console.log();

    console.log("  [3/4] Gerando URL presigned e fazendo GET real (URL não será impressa)...");
    const url = await getMediaUrl(storageKey, 900);
    const res = await fetch(url);
    console.log(`        status=${res.status} content-type=${res.headers.get("content-type")} content-length=${res.headers.get("content-length")}`);
    if (res.status !== 200) throw new Error(`GET retornou ${res.status}, esperado 200`);
    if (res.headers.get("content-type") !== TEST_MIME) throw new Error(`Content-Type da resposta HTTP inesperado: ${res.headers.get("content-type")}`);
    getOk = true;
    console.log();

    console.log("  [4/4] Comparando bytes baixados com os enviados (SHA-256)...");
    const downloaded = Buffer.from(await res.arrayBuffer());
    const sameSize = downloaded.length === TEST_BUFFER.length;
    const sameHash = createHash("sha256").update(downloaded).digest("hex") === createHash("sha256").update(TEST_BUFFER).digest("hex");
    bytesMatchOk = sameSize && sameHash;
    console.log(`        tamanho igual=${sameSize} hash igual=${sameHash}`);
    console.log();
  } catch (err) {
    console.error(`  ❌ FALHOU: ${err.message}\n`);
  } finally {
    if (storageKey) {
      try {
        await deleteMedia(storageKey);
        deleteOk = true;
        console.log(`  🧹 Objeto de diagnóstico removido: ${storageKey}\n`);
      } catch (err) {
        console.warn(`  ⚠️  Falha ao limpar objeto de diagnóstico (${storageKey}): ${err.message}\n`);
      }
    }
  }

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  RESULTADO");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Upload         : ${uploadOk      ? "✅ OK" : "❌ FALHOU"}`);
  console.log(`  HEAD (MIME)    : ${headOk        ? "✅ OK" : "❌ FALHOU"}`);
  console.log(`  GET (200)      : ${getOk         ? "✅ OK" : "❌ FALHOU"}`);
  console.log(`  Bytes idênticos: ${bytesMatchOk  ? "✅ OK" : "❌ FALHOU"}`);
  console.log(`  Limpeza        : ${deleteOk      ? "✅ OK" : "❌ FALHOU"}`);
  console.log();
  console.log("  ✅ Nenhum dado de cliente foi usado neste teste");
  console.log("  ✅ Nenhuma credencial ou URL presigned foi impressa");
  console.log();

  process.exit(uploadOk && headOk && getOk && bytesMatchOk ? 0 : 1);
}

run().catch((err) => {
  console.error("❌  Erro fatal:", err.message);
  process.exit(1);
});
