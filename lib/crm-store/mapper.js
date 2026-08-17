import { createHash } from "node:crypto";

const CUSTOMER_TYPES = new Set(["pf", "pj", "unknown"]);
const CUSTOMER_DEMAND_TYPES = new Set([
  "outro",
  "lista",
  "cotacao_pj",
  "xerox",
  "produto",
  "duvida",
]);

const CONTACT_FIELDS = new Set([
  "phone",
  "whatsappName",
  "clientName",
  "clientType",
  "demandType",
  "contactNotes",
  "firstSeenAt",
  "lastSeenAt",
  "lastActivityAt",
  "lastConversationStatus",
  "lastPipelineStatus",
  "createdAt",
  "updatedAt",
]);

const SESSION_FIELDS = new Set([
  "history",
  "clientName",
  "clientPhone",
  "clientType",
  "demandType",
  "status",
  "pipelineStatus",
  "cardTitle",
  "priorityManual",
  "dataLimite",
  "formaEntrega",
  "endereco",
  "observacoes",
  "escola",
  "serie",
  "schoolList",
  "handoffDone",
  "handoffAt",
  "postHandoffReplySent",
  "resolvedAt",
  "archivedAt",
  "lastActivityAt",
  "lastUserMessageAt",
  "windowExpiresAt",
  "templateWaitingReply",
  "templateSentAt",
  "lastTemplateType",
  "lastTemplateName",
  "lastTemplateMessageId",
  "lastTemplateDeliveryStatus",
  "lastTemplateStatusAt",
  "lastTemplateError",
  "activeAttendant",
  "activeAttendantAt",
]);

const MESSAGE_FIELDS = new Set([
  "role",
  "content",
  "createdAt",
  "metaMessageId",
  "replyToMsgId",
  "replyToFrom",
  "sentByHuman",
  "attendantId",
  "attendantName",
  "mediaType",
  "mediaMimeType",
  "mediaFilename",
  "mediaStorageKey",
  "mediaStorageProvider",
  "mediaStorageFailed",
  "mediaDeleted",
  "mediaUnavailable",
  "mediaDataRemoved",
  "transcription",
  "transcriptionError",
  "deliveryStatus",
  "deliveryStatusAt",
  "deliveryError",
  "messageType",
  "origin",
  "templateType",
  "templateName",
  "templateLabel",
  "templateText",
  "sentByTemplate",
  "reactions",
]);

export function normalizeSartecPhone(value) {
  const phone = String(value || "").replace(/\D/g, "");
  if (!/^\d{10,15}$/.test(phone)) {
    throw new Error("Telefone Sartec inválido: esperado número com 10 a 15 dígitos.");
  }
  return phone;
}

export function deterministicUuid(namespace, value) {
  const bytes = createHash("sha256")
    .update(`${namespace}:${value}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defined(value) {
  return value === undefined ? null : value;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return value === undefined ? null : value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])])
  );
}

export function sha256Canonical(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function base64Bytes(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const encoded = value.replace(/^data:[^;]+;base64,/i, "").replace(/\s/g, "");
  return Buffer.from(encoded, "base64");
}

function legacyBase64Value(message) {
  if (typeof message.mediaData === "string" && message.mediaData.trim()) {
    return message.mediaData;
  }
  if (!Array.isArray(message.content)) return null;
  for (const part of message.content) {
    if (typeof part?.source?.data === "string" && part.source.data.trim()) {
      return part.source.data;
    }
  }
  return null;
}

function hasValidR2Reference(message) {
  return String(message.mediaStorageProvider || "").toLowerCase() === "cloudflare-r2"
    && typeof message.mediaStorageKey === "string"
    && message.mediaStorageKey.trim().length > 0;
}

function legacyMediaAudit(message) {
  const bytes = base64Bytes(legacyBase64Value(message));
  if (!bytes) return null;
  return {
    present: true,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mediaStorageKey: message.mediaStorageKey || null,
    mediaStorageProvider: message.mediaStorageProvider || null,
    hasValidR2Reference: hasValidR2Reference(message),
  };
}

function withoutLegacyMediaData(value) {
  if (Array.isArray(value)) return value.map((item) => withoutLegacyMediaData(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "mediaData")
      .map(([key, item]) => [key, withoutLegacyMediaData(item)])
  );
}

function sanitizedLegacyMessage(message, mediaAudit) {
  const payload = withoutLegacyMediaData(structuredClone(message));
  if (Array.isArray(payload.content)) {
    payload.content = payload.content.map((part) => {
      if (!part?.source || typeof part.source.data !== "string") return part;
      const sanitizedPart = structuredClone(part);
      delete sanitizedPart.source.data;
      sanitizedPart.source.legacyDataRemoved = true;
      return sanitizedPart;
    });
  }
  if (mediaAudit) payload.legacyMediaData = mediaAudit;
  return payload;
}

function unknownFields(value, known) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((field) => !known.has(field)).sort();
}

function normalizedClientType(value) {
  const type = String(value || "").toLowerCase();
  return CUSTOMER_TYPES.has(type) ? type : "unknown";
}

function normalizedCustomerDemandType(value) {
  const demand = String(value || "").toLowerCase();
  return CUSTOMER_DEMAND_TYPES.has(demand) ? demand : "outro";
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n") || null;
}

function inferSource(message) {
  const explicitOrigin = String(message.origin || "").toLowerCase();
  if ([
    "cloud_api",
    "whatsapp_business_app",
    "history_sync",
    "site",
    "agent",
    "human_crm",
    "template",
    "system",
    "legacy_import",
  ].includes(explicitOrigin)) return explicitOrigin;
  if (message.sentByTemplate || message.messageType === "template") return "template";
  if (message.role === "system") return "system";
  if (message.sentByHuman) return "human_crm";
  if (message.role === "assistant") return "agent";
  if (typeof message.content === "string" && /\[SITE_(?:CATALOGO_ORCAMENTO|LISTA_ESCOLAR)\]/i.test(message.content)) {
    return "site";
  }
  return "cloud_api";
}

function inferMessageType(message) {
  if (message.messageType) return message.messageType;
  if (message.mediaType) return message.mediaType;
  return "text";
}

export function mapRedisContact(phoneValue, contact = {}) {
  const phone = normalizeSartecPhone(contact.phone || phoneValue);
  const clientType = normalizedClientType(contact.clientType);
  const demandType = normalizedCustomerDemandType(contact.demandType);

  return {
    customer: {
      id: deterministicUuid("sartec-customer", phone),
      phone,
      whatsapp_name: contact.whatsappName || null,
      client_name: contact.clientName || contact.whatsappName || null,
      client_type: clientType,
      demand_type: demandType,
      contact_notes: contact.contactNotes || null,
      first_seen_at: isoOrNull(contact.firstSeenAt),
      last_seen_at: isoOrNull(contact.lastSeenAt),
      last_activity_at: isoOrNull(contact.lastActivityAt),
      last_conversation_status: contact.lastConversationStatus || null,
      last_pipeline_status: contact.lastPipelineStatus || null,
      legacy_contact: structuredClone(contact),
      ...(isoOrNull(contact.createdAt || contact.firstSeenAt)
        ? { created_at: isoOrNull(contact.createdAt || contact.firstSeenAt) }
        : {}),
      ...(isoOrNull(contact.updatedAt || contact.lastActivityAt)
        ? { updated_at: isoOrNull(contact.updatedAt || contact.lastActivityAt) }
        : {}),
    },
    unmappedFields: unknownFields(contact, CONTACT_FIELDS),
    normalizedFallbacks: [
      ...(String(contact.clientType || "").toLowerCase() && clientType === "unknown"
        ? [`clientType:${contact.clientType}`]
        : []),
      ...(String(contact.demandType || "").toLowerCase() && demandType === "outro"
        && String(contact.demandType).toLowerCase() !== "outro"
        ? [`demandType:${contact.demandType}`]
        : []),
    ],
  };
}

export function mapHistoryMessage({ phone, conversationId, message, legacyHistoryIndex }) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("Item de histórico inválido: esperado objeto.");
  }

  if (!Number.isInteger(legacyHistoryIndex) || legacyHistoryIndex < 0) {
    throw new Error("legacyHistoryIndex inválido: esperado inteiro não negativo.");
  }

  const metaId = message.metaMessageId || null;
  const stableKey = metaId
    ? `meta:${metaId}`
    : `legacy:${phone}:${legacyHistoryIndex}`;
  const payloadHash = sha256Canonical(message);
  const mediaAudit = legacyMediaAudit(message);
  const sanitizedPayload = sanitizedLegacyMessage(message, mediaAudit);
  const role = ["user", "assistant", "system"].includes(message.role)
    ? message.role
    : "system";
  const direction = role === "user"
    ? "inbound"
    : (message.sentByTemplate || message.messageType === "template" || role === "assistant")
      ? "outbound"
      : "system";

  return {
    message: {
      id: deterministicUuid("sartec-message", stableKey),
      conversation_id: conversationId,
      direction,
      role,
      source: inferSource(message),
      message_type: inferMessageType(message),
      content: textContent(message.content),
      content_json: typeof sanitizedPayload.content === "string"
        ? null
        : defined(sanitizedPayload.content),
      meta_message_id: metaId,
      reply_to_meta_message_id: message.replyToMsgId || null,
      reply_to_from: message.replyToFrom || null,
      sent_by_human: Boolean(message.sentByHuman),
      attendant_id: null,
      attendant_external_id: message.attendantId || null,
      attendant_name: message.attendantName || null,
      media_type: message.mediaType || null,
      media_mime_type: message.mediaMimeType || null,
      media_filename: message.mediaFilename || null,
      media_storage_key: message.mediaStorageKey || null,
      media_storage_provider: message.mediaStorageProvider || null,
      media_storage_failed: Boolean(message.mediaStorageFailed),
      media_deleted: Boolean(message.mediaDeleted),
      media_unavailable: Boolean(message.mediaUnavailable || message.mediaDataRemoved),
      transcription: message.transcription || null,
      transcription_error: Boolean(message.transcriptionError),
      delivery_status: message.deliveryStatus || null,
      delivery_status_at: isoOrNull(message.deliveryStatusAt),
      delivery_error: message.deliveryError || null,
      template_type: message.templateType || null,
      template_name: message.templateName || null,
      template_label: message.templateLabel || null,
      template_text: message.templateText || null,
      sent_by_template: Boolean(message.sentByTemplate || message.messageType === "template"),
      reactions: message.reactions || null,
      raw_payload: sanitizedPayload,
      created_at: isoOrNull(message.createdAt),
      legacy_history_index: legacyHistoryIndex,
      legacy_payload_hash: payloadHash,
    },
    stableKey,
    missingTimestamp: !isoOrNull(message.createdAt),
    unmappedFields: unknownFields(message, MESSAGE_FIELDS),
    hasMedia: Boolean(message.mediaType || message.mediaStorageKey || message.mediaData || mediaAudit),
    legacyBase64: mediaAudit,
    isTemplate: Boolean(
      message.sentByTemplate
      || message.messageType === "template"
      || message.messageType === "template_status"
    ),
  };
}

export function mapRedisSession(phoneValue, session = {}) {
  const phone = normalizeSartecPhone(session.clientPhone || phoneValue);
  const redisKey = `sartec:${phone}`;
  const conversationId = deterministicUuid("sartec-conversation", redisKey);
  const history = Array.isArray(session.history) ? session.history : [];
  const messages = [];
  const messageDiagnostics = [];

  for (const [legacyHistoryIndex, item] of history.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      messageDiagnostics.push({ invalid: true, reason: "history_item_not_object" });
      continue;
    }
    const mapped = mapHistoryMessage({ phone, conversationId, message: item, legacyHistoryIndex });
    messages.push(mapped.message);
    messageDiagnostics.push(mapped);
  }

  const firstMessageAt = messages
    .map((message) => message.created_at)
    .filter(Boolean)
    .sort()[0] || null;
  const clientType = normalizedClientType(
    session.clientType || (session.demandType === "cotacao_pj" ? "pj" : "unknown")
  );
  const legacySession = withoutLegacyMediaData(structuredClone(session));
  delete legacySession.history;
  legacySession.legacyHistoryAudit = {
    count: history.length,
    checksum: sha256Canonical(history),
  };

  return {
    conversation: {
      id: conversationId,
      customer_id: deterministicUuid("sartec-customer", phone),
      redis_key: redisKey,
      status: session.status || "ativo",
      pipeline_status: session.pipelineStatus || "novo",
      demand_type: session.demandType || "outro",
      client_type: clientType,
      card_title: session.cardTitle || null,
      priority_manual: defined(session.priorityManual),
      data_limite: defined(session.dataLimite),
      forma_entrega: defined(session.formaEntrega),
      endereco: defined(session.endereco),
      observacoes: defined(session.observacoes),
      escola: defined(session.escola),
      serie: defined(session.serie),
      school_list: defined(session.schoolList),
      handoff_done: Boolean(session.handoffDone),
      handoff_at: isoOrNull(session.handoffAt),
      post_handoff_reply_sent: Boolean(session.postHandoffReplySent),
      resolved_at: isoOrNull(session.resolvedAt),
      archived_at: isoOrNull(session.archivedAt),
      last_activity_at: isoOrNull(session.lastActivityAt),
      last_user_message_at: isoOrNull(session.lastUserMessageAt),
      window_expires_at: isoOrNull(session.windowExpiresAt),
      template_waiting_reply: Boolean(session.templateWaitingReply),
      template_sent_at: isoOrNull(session.templateSentAt),
      last_template_type: session.lastTemplateType || null,
      last_template_name: session.lastTemplateName || null,
      last_template_message_id: session.lastTemplateMessageId || null,
      last_template_delivery_status: session.lastTemplateDeliveryStatus || null,
      last_template_status_at: isoOrNull(session.lastTemplateStatusAt),
      last_template_error: defined(session.lastTemplateError),
      active_attendant: defined(session.activeAttendant),
      active_attendant_at: isoOrNull(session.activeAttendantAt),
      source_mode: "cloud_api_legacy",
      legacy_session: legacySession,
      ...(firstMessageAt ? { created_at: firstMessageAt } : {}),
      ...(isoOrNull(session.lastActivityAt) ? { updated_at: isoOrNull(session.lastActivityAt) } : {}),
    },
    messages,
    diagnostics: {
      unmappedFields: unknownFields(session, SESSION_FIELDS),
      invalidHistoryItems: messageDiagnostics.filter((item) => item.invalid).length,
      missingTimestamps: messageDiagnostics.filter((item) => item.missingTimestamp).length,
      mediaCount: messageDiagnostics.filter((item) => item.hasMedia).length,
      templateCount: messageDiagnostics.filter((item) => item.isTemplate).length,
      legacyBase64Messages: messageDiagnostics.filter((item) => item.legacyBase64).length,
      legacyBase64Bytes: messageDiagnostics.reduce(
        (total, item) => total + (item.legacyBase64?.bytes || 0),
        0
      ),
      legacyBase64WithoutR2: messageDiagnostics.filter(
        (item) => item.legacyBase64 && !item.legacyBase64.hasValidR2Reference
      ).length,
      largestLegacyBase64Bytes: messageDiagnostics.reduce(
        (largest, item) => Math.max(largest, item.legacyBase64?.bytes || 0),
        0
      ),
      messageUnmappedFields: [...new Set(
        messageDiagnostics.flatMap((item) => item.unmappedFields || [])
      )].sort(),
    },
  };
}

export function mapPipelineOrder(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("sartec:pipelineOrder inválido: esperado objeto.");
  }

  const rows = [];
  const invalidEntries = [];
  for (const [key, order] of Object.entries(value)) {
    const separator = key.indexOf(":");
    const clientType = separator >= 0 ? key.slice(0, separator) : "";
    const columnKey = separator >= 0 ? key.slice(separator + 1) : "";
    if (!["pf", "pj"].includes(clientType) || !columnKey || !Array.isArray(order)) {
      invalidEntries.push(key);
      continue;
    }
    rows.push({
      client_type: clientType,
      column_key: columnKey,
      phone_order: order.map((phone) => String(phone)),
    });
  }
  return { rows, invalidEntries };
}
