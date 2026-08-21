import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  FakeRedis,
  rawClient,
  callMetrics,
  forceSetSession,
} from "./helpers/harness.js";

beforeEach(() => FakeRedis._reset());

const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(); // fora de "hoje"/"7d"/"30d", dentro de "tudo"

function humanMsg(overrides = {}) {
  return { role: "assistant", content: "oi", sentByHuman: true, attendantId: "lucas", attendantName: "Lucas", metaMessageId: "wamid_h", deliveryStatus: "sent", createdAt: NOW, ...overrides };
}
function agentConfirmedMsg(overrides = {}) {
  return { role: "assistant", content: "resposta automática", metaMessageId: "wamid_a", createdAt: NOW, ...overrides };
}
function agentUnconfirmedMsg(overrides = {}) {
  return { role: "assistant", content: "tentativa não confirmada", createdAt: NOW, ...overrides }; // sem metaMessageId
}
function templateMsg(overrides = {}) {
  return { role: "system", content: "Template enviado", messageType: "template", sentByTemplate: true, sentByHuman: false, metaMessageId: "wamid_t", createdAt: NOW, ...overrides };
}
function internalNoteMsg(overrides = {}) {
  return { role: "system", content: "Lista escolar enviada pelo site.", messageType: "internal_note", origin: "site", createdAt: NOW, ...overrides };
}
function templateStatusMsg(overrides = {}) {
  return { role: "system", content: "", messageType: "template_status", templateStatus: "failed", relatedMessageId: "wamid_t", createdAt: NOW, ...overrides };
}
function inboundMsg(overrides = {}) {
  return { role: "user", content: "mensagem do cliente", createdAt: NOW, ...overrides };
}

async function seedSession(phone, history, extra = {}) {
  await forceSetSession(phone, (s) => Object.assign(s, {
    history, clientType: "pf", status: "aguardando_humano", lastActivityAt: NOW, ...extra,
  }));
}

test("classifica origem por mensagem: humano, agente confirmado, template — exclui não-outbound", async () => {
  await seedSession("5512900000401", [
    inboundMsg(),
    humanMsg(),
    agentConfirmedMsg(),
    agentUnconfirmedMsg(),   // não conta — bot sem confirmação da Meta (sem metaMessageId)
    templateMsg(),
    internalNoteMsg(),       // não conta — nunca vai à Meta
    templateStatusMsg(),     // não conta — evento sintético, não é mensagem real
  ]);

  const data = await callMetrics({ period: "tudo" });
  const cloud = data.apiUsage.cloudApi;

  assert.equal(cloud.customerOutbound, 3);
  assert.equal(cloud.byOrigin.human, 1);
  assert.equal(cloud.byOrigin.agent, 1);
  assert.equal(cloud.byOrigin.template, 1);
  assert.equal(cloud.byOrigin.unknown, 0);
});

test("classifica por tipo (texto, imagem, áudio, documento, template)", async () => {
  await seedSession("5512900000402", [
    humanMsg(),
    humanMsg({ mediaType: "image", metaMessageId: "wamid_img" }),
    humanMsg({ mediaType: "audio", metaMessageId: "wamid_aud" }),
    humanMsg({ mediaType: "document", metaMessageId: "wamid_doc" }),
    templateMsg(),
  ]);

  const data = await callMetrics({ period: "tudo" });
  const byType = data.apiUsage.cloudApi.byType;

  assert.equal(byType.text, 1);
  assert.equal(byType.image, 1);
  assert.equal(byType.audio, 1);
  assert.equal(byType.document, 1);
  assert.equal(byType.template, 1);
});

test("mensagens sem createdAt: contam em 'tudo', ficam fora de 'hoje' e são reportadas em dataNotes", async () => {
  await seedSession("5512900000403", [
    humanMsg({ createdAt: undefined }),
  ]);

  const all = await callMetrics({ period: "tudo" });
  assert.equal(all.apiUsage.cloudApi.customerOutbound, 1);
  assert.equal(all.apiUsage.cloudApi.byDay.length, 0);
  assert.equal(all.apiUsage.dataNotes.undatedMessageCount, 1);

  const today = await callMetrics({ period: "hoje" });
  assert.equal(today.apiUsage.cloudApi.customerOutbound, 0);
});

test("mensagem antiga não entra em 'hoje' mas entra em 'tudo'", async () => {
  await seedSession("5512900000404", [humanMsg({ createdAt: OLD })]);

  const today = await callMetrics({ period: "hoje" });
  assert.equal(today.apiUsage.cloudApi.customerOutbound, 0);

  const all = await callMetrics({ period: "tudo" });
  assert.equal(all.apiUsage.cloudApi.customerOutbound, 1);
  assert.equal(all.apiUsage.cloudApi.byDay.length, 1);
});

test("PF/PJ, conversas distintas e média por conversa", async () => {
  await seedSession("5512900000405", [humanMsg(), humanMsg({ metaMessageId: "wamid_h2" })], { clientType: "pf" });
  await seedSession("5512900000406", [humanMsg({ metaMessageId: "wamid_h3" })], { clientType: "pj" });

  const data = await callMetrics({ period: "tudo" });
  const cloud = data.apiUsage.cloudApi;

  assert.equal(cloud.byClientType.pf, 2);
  assert.equal(cloud.byClientType.pj, 1);
  assert.equal(cloud.distinctConversations, 2);
  assert.equal(cloud.avgPerConversation, 1.5);
});

test("encaminhamentos para Denise: lidos da lista dedicada, sem afetar o total ao cliente", async () => {
  await seedSession("5512900000407", [humanMsg()]);
  await rawClient.lpush("sartec:metrics:denise_forwards", JSON.stringify({ at: NOW, mediaType: "document" }));
  await rawClient.lpush("sartec:metrics:denise_forwards", JSON.stringify({ at: NOW, mediaType: "image" }));

  const data = await callMetrics({ period: "tudo" });
  const cloud = data.apiUsage.cloudApi;

  assert.equal(cloud.internalForward.total, 2);
  assert.equal(cloud.customerOutbound, 1, "encaminhamento para Denise não é mensagem ao cliente");
  assert.equal(cloud.internalOutbound, 2);
  assert.equal(cloud.totalCloudApiOutbound, 3, "totalCloudApiOutbound = customerOutbound + internalOutbound");
});

test("totalCloudApiOutbound = customerOutbound + internalOutbound, e a estimativa de custo parte do total", async () => {
  // 10 mensagens outbound para clientes (customerOutbound)
  const clientHistory = Array.from({ length: 10 }, (_, i) => humanMsg({ metaMessageId: `wamid_h${i}` }));
  await seedSession("5512900000410", clientHistory);

  // 2 encaminhamentos internos para Denise (internalOutbound)
  await rawClient.lpush("sartec:metrics:denise_forwards", JSON.stringify({ at: NOW, mediaType: "document" }));
  await rawClient.lpush("sartec:metrics:denise_forwards", JSON.stringify({ at: NOW, mediaType: "image" }));

  const data = await callMetrics({ period: "tudo" });
  const cloud = data.apiUsage.cloudApi;

  assert.equal(cloud.customerOutbound, 10);
  assert.equal(cloud.internalOutbound, 2);
  assert.equal(cloud.totalCloudApiOutbound, 12);

  const original = process.env.META_SERVICE_MESSAGE_PRICE_BRL;
  process.env.META_SERVICE_MESSAGE_PRICE_BRL = "1";
  try {
    const withPrice = await callMetrics({ period: "tudo" });
    assert.equal(withPrice.apiUsage.cloudApi.totalCloudApiOutbound, 12);
    assert.equal(withPrice.apiUsage.costEstimate.totalEstimateBRL, 12, "estimativa deve usar totalCloudApiOutbound (12), não só customerOutbound (10)");
  } finally {
    if (original === undefined) delete process.env.META_SERVICE_MESSAGE_PRICE_BRL;
    else process.env.META_SERVICE_MESSAGE_PRICE_BRL = original;
  }
});

test("chave sartec:metrics:* nunca é tratada como sessão pelo scan genérico", async () => {
  await seedSession("5512900000408", [humanMsg()]);
  await rawClient.set("sartec:metrics:algum_contador_futuro", "não é uma sessão JSON válida {{{");

  const data = await callMetrics({ period: "tudo" });
  assert.equal(data.summary.totalChats, 1);
});

test("estimativa de custo só aparece com META_SERVICE_MESSAGE_PRICE_BRL configurada", async () => {
  await seedSession("5512900000409", [humanMsg(), humanMsg({ metaMessageId: "wamid_h2" })]);

  const withoutPrice = await callMetrics({ period: "tudo" });
  assert.equal(withoutPrice.apiUsage.costEstimate, null);

  const original = process.env.META_SERVICE_MESSAGE_PRICE_BRL;
  process.env.META_SERVICE_MESSAGE_PRICE_BRL = "0.05";
  try {
    const withPrice = await callMetrics({ period: "tudo" });
    assert.equal(withPrice.apiUsage.costEstimate.priceBRL, 0.05);
    assert.equal(withPrice.apiUsage.costEstimate.totalEstimateBRL, 0.1);
  } finally {
    if (original === undefined) delete process.env.META_SERVICE_MESSAGE_PRICE_BRL;
    else process.env.META_SERVICE_MESSAGE_PRICE_BRL = original;
  }
});

test("base vazia retorna apiUsage zerado sem erro", async () => {
  const data = await callMetrics({ period: "tudo" });
  assert.equal(data.apiUsage.cloudApi.customerOutbound, 0);
  assert.equal(data.apiUsage.cloudApi.internalOutbound, 0);
  assert.equal(data.apiUsage.cloudApi.totalCloudApiOutbound, 0);
  assert.deepEqual(data.apiUsage.cloudApi.byOrigin, { human: 0, agent: 0, template: 0, unknown: 0 });
  assert.equal(data.apiUsage.costEstimate, null);
});

test("base sem sessões mas com encaminhamentos Denise: totalCloudApiOutbound e estimativa refletem só o interno", async () => {
  await rawClient.lpush("sartec:metrics:denise_forwards", JSON.stringify({ at: NOW, mediaType: "document" }));

  const original = process.env.META_SERVICE_MESSAGE_PRICE_BRL;
  process.env.META_SERVICE_MESSAGE_PRICE_BRL = "2";
  try {
    const data = await callMetrics({ period: "tudo" });
    const cloud = data.apiUsage.cloudApi;
    assert.equal(cloud.customerOutbound, 0);
    assert.equal(cloud.internalOutbound, 1);
    assert.equal(cloud.totalCloudApiOutbound, 1);
    assert.equal(data.apiUsage.costEstimate.totalEstimateBRL, 2);
  } finally {
    if (original === undefined) delete process.env.META_SERVICE_MESSAGE_PRICE_BRL;
    else process.env.META_SERVICE_MESSAGE_PRICE_BRL = original;
  }
});
