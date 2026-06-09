// ============================================================
// Sartec — Diagnóstico de memória Redis (somente leitura)
//
// Uso:
//   REDIS_URL=rediss://... node scripts/redis-memory-report.js
//
// Não apaga nada. Apenas lê e reporta.
// ============================================================

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("❌  REDIS_URL não definida. Exporte antes de rodar:");
  console.error("    REDIS_URL=rediss://... node scripts/redis-memory-report.js");
  process.exit(1);
}

const redis = new Redis(REDIS_URL, {
  connectTimeout: 10_000,
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
});
redis.on("error", () => {});

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseInfo(raw) {
  const map = {};
  for (const line of String(raw).split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) map[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return map;
}

function fmt(bytes) {
  if (typeof bytes !== "number" || bytes < 0) return "n/a";
  if (bytes < 1_024)             return `${bytes} B`;
  if (bytes < 1_048_576)         return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

function categorize(key) {
  if (key.includes(":archive:"))        return "archive";
  if (key.includes(":contact:"))        return "contact";
  if (key.includes(":settings:"))       return "settings";
  if (key.includes(":pending_status:")) return "pending_status";
  if (key === "sartec:pipelineOrder")   return "pipeline_order";
  if (key.startsWith("lock:"))          return "lock";
  const rest = key.startsWith("sartec:") ? key.slice(7) : key;
  if (/^\d{10,15}$/.test(rest))         return "session";
  return "other";
}

async function memUsage(key) {
  try {
    const b = await redis.call("MEMORY", "USAGE", key);
    return typeof b === "number" ? b : -1;
  } catch { return -1; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  try {
    // ── INFO memory ──────────────────────────────────────────────────────────
    const infoRaw = await redis.info("memory");
    const info    = parseInfo(infoRaw);

    const usedBytes = parseInt(info.used_memory  || "0", 10);
    const maxBytes  = parseInt(info.maxmemory    || "0", 10);
    const pct       = maxBytes > 0 ? ((usedBytes / maxBytes) * 100).toFixed(1) : "n/a";

    console.log("\n══════════════════════════════════════════════════════════════");
    console.log("  Sartec — Redis Memory Report");
    console.log("══════════════════════════════════════════════════════════════");
    console.log(`  used_memory        : ${info.used_memory_human      || "n/a"}`);
    console.log(`  maxmemory          : ${info.maxmemory_human        || "sem limite"}`);
    console.log(`  uso %              : ${pct}%`);
    console.log(`  peak               : ${info.used_memory_peak_human || "n/a"}`);
    console.log(`  fragmentation      : ${info.mem_fragmentation_ratio || "n/a"}`);
    console.log("──────────────────────────────────────────────────────────────\n");

    // ── SCAN todas as chaves (COUNT baixo para não pressionar o servidor) ────
    console.log("  Varrendo chaves (SCAN COUNT=100)...\n");

    const counts = {
      session: 0, archive: 0, contact: 0, settings: 0,
      pending_status: 0, pipeline_order: 0, lock: 0, other: 0,
    };
    const allKeys = [];

    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, "COUNT", 100);
      cursor = next;
      for (const k of batch) {
        const cat = categorize(k);
        counts[cat] = (counts[cat] || 0) + 1;
        allKeys.push({ key: k, cat });
      }
    } while (cursor !== "0");

    console.log("  Contagem por grupo:");
    console.log(`    Sessões principais sartec:{phone}  : ${counts.session}`);
    console.log(`    Archives sartec:archive:*          : ${counts.archive}`);
    console.log(`    Contatos sartec:contact:*          : ${counts.contact}`);
    console.log(`    Settings sartec:settings:*         : ${counts.settings}`);
    console.log(`    Pending status                     : ${counts.pending_status}`);
    console.log(`    Pipeline order                     : ${counts.pipeline_order}`);
    console.log(`    Locks ativos                       : ${counts.lock}`);
    console.log(`    Outras                             : ${counts.other}`);
    console.log(`    TOTAL                              : ${allKeys.length}`);
    console.log("");

    // ── MEMORY USAGE por chave ────────────────────────────────────────────────
    console.log("  Medindo tamanho (MEMORY USAGE)... pode levar alguns segundos.\n");

    const sized = [];
    for (const { key, cat } of allKeys) {
      const bytes = await memUsage(key);
      sized.push({ key, cat, bytes });
    }
    sized.sort((a, b) => b.bytes - a.bytes);

    console.log("  Top 20 chaves mais pesadas:");
    console.log("  " + "─".repeat(76));
    for (let i = 0; i < Math.min(20, sized.length); i++) {
      const { key, cat, bytes } = sized[i];
      const label = key.length > 52 ? key.slice(0, 49) + "..." : key;
      console.log(
        `  ${String(i + 1).padStart(2)}. [${cat.padEnd(14)}] ${label.padEnd(52)} ${fmt(bytes).padStart(10)}`
      );
    }
    console.log("");

    // ── Detalhes de sessões principais ────────────────────────────────────────
    const sessions   = sized.filter(s => s.cat === "session");
    const archives   = sized.filter(s => s.cat === "archive");
    let   mediaTotal = 0;

    if (sessions.length > 0) {
      console.log("  Sessões principais — metadados (sem conteúdo de mensagens):");
      console.log("  " + "─".repeat(96));
      console.log(
        "  " +
        "phone".padEnd(16) +
        "status".padEnd(22) +
        "hist".padStart(5) +
        "media".padStart(6) +
        "size".padStart(10) +
        "  clientName (truncado)"
      );
      console.log("  " + "─".repeat(96));

      // Inspeciona até 200 sessões para não transferir tudo em ambientes grandes
      const toInspect = sessions.slice(0, 200);
      for (const { key, bytes } of toInspect) {
        try {
          const raw = await redis.get(key);
          if (!raw) continue;
          const s      = JSON.parse(raw);
          const phone  = key.slice(7);   // remove "sartec:"
          const hist   = (s.history  || []).length;
          const media  = (s.history  || []).filter(m => m.mediaData).length;
          mediaTotal  += media;
          const name   = (s.clientName || "—").slice(0, 30);
          const status = (s.status    || "ativo").slice(0, 20);
          console.log(
            "  " +
            phone.padEnd(16) +
            status.padEnd(22) +
            String(hist).padStart(5) +
            String(media).padStart(6) +
            fmt(bytes).padStart(10) +
            `  ${name}`
          );
        } catch { /* ignora sessões com JSON inválido */ }
      }

      if (sessions.length > 200) {
        console.log(`  ... (${sessions.length - 200} sessões omitidas do detalhe)`);
      }

      console.log("");
      console.log(`  Total de entradas com mediaData inline em sessões: ${mediaTotal}`);
      console.log("");
    }

    // ── Detalhes de archives ──────────────────────────────────────────────────
    const totalArchiveBytes = archives.reduce((s, a) => s + Math.max(a.bytes, 0), 0);

    if (archives.length > 0) {
      console.log(`  Archives sartec:archive:* — ${archives.length} chaves | total estimado: ${fmt(totalArchiveBytes)}`);
      console.log("  Top 20 archives mais pesados:");
      console.log("  " + "─".repeat(76));
      for (let i = 0; i < Math.min(20, archives.length); i++) {
        const { key, bytes } = archives[i];
        const label = key.length > 58 ? key.slice(0, 55) + "..." : key;
        console.log(`  ${String(i + 1).padStart(2)}. ${label.padEnd(60)} ${fmt(bytes).padStart(10)}`);
      }
      console.log("");
    }

    // ── Resumo e recomendações ────────────────────────────────────────────────
    const archivePct = (usedBytes > 0 && totalArchiveBytes > 0)
      ? ((totalArchiveBytes / usedBytes) * 100).toFixed(1)
      : "0";

    console.log("══════════════════════════════════════════════════════════════");
    console.log("  RESUMO");
    console.log("══════════════════════════════════════════════════════════════");
    console.log(`  Memória usada    : ${info.used_memory_human || "n/a"} / ${info.maxmemory_human || "sem limite"} (${pct}%)`);
    console.log(`  Sessões          : ${counts.session}`);
    console.log(`  Archives         : ${counts.archive} → ${fmt(totalArchiveBytes)} (~${archivePct}% da memória usada)`);
    console.log(`  Contatos         : ${counts.contact}`);
    console.log(`  MediaData inline : ${mediaTotal} entradas em sessões inspecionadas`);
    console.log(`  Total chaves     : ${allKeys.length}`);
    console.log("──────────────────────────────────────────────────────────────");
    console.log("  RECOMENDAÇÕES:");

    if (counts.archive > 0) {
      console.log(`  a. LIMPEZA PRIORITÁRIA: ${counts.archive} archives ocupam ${fmt(totalArchiveBytes)}.`);
      console.log("     O histórico já vive em sartec:{phone} por 90 dias — archives são redundantes.");
      console.log("     Dry-run (somente leitura):");
      console.log("       node scripts/redis-clean-archives.js");
      console.log("     Limpeza real (apenas com autorização do Lucas):");
      console.log("       node scripts/redis-clean-archives.js --confirm-delete-archives");
    } else {
      console.log("  a. Nenhum archive encontrado — sem ganho de memória por esse lado.");
    }

    if (mediaTotal > 50) {
      console.log(`  b. ${mediaTotal} entradas com mediaData inline em sessões.`);
      console.log("     Migrar mídia para storage externo (S3/Cloudinary) reduziria muito o tamanho das sessões.");
    }

    if (maxBytes > 0 && usedBytes / maxBytes >= 0.85) {
      console.log("  c. Uso ≥ 85% — RISCO ALTO. Limpe archives e/ou suba o plano Redis imediatamente.");
    } else if (maxBytes > 0 && usedBytes / maxBytes >= 0.70) {
      console.log("  c. Uso entre 70–85% — atenção. Considere subir o plano Redis em breve.");
    }

    console.log("══════════════════════════════════════════════════════════════\n");

  } catch (err) {
    console.error("❌  Erro durante diagnóstico:", err.message);
  } finally {
    redis.disconnect();
  }
}

run();
