// ============================================================
// Sartec — Smoke test seguro para Cloudflare R2
//
// Sem flags:
//   Valida existência das envs (true/false, sem imprimir valores)
//
// Com --confirm-r2-test:
//   Tenta upload de arquivo de diagnóstico pequeno
//   Gera URL presigned
//   Deleta o arquivo de teste ao final
//
// NUNCA:
//   - imprime credenciais, tokens ou segredos
//   - usa dados de clientes
//   - altera dados de produção
// ============================================================

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const RUN_TEST = process.argv.includes("--confirm-r2-test");

// ── Tarefa 1: Verificar envs ──────────────────────────────────────────────────
const envCheck = {
  R2_ACCOUNT_ID:        Boolean(process.env.R2_ACCOUNT_ID),
  R2_ACCESS_KEY_ID:     Boolean(process.env.R2_ACCESS_KEY_ID),
  R2_SECRET_ACCESS_KEY: Boolean(process.env.R2_SECRET_ACCESS_KEY),
  R2_BUCKET:            Boolean(process.env.R2_BUCKET),
  R2_ENDPOINT:          Boolean(process.env.R2_ENDPOINT),
  R2_DISABLED:          Boolean(process.env.R2_DISABLED),
};

const R2_DISABLED_VALUE = process.env.R2_DISABLED; // apenas para checar se é "true"
const allRequired = envCheck.R2_ACCESS_KEY_ID && envCheck.R2_SECRET_ACCESS_KEY &&
                    envCheck.R2_BUCKET && envCheck.R2_ENDPOINT;

console.log("\n══════════════════════════════════════════════════════════════");
console.log("  Sartec — R2 Smoke Test");
console.log(RUN_TEST
  ? "  MODO: TESTE REAL — upload/presign/delete de arquivo diagnóstico"
  : "  MODO: APENAS VALIDAÇÃO DE ENVS (sem upload)");
console.log("══════════════════════════════════════════════════════════════\n");

console.log("  Variáveis de ambiente:");
for (const [key, present] of Object.entries(envCheck)) {
  const icon = present ? "✅" : "❌";
  let extra = "";
  if (key === "R2_DISABLED" && present) {
    extra = R2_DISABLED_VALUE === "true"
      ? " → valor: \"true\"  ⚠️  ROLLBACK ATIVO — uploads ignorados"
      : ` → valor: "${R2_DISABLED_VALUE}" (não é "true" — R2 habilitado)`;
  }
  console.log(`    ${icon} ${key.padEnd(22)}: ${present}${extra}`);
}

console.log();
if (!allRequired) {
  console.log("  ❌ PROBLEMA: uma ou mais envs obrigatórias estão ausentes.");
  console.log("     → R2 está desconfigurado — todo upload cairá em fallback.");
  console.log("     → Verifique Vercel → Project → Settings → Environment Variables.");
} else if (R2_DISABLED_VALUE === "true") {
  console.log("  ⚠️  R2_DISABLED=true — uploads retornam null (rollback ativo).");
  console.log("     → Para reativar: remova ou altere R2_DISABLED na Vercel e faça redeploy.");
} else {
  console.log("  ✅ Todas as envs obrigatórias presentes. R2 está habilitado.");
}
console.log();

if (!RUN_TEST) {
  console.log("  Para testar upload real (sem dados de clientes):");
  console.log("    node scripts/r2-smoke-test.js --confirm-r2-test");
  console.log();
  process.exit(allRequired ? 0 : 1);
}

// ── Tarefa 2: Smoke test real ─────────────────────────────────────────────────
if (!allRequired) {
  console.error("  ❌ Não é possível testar: envs obrigatórias ausentes.");
  process.exit(1);
}

if (R2_DISABLED_VALUE === "true") {
  console.log("  ⚠️  R2_DISABLED=true — smoke test pulado (uploads desabilitados).");
  process.exit(0);
}

const s3 = new S3Client({
  region:   "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const TEST_KEY     = `diagnostics/r2-smoke-test-${Date.now()}.txt`;
const TEST_CONTENT = Buffer.from(
  `Sartec R2 smoke test\ntimestamp: ${new Date().toISOString()}\n`
);
const BUCKET       = process.env.R2_BUCKET;

async function run() {
  let uploadOk   = false;
  let presignOk  = false;
  let deleteOk   = false;
  let presignUrl = null;

  // 1. Upload
  console.log(`  [1/3] Upload de arquivo de diagnóstico...`);
  console.log(`        key : ${TEST_KEY}`);
  console.log(`        size: ${TEST_CONTENT.byteLength} bytes`);
  try {
    await s3.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         TEST_KEY,
      Body:        TEST_CONTENT,
      ContentType: "text/plain",
    }));
    uploadOk = true;
    console.log("        ✅ Upload OK");
  } catch (err) {
    console.error(`        ❌ Upload FALHOU: ${err.name} — ${err.message}`);
    if (err.$metadata) {
      console.error(`           httpStatus: ${err.$metadata.httpStatusCode}`);
    }
  }
  console.log();

  // 2. Presign URL
  if (uploadOk) {
    console.log("  [2/3] Gerando URL presigned (60 segundos)...");
    try {
      const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: TEST_KEY });
      presignUrl = await getSignedUrl(s3, cmd, { expiresIn: 60 });
      presignOk  = true;
      // Imprime apenas o host e path sem query string (sem credenciais embutidas)
      const urlObj = new URL(presignUrl);
      console.log(`        ✅ Presign OK — host: ${urlObj.host}`);
      console.log(`           path: ${urlObj.pathname}`);
    } catch (err) {
      console.error(`        ❌ Presign FALHOU: ${err.name} — ${err.message}`);
    }
    console.log();
  }

  // 3. Delete (cleanup)
  if (uploadOk) {
    console.log("  [3/3] Deletando arquivo de diagnóstico...");
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: TEST_KEY }));
      deleteOk = true;
      console.log("        ✅ Delete OK — arquivo de teste removido");
    } catch (err) {
      console.error(`        ❌ Delete FALHOU: ${err.name} — ${err.message}`);
      console.log(`           ⚠️  O arquivo ${TEST_KEY} pode ter ficado no bucket.`);
    }
    console.log();
  }

  // Resumo
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  RESULTADO DO SMOKE TEST");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Upload   : ${uploadOk  ? "✅ OK" : "❌ FALHOU"}`);
  console.log(`  Presign  : ${presignOk ? "✅ OK" : "❌ FALHOU"}`);
  console.log(`  Delete   : ${deleteOk  ? "✅ OK" : "❌ FALHOU"}`);
  console.log();

  if (uploadOk && presignOk && deleteOk) {
    console.log("  ✅ R2 funcionando corretamente.");
    console.log("     O problema das mídias em redis-fallback é de outra origem.");
    console.log("     (ex: envs ausentes no deploy anterior, cold start, timing)");
  } else if (!uploadOk) {
    console.log("  ❌ Upload falhou — provável causa das mídias em redis-fallback:");
    console.log("     Verificar R2_ENDPOINT, R2_BUCKET, permissões do token.");
  } else if (!presignOk) {
    console.log("  ⚠️  Upload OK mas presign falhou.");
    console.log("     Mídias são salvas no R2, mas o painel não consegue exibi-las.");
  }
  console.log();
  console.log("  ✅ Nenhum dado de cliente foi usado neste teste");
  console.log("  ✅ Nenhuma credencial foi impressa");
  console.log();

  process.exit(uploadOk && presignOk ? 0 : 1);
}

run().catch(err => {
  console.error("❌  Erro fatal:", err.message);
  process.exit(1);
});
