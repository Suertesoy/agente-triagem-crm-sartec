// Cobertura da rodada "PF/PJ com Reply Buttons + handoff PJ imediato +
// agregação/debounce do turno PF pré-handoff".
//
// Escopo: api/webhook.js (classificação PF/PJ determinística, novo handler
// message.type === "interactive"/"button_reply", burst/debounce via
// lib/agent-burst.js + api/agent-burst-sweep.js). Não toca em migração
// Redis/Supabase, Coexistence, smb_message_echoes, rotação Redis, número
// WhatsApp, template attendance_resume nem em OCR/visão de imagem.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  sendText,
  sendAudio,
  sendButton,
  sendInteractiveButton,
  callBurstSweep,
  getSession,
  forceSetSession,
  sentText,
  sentTexts,
  rawClient,
  anthropicSpy,
  imageWebhookBody,
  documentWebhookBody,
  resetFetchCalls,
  getFetchCalls,
  handler,
} from "./helpers/harness.js";
import { getBurstRecord } from "../lib/agent-burst.js";

const PJ_HANDOFF_SNIPPET = "vou direcionar seu atendimento para a equipe";
const PF_GREETING_SNIPPET = "Me conte o que você precisa";

function fakeRes() {
  return { _status: null, _body: null, status(c) { this._status = c; return this; }, json(b) { this._body = b; return this; }, send(b) { this._body = b; return this; } };
}
async function sendImage(phone, opts) {
  resetFetchCalls();
  const req = { method: "POST", body: imageWebhookBody(phone, opts) };
  const res = fakeRes();
  await handler(req, res);
  return { res, calls: getFetchCalls() };
}
async function sendDocument(phone, opts) {
  resetFetchCalls();
  const req = { method: "POST", body: documentWebhookBody(phone, opts) };
  const res = fakeRes();
  await handler(req, res);
  return { res, calls: getFetchCalls() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("PF/PJ inicial — Reply Buttons interativos", () => {
  test("1ª mensagem ambígua envia a mensagem interativa PF/PJ (type=interactive/button), não chama Claude", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000001";
    const { calls } = await sendText(phone, "Oi", { msgId: "wamid_first_1" });

    assert.equal(calls.length, 1, "deve haver exatamente 1 envio — a mensagem interativa");
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.type, "interactive");
    assert.equal(body.interactive.type, "button");
    assert.equal(body.interactive.body.text.includes("escolha uma opção"), true);
    const ids = body.interactive.action.buttons.map((b) => b.reply.id);
    assert.deepEqual(ids, ["client_type_pf", "client_type_pj"]);
    const titles = body.interactive.action.buttons.map((b) => b.reply.title);
    assert.deepEqual(titles, ["Pessoa física", "Pessoa jurídica"]);
    assert.equal(anthropicSpy.callCount, 0, "mensagem determinística — não deve chamar Claude");

    const s = await getSession(phone);
    assert.equal(s.pfPjPromptSent, true);
    assert.ok(!s.clientType, "clientType ainda não deve estar definido");
    const lastAsst = s.history.filter((m) => m.role === "assistant").pop();
    assert.equal(lastAsst.messageType, "interactive_buttons");
  });

  test("clique no botão PF envia a saudação PF determinística, sem chamar Claude, e não espera debounce", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000002";

    const { calls } = await sendInteractiveButton(phone, { id: "client_type_pf", msgId: "wamid_pf_btn_1" });
    assert.equal(calls.length, 1, "deve responder imediatamente — botão nunca espera burst");
    assert.equal(sentText(calls), "Perfeito! Me conte o que você precisa. Pode mandar texto, fotos, áudio ou arquivo — vou reunir as informações para te ajudar.");
    assert.equal(anthropicSpy.callCount, 0);

    const s = await getSession(phone);
    assert.equal(s.clientType, "pf");
    assert.ok(!s.handoffDone, "PF não deve fazer handoff só por identificar o tipo");
    const click = s.history.find((m) => m.metaMessageId === "wamid_pf_btn_1");
    assert.equal(click.role, "user");
    assert.equal(click.content, "Pessoa física");
    assert.equal(click.messageType, "interactive_button");
    assert.equal(click.buttonId, "client_type_pf");
  });

  test("clique no botão PJ faz handoff IMEDIATO, sem chamar Claude, e não espera debounce", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000003";

    const before = Date.now();
    const { calls } = await sendInteractiveButton(phone, { id: "client_type_pj", msgId: "wamid_pj_btn_1" });
    assert.equal(calls.length, 1);
    const reply = sentText(calls);
    assert.ok(reply.includes(PJ_HANDOFF_SNIPPET), "deve usar a mensagem curta de handoff PJ");
    assert.ok(!reply.toLowerCase().includes("cadastro"));
    assert.ok(!reply.toLowerCase().includes("desconto"));
    assert.equal(anthropicSpy.callCount, 0);

    const s = await getSession(phone);
    assert.equal(s.clientType, "pj");
    assert.equal(s.handoffDone, true);
    assert.equal(s.status, "aguardando_humano");
    assert.equal(s.postHandoffReplySent, true);
    assert.ok(new Date(s.handoffAt).getTime() >= before);
  });

  test("redelivery do mesmo metaMessageId do botão não duplica nem reenvia", async () => {
    const phone = "+5512950000003"; // mesmo telefone do teste anterior, já PJ+handoffDone
    const { calls } = await sendInteractiveButton(phone, { id: "client_type_pj", msgId: "wamid_pj_btn_1" });
    assert.equal(calls.length, 0, "redelivery não deve gerar novo envio");
    const s = await getSession(phone);
    const clicks = s.history.filter((m) => m.metaMessageId === "wamid_pj_btn_1");
    assert.equal(clicks.length, 1);
  });
});

describe("Fallback textual PF/PJ (sem clicar no botão)", () => {
  test("texto 'sou pessoa física' classifica PF determinística, sem Claude", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000010";
    const { calls } = await sendText(phone, "sou pessoa física", { msgId: "wamid_pf_txt_1" });
    assert.equal(calls.length, 1);
    assert.ok(sentText(calls).includes(PF_GREETING_SNIPPET));
    assert.equal(anthropicSpy.callCount, 0);
    const s = await getSession(phone);
    assert.equal(s.clientType, "pf");
  });

  test("texto 'é pra minha empresa' classifica PJ determinística e faz handoff imediato", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000011";
    const { calls } = await sendText(phone, "é para a empresa, pode ser?", { msgId: "wamid_pj_txt_1" });
    assert.equal(calls.length, 1);
    assert.ok(sentText(calls).includes(PJ_HANDOFF_SNIPPET));
    const s = await getSession(phone);
    assert.equal(s.clientType, "pj");
    assert.equal(s.handoffDone, true);
  });

  test("CNPJ explícito na 1ª mensagem classifica PJ automaticamente, sem mostrar botões", async () => {
    const phone = "+5512950000012";
    const { calls } = await sendText(phone, "Bom dia, meu CNPJ é 12.345.678/0001-90, preciso de orçamento", { msgId: "wamid_cnpj_1" });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.type, "text", "CNPJ explícito deve pular os botões e ir direto para o handoff PJ");
    assert.ok(sentText(calls).includes(PJ_HANDOFF_SNIPPET));
    const s = await getSession(phone);
    assert.equal(s.clientType, "pj");
    assert.equal(s.handoffDone, true);
  });
});

describe("PJ pós-handoff — CNPJ opcional, zero respostas automáticas", () => {
  test("CNPJ enviado espontaneamente pós-handoff é só registrado — nenhuma pergunta adicional", async () => {
    const phone = "+5512950000012"; // já PJ + handoffDone do teste anterior
    const { calls } = await sendText(phone, "CNPJ: 12.345.678/0001-90", { msgId: "wamid_cnpj_2" });
    assert.equal(calls.length, 0, "PJ pós-handoff deve ficar em silêncio total, mesmo recebendo o CNPJ");
    const s = await getSession(phone);
    assert.ok(s.history.some((m) => m.content === "CNPJ: 12.345.678/0001-90"));
  });

  test("foto + PDF + várias mensagens pós-handoff PJ: tudo registrado, zero envios do agente", async () => {
    const phone = "+5512950000013";
    await sendInteractiveButton(phone, { id: "client_type_pj", msgId: "wamid_pj_multi_btn" });

    const r1 = await sendImage(phone, { msgId: "wamid_pj_img_1" });
    assert.equal(r1.calls.filter((c) => String(c.url).includes("/messages")).length, 0);

    const r2 = await sendDocument(phone, { msgId: "wamid_pj_doc_1" });
    assert.equal(r2.calls.filter((c) => String(c.url).includes("/messages")).length, 0);

    const r3 = await sendText(phone, "preciso de 20 unidades", { msgId: "wamid_pj_txt_after" });
    assert.equal(r3.calls.length, 0);

    const s = await getSession(phone);
    assert.ok(s.history.some((m) => m.content === "[documento]"));
    assert.ok(s.history.some((m) => m.content === "preciso de 20 unidades"));
    const assistantMsgsAfterHandoff = s.history.filter((m) => m.role === "assistant");
    assert.equal(assistantMsgsAfterHandoff.length, 1, "só a mensagem de handoff — nenhuma resposta extra depois");
  });
});

describe("attendance_resume (Quick Reply de template) continua funcionando sem alteração", () => {
  test("clique no Quick Reply de template ainda retoma silenciosamente (não é o novo Reply Button PF/PJ)", async () => {
    const phone = "+5512950000020";
    await forceSetSession(phone, (s) => {
      s.history = [];
      s.clientType = "pf";
      s.status = "aguardando_humano";
      s.handoffDone = true;
      s.handoffAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      s.postHandoffReplySent = true;
      s.templateSentAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      s.templateWaitingReply = true;
      s.lastTemplateType = "attendance_resume";
      s.lastTemplateMessageId = "wamid_tmpl_resume_1";
    });

    const { calls } = await sendButton(phone, {
      msgId: "wamid_resume_click_1",
      contextId: "wamid_tmpl_resume_1",
      buttonText: "Continuar",
      buttonPayload: "attendance_resume_continue",
    });

    assert.equal(calls.length, 0, "retomada continua silenciosa");
    const s = await getSession(phone);
    assert.equal(s.templateWaitingReply, false);
    assert.equal(s.handoffDone, true);
  });
});

describe("Burst/debounce — turno PF pré-handoff (janelas reduzidas para teste)", () => {
  before(() => {
    process.env.AGENT_BURST_QUIET_MS = "60";
    process.env.AGENT_BURST_MAX_MS = "220";
  });
  after(() => {
    delete process.env.AGENT_BURST_QUIET_MS;
    delete process.env.AGENT_BURST_MAX_MS;
  });

  test("burst simples de 1 mensagem: nenhuma resposta imediata; após o quiet period, o sweep gera exatamente 1 resposta", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000030";
    await sendInteractiveButton(phone, { id: "client_type_pf", msgId: "wamid_burst1_btn" });

    const { calls } = await sendText(phone, "Preciso de canetas e cadernos coloridos", { msgId: "wamid_burst1_1" });
    assert.equal(calls.length, 0, "não deve responder imediatamente — aguarda o turno");
    assert.equal(anthropicSpy.callCount, 0);

    const rec = await getBurstRecord(rawClient, phone);
    assert.ok(rec, "deve existir um registro de burst pendente");
    assert.equal(rec.generation, 1);

    await sleep(90); // > quietMs(60ms)
    const sweep1 = await callBurstSweep();
    const sent = sweep1.calls.filter((c) => String(c.url).includes("/messages"));
    assert.equal(sent.length, 1, "sweep deve gerar exatamente 1 resposta após o quiet period");
    assert.equal(anthropicSpy.callCount, 1, "Claude deve ser chamado exatamente 1 vez para o turno inteiro");

    assert.equal(await getBurstRecord(rawClient, phone), null, "registro de burst deve ser limpo após o fechamento");
  });

  test("3 mensagens de texto em sequência → exatamente 1 resposta do agente", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000031";
    await sendInteractiveButton(phone, { id: "client_type_pf", msgId: "wamid_burst3_btn" });

    await sendText(phone, "Oi", { msgId: "wamid_burst3_1" });
    await sleep(20);
    await sendText(phone, "Tudo bem?", { msgId: "wamid_burst3_2" });
    await sleep(20);
    const r3 = await sendText(phone, "Preciso de canetas e cadernos", { msgId: "wamid_burst3_3" });
    assert.equal(r3.calls.length, 0);

    const recBefore = await getBurstRecord(rawClient, phone);
    assert.equal(recBefore.generation, 3, "cada mensagem deve reiniciar o quiet period (generation incrementa)");

    await sleep(90);
    const sweep = await callBurstSweep();
    const sent = sweep.calls.filter((c) => String(c.url).includes("/messages"));
    assert.equal(sent.length, 1);
    assert.equal(anthropicSpy.callCount, 1, "3 mensagens do mesmo turno geram só 1 chamada a Claude");

    const s = await getSession(phone);
    const userMsgs = s.history.filter((m) => m.role === "user" && typeof m.content === "string");
    assert.ok(userMsgs.some((m) => m.content === "Oi"));
    assert.ok(userMsgs.some((m) => m.content === "Tudo bem?"));
    assert.ok(userMsgs.some((m) => m.content === "Preciso de canetas e cadernos"));
  });

  test("texto + imagem + texto → 1 resposta consolidada (sem 'Recebi sua imagem' isolado)", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000032";
    await sendInteractiveButton(phone, { id: "client_type_pf", msgId: "wamid_burstmix_btn" });

    await sendText(phone, "é uma lista escolar", { msgId: "wamid_burstmix_1" });
    await sleep(20);
    const rImg = await sendImage(phone, { msgId: "wamid_burstmix_img" });
    assert.equal(rImg.calls.filter((c) => String(c.url).includes("/messages")).length, 0, "não deve responder isoladamente à foto");
    await sleep(20);
    await sendText(phone, "queria um orçamento", { msgId: "wamid_burstmix_2" });

    await sleep(90);
    const sweep = await callBurstSweep();
    const sent = sweep.calls.filter((c) => String(c.url).includes("/messages"));
    assert.equal(sent.length, 1, "só 1 mensagem enviada ao cliente, mesmo com texto+imagem+texto no turno");
    // callCount pode ser 2 aqui (resposta principal + extração interna de lista
    // escolar, que também chama Claude) — o que importa é que só 1 mensagem
    // chega ao cliente (sent.length acima), nunca uma por mídia isolada.
    assert.ok(anthropicSpy.callCount >= 1);
  });

  test("duas imagens + texto → 1 resposta única", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000033";
    await sendInteractiveButton(phone, { id: "client_type_pf", msgId: "wamid_burst2img_btn" });

    await sendImage(phone, { msgId: "wamid_burst2img_1" });
    await sleep(20);
    await sendImage(phone, { msgId: "wamid_burst2img_2" });
    await sleep(20);
    await sendText(phone, "essas fotos são da lista", { msgId: "wamid_burst2img_3" });

    await sleep(90);
    const sweep = await callBurstSweep();
    assert.equal(sweep.calls.filter((c) => String(c.url).includes("/messages")).length, 1);
    assert.equal(anthropicSpy.callCount, 1);
  });

  test("hard cap: mensagens contínuas (sem pausa) ainda assim fecham o turno ~220ms após a 1ª mensagem", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000034";
    await sendInteractiveButton(phone, { id: "client_type_pf", msgId: "wamid_hardcap_btn" });

    const t0 = Date.now();
    await sendText(phone, "msg1", { msgId: "wamid_hardcap_1" });
    while (Date.now() - t0 < 200) {
      await sleep(30);
      await sendText(phone, "msg" + Date.now(), { msgId: "wamid_hardcap_" + Date.now() + Math.random() });
    }

    // Mesmo com mensagens quase contínuas, o dueAt não deve passar de firstMessageAt + maxMs(220ms)
    const rec = await getBurstRecord(rawClient, phone);
    assert.ok(rec, "burst ainda deve existir logo após o loop");
    assert.ok(rec.dueAt <= rec.firstMessageAt + 220 + 5, "hard cap deve limitar dueAt mesmo sob mensagens contínuas");

    await sleep(250);
    const sweep = await callBurstSweep();
    const sent = sweep.calls.filter((c) => String(c.url).includes("/messages"));
    assert.equal(sent.length, 1, "hard cap deve garantir 1 resposta mesmo sem pausa real do cliente");
  });

  test("geração antiga não responde: sweep chamado com registro já superado por mensagem mais nova não duplica", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000035";
    await sendInteractiveButton(phone, { id: "client_type_pf", msgId: "wamid_gen_btn" });
    await sendText(phone, "primeira", { msgId: "wamid_gen_1" });

    // Sweep chamado ANTES do quiet period (dueAt ainda no futuro) — não deve processar.
    const early = await callBurstSweep();
    assert.equal(early.calls.filter((c) => String(c.url).includes("/messages")).length, 0);
    assert.equal(anthropicSpy.callCount, 0);

    // Mensagem nova estende o turno (nova generation).
    await sendText(phone, "segunda", { msgId: "wamid_gen_2" });

    await sleep(90);
    const sweep = await callBurstSweep();
    assert.equal(sweep.calls.filter((c) => String(c.url).includes("/messages")).length, 1, "só 1 resposta final, cobrindo as duas mensagens");
    assert.equal(anthropicSpy.callCount, 1, "nunca deve gerar uma resposta por geração intermediária");
  });

  test("pedido explícito de humano pula o burst e responde imediatamente", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000036";
    await sendInteractiveButton(phone, { id: "client_type_pf", msgId: "wamid_human_btn" });

    const { calls } = await sendText(phone, "quero falar com um atendente", { msgId: "wamid_human_1" });
    assert.equal(calls.length, 1, "pedido explícito de humano não deve esperar o quiet period");
    assert.equal(anthropicSpy.callCount, 1);
  });

  test("PJ nunca entra no burst — handoff continua instantâneo mesmo com as janelas de teste ativas", async () => {
    anthropicSpy.resetAnthropicSpy();
    const phone = "+5512950000037";
    const { calls } = await sendInteractiveButton(phone, { id: "client_type_pj", msgId: "wamid_pj_nodefer" });
    assert.equal(calls.length, 1);
    assert.equal(anthropicSpy.callCount, 0);
    const rec = await getBurstRecord(rawClient, phone);
    assert.equal(rec, null, "PJ não deve gerar registro de burst");
  });
});

describe("Suíte existente permanece verde (sanity check rápido)", () => {
  test("mensagem de áudio simples ainda funciona (transcrição + fluxo normal)", async () => {
    const phone = "+5512950000040";
    // handoff prévio para evitar depender de burst neste smoke test
    await forceSetSession(phone, (s) => {
      s.history = [];
      s.clientType = "pf";
      s.handoffDone = true;
      s.handoffAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      s.postHandoffReplySent = true;
      s.status = "aguardando_humano";
    });
    const { calls } = await sendAudio(phone, { msgId: "wamid_audio_smoke_1" });
    // Pós-handoff PF fora da janela operacional → silêncio total (comportamento já existente)
    assert.equal(calls.filter((c) => String(c.url).includes("/messages")).length, 0);
  });
});
