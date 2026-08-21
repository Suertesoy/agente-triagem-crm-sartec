// Cobertura da retomada de atendimento via botão Quick Reply de template
// (attendance_resume / retomar_atendimento_v2).
//
// Escopo: api/send-template.js (envio do componente de botão) e api/webhook.js
// (recebimento de message.type === "button", validação de contexto e retomada
// silenciosa reaproveitando handleTemplateResumeReply). Não toca em Coexistence,
// smb_message_echoes, PF/PJ, listas escolares nem na migração Redis/Supabase.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  sendText,
  sendAudio,
  sendButton,
  callSendTemplate,
  getSession,
  forceSetSession,
  sentText,
  POST_HANDOFF_DEFAULT_REPLY,
} from "./helpers/harness.js";

function isoMinutesAgo(min) {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}
function isoHoursAgo(h) {
  return isoMinutesAgo(h * 60);
}

// Sessão "aguardando resposta do template attendance_resume" — mesmo shape que
// send-template.js grava de verdade em markTemplateSent().
async function seedWaitingAttendanceResume(phone, { templateMsgId = "wamid_tmpl_1" } = {}) {
  await forceSetSession(phone, (s) => {
    s.history                    = s.history || [];
    s.clientName                 = "Cliente Teste";
    s.clientType                 = "pf";
    s.demandType                 = "produto";
    s.status                     = "aguardando_humano";
    s.pipelineStatus              = "novo";
    s.handoffDone                = true;
    s.handoffAt                  = isoHoursAgo(2);
    s.postHandoffReplySent       = true;
    s.templateSentAt             = isoMinutesAgo(5);
    s.templateWaitingReply       = true;
    s.lastTemplateType           = "attendance_resume";
    s.lastTemplateName           = "retomar_atendimento_v2";
    s.lastTemplateMessageId      = templateMsgId;
    s.lastTemplateDeliveryStatus = "delivered";
    s.lastUserMessageAt          = isoHoursAgo(30); // janela antiga, fechada
    s.windowExpiresAt            = isoHoursAgo(6);
  });
}

describe("send-template.js — componente de botão Quick Reply", () => {
  after(() => {
    delete process.env.TEMPLATE_ATTENDANCE_RESUME_QUICK_REPLY;
    delete process.env.TEMPLATE_ATTENDANCE_RESUME_BUTTON_PAYLOAD;
  });

  test("v1 (padrão, sem env var) NÃO envia componente de botão — evita rejeição da Meta para template sem Quick Reply aprovado", async () => {
    delete process.env.TEMPLATE_ATTENDANCE_RESUME_QUICK_REPLY;
    const phone = "+5512930000001";

    const { calls, res } = await callSendTemplate({
      to: phone, templateType: "attendance_resume", variables: ["Maria"],
    });

    assert.equal(res._body.success, true);
    const sendCall = calls.find((c) => String(c.url).includes("/messages"));
    const body = JSON.parse(sendCall.opts.body);
    assert.equal(body.template.components.length, 1, "só o componente body — nenhum botão");
    assert.equal(body.template.components[0].type, "body");
  });

  test("v2 (TEMPLATE_ATTENDANCE_RESUME_QUICK_REPLY=true) envia body + botão quick_reply no formato oficial da Cloud API", async () => {
    process.env.TEMPLATE_ATTENDANCE_RESUME_QUICK_REPLY = "true";
    const phone = "+5512930000002";

    const { calls, res } = await callSendTemplate({
      to: phone, templateType: "attendance_resume", variables: ["João"],
    });

    assert.equal(res._body.success, true);
    const sendCall = calls.find((c) => String(c.url).includes("/messages"));
    const body = JSON.parse(sendCall.opts.body);

    assert.equal(body.template.components.length, 2);
    assert.equal(body.template.components[0].type, "body");
    assert.equal(body.template.components[0].parameters[0].text, "João");

    const btn = body.template.components[1];
    assert.equal(btn.type, "button");
    assert.equal(btn.sub_type, "quick_reply");
    assert.equal(btn.index, "0");
    assert.equal(btn.parameters[0].type, "payload");
    assert.equal(btn.parameters[0].payload, "attendance_resume_continue");
  });

  test("payload do botão é configurável via TEMPLATE_ATTENDANCE_RESUME_BUTTON_PAYLOAD", async () => {
    process.env.TEMPLATE_ATTENDANCE_RESUME_QUICK_REPLY    = "true";
    process.env.TEMPLATE_ATTENDANCE_RESUME_BUTTON_PAYLOAD = "custom_payload_xyz";
    const phone = "+5512930000003";

    const { calls } = await callSendTemplate({
      to: phone, templateType: "attendance_resume", variables: ["Ana"],
    });

    const body = JSON.parse(calls.find((c) => String(c.url).includes("/messages")).opts.body);
    assert.equal(body.template.components[1].parameters[0].payload, "custom_payload_xyz");

    delete process.env.TEMPLATE_ATTENDANCE_RESUME_BUTTON_PAYLOAD;
  });

  test("outros templateTypes nunca ganham botão, mesmo com a flag ligada (budget_update/pj_prospecting seguem bloqueados nos testes)", async () => {
    process.env.TEMPLATE_ATTENDANCE_RESUME_QUICK_REPLY = "true";
    const { res } = await callSendTemplate({
      to: "+5512930000004", templateType: "budget_update", variables: ["X"],
    });
    // budget_update continua bloqueado por ALLOWED_IN_TESTING — não deve nem chegar a montar botão.
    assert.equal(res._status, 403);
  });
});

describe("webhook — clique em Quick Reply (message.type === 'button')", () => {
  test("clique válido: payload+context.id do template atual retoma silenciosamente (sem chamar o bot)", async () => {
    const phone = "+5512940000001";
    await seedWaitingAttendanceResume(phone, { templateMsgId: "wamid_tmpl_A" });

    const before = Date.now();
    const { calls } = await sendButton(phone, {
      msgId: "wamid_btn_A1",
      contextId: "wamid_tmpl_A",
      buttonText: "Continuar",
      buttonPayload: "attendance_resume_continue",
    });

    assert.equal(calls.length, 0, "bot deve ficar em silêncio — nenhuma resposta automática");

    const s = await getSession(phone);
    assert.equal(s.templateWaitingReply, false, "flag de espera do template deve ser limpa");
    assert.equal(s.handoffDone, true);
    assert.equal(s.status, "aguardando_humano");
    assert.ok(new Date(s.lastUserMessageAt).getTime() >= before, "lastUserMessageAt deve ser atualizado (janela reabre)");
    assert.ok(new Date(s.windowExpiresAt).getTime() > Date.now() + 23 * 60 * 60 * 1000, "windowExpiresAt deve ser ~24h à frente");

    const clickEntries = s.history.filter((m) => m.metaMessageId === "wamid_btn_A1");
    assert.equal(clickEntries.length, 1, "clique deve aparecer exatamente 1x no histórico");
    const click = clickEntries[0];
    assert.equal(click.role, "user");
    assert.equal(click.content, "Continuar");
    assert.equal(click.messageType, "button");
    assert.equal(click.templateType, "attendance_resume");
    assert.equal(click.replyToMsgId, "wamid_tmpl_A");
  });

  test("redelivery do mesmo metaMessageId não duplica o clique nem reenvia nada", async () => {
    const phone = "+5512940000001"; // mesmo telefone do teste anterior, já retomado
    const { calls } = await sendButton(phone, {
      msgId: "wamid_btn_A1", // mesmo id de antes
      contextId: "wamid_tmpl_A",
      buttonText: "Continuar",
      buttonPayload: "attendance_resume_continue",
    });

    assert.equal(calls.length, 0);
    const s = await getSession(phone);
    const clickEntries = s.history.filter((m) => m.metaMessageId === "wamid_btn_A1");
    assert.equal(clickEntries.length, 1, "redelivery não deve criar uma 2ª entrada no histórico");
  });

  test("clique em template ANTIGO (context.id não bate com lastTemplateMessageId): não corrompe o estado atual, é tratado como inbound normal", async () => {
    const phone = "+5512940000002";
    // Conversa já resolvida há muito tempo (fora da janela de continuação de 6h) —
    // qualquer mensagem real do cliente deve iniciar um NOVO ciclo de triagem, não
    // reabrir silenciosamente como se fosse a retomada do template.
    await forceSetSession(phone, (s) => {
      s.history               = [];
      s.clientType             = "pf";
      s.status                 = "resolvido";
      s.resolvedAt             = isoHoursAgo(10);
      s.handoffDone            = true;
      s.pipelineStatus         = "finalizado";
      s.templateWaitingReply   = true;
      s.lastTemplateType       = "attendance_resume";
      s.lastTemplateMessageId  = "wamid_tmpl_CURRENT"; // template mais recente enviado
    });

    const { calls } = await sendButton(phone, {
      msgId: "wamid_btn_STALE",
      contextId: "wamid_tmpl_OLD", // NÃO é o template mais recente — clique num botão antigo
      buttonText: "Continuar",
      buttonPayload: "attendance_resume_continue",
    });

    // Não foi tratado como retomada válida: virou mensagem normal, novo ciclo de
    // triagem começou (bot responde a saudação/triagem, não fica em silêncio).
    assert.equal(calls.length, 1, "clique antigo deve seguir o fluxo normal de mensagem (bot pode responder)");

    const s = await getSession(phone);
    assert.equal(s.templateWaitingReply, false, "flag obsoleta deve ser limpa mesmo no clique antigo");
    assert.notEqual(s.status, "resolvido", "novo ciclo deve ter iniciado — não deve continuar 'resolvido' com o clique como se nada tivesse acontecido");
    // A marca da retomada "forçada" (handoffDone/aguardando_humano via handleTemplateResumeReply)
    // não deve ter sido aplicada por cima do estado antigo sem passar pela triagem normal.
  });

  test("botão desconhecido / sem template em espera: tratado como mensagem inbound normal (primeira mensagem = triagem)", async () => {
    const phone = "+5512940000003"; // contato novo, nunca recebeu template nenhum
    const { calls } = await sendButton(phone, {
      msgId: "wamid_btn_UNKNOWN",
      buttonText: "Continuar",
      buttonPayload: "algum_payload_nao_reconhecido",
    });

    assert.equal(calls.length, 1, "sem retomada ativa, o clique deve cair na triagem normal (bot responde)");
    const s = await getSession(phone);
    const clickEntries = s.history.filter((m) => m.metaMessageId === "wamid_btn_UNKNOWN");
    assert.equal(clickEntries.length, 1);
    assert.equal(clickEntries[0].messageType, "button");
    assert.notEqual(clickEntries[0].templateType, "attendance_resume", "não deve ser marcado como retomada de attendance_resume");
  });

  test("botão de espera de OUTRO template (ex.: budget_update) não é confundido com attendance_resume", async () => {
    const phone = "+5512940000004";
    await forceSetSession(phone, (s) => {
      s.history               = [];
      s.clientType             = "pf";
      s.status                 = "aguardando_humano";
      s.handoffDone            = true;
      s.handoffAt              = isoHoursAgo(1);
      s.postHandoffReplySent   = true;
      s.templateWaitingReply   = true;
      s.lastTemplateType       = "budget_update";
      s.lastTemplateMessageId  = "wamid_tmpl_budget";
    });

    const { calls } = await sendButton(phone, {
      msgId: "wamid_btn_budget_click",
      contextId: "wamid_tmpl_budget",
      buttonText: "Continuar",
      buttonPayload: "attendance_resume_continue",
    });

    // Não é resposta de attendance_resume — não deve disparar a retomada silenciosa
    // (handleTemplateResumeReply não deve ter sido chamado); cai no fluxo normal.
    const s = await getSession(phone);
    const clickEntries = s.history.filter((m) => m.metaMessageId === "wamid_btn_budget_click");
    assert.equal(clickEntries.length, 1);
    assert.notEqual(clickEntries[0].templateType, "attendance_resume");
    // calls pode ser 0 (silêncio pós-handoff, já tinha postHandoffReplySent=true) — o que importa
    // é que não seja tratado como o caminho especial de attendance_resume.
    assert.ok(calls.length === 0 || calls.length === 1);
  });
});

describe("webhook — compatibilidade com resposta manual (texto/mídia) enquanto aguarda o Quick Reply", () => {
  test("resposta de TEXTO manual ('sim') continua retomando normalmente", async () => {
    const phone = "+5512940000005";
    await seedWaitingAttendanceResume(phone, { templateMsgId: "wamid_tmpl_txt" });

    const { calls } = await sendText(phone, "sim", { msgId: "wamid_txt_reply" });

    assert.equal(calls.length, 0, "bot deve ficar em silêncio na retomada por texto, como já era");
    const s = await getSession(phone);
    assert.equal(s.templateWaitingReply, false);
    assert.equal(s.handoffDone, true);
    assert.equal(s.status, "aguardando_humano");
  });

  test("ÁUDIO enquanto aguarda o template continua reabrindo a retomada normalmente", async () => {
    const phone = "+5512940000006";
    await seedWaitingAttendanceResume(phone, { templateMsgId: "wamid_tmpl_audio" });

    const { calls } = await sendAudio(phone, { msgId: "wamid_audio_reply", mediaId: "media_reply_1" });

    // sendAudio também gera fetches de download de mídia (lookup + arquivo) — o que
    // importa aqui é que nenhuma mensagem de TEXTO seja enviada de volta ao cliente.
    const outboundTexts = calls.filter((c) => String(c.url).includes("/messages"));
    assert.equal(outboundTexts.length, 0, "bot deve ficar em silêncio na retomada por áudio, como já era");
    const s = await getSession(phone);
    assert.equal(s.templateWaitingReply, false);
    assert.equal(s.handoffDone, true);
    assert.equal(s.status, "aguardando_humano");
  });
});
