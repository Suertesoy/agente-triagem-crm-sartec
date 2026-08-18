#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import Redis from "ioredis";
import {
  RedisCrmStore,
  SupabaseCrmStore,
  mapPipelineOrder,
  mapRedisContact,
  mapRedisSession,
  normalizeSartecPhone,
  sha256Canonical,
} from "../lib/crm-store/index.js";
import { isSupabaseCrmEnabled } from "../lib/supabase-server.js";
import { inspectMediaObject } from "../api/_lib/media-storage.js";

export const COMMIT_BLOCKING_COUNTERS = [
  "invalidJson",
  "invalidSessions",
  "invalidHistoryItems",
  "invalidPipelineEntries",
  "crossConversationDuplicates",
  "duplicateConflicts",
  "legacyBase64WithoutR2",
];

function incrementFieldCounts(target, fields) {
  for (const field of fields) target[field] = (target[field] || 0) + 1;
}

function recordShadowResult(counters, entity, result) {
  const other = result.other ?? (!["applied", "stale_ignored"].includes(result.status) ? 1 : 0);
  if (other > 0) throw new Error(`catch-up ${entity} requer reconciliação manual (${other} resultado(s))`);
  counters.shadowApplied[entity] += result.applied ?? (result.status === "applied" ? 1 : 0);
  counters.shadowStaleIgnored[entity] += result.staleIgnored ?? (result.status === "stale_ignored" ? 1 : 0);
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

function comparableMessage(message) {
  const comparable = structuredClone(message);
  delete comparable.id;
  delete comparable.legacy_history_index;
  delete comparable.legacy_payload_hash;
  delete comparable.raw_payload;
  return comparable;
}

function logicalMessage(message) {
  const logical = comparableMessage(message);
  delete logical.created_at;
  delete logical.media_storage_key;
  return logical;
}

function differingFields(first, second) {
  const fields = new Set([...Object.keys(first), ...Object.keys(second)]);
  return [...fields].filter(
    (field) => sha256Canonical(first[field]) !== sha256Canonical(second[field])
  ).sort();
}

function maskedPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

function maskPhonesInText(value) {
  return String(value).replace(/\d{10,15}/g, (digits) => `***${digits.slice(-4)}`);
}

function summarizeDifference(field, value) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["content", "template_text", "transcription", "delivery_error"].includes(field)) {
      return {
        type: "text",
        length: value.length,
        sha256: createHash("sha256").update(value).digest("hex"),
        preview: maskPhonesInText(value.replace(/\s+/g, " ").slice(0, 48)),
      };
    }
    return maskPhonesInText(value.length > 160 ? `${value.slice(0, 157)}...` : value);
  }
  const serialized = JSON.stringify(value);
  return {
    type: Array.isArray(value) ? "array" : "object",
    length: serialized.length,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    preview: maskPhonesInText(serialized.slice(0, 120)),
  };
}

function suggestedConflictClassification(fields, first, second) {
  const deliveryFields = new Set(["delivery_status", "delivery_status_at", "delivery_error"]);
  const metadataFields = new Set([
    "created_at",
    "reactions",
    "media_storage_key",
    "media_storage_provider",
    "media_storage_failed",
    "media_unavailable",
  ]);
  if (fields.some((field) => deliveryFields.has(field))) return "evolução de delivery status";
  if (first.message_type === "reaction_event" || second.message_type === "reaction_event"
    || fields.some((field) => metadataFields.has(field)) && fields.length > 1) {
    return "reação/metadado posterior";
  }
  if (fields.length === 1 && fields[0] === "created_at") return "duplicata legítima";
  if (fields.some((field) => ["content", "content_json", "role", "source", "message_type"].includes(field))) {
    return "possível corrupção";
  }
  return "outro";
}

function conflictOccurrence(message, phoneByConversationId) {
  return {
    telefone: maskedPhone(phoneByConversationId.get(message.conversation_id)),
    metaMessageId: message.meta_message_id || null,
    legacy_history_index: message.legacy_history_index,
    message_type: message.message_type,
    role: message.role,
    source: message.source,
    created_at: message.created_at,
  };
}

function mediaPairKey(firstKey, secondKey) {
  return [firstKey, secondKey].sort().join("\n");
}

function validIsoTimestamp(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function safeEvidenceObject(value) {
  if (!value) return null;
  return {
    storageKey: maskPhonesInText(value.storageKey),
    exists: Boolean(value.exists),
    size: value.size ?? null,
    mimeType: value.mimeType || null,
    downloadedSize: value.downloadedSize ?? null,
    sha256: value.downloadedSha256 || null,
  };
}

function duplicateAuditValues(message) {
  const previous = message.raw_payload?.legacyDuplicateAudit || {};
  return {
    indexes: previous.consolidatedLegacyHistoryIndexes || [message.legacy_history_index],
    timestamps: previous.observedCreatedAt || [message.created_at],
    mediaKeys: [
      message.media_storage_key,
      ...(previous.alternateMediaStorageKeys || []),
    ].filter(Boolean),
  };
}

function consolidateWebhookDuplicate(existing, incoming) {
  const occurrences = [existing, incoming];
  const canonical = structuredClone(
    occurrences.slice().sort((a, b) => a.legacy_history_index - b.legacy_history_index)[0]
  );
  const validTimestamps = occurrences
    .map((message) => validIsoTimestamp(message.created_at))
    .filter(Boolean)
    .sort();
  canonical.created_at = validTimestamps[0] || null;
  canonical.legacy_history_index = Math.min(
    ...occurrences.map((message) => message.legacy_history_index)
  );

  const mediaOccurrences = occurrences
    .filter((message) => message.media_storage_key)
    .sort((first, second) => first.legacy_history_index - second.legacy_history_index);
  if (mediaOccurrences.length) {
    canonical.media_storage_key = mediaOccurrences[0].media_storage_key;
  }

  const audit = occurrences.map(duplicateAuditValues);
  const indexes = [...new Set(audit.flatMap((item) => item.indexes))].sort((a, b) => a - b);
  const timestamps = [...new Set(audit.flatMap((item) => item.timestamps))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  const allMediaKeys = [...new Set(audit.flatMap((item) => item.mediaKeys))];
  canonical.raw_payload = {
    ...(canonical.raw_payload || {}),
    legacyDuplicateAudit: {
      reason: "duplicate_webhook_processing",
      consolidatedLegacyHistoryIndexes: indexes,
      observedCreatedAt: timestamps,
      alternateMediaStorageKeys: allMediaKeys.filter(
        (storageKey) => storageKey !== canonical.media_storage_key
      ),
    },
  };
  return canonical;
}

function eligibleWebhookDuplicate(existing, incoming, differences, mediaEvidenceByPair) {
  if (!existing.meta_message_id || existing.meta_message_id !== incoming.meta_message_id) return false;
  if (existing.conversation_id !== incoming.conversation_id
    || existing.role !== incoming.role
    || existing.source !== incoming.source
    || existing.message_type !== incoming.message_type
    || existing.direction !== incoming.direction) return false;
  if (sha256Canonical(logicalMessage(existing)) !== sha256Canonical(logicalMessage(incoming))) return false;

  const allowed = new Set(["created_at", "media_storage_key"]);
  if (!differences.every((field) => allowed.has(field))) return false;
  if (!differences.includes("media_storage_key")) return true;
  if (!existing.media_storage_key || !incoming.media_storage_key) return false;
  const evidence = mediaEvidenceByPair.get(
    mediaPairKey(existing.media_storage_key, incoming.media_storage_key)
  );
  return Boolean(evidence?.equivalent);
}

export async function collectMediaDuplicateEvidence(messages, inspector) {
  const evidence = new Map();
  if (typeof inspector !== "function") return evidence;
  const firstById = new Map();
  const objectCache = new Map();
  const inspect = async (storageKey) => {
    if (!objectCache.has(storageKey)) objectCache.set(storageKey, inspector(storageKey));
    return objectCache.get(storageKey);
  };

  for (const message of messages) {
    const existing = firstById.get(message.id);
    if (!existing) {
      firstById.set(message.id, message);
      continue;
    }
    if (!existing.media_storage_key || !message.media_storage_key
      || existing.media_storage_key === message.media_storage_key) continue;
    const key = mediaPairKey(existing.media_storage_key, message.media_storage_key);
    try {
      const objects = await Promise.all([
        inspect(existing.media_storage_key),
        inspect(message.media_storage_key),
      ]);
      const bothValid = objects.every((object) => object.exists
        && object.downloadedSha256
        && object.size === object.downloadedSize);
      evidence.set(key, {
        equivalent: bothValid
          && objects[0].downloadedSha256 === objects[1].downloadedSha256,
        objects,
        error: null,
      });
    } catch (error) {
      evidence.set(key, { equivalent: false, objects: [], error: error.message });
    }
  }
  return evidence;
}

export function classifyAndConsolidateMessages(messages, sampleLimit = 20, options = {}) {
  const phoneByConversationId = options.phoneByConversationId || new Map();
  const mediaEvidenceByPair = options.mediaEvidenceByPair || new Map();
  const messagesById = new Map();
  const crossConversationIds = new Set();
  const exactIds = [];
  const conflictSamples = [];
  let exactDuplicates = 0;
  let consolidatedDuplicates = 0;
  let duplicateConflicts = 0;
  const consolidatedSamples = [];

  for (const message of messages) {
    const existing = messagesById.get(message.id);
    if (!existing) {
      messagesById.set(message.id, message);
      continue;
    }

    if (existing.conversation_id !== message.conversation_id) {
      crossConversationIds.add(message.id);
    }
    const existingComparable = comparableMessage(existing);
    const incomingComparable = comparableMessage(message);
    if (sha256Canonical(existingComparable) === sha256Canonical(incomingComparable)) {
      exactDuplicates += 1;
      if (exactIds.length < sampleLimit) exactIds.push(message.id);
      continue;
    }

    const differences = differingFields(existingComparable, incomingComparable);
    if (eligibleWebhookDuplicate(existing, message, differences, mediaEvidenceByPair)) {
      const consolidated = consolidateWebhookDuplicate(existing, message);
      messagesById.set(message.id, consolidated);
      consolidatedDuplicates += 1;
      if (consolidatedSamples.length < sampleLimit) {
        const evidence = differences.includes("media_storage_key")
          ? mediaEvidenceByPair.get(mediaPairKey(existing.media_storage_key, message.media_storage_key))
          : null;
        consolidatedSamples.push({
          id: message.id,
          metaMessageId: message.meta_message_id,
          telefone: maskedPhone(phoneByConversationId.get(message.conversation_id)),
          legacyHistoryIndexes: [existing.legacy_history_index, message.legacy_history_index].sort((a, b) => a - b),
          canonicalLegacyHistoryIndex: consolidated.legacy_history_index,
          canonicalCreatedAt: consolidated.created_at,
          canonicalMediaStorageKey: consolidated.media_storage_key
            ? maskPhonesInText(consolidated.media_storage_key)
            : null,
          alternateMediaStorageKeys: consolidated.raw_payload.legacyDuplicateAudit
            .alternateMediaStorageKeys.map(maskPhonesInText),
          mediaEvidence: evidence ? {
            equivalent: evidence.equivalent,
            objects: evidence.objects.map(safeEvidenceObject),
          } : null,
          classification: "duplicate webhook processing",
        });
      }
      continue;
    }

    duplicateConflicts += 1;
    if (conflictSamples.length < sampleLimit) {
      const evidence = differences.includes("media_storage_key")
        ? mediaEvidenceByPair.get(mediaPairKey(existing.media_storage_key, message.media_storage_key))
        : null;
      conflictSamples.push({
        id: message.id,
        mesmaConversa: existing.conversation_id === message.conversation_id,
        ocorrencias: [
          conflictOccurrence(existing, phoneByConversationId),
          conflictOccurrence(message, phoneByConversationId),
        ],
        camposDiferentes: differences,
        valoresResumidos: Object.fromEntries(differences.map((field) => [
          field,
          [summarizeDifference(field, existingComparable[field]), summarizeDifference(field, incomingComparable[field])],
        ])),
        classificacaoSugerida: suggestedConflictClassification(
          differences,
          existingComparable,
          incomingComparable
        ),
        mediaEvidence: evidence ? {
          equivalent: evidence.equivalent,
          error: evidence.error,
          objects: evidence.objects.map(safeEvidenceObject),
        } : null,
      });
    }
  }

  return {
    messages: [...messagesById.values()],
    exactDuplicates,
    consolidatedDuplicates,
    duplicateConflicts,
    crossConversationDuplicates: crossConversationIds.size,
    exactIds,
    consolidatedSamples,
    conflictSamples,
  };
}

export function commitBlockers(report) {
  return COMMIT_BLOCKING_COUNTERS.filter((counter) => (report.counters[counter] || 0) > 0);
}

export function assertCommitAllowed(report, { supabaseEnabled = isSupabaseCrmEnabled() } = {}) {
  if (!supabaseEnabled) {
    throw new Error(
      "--commit recusado: defina SUPABASE_CRM_ENABLED=true para confirmar que o destino é o Supabase Sartec CRM."
    );
  }
  const blockers = commitBlockers(report);
  if (blockers.length) {
    throw new Error(`--commit recusado pelos guard rails: ${blockers.join(", ")}.`);
  }
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
  mensagens com base64:     ${report.counters.legacyBase64Messages}
  bytes de base64 legado:   ${report.counters.legacyBase64Bytes}
  maior base64 (bytes):     ${report.counters.largestLegacyBase64Bytes}
  base64 sem R2 válido:     ${report.counters.legacyBase64WithoutR2}
  templates/eventos:        ${report.counters.templates}
  linhas de pipeline:       ${report.counters.pipelineRows}

Resultado do catch-up administrativo
  aplicados: ${JSON.stringify(report.counters.shadowApplied)}
  stale ignorados: ${JSON.stringify(report.counters.shadowStaleIgnored)}

Diagnóstico
  JSON inválido:             ${report.counters.invalidJson}
  sessões inválidas:        ${report.counters.invalidSessions}
  itens de histórico invál.:${report.counters.invalidHistoryItems}
  mensagens sem timestamp:  ${report.counters.messagesWithoutTimestamp}
  duplicatas exatas:        ${report.counters.exactDuplicates}
  duplicatas consolidadas:  ${report.counters.consolidatedDuplicates}
  duplicatas conflitantes:  ${report.counters.duplicateConflicts}
  duplicatas entre conversas:${report.counters.crossConversationDuplicates}
  entradas pipeline invál.: ${report.counters.invalidPipelineEntries}

Campos de sessão sem coluna normalizada: ${Object.keys(report.unmapped.session).join(", ") || "nenhum"}
Campos de mensagem sem coluna normalizada: ${Object.keys(report.unmapped.message).join(", ") || "nenhum"}
Campos de contato sem coluna normalizada: ${Object.keys(report.unmapped.contact).join(", ") || "nenhum"}
Fallbacks de enum detectados: ${Object.keys(report.normalizedFallbacks).join(", ") || "nenhum"}
Checksum: ${report.checksum}
${report.duplicates.conflictSamples.length
    ? `Conflitos de duplicata (amostra): ${JSON.stringify(report.duplicates.conflictSamples)}`
    : "Conflitos de duplicata: nenhum"}
${report.duplicates.consolidatedSamples.length
    ? `Duplicatas consolidadas (auditoria): ${JSON.stringify(report.duplicates.consolidatedSamples)}`
    : "Duplicatas consolidadas: nenhuma"}

${report.mode === "DRY RUN" ? "Nenhuma escrita foi realizada no Supabase." : "Importação gravada no Supabase CRM."}`);
}

export async function buildPlan(redisStore, { commit = false, inspectR2Object = null } = {}) {
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
      exactDuplicates: 0,
      consolidatedDuplicates: 0,
      duplicateConflicts: 0,
      crossConversationDuplicates: 0,
      invalidPipelineEntries: 0,
      legacyBase64Messages: 0,
      legacyBase64Bytes: 0,
      legacyBase64WithoutR2: 0,
      largestLegacyBase64Bytes: 0,
      shadowApplied: { customers: 0, conversations: 0, messages: 0, pipelineRows: 0 },
      shadowStaleIgnored: { customers: 0, conversations: 0, messages: 0, pipelineRows: 0 },
    },
    unmapped: { contact: {}, session: {}, message: {} },
    normalizedFallbacks: {},
    duplicates: { exactIds: [], consolidatedSamples: [], conflictSamples: [] },
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
      report.counters.legacyBase64Messages += mapped.diagnostics.legacyBase64Messages;
      report.counters.legacyBase64Bytes += mapped.diagnostics.legacyBase64Bytes;
      report.counters.legacyBase64WithoutR2 += mapped.diagnostics.legacyBase64WithoutR2;
      report.counters.largestLegacyBase64Bytes = Math.max(
        report.counters.largestLegacyBase64Bytes,
        mapped.diagnostics.largestLegacyBase64Bytes
      );
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

  const phoneByConversationId = new Map(
    conversations.map((conversation) => [
      conversation.id,
      conversation.redis_key.slice("sartec:".length),
    ])
  );
  const mediaEvidenceByPair = await collectMediaDuplicateEvidence(messages, inspectR2Object);
  const deduplicated = classifyAndConsolidateMessages(messages, 20, {
    phoneByConversationId,
    mediaEvidenceByPair,
  });
  const uniqueMessages = deduplicated.messages;
  report.counters.exactDuplicates = deduplicated.exactDuplicates;
  report.counters.consolidatedDuplicates = deduplicated.consolidatedDuplicates;
  report.counters.duplicateConflicts = deduplicated.duplicateConflicts;
  report.counters.crossConversationDuplicates = deduplicated.crossConversationDuplicates;
  report.duplicates.exactIds = deduplicated.exactIds;
  report.duplicates.consolidatedSamples = deduplicated.consolidatedSamples;
  report.duplicates.conflictSamples = deduplicated.conflictSamples;
  const readEntityRevision = async (entityType, entityKey) => {
    if (typeof redisStore.entityRevision !== "function") return 0;
    return redisStore.entityRevision(entityType, entityKey);
  };
  await Promise.all([
    ...[...contactsByPhone.values()].map(async (customer) => {
      customer.shadow_revision = await readEntityRevision("customer", customer.phone);
    }),
    ...conversations.map(async (conversation) => {
      conversation.shadow_revision = await readEntityRevision("conversation", conversation.redis_key);
    }),
    ...uniqueMessages.map(async (message) => {
      message.shadow_revision = await readEntityRevision("message", message.id);
    }),
    ...pipelineRows.map(async (row) => {
      row.shadow_revision = await readEntityRevision(
        "pipeline",
        `${row.client_type}:${row.column_key}`
      );
    }),
  ]);

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

export async function commitPlan(plan, {
  store = new SupabaseCrmStore(),
  supabaseEnabled = isSupabaseCrmEnabled(),
} = {}) {
  assertCommitAllowed(plan.report, { supabaseEnabled });

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
      const result = await store.upsertCustomer(customer);
      customerIds.set(customer.phone, result.id);
      recordShadowResult(plan.report.counters, "customers", result);
    }

    const conversationIds = new Map();
    for (const conversation of plan.conversations) {
      const phone = conversation.redis_key.slice("sartec:".length);
      conversation.customer_id = customerIds.get(phone) || conversation.customer_id;
      const result = await store.upsertConversation(conversation);
      conversationIds.set(conversation.id, result.id);
      recordShadowResult(plan.report.counters, "conversations", result);
    }

    for (const message of plan.messages) {
      message.conversation_id = conversationIds.get(message.conversation_id) || message.conversation_id;
    }
    recordShadowResult(plan.report.counters, "messages", await store.upsertMessages(plan.messages));
    recordShadowResult(plan.report.counters, "pipelineRows", await store.upsertPipelineOrder(plan.pipelineRows));
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
  const args = new Set(process.argv.slice(2));
  const allowedArgs = new Set(["--commit", "--help"]);
  const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));
  if (args.has("--help")) {
    console.log(`Uso:
  node scripts/migrate-redis-to-supabase.js           # dry-run (somente leitura)
  node scripts/migrate-redis-to-supabase.js --commit  # gravação explícita

Para --commit, SUPABASE_CRM_ENABLED deve ser true e todos os guard rails devem estar zerados.`);
    return;
  }
  if (unknownArgs.length) {
    throw new Error(`Argumento(s) desconhecido(s): ${unknownArgs.join(", ")}`);
  }
  const commit = args.has("--commit");
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
    const plan = await buildPlan(new RedisCrmStore(redis), {
      commit,
      inspectR2Object: inspectMediaObject,
    });
    if (commit) await commitPlan(plan);
    printReport(plan.report);
  } finally {
    try { await redis.quit(); } catch { redis.disconnect(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Migração interrompida: ${error.message}`);
    process.exitCode = 1;
  });
}
