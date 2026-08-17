#!/usr/bin/env node

import { createHash } from "node:crypto";
import Redis from "ioredis";
import {
  RedisCrmStore,
  SupabaseCrmStore,
  mapPipelineOrder,
  mapRedisContact,
  mapRedisSession,
  normalizeSartecPhone,
} from "../lib/crm-store/index.js";
import { isSupabaseCrmEnabled } from "../lib/supabase-server.js";

const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--commit", "--help"]);
const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));

if (args.has("--help")) {
  console.log(`Uso:
  node scripts/migrate-redis-to-supabase.js           # dry-run (somente leitura)
  node scripts/migrate-redis-to-supabase.js --commit  # gravação explícita

Para --commit, SUPABASE_CRM_ENABLED deve ser true e as variáveis específicas do CRM devem estar configuradas.`);
  process.exit(0);
}

if (unknownArgs.length) {
  console.error(`Argumento(s) desconhecido(s): ${unknownArgs.join(", ")}`);
  process.exit(2);
}

const commit = args.has("--commit");

function incrementFieldCounts(target, fields) {
  for (const field of fields) target[field] = (target[field] || 0) + 1;
}

function checksumPlan(customers, conversations, messages, pipelineRows) {
  const hash = createHash("sha256");
  const groups = [
    customers.slice().sort((a, b) => a.phone.localeCompare(b.phone)),
    conversations.slice().sort((a, b) => a.redis_key.localeCompare(b.redis_key)),
    messages.slice().sort((a, b) => a.id.localeCompare(b.id)),
    pipelineRows.slice().sort((a, b) =>
      `${a.client_type}:${a.column_key}`.localeCompare(`${b.client_type}:${b.column_key}`)
    ),
  ];
  for (const group of groups) {
    hash.update("[");
    for (const item of group) hash.update(JSON.stringify(item));
    hash.update("]");
  }
  return hash.digest("hex");
}

function printReport(report) {
  console.log(`
Migração Redis → Supabase CRM (${report.mode})
Projeto de destino: Sartec CRM (uzwyzwbybtnvgjjhimwy)

Contagens
  contatos Redis:           ${report.counters.redisContacts}
  sessões Redis:            ${report.counters.redisSessions}
  clientes normalizados:    ${report.counters.customers}
  conversas normalizadas:   ${report.counters.conversations}
  mensagens normalizadas:   ${report.counters.messages}
  itens de histórico lidos: ${report.counters.historyItems}
  mídias referenciadas:     ${report.counters.media}
  templates/eventos:        ${report.counters.templates}
  linhas de pipeline:       ${report.counters.pipelineRows}

Diagnóstico
  JSON inválido:             ${report.counters.invalidJson}
  sessões inválidas:        ${report.counters.invalidSessions}
  itens de histórico invál.:${report.counters.invalidHistoryItems}
  mensagens sem timestamp:  ${report.counters.messagesWithoutTimestamp}
  possíveis duplicatas:     ${report.counters.possibleDuplicates}
  duplicatas entre conversas:${report.counters.crossConversationDuplicates}
  entradas pipeline invál.: ${report.counters.invalidPipelineEntries}

Campos de sessão sem coluna normalizada: ${Object.keys(report.unmapped.session).join(", ") || "nenhum"}
Campos de mensagem sem coluna normalizada: ${Object.keys(report.unmapped.message).join(", ") || "nenhum"}
Campos de contato sem coluna normalizada: ${Object.keys(report.unmapped.contact).join(", ") || "nenhum"}
Fallbacks de enum detectados: ${Object.keys(report.normalizedFallbacks).join(", ") || "nenhum"}
Checksum: ${report.checksum}

${report.mode === "DRY RUN" ? "Nenhuma escrita foi realizada no Supabase." : "Importação gravada no Supabase CRM."}`);
}

async function buildPlan(redisStore) {
  const [contactEntries, sessionEntries, pipelineEntry] = await Promise.all([
    redisStore.contactEntries(),
    redisStore.sessionEntries(),
    redisStore.pipelineOrderEntry(),
  ]);

  const report = {
    mode: commit ? "COMMIT" : "DRY RUN",
    counters: {
      redisContacts: contactEntries.length,
      redisSessions: sessionEntries.length,
      customers: 0,
      conversations: 0,
      messages: 0,
      historyItems: 0,
      media: 0,
      templates: 0,
      pipelineRows: 0,
      invalidJson: 0,
      invalidSessions: 0,
      invalidHistoryItems: 0,
      messagesWithoutTimestamp: 0,
      possibleDuplicates: 0,
      crossConversationDuplicates: 0,
      invalidPipelineEntries: 0,
    },
    unmapped: { contact: {}, session: {}, message: {} },
    normalizedFallbacks: {},
    checksum: null,
  };

  const contactsByPhone = new Map();
  for (const entry of contactEntries) {
    if (entry.error) {
      report.counters.invalidJson += 1;
      continue;
    }
    try {
      const keyPhone = entry.key.slice("sartec:contact:".length);
      const phone = normalizeSartecPhone(entry.value?.phone || keyPhone);
      const mapped = mapRedisContact(phone, entry.value || {});
      contactsByPhone.set(phone, mapped.customer);
      incrementFieldCounts(report.unmapped.contact, mapped.unmappedFields);
      incrementFieldCounts(report.normalizedFallbacks, mapped.normalizedFallbacks);
    } catch {
      report.counters.invalidJson += 1;
    }
  }

  const conversations = [];
  const messages = [];
  for (const entry of sessionEntries) {
    if (entry.error) {
      report.counters.invalidJson += 1;
      report.counters.invalidSessions += 1;
      continue;
    }

    try {
      const phone = normalizeSartecPhone(entry.key.slice("sartec:".length));
      const session = entry.value;
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        report.counters.invalidSessions += 1;
        continue;
      }

      if (!contactsByPhone.has(phone)) {
        const syntheticContact = mapRedisContact(phone, {
          phone,
          clientName: session.clientName,
          clientType: session.clientType,
          demandType: session.demandType,
          lastActivityAt: session.lastActivityAt,
          lastConversationStatus: session.status,
          lastPipelineStatus: session.pipelineStatus,
        });
        contactsByPhone.set(phone, syntheticContact.customer);
      }

      const mapped = mapRedisSession(phone, session);
      const customer = contactsByPhone.get(phone);
      if (session.clientName) customer.client_name = session.clientName;
      if (["pf", "pj"].includes(String(session.clientType || "").toLowerCase())) {
        customer.client_type = String(session.clientType).toLowerCase();
      }
      if (["outro", "lista", "cotacao_pj", "xerox", "produto", "duvida"].includes(session.demandType)) {
        customer.demand_type = session.demandType;
      }
      if (mapped.conversation.last_activity_at) {
        customer.last_activity_at = mapped.conversation.last_activity_at;
      }
      if (session.status) customer.last_conversation_status = session.status;
      if (session.pipelineStatus) customer.last_pipeline_status = session.pipelineStatus;
      conversations.push(mapped.conversation);
      messages.push(...mapped.messages);
      report.counters.invalidHistoryItems += mapped.diagnostics.invalidHistoryItems;
      report.counters.messagesWithoutTimestamp += mapped.diagnostics.missingTimestamps;
      report.counters.media += mapped.diagnostics.mediaCount;
      report.counters.templates += mapped.diagnostics.templateCount;
      incrementFieldCounts(report.unmapped.session, mapped.diagnostics.unmappedFields);
      incrementFieldCounts(report.unmapped.message, mapped.diagnostics.messageUnmappedFields);
    } catch {
      report.counters.invalidSessions += 1;
    }
  }

  let pipelineRows = [];
  if (pipelineEntry.error) {
    report.counters.invalidJson += 1;
  } else if (pipelineEntry.exists) {
    try {
      const mapped = mapPipelineOrder(pipelineEntry.value);
      pipelineRows = mapped.rows;
      report.counters.invalidPipelineEntries = mapped.invalidEntries.length;
    } catch {
      report.counters.invalidPipelineEntries += 1;
    }
  }

  const messagesById = new Map();
  const crossConversationIds = new Set();
  for (const message of messages) {
    const existing = messagesById.get(message.id);
    if (existing) {
      report.counters.possibleDuplicates += 1;
      if (existing.conversation_id !== message.conversation_id) {
        crossConversationIds.add(message.id);
      }
      continue;
    }
    messagesById.set(message.id, message);
  }
  const uniqueMessages = [...messagesById.values()];
  report.counters.crossConversationDuplicates = crossConversationIds.size;
  report.counters.customers = contactsByPhone.size;
  report.counters.conversations = conversations.length;
  report.counters.historyItems = messages.length;
  report.counters.messages = uniqueMessages.length;
  report.counters.pipelineRows = pipelineRows.length;

  const customers = [...contactsByPhone.values()].sort((a, b) => a.phone.localeCompare(b.phone));
  report.checksum = checksumPlan(customers, conversations, uniqueMessages, pipelineRows);

  return {
    report,
    customers,
    conversations,
    messages: uniqueMessages,
    pipelineRows,
  };
}

async function commitPlan(plan) {
  if (!isSupabaseCrmEnabled()) {
    throw new Error(
      "--commit recusado: defina SUPABASE_CRM_ENABLED=true para confirmar que o destino é o Supabase Sartec CRM."
    );
  }
  if (plan.report.counters.crossConversationDuplicates > 0) {
    throw new Error(
      "--commit recusado: há Meta IDs repetidos em conversas diferentes. Revise os conflitos antes de importar."
    );
  }

  const store = new SupabaseCrmStore();
  let runId = null;
  try {
    runId = await store.startMigrationRun({
      source: "redis:sartec:*",
      counters: plan.report.counters,
      checksum: plan.report.checksum,
      notes: "Importação administrativa idempotente. Redis permanece como fonte operacional.",
    });

    const customerIds = new Map();
    for (const customer of plan.customers) {
      customerIds.set(customer.phone, await store.upsertCustomer(customer));
    }

    const conversationIds = new Map();
    for (const conversation of plan.conversations) {
      const phone = conversation.redis_key.slice("sartec:".length);
      conversation.customer_id = customerIds.get(phone) || conversation.customer_id;
      const actualId = await store.upsertConversation(conversation);
      conversationIds.set(conversation.id, actualId);
    }

    for (const message of plan.messages) {
      message.conversation_id = conversationIds.get(message.conversation_id) || message.conversation_id;
    }
    await store.upsertMessages(plan.messages);
    await store.upsertPipelineOrder(plan.pipelineRows);
    await store.finishMigrationRun(runId, {
      status: "completed",
      counters: plan.report.counters,
      checksum: plan.report.checksum,
      notes: "Importação concluída; nenhuma fonte de leitura foi alterada.",
    });
  } catch (error) {
    if (runId) {
      try {
        await store.finishMigrationRun(runId, {
          status: "failed",
          counters: plan.report.counters,
          checksum: plan.report.checksum,
          notes: String(error.message || error).slice(0, 1000),
        });
      } catch {
        // A falha original continua sendo a causa principal.
      }
    }
    throw error;
  }
}

async function main() {
  if (!process.env.REDIS_URL) {
    throw new Error("REDIS_URL não configurada. O dry-run precisa de acesso somente leitura ao Redis de origem.");
  }

  const redis = new Redis(process.env.REDIS_URL, {
    connectTimeout: 5000,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  redis.on("error", (error) => console.error(`[redis/migration] ${error.message}`));

  try {
    await redis.connect();
    const plan = await buildPlan(new RedisCrmStore(redis));
    if (commit) await commitPlan(plan);
    printReport(plan.report);
  } finally {
    try { await redis.quit(); } catch { redis.disconnect(); }
  }
}

main().catch((error) => {
  console.error(`Migração interrompida: ${error.message}`);
  process.exitCode = 1;
});
