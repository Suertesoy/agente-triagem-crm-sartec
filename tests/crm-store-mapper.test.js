import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mapHistoryMessage,
  mapPipelineOrder,
  mapRedisContact,
  mapRedisSession,
  normalizeSartecPhone,
} from "../lib/crm-store/mapper.js";
import {
  assertSupabaseCrmTarget,
  isSupabaseCrmEnabled,
} from "../lib/supabase-server.js";
import {
  assertCommitAllowed,
  classifyAndConsolidateMessages,
  commitBlockers,
} from "../scripts/migrate-redis-to-supabase.js";

const PHONE = "5512999990000";
const BASE_TIME = "2026-08-17T12:00:00.000Z";

function session(overrides = {}) {
  return {
    history: [],
    clientName: "Cliente Teste",
    clientPhone: PHONE,
    clientType: "pf",
    demandType: "produto",
    status: "ativo",
    pipelineStatus: "novo",
    lastActivityAt: BASE_TIME,
    lastUserMessageAt: BASE_TIME,
    windowExpiresAt: "2026-08-18T12:00:00.000Z",
    handoffDone: false,
    postHandoffReplySent: false,
    ...overrides,
  };
}

function mapMessage(message, legacyHistoryIndex = 0) {
  return mapHistoryMessage({
    phone: PHONE,
    conversationId: "3a1476ca-c82d-5e69-b127-a71db5d7f02f",
    message,
    legacyHistoryIndex,
  });
}

test("normaliza telefone no mesmo formato numérico usado pelas chaves Sartec", () => {
  assert.equal(normalizeSartecPhone("+55 (12) 99999-0000"), PHONE);
  assert.throws(() => normalizeSartecPhone("123"), /inválido/);
});

test("feature flag fica desligada por padrão e recusa outro projeto Supabase", () => {
  assert.equal(isSupabaseCrmEnabled({}), false);
  assert.equal(isSupabaseCrmEnabled({ SUPABASE_CRM_ENABLED: "true" }), true);
  assert.doesNotThrow(() => assertSupabaseCrmTarget("https://uzwyzwbybtnvgjjhimwy.supabase.co"));
  assert.throws(
    () => assertSupabaseCrmTarget("https://projeto-do-site.supabase.co"),
    /Destino Supabase recusado/
  );
});

test("mapeia contato PF preservando o JSON legado", () => {
  const original = {
    phone: PHONE,
    whatsappName: "Maria",
    clientName: "Maria Silva",
    clientType: "pf",
    demandType: "lista",
    contactNotes: "Prefere retirada",
    firstSeenAt: BASE_TIME,
  };
  const { customer } = mapRedisContact(PHONE, original);
  assert.equal(customer.phone, PHONE);
  assert.equal(customer.client_type, "pf");
  assert.equal(customer.demand_type, "lista");
  assert.deepEqual(customer.legacy_contact, original);
});

test("mapeia contato PJ e reporta campos sem coluna normalizada", () => {
  const { customer, unmappedFields } = mapRedisContact(PHONE, {
    clientName: "Empresa Exemplo Ltda",
    clientType: "pj",
    demandType: "cotacao_pj",
    inscricaoEstadual: "legado",
  });
  assert.equal(customer.client_type, "pj");
  assert.equal(customer.demand_type, "cotacao_pj");
  assert.deepEqual(unmappedFields, ["inscricaoEstadual"]);
});

test("mapeia conversa em triagem sem alterar o estado", () => {
  const { conversation } = mapRedisSession(PHONE, session({
    status: "triagem_incompleta",
    pipelineStatus: "novo",
  }));
  assert.equal(conversation.status, "triagem_incompleta");
  assert.equal(conversation.pipeline_status, "novo");
  assert.equal(conversation.source_mode, "cloud_api_legacy");
});

test("mapeia conversa entregue ao humano e atendente ativo", () => {
  const activeAttendant = { id: "lucas", name: "Lucas", initials: "LU", color: "#123456" };
  const { conversation } = mapRedisSession(PHONE, session({
    status: "aguardando_humano",
    pipelineStatus: "em_atendimento",
    handoffDone: true,
    handoffAt: BASE_TIME,
    activeAttendant,
    activeAttendantAt: BASE_TIME,
  }));
  assert.equal(conversation.handoff_done, true);
  assert.equal(conversation.handoff_at, BASE_TIME);
  assert.deepEqual(conversation.active_attendant, activeAttendant);
});

test("mapeia conversa resolvida", () => {
  const { conversation } = mapRedisSession(PHONE, session({
    status: "resolvido",
    pipelineStatus: "finalizado",
    resolvedAt: BASE_TIME,
  }));
  assert.equal(conversation.status, "resolvido");
  assert.equal(conversation.resolved_at, BASE_TIME);
});

test("mapeia texto inbound e outbound do agente", () => {
  const inbound = mapMessage({ role: "user", content: "Olá", createdAt: BASE_TIME, metaMessageId: "wamid.in" });
  const outbound = mapMessage({ role: "assistant", content: "Como posso ajudar?", createdAt: BASE_TIME });
  assert.equal(inbound.message.direction, "inbound");
  assert.equal(inbound.message.source, "cloud_api");
  assert.equal(outbound.message.direction, "outbound");
  assert.equal(outbound.message.source, "agent");
});

test("preserva origem site quando registrada explicitamente", () => {
  const { message } = mapMessage({
    role: "system",
    content: "Lista recebida pelo site",
    messageType: "internal_note",
    origin: "site",
    createdAt: BASE_TIME,
  });
  assert.equal(message.source, "site");
  assert.equal(message.message_type, "internal_note");
});

test("mapeia mensagem enviada por humano e mantém ID externo do atendente", () => {
  const { message } = mapMessage({
    role: "assistant",
    content: "Seu orçamento está pronto",
    sentByHuman: true,
    attendantId: "att-123",
    attendantName: "Ana",
    createdAt: BASE_TIME,
  });
  assert.equal(message.source, "human_crm");
  assert.equal(message.sent_by_human, true);
  assert.equal(message.attendant_external_id, "att-123");
  assert.equal(message.attendant_id, null);
});

test("mapeia imagem e referência Cloudflare R2", () => {
  const { message, hasMedia } = mapMessage({
    role: "user",
    content: "Foto do produto",
    mediaType: "image",
    mediaMimeType: "image/jpeg",
    mediaStorageKey: `media/${PHONE}/202608/wamid.image.jpg`,
    mediaStorageProvider: "cloudflare-r2",
    createdAt: BASE_TIME,
  });
  assert.equal(hasMedia, true);
  assert.equal(message.media_type, "image");
  assert.equal(message.media_storage_provider, "cloudflare-r2");
});

test("mapeia documento e nome do arquivo", () => {
  const { message } = mapMessage({
    role: "assistant",
    content: "Orçamento",
    sentByHuman: true,
    mediaType: "document",
    mediaMimeType: "application/pdf",
    mediaFilename: "orcamento.pdf",
    mediaStorageKey: `media/${PHONE}/202608/orcamento.pdf`,
    createdAt: BASE_TIME,
  });
  assert.equal(message.message_type, "document");
  assert.equal(message.media_filename, "orcamento.pdf");
});

test("mapeia áudio com transcrição e erro de transcrição", () => {
  const success = mapMessage({
    role: "user",
    content: "[áudio]",
    mediaType: "audio",
    transcription: "Preciso de dez cadernos",
    createdAt: BASE_TIME,
  });
  const failed = mapMessage({
    role: "user",
    content: "[áudio]",
    mediaType: "audio",
    transcriptionError: true,
    createdAt: BASE_TIME,
  });
  assert.equal(success.message.transcription, "Preciso de dez cadernos");
  assert.equal(failed.message.transcription_error, true);
});

test("mapeia template e estado de entrega", () => {
  const { message, isTemplate } = mapMessage({
    role: "system",
    content: "Template enviado: Retomar atendimento",
    messageType: "template",
    templateType: "attendance_resume",
    templateName: "retomar_atendimento_v1",
    templateLabel: "Retomar atendimento",
    templateText: "Olá, Maria",
    sentByTemplate: true,
    metaMessageId: "wamid.template",
    deliveryStatus: "read",
    deliveryStatusAt: BASE_TIME,
    createdAt: BASE_TIME,
  });
  assert.equal(isTemplate, true);
  assert.equal(message.direction, "outbound");
  assert.equal(message.source, "template");
  assert.equal(message.delivery_status, "read");
});

test("mapeia reply/context e status de falha", () => {
  const { message } = mapMessage({
    role: "assistant",
    content: "Respondendo sua mensagem",
    replyToMsgId: "wamid.original",
    replyToFrom: PHONE,
    deliveryStatus: "failed",
    deliveryStatusAt: BASE_TIME,
    deliveryError: "Falha na entrega",
    createdAt: BASE_TIME,
  });
  assert.equal(message.reply_to_meta_message_id, "wamid.original");
  assert.equal(message.reply_to_from, PHONE);
  assert.equal(message.delivery_error, "Falha na entrega");
});

test("preserva lista escolar e sessão legada sem duplicar o history", () => {
  const schoolList = {
    source: "pdf",
    items: ["2 cadernos", "1 estojo"],
    school: "Escola Exemplo",
  };
  const original = session({
    demandType: "lista",
    escola: "Escola Exemplo",
    serie: "5º ano",
    schoolList,
    historySummary: "campo legado sem coluna própria",
  });
  const { conversation, diagnostics } = mapRedisSession(PHONE, original);
  assert.deepEqual(conversation.school_list, schoolList);
  assert.equal("history" in conversation.legacy_session, false);
  assert.equal(conversation.legacy_session.historySummary, original.historySummary);
  assert.equal(conversation.legacy_session.legacyHistoryAudit.count, 0);
  assert.match(conversation.legacy_session.legacyHistoryAudit.checksum, /^[a-f0-9]{64}$/);
  assert.ok(diagnostics.unmappedFields.includes("historySummary"));
});

test("gera ID determinístico para mensagem sem Meta ID e é idempotente", () => {
  const legacy = {
    role: "user",
    content: "Mensagem legada",
    createdAt: BASE_TIME,
  };
  const first = mapMessage(legacy);
  const repeated = mapMessage(structuredClone(legacy));
  assert.equal(first.message.id, repeated.message.id);

  const firstRun = mapRedisSession(PHONE, session({ history: [legacy] }));
  const secondRun = mapRedisSession(PHONE, session({ history: [structuredClone(legacy)] }));
  assert.deepEqual(firstRun, secondRun);
});

test("distingue mensagens legadas idênticas pela posição histórica", () => {
  const duplicate = { role: "user", content: "ok", createdAt: BASE_TIME };
  const { messages } = mapRedisSession(PHONE, session({ history: [duplicate, duplicate] }));
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].id, messages[1].id);
});

test("mensagem sem timestamp grava created_at nulo e preserva a posição histórica", () => {
  const { message, missingTimestamp } = mapMessage({ role: "user", content: "Sem hora" }, 17);
  assert.equal(message.created_at, null);
  assert.equal(message.legacy_history_index, 17);
  assert.equal(missingTimestamp, true);
});

test("ID legado depende da posição, não de campos mutáveis", () => {
  const original = mapMessage({
    role: "assistant",
    content: "Pedido enviado",
    deliveryStatus: "sent",
    reactions: [],
  }, 8);
  const updated = mapMessage({
    role: "assistant",
    content: "Pedido enviado",
    deliveryStatus: "read",
    reactions: [{ emoji: "👍" }],
  }, 8);
  assert.equal(original.message.id, updated.message.id);
  assert.notEqual(original.message.legacy_payload_hash, updated.message.legacy_payload_hash);
});

test("mensagens idênticas em posições diferentes têm IDs diferentes", () => {
  const value = { role: "user", content: "Mesmo conteúdo" };
  assert.notEqual(mapMessage(value, 3).message.id, mapMessage(value, 4).message.id);
});

test("audita count e checksum do history sem persistir seu conteúdo na conversa", () => {
  const history = [
    { role: "user", content: "A", createdAt: BASE_TIME },
    { role: "assistant", content: "B" },
  ];
  const { conversation } = mapRedisSession(PHONE, session({ history }));
  assert.equal(conversation.legacy_session.legacyHistoryAudit.count, 2);
  assert.match(conversation.legacy_session.legacyHistoryAudit.checksum, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(conversation.legacy_session).includes("\"history\":"), false);
});

test("remove base64 legado do payload PostgreSQL e preserva SHA, tamanho e referência R2", () => {
  const binary = Buffer.from("conteúdo binário legado", "utf8");
  const encoded = binary.toString("base64");
  const mapped = mapMessage({
    role: "user",
    content: [{ type: "image", source: { type: "base64", data: encoded } }],
    mediaData: encoded,
    mediaType: "image",
    mediaStorageKey: `media/${PHONE}/legacy.jpg`,
    mediaStorageProvider: "cloudflare-r2",
  }, 2);
  assert.equal("mediaData" in mapped.message.raw_payload, false);
  assert.equal("data" in mapped.message.raw_payload.content[0].source, false);
  assert.equal("data" in mapped.message.content_json[0].source, false);
  assert.equal(mapped.legacyBase64.bytes, binary.length);
  assert.equal(
    mapped.legacyBase64.sha256,
    createHash("sha256").update(binary).digest("hex")
  );
  assert.equal(mapped.legacyBase64.hasValidR2Reference, true);
  assert.deepEqual(mapped.message.raw_payload.legacyMediaData, mapped.legacyBase64);

  const { conversation } = mapRedisSession(PHONE, session({ mediaData: encoded }));
  assert.equal("mediaData" in conversation.legacy_session, false);
});

test("base64 legado sem R2 válido bloqueia commit", () => {
  const mapped = mapRedisSession(PHONE, session({
    history: [{ role: "user", content: "arquivo", mediaData: Buffer.from("x").toString("base64") }],
  }));
  assert.equal(mapped.diagnostics.legacyBase64Messages, 1);
  assert.equal(mapped.diagnostics.legacyBase64WithoutR2, 1);
  const report = { counters: { legacyBase64WithoutR2: 1 } };
  assert.throws(
    () => assertCommitAllowed(report, { supabaseEnabled: true }),
    /legacyBase64WithoutR2/
  );
});

test("consolida duplicata normalizada exata", () => {
  const first = mapMessage({
    role: "user",
    content: "duplicada",
    metaMessageId: "wamid.duplicate",
    createdAt: BASE_TIME,
  }, 1).message;
  const second = { ...structuredClone(first), legacy_history_index: 9 };
  const result = classifyAndConsolidateMessages([first, second]);
  assert.equal(result.messages.length, 1);
  assert.equal(result.exactDuplicates, 1);
  assert.equal(result.duplicateConflicts, 0);
});

test("reporta duplicata conflitante sem tratá-la como exata", () => {
  const first = mapMessage({
    role: "user",
    content: "versão A",
    metaMessageId: "wamid.conflict",
  }, 1).message;
  const second = mapMessage({
    role: "user",
    content: "versão B",
    metaMessageId: "wamid.conflict",
  }, 2).message;
  const result = classifyAndConsolidateMessages([first, second]);
  assert.equal(result.exactDuplicates, 0);
  assert.equal(result.duplicateConflicts, 1);
  assert.equal(result.conflictSamples[0].id, first.id);
  assert.ok(result.conflictSamples[0].camposDiferentes.includes("content"));
  assert.equal(result.conflictSamples[0].classificacaoSugerida, "possível corrupção");
});

test("guard rails de commit bloqueiam todos os contadores exigidos e ignoram timestamp ausente", () => {
  const blocking = [
    "invalidJson",
    "invalidSessions",
    "invalidHistoryItems",
    "invalidPipelineEntries",
    "crossConversationDuplicates",
    "duplicateConflicts",
    "legacyBase64WithoutR2",
  ];
  for (const counter of blocking) {
    const report = { counters: { [counter]: 1, messagesWithoutTimestamp: 182 } };
    assert.deepEqual(commitBlockers(report), [counter]);
    assert.throws(() => assertCommitAllowed(report, { supabaseEnabled: true }), /--commit recusado/);
  }
  assert.doesNotThrow(() => assertCommitAllowed({
    counters: { messagesWithoutTimestamp: 182, exactDuplicates: 8 },
  }, { supabaseEnabled: true }));
});

test("mapeia ordem do pipeline por tipo e coluna", () => {
  const { rows, invalidEntries } = mapPipelineOrder({
    "pf:novo": [PHONE, "5512888880000"],
    "pj:em_cotacao": ["5512777770000"],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(invalidEntries, []);
  assert.deepEqual(rows[0].phone_order, [PHONE, "5512888880000"]);
});
