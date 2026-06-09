// ============================================================
// Sartec — Limpeza segura de archives Redis
//
// Por padrão: DRY-RUN (apenas mostra o que seria apagado, sem deletar nada)
//
// Para deletar de fato (somente com autorização explícita do Lucas):
//   node scripts/redis-clean-archives.js --confirm-delete-archives
//
// NUNCA toca em:
//   sartec:{phone}       — sessões principais de conversa
//   sartec:contact:*     — contatos
//   sartec:settings:*    — configurações
//   sartec:pipelineOrder — ordem do pipeline
//   lock:sartec:*        — locks de concorrência
//   qualquer chave que não comece exatamente com "sartec:archive:"
// ============================================================

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("❌  REDIS_URL não definida. Exporte antes de rodar:");
  console.error("    REDIS_URL=rediss://... node scripts/redis-clean-archives.js");
  process.exit(1);
}

const DRY_RUN   = !process.argv.includes("--confirm-delete-archives");
const BATCH_SZ  = 10;   // lotes pequenos para não estressar o servidor

const redis = new Redis(REDIS_URL, {
  connectTimeout: 10_000,
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
});
redis.on("error", () => {});

function fmt(bytes) {
  if (typeof bytes !== "number" || bytes < 0) return "n/a";
  if (bytes < 1_024)             return `${bytes} B`;
  if (bytes < 1_048_576)         return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

async function memUsage(key) {
  try {
    const b = await redis.call("MEMORY", "USAGE", key);
    return typeof b === "number" ? b : 0;
  } catch { return 0; }
}

async function safeDelete(key) {
  // Guarda dupla — nunca deleta fora do namespace sartec:archive:
  if (!key.startsWith("sartec:archive:")) {
    throw new Error(`Recusado — fora do escopo: ${key}`);
  }
  try {
    await redis.unlink(key);   // UNLINK é assíncrono e não bloqueia o servidor
  } catch {
    await redis.del(key);      // fallback para versões antigas do Redis
  }
}

async function run() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Sartec — Redis Archive Cleanup");
  if (DRY_RUN) {
    console.log("  MODO: DRY-RUN — nada será apagado");
  } else {
    console.log("  MODO: ⚠️  DELEÇÃO REAL ATIVADA — archives serão removidos");
  }
  console.log("══════════════════════════════════════════════════════════════\n");

  if (!DRY_RUN) {
    console.log("  ⚠️  AVISO IMPORTANTE:");
    console.log("  Isso remove APENAS chaves sartec:archive:*.");
    console.log("  Conversas principais (sartec:{phone}) e contatos NÃO serão apagados.");
    console.log("  Iniciando em 5 segundos... Pressione Ctrl+C para cancelar.\n");
    await new Promise(r => setTimeout(r, 5_000));
  }

  // ── SCAN sartec:archive:* ─────────────────────────────────────────────────
  console.log("  Varrendo sartec:archive:* (SCAN COUNT=100)...\n");

  const archiveKeys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor, "MATCH", "sartec:archive:*", "COUNT", 100
    );
    cursor = next;
    // Filtragem extra: só inclui chaves que comecem exatamente com sartec:archive:
    for (const k of batch) {
      if (k.startsWith("sartec:archive:")) archiveKeys.push(k);
    }
  } while (cursor !== "0");

  if (archiveKeys.length === 0) {
    console.log("  ✅ Nenhum archive encontrado. Nada a fazer.\n");
    redis.disconnect();
    return;
  }

  // ── Estima tamanho total ──────────────────────────────────────────────────
  console.log(`  Medindo tamanho de ${archiveKeys.length} archives...\n`);

  let totalBytes = 0;
  for (const key of archiveKeys) {
    totalBytes += await memUsage(key);
  }

  console.log(`  Archives encontrados : ${archiveKeys.length}`);
  console.log(`  Tamanho estimado     : ${fmt(totalBytes)}\n`);

  // ── Modo dry-run: para aqui ───────────────────────────────────────────────
  if (DRY_RUN) {
    console.log("  DRY-RUN: nenhuma chave foi apagada.");
    console.log("");
    console.log("  Para executar a limpeza real (SOMENTE com autorização do Lucas):");
    console.log("    node scripts/redis-clean-archives.js --confirm-delete-archives");
    console.log("");
    redis.disconnect();
    return;
  }

  // ── Deleção em lotes ──────────────────────────────────────────────────────
  let deleted    = 0;
  let errors     = 0;
  let freedBytes = 0;

  for (let i = 0; i < archiveKeys.length; i += BATCH_SZ) {
    const batch = archiveKeys.slice(i, i + BATCH_SZ);
    for (const key of batch) {
      try {
        const bytes = await memUsage(key);
        await safeDelete(key);
        freedBytes += bytes;
        deleted++;
        if (deleted % 50 === 0 || deleted === archiveKeys.length) {
          process.stdout.write(
            `\r  ... ${deleted}/${archiveKeys.length} deletados | ${fmt(freedBytes)} liberados   `
          );
        }
      } catch (err) {
        console.error(`\n  ❌ Erro ao deletar ${key}: ${err.message}`);
        errors++;
      }
    }
  }

  console.log(""); // quebra de linha após o progress

  // ── Relatório final ───────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Relatório final de limpeza");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Total encontrado  : ${archiveKeys.length}`);
  console.log(`  Total deletado    : ${deleted}`);
  console.log(`  Memória liberada  : ${fmt(freedBytes)}`);
  if (errors > 0) {
    console.log(`  Erros             : ${errors} (verifique os logs acima)`);
  } else {
    console.log("  Erros             : 0");
  }
  console.log("══════════════════════════════════════════════════════════════\n");

  redis.disconnect();
}

run().catch(err => {
  console.error("❌  Erro fatal:", err.message);
  redis.disconnect();
  process.exit(1);
});
