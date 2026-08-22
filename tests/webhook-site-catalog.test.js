// Contratos críticos do fluxo site → WhatsApp → webhook → CRM para orçamentos
// originados do catálogo do site ([SITE_CATALOGO_ORCAMENTO] + [TIPO_CLIENTE:PF|PJ]).
//
// Testes passam pela entrada pública real do webhook (handler(req, res)),
// simulando o payload do WhatsApp como a Vercel receberia — não testam regex
// isolada. ioredis e @anthropic-ai/sdk são substituídos por fakes em memória
// (ver tests/helpers/); nenhuma rede real é usada.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  anthropicSpy,
  sendText,
  callQueue,
  getSession,
  getContact,
  forceSetSession,
  sentText,
  PF_CATALOG_MSG,
  PJ_CATALOG_MSG,
  SCHOOL_LIST_MSG,
  EXPECTED_CATALOG_REPLY,
} from "./helpers/harness.js";

describe("catálogo do site — PF válido", () => {
  const phone = "+5512910000001";

  test("não chama a Anthropic e responde com a confirmação determinística", async () => {
    anthropicSpy.resetAnthropicSpy();
    const { calls } = await sendText(phone, PF_CATALOG_MSG(), { msgId: "wamid_pf_1" });
    assert.equal(anthropicSpy.callCount, 0);
    assert.equal(calls.length, 1, "deve enviar exatamente uma confirmação");
    assert.equal(sentText(calls), EXPECTED_CATALOG_REPLY);
  });

  test("associa o ID devolvido pela Meta à resposta exata já salva", async () => {
    const s = await getSession(phone);
    const inbound = s.history.find((message) => message.role === "user");
    const outbound = s.history.find((message) => message.role === "assistant");

    assert.equal(inbound.metaMessageId, "wamid_pf_1");
    assert.equal(outbound.content, EXPECTED_CATALOG_REPLY);
    assert.equal(outbound.metaMessageId, "wamid_out_1");
    assert.equal(s.history.filter((message) => message.role === "assistant").length, 1);
  });

  test("persiste os campos determinísticos esperados na sessão", async () => {
    const s = await getSession(phone);
    assert.equal(s.clientType, "pf");
    assert.equal(s.demandType, "produto");
    assert.equal(s.status, "aguardando_humano");
    assert.equal(s.pipelineStatus, "novo");
    assert.equal(s.handoffDone, true);
    assert.equal(s.requestSource, "site_catalog_quote");
    assert.ok(s.handoffAt, "handoffAt deve estar preenchido");
  });

  test("preserva a mensagem inbound completa no histórico", async () => {
    const s = await getSession(phone);
    assert.ok(
      s.history.some((m) => m.role === "user" && m.content === PF_CATALOG_MSG()),
      "mensagem original (com marcadores e itens) deve estar íntegra no histórico"
    );
  });

  test("contato persistente é atualizado com clientType pf", async () => {
    const c = await getContact(phone);
    assert.equal(c.clientType, "pf");
  });
});

describe("catálogo do site — PJ válido", () => {
  const phone = "+5512910000002";

  test("não chama a Anthropic e responde com a confirmação determinística", async () => {
    anthropicSpy.resetAnthropicSpy();
    const { calls } = await sendText(phone, PJ_CATALOG_MSG(), { msgId: "wamid_pj_1" });
    assert.equal(anthropicSpy.callCount, 0);
    assert.equal(calls.length, 1);
    assert.equal(sentText(calls), EXPECTED_CATALOG_REPLY);
  });

  test("persiste os campos determinísticos esperados na sessão", async () => {
    const s = await getSession(phone);
    assert.equal(s.clientType, "pj");
    assert.equal(s.demandType, "cotacao_pj");
    assert.equal(s.status, "aguardando_humano");
    assert.equal(s.pipelineStatus, "novo");
    assert.equal(s.handoffDone, true);
    assert.equal(s.requestSource, "site_catalog_quote");
    assert.ok(s.handoffAt);
  });

  test("preserva a mensagem inbound completa no histórico", async () => {
    const s = await getSession(phone);
    assert.ok(s.history.some((m) => m.role === "user" && m.content === PJ_CATALOG_MSG()));
  });
});

describe("catálogo do site — reabertura de conversa resolvida", () => {
  const phone = "+5512910000003";

  test("preserva histórico antigo, limpa resolvedAt e reabre em aguardando_humano", async () => {
    await sendText(phone, PF_CATALOG_MSG(), { msgId: "wamid_resolve_1" });
    const before = await getSession(phone);
    const histLenBefore = before.history.length;

    // Simula api/resolve.js marcando a conversa como resolvida
    await forceSetSession(phone, (s) => {
      s.status = "resolvido";
      s.resolvedAt = new Date().toISOString();
    });

    await sendText(phone, PJ_CATALOG_MSG(), { msgId: "wamid_resolve_2" });
    const after = await getSession(phone);

    assert.equal(after.status, "aguardando_humano");
    assert.equal(after.resolvedAt, null);
    assert.equal(after.pipelineStatus, "novo");
    assert.ok(after.history.length > histLenBefore, "histórico antigo deve ser preservado, não apagado");
    // Marcador da NOVA mensagem (PJ) vence o estado anterior (PF)
    assert.equal(after.clientType, "pj");
    assert.equal(after.demandType, "cotacao_pj");
  });
});

describe("catálogo do site — marcador vence histórico do contato", () => {
  test("contato conhecido como PF enviando [TIPO_CLIENTE:PJ] é reclassificado para PJ", async () => {
    const phone = "+5512910000004";
    await sendText(phone, PF_CATALOG_MSG(), { msgId: "wamid_reclass_1" });
    assert.equal((await getSession(phone)).clientType, "pf");

    await sendText(phone, PJ_CATALOG_MSG(), { msgId: "wamid_reclass_2" });
    const s = await getSession(phone);
    assert.equal(s.clientType, "pj");
    assert.equal(s.demandType, "cotacao_pj");
    assert.equal((await getContact(phone)).clientType, "pj");
  });

  test("contato conhecido como PJ enviando [TIPO_CLIENTE:PF] é reclassificado para PF", async () => {
    const phone = "+5512910000005";
    await sendText(phone, PJ_CATALOG_MSG(), { msgId: "wamid_reclass_3" });
    assert.equal((await getSession(phone)).clientType, "pj");

    await sendText(phone, PF_CATALOG_MSG(), { msgId: "wamid_reclass_4" });
    const s = await getSession(phone);
    assert.equal(s.clientType, "pf");
    assert.equal(s.demandType, "produto");
  });
});

describe("catálogo do site — fallback de segurança", () => {
  // Nota (rodada PF/PJ + burst): sem os dois marcadores válidos, a mensagem cai
  // no fluxo normal de PRIMEIRO CONTATO — que agora é determinístico (Reply
  // Buttons PF/PJ) ANTES de chamar Claude, não mais "sempre chama a Anthropic".
  // O que este teste protege continua válido: o bypass do catálogo (que pula
  // toda a triagem e vai direto para atendimento humano) não deve ativar.
  test("[SITE_CATALOGO_ORCAMENTO] sem tipo válido não ativa o bypass (cai no 1º contato normal — Reply Buttons)", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512910000006";
    await sendText(
      phone,
      "[SITE_CATALOGO_ORCAMENTO]\n\nOlá, quero um orçamento mas esqueci de indicar o tipo de cliente no site.",
      { msgId: "wamid_fallback_1" }
    );
    const s = await getSession(phone);
    assert.notEqual(s.handoffDone, true, "não deve forçar handoff sem tipo válido");
    assert.notEqual(s.requestSource, "site_catalog_quote");
    assert.equal(s.pfPjPromptSent, true, "deve cair no 1º contato normal e mostrar os Reply Buttons PF/PJ");
    assert.equal(anthropicSpy.callCount, 0, "1º contato agora é determinístico — não chama a Anthropic");
  });

  test("[TIPO_CLIENTE:PF] sem marcador de origem não ativa o bypass", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512910000007";
    await sendText(phone, "[TIPO_CLIENTE:PF]\n\nQueria saber o horário de vocês, por favor.", { msgId: "wamid_fallback_2" });
    const s = await getSession(phone);
    assert.notEqual(s.requestSource, "site_catalog_quote");
    assert.equal(s.pfPjPromptSent, true, "deve cair no 1º contato normal e mostrar os Reply Buttons PF/PJ");
    assert.equal(anthropicSpy.callCount, 0);
  });
});

describe("catálogo do site — sem regressão na lista escolar", () => {
  test("[SITE_LISTA_ESCOLAR] continua funcionando e continua evitando a Anthropic", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512910000008";
    const { calls } = await sendText(phone, SCHOOL_LIST_MSG, { msgId: "wamid_school_1" });
    const s = await getSession(phone);

    assert.equal(anthropicSpy.callCount, 0);
    assert.equal(s.clientType, "pj");
    assert.equal(s.demandType, "lista");
    assert.notEqual(sentText(calls), EXPECTED_CATALOG_REPLY, "não deve usar a confirmação do catálogo");
    assert.match(sentText(calls) || "", /lista escolar/i);
  });
});

describe("catálogo do site — fila (/api/queue)", () => {
  test("card PF aparece com clientType=pf e pipelineStatus=novo", async () => {
    const data = await callQueue();
    const card = data.conversations.find((c) => c.phone === "+5512910000001");
    assert.ok(card, "card PF deveria estar na fila");
    assert.equal(card.clientType, "pf");
    assert.equal(card.pipelineStatus, "novo");
    assert.equal(card.status, "aguardando_humano");
  });

  test("card PJ aparece com clientType=pj e pipelineStatus=novo", async () => {
    const data = await callQueue();
    const card = data.conversations.find((c) => c.phone === "+5512910000002");
    assert.ok(card, "card PJ deveria estar na fila");
    assert.equal(card.clientType, "pj");
    assert.equal(card.pipelineStatus, "novo");
    assert.equal(card.status, "aguardando_humano");
  });
});
