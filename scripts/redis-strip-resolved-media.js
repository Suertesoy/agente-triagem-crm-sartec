// ============================================================
// Sartec — Limpeza segura de mediaData em sessões resolvidas
//
// Por padrão: DRY-RUN (apenas mostra o que seria removido)
//
// Para executar a limpeza real (somente com autorização explícita do Lucas):
//   node scripts/redis-strip-resolved-media.js --confirm-strip-resolved-media
//
// NUNCA:
//   - apaga chaves
//   - altera sessões não resolvidas (aguardando_humano, em_atendimento, etc.)
//   - imprime conteúdo de mensagens ou base64
//   - toca em sartec:contact:*, sartec:settings:*, sartec:archive:*, locks
// ============================================================

import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error("❌  REDIS_URL não definida. Exporte antes de rodar:");
  console.error("    REDIS_URL=rediss://... node scripts/redis-strip-resolved-media.js");
  process.exit(1);
}

const DRY_RUN   = !process.argv.includes("--confirm-strip-resolved-media");
const SCAN_COUNT = 100;
const BATCH_SZ   = 5;
const NOW_ISO    = new Date().toISOString();

const ACTIVE_STATUSES = new Set([
  "aguardando_humano",
  "em_atendimento",
  "aguardando_triagem",
]);

const redis = new Redis(REDIS_URL, {
  connectTimeout: 10_000,
  maxRetriesPerRequest: 1,
  enableReadyCheck: false,
});
redis.on("error", () => {});

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(bytes) {
  if (typeof bytes !== "number" || bytes < 0) return "n/a";
  if (bytes < 1_024)     return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

async function memUsage(key) {
  try {
    const b = await redis.call("MEMORY", "USAGE", key);
    return typeof b === "number" ? b : 0;
  } catch { return 0; }
}

// Chave de sessão principal: sartec:{phone} onde phone são apenas dígitos (10-15 chars)
function isSessionKey(key) {
  if (!key.startsWith("sartec:")) return false;
  const rest = key.slice(7);
  return /^\d{10,15}$/.test(rest);
}

// Estima o custo em bytes de um valor dentro do JSON serializado
function roughBytes(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try { return JSON.stringify(value).length; } catch { return 0; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Sartec — Strip mediaData de sessões resolvidas");
  if (DRY_RUN) {
    console.log("  MODO: DRY-RUN — nada será alterado");
  } else {
    console.log("  MODO: ⚠️  LIMPEZA REAL — mediaData será removido de sessões resolvidas");
  }
  console.log("══════════════════════════════════════════════════════════════\n");

  if (!DRY_RUN) {
    console.log("  ⚠️  AVISO IMPORTANTE:");
    console.log("  Apenas sessões com status \"resolvido\" serão alteradas.");
    console.log("  Nenhuma chave será apagada.");
    console.log("  O campo mediaData de cada mensagem será removido; todos os");
    console.log("  demais campos (texto, tipo, metadados) são preservados.");
    console.log("  Iniciando em 5 segundos... Pressione Ctrl+C para cancelar.\n");
    await new Promise(r => setTimeout(r, 5_000));
  }

  // ── SCAN: coleta apenas chaves de sessão principal ────────────────────────
  console.log("  Varrendo sartec:* (SCAN COUNT=100)...\n");

  const sessionKeys = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(
      cursor, "MATCH", "sartec:*", "COUNT", SCAN_COUNT
    );
    cursor = next;
    for (const k of batch) {
      if (isSessionKey(k)) sessionKeys.push(k);
    }
  } while (cursor !== "0");

  console.log(`  Sessões principais encontradas: ${sessionKeys.length}\n`);

  // ── Análise por sessão ────────────────────────────────────────────────────
  let totalInspected   = 0;
  let totalResolved    = 0;
  let totalActive      = 0;
  let totalOtherStatus = 0;
  let totalWouldChange = 0;
  let totalMediaMsgs   = 0;
  let totalEstSavings  = 0;

  const outsideHistoryReport = [];            // mediaData fora de history
  const candidates = [];                       // sessões elegíveis para limpeza

  for (let i = 0; i < sessionKeys.length; i += BATCH_SZ) {
    const batch = sessionKeys.slice(i, i + BATCH_SZ);

    for (const key of batch) {
      totalInspected++;
      try {
        const raw = await redis.get(key);
        if (!raw) continue;

        const session = JSON.parse(raw);
        const status  = session.status || "ativo";
        const phone   = key.slice(7);

        // Sessões ativas: nunca tocar
        if (ACTIVE_STATUSES.has(status)) {
          totalActive++;
          continue;
        }

        // Só processa resolvido
        if (status !== "resolvido") {
          totalOtherStatus++;
          continue;
        }

        totalResolved++;

        // Detectar mediaData fora de history (report-only — nunca remover)
        for (const field of Object.keys(session)) {
          if (field === "history") continue;
          if (field === "mediaData" || String(session[field]).startsWith("data:")) {
            outsideHistoryReport.push({ phone, field });
          }
        }

        // Contar mediaData dentro de history
        const history = Array.isArray(session.history) ? session.history : [];
        let mediaCount    = 0;
        let estimatedSave = 0;

        for (const msg of history) {
          if (msg.mediaData != null) {
            mediaCount++;
            estimatedSave += roughBytes(msg.mediaData);
          }
        }

        if (mediaCount === 0) continue;

        const currentBytes = await memUsage(key);

        totalWouldChange++;
        totalMediaMsgs  += mediaCount;
        totalEstSavings += estimatedSave;

        candidates.push({
          phone,
          key,
          currentBytes,
          estimatedSaving: estimatedSave,
          mediaCount,
          clientName: (session.clientName || "—").slice(0, 30),
        });

      } catch (err) {
        console.error(`  ⚠️  Erro ao inspecionar ${key}: ${err.message}`);
      }
    }
  }

  candidates.sort((a, b) => b.estimatedSaving - a.estimatedSaving);

  // ── Relatório de análise ──────────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  RESUMO DA ANÁLISE");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Total sessões inspecionadas      : ${totalInspected}`);
  console.log(`  Sessões resolvidas               : ${totalResolved}`);
  console.log(`  Sessões ativas (preservadas)     : ${totalActive}`);
  console.log(`  Sessões outro status (ignoradas) : ${totalOtherStatus}`);
  console.log(`  Sessões que seriam alteradas     : ${totalWouldChange}`);
  console.log(`  Mensagens com mediaData          : ${totalMediaMsgs}`);
  console.log(`  Economia estimada                : ${fmt(totalEstSavings)}`);
  console.log(`  (Estimativa baseada no tamanho da string base64 serializada)`);
  console.log("");

  if (outsideHistoryReport.length > 0) {
    console.log("  ⚠️  mediaData detectado FORA de history (NÃO será removido sem nova autorização):");
    for (const o of outsideHistoryReport) {
      console.log(`     phone=${o.phone}  campo=\"${o.field}\"`);
    }
    console.log("");
  }

  if (candidates.length > 0) {
    console.log("  Top 20 sessões que mais liberariam espaço:");
    console.log("  " + "─".repeat(92));
    console.log(
      "  " +
      "phone".padEnd(16) +
      "clientName".padEnd(32) +
      "mídias".padStart(7) +
      "tam. atual".padStart(12) +
      "economia est.".padStart(15)
    );
    console.log("  " + "─".repeat(92));

    for (let i = 0; i < Math.min(20, candidates.length); i++) {
      const { phone, clientName, mediaCount, currentBytes, estimatedSaving } = candidates[i];
      console.log(
        "  " +
        phone.padEnd(16) +
        clientName.padEnd(32) +
        String(mediaCount).padStart(7) +
        fmt(currentBytes).padStart(12) +
        fmt(estimatedSaving).padStart(15)
      );
    }
    console.log("");
  } else {
    console.log("  Nenhuma sessão resolvida com mediaData encontrada.\n");
  }

  // Confirmações de segurança (dry-run)
  console.log("  Confirmações de segurança:");
  console.log(`  ✅ ${totalActive} sessão(ões) ativa(s) preservada(s) — não seriam tocadas`);
  console.log("  ✅ Nenhuma chave seria apagada — apenas campo mediaData removido das mensagens");
  console.log("  ✅ Contatos, settings, pipelineOrder, locks e archives não foram tocados");

  if (DRY_RUN) {
    console.log("");
    console.log("  DRY-RUN concluído. Nenhuma alteração foi feita.");
    console.log("");
    if (totalWouldChange > 0) {
      console.log("  Para executar a limpeza real (SOMENTE com autorização do Lucas):");
      console.log("    node scripts/redis-strip-resolved-media.js --confirm-strip-resolved-media");
    }
    console.log("");
    redis.disconnect();
    return;
  }

  // ── Limpeza real ──────────────────────────────────────────────────────────
  if (candidates.length === 0) {
    console.log("\n  Nenhuma sessão elegível. Encerrando.\n");
    redis.disconnect();
    return;
  }

  let cleaned      = 0;
  let mediaCleaned = 0;
  let errors       = 0;
  let totalBefore  = 0;
  let totalAfter   = 0;
  const affectedPhones = [];

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  EXECUTANDO LIMPEZA REAL");
  console.log("══════════════════════════════════════════════════════════════\n");

  for (const { key, phone } of candidates) {
    try {
      const raw = await redis.get(key);
      if (!raw) continue;

      const session = JSON.parse(raw);
      const status  = session.status || "ativo";

      // Guarda dupla: verifica status no momento da escrita
      if (ACTIVE_STATUSES.has(status) || status !== "resolvido") {
        console.error(`  ⛔ SKIP (status mudou para "${status}"): ${key}`);
        continue;
      }

      const bytesBefore = await memUsage(key);
      totalBefore += bytesBefore;

      let msgsCleaned = 0;
      session.history = (session.history || []).map(msg => {
        if (msg.mediaData == null) return msg;

        // Remove mediaData, preserva todos os outros campos
        const { mediaData: _stripped, ...rest } = msg;
        msgsCleaned++;
        return {
          ...rest,
          mediaDataRemoved:       true,
          mediaDataRemovedAt:     NOW_ISO,
          mediaDataRemovedReason: "redis_memory_cleanup_resolved_session",
        };
      });

      if (msgsCleaned === 0) continue;

      // Preserva o TTL original da chave
      const ttl    = await redis.ttl(key);
      const newRaw = JSON.stringify(session);

      if (ttl > 0) {
        await redis.setex(key, ttl, newRaw);
      } else {
        await redis.set(key, newRaw);
      }

      const bytesAfter = await memUsage(key);
      totalAfter += bytesAfter;

      cleaned++;
      mediaCleaned += msgsCleaned;
      affectedPhones.push(phone);

      process.stdout.write(
        `\r  ... ${cleaned}/${candidates.length} sessões | ${mediaCleaned} mídias removidas   `
      );

    } catch (err) {
      console.error(`\n  ❌ Erro em ${key}: ${err.message}`);
      errors++;
    }
  }

  console.log("\n");

  // ── Relatório final da limpeza real ──────────────────────────────────────
  const freed = Math.max(0, totalBefore - totalAfter);

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  RELATÓRIO FINAL DA LIMPEZA");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  Sessões alteradas          : ${cleaned}`);
  console.log(`  Mensagens com mídia limpa  : ${mediaCleaned}`);
  console.log(`  Memória medida antes       : ${fmt(totalBefore)}`);
  console.log(`  Memória medida depois      : ${fmt(totalAfter)}`);
  console.log(`  Economia medida            : ${fmt(freed)}`);
  console.log(`  Erros                      : ${errors}`);
  console.log("");
  console.log("  Telefones afetados (sem conteúdo de mensagem):");
  for (const p of affectedPhones) {
    console.log(`    +${p}`);
  }
  console.log("");
  console.log("  ✅ Nenhuma chave foi apagada");
  console.log("  ✅ Nenhuma sessão ativa foi alterada");
  console.log("══════════════════════════════════════════════════════════════\n");

  redis.disconnect();
}

run().catch(err => {
  console.error("❌  Erro fatal:", err.message);
  redis.disconnect();
  process.exit(1);
});
