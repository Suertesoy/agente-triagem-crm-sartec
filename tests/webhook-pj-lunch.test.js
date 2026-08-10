// Regressão para o bug de duplicidade da auto-resposta de "modo almoço PJ".
//
// Causa raiz (confirmada no código antes da correção): tanto a branch de
// texto (dentro de chatWithAgent) quanto a branch equivalente de áudio (inline
// em handleIncomingMessage) chamavam sendTextMessage() diretamente E também
// retornavam o mesmo texto — e o chamador no topo (handleIncomingMessage)
// SEMPRE envia o texto retornado (`if (reply) await sendTextMessage(...)`),
// resultando em dois envios da mesma mensagem de almoço.
//
// A correção remove o envio direto nas duas branches, mantendo o retorno do
// texto — a mesma convenção usada em todo o resto do arquivo (a função
// interna retorna texto ou null; só handleIncomingMessage envia).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sendText,
  sendAudio,
  getSession,
  forceSetSession,
  setPjLunchMode,
  sentText,
  sentTexts,
  EXPECTED_LUNCH_REPLY,
  EXPECTED_CATALOG_REPLY,
  POST_HANDOFF_DEFAULT_REPLY,
  PJ_CATALOG_MSG,
} from "./helpers/harness.js";

// Estado de um contato PJ já triado, com handoff concluído há tempo (fora da
// janela de 5min de dúvidas operacionais) e já tendo recebido a resposta
// padrão de pós-handoff — é exatamente a condição em que shouldRespond()
// retorna `false` e a branch de silêncio (onde mora o modo almoço) executa.
async function seedHandedOffPJ(phone) {
  await forceSetSession(phone, (s) => {
    s.history              = s.history || [];
    s.clientType            = "pj";
    s.demandType            = "cotacao_pj";
    s.status                = "aguardando_humano";
    s.handoffDone           = true;
    s.handoffAt             = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h atrás
    s.postHandoffReplySent  = true;
    s.pipelineStatus        = "novo";
  });
}

async function seedHandedOffPF(phone) {
  await forceSetSession(phone, (s) => {
    s.history              = s.history || [];
    s.clientType            = "pf";
    s.demandType            = "produto";
    s.status                = "aguardando_humano";
    s.handoffDone           = true;
    s.handoffAt             = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    s.postHandoffReplySent  = true;
    s.pipelineStatus        = "novo";
  });
}

describe("modo almoço PJ — texto", () => {
  const phone = "+5512920000001";

  test("1/5/6/7. PJ com modo almoço ativo recebe EXATAMENTE 1 envio, com o texto exato, registrado 1x no histórico com pjLunchAutoReply", async () => {
    await seedHandedOffPJ(phone);
    await setPjLunchMode(true);

    const { calls } = await sendText(phone, "Alguma novidade sobre meu orçamento?", { msgId: "wamid_lunch_txt_1" });

    assert.equal(calls.length, 1, "deve haver exatamente 1 envio ao cliente");
    assert.equal(sentText(calls), EXPECTED_LUNCH_REPLY);

    const s = await getSession(phone);
    const lunchEntries = s.history.filter((m) => m.role === "assistant" && m.content === EXPECTED_LUNCH_REPLY);
    assert.equal(lunchEntries.length, 1, "a resposta de almoço deve aparecer exatamente 1x no histórico");
    assert.equal(lunchEntries[0].pjLunchAutoReply, true);
    assert.ok(s.pjLunchAutoReplySentFor, "sessão deve registrar para qual janela de almoço a resposta já foi enviada");
  });

  test("8. reenviar mensagem na MESMA janela de almoço não duplica (nem 2º envio, nem 2ª entrada no histórico)", async () => {
    const { calls } = await sendText(phone, "Só confirmando de novo.", { msgId: "wamid_lunch_txt_2" });

    assert.equal(calls.length, 0, "não deve reenviar a mesma auto-resposta de almoço na mesma janela");

    const s = await getSession(phone);
    const lunchEntries = s.history.filter((m) => m.role === "assistant" && m.content === EXPECTED_LUNCH_REPLY);
    assert.equal(lunchEntries.length, 1, "ainda deve haver só 1 entrada de almoço no histórico (da mensagem anterior)");

    const metaIds = s.history.map((m) => m.metaMessageId).filter(Boolean);
    assert.equal(metaIds.length, new Set(metaIds).size, "metaMessageId não deve se repetir no histórico");
  });

  test("3. modo almoço desligado não dispara a resposta de almoço", async () => {
    const phone2 = "+5512920000002";
    await seedHandedOffPJ(phone2);
    await setPjLunchMode(false);

    const { calls } = await sendText(phone2, "Oi, ainda aguardando.", { msgId: "wamid_lunch_off_1" });

    assert.equal(calls.length, 0, "sem modo almoço, mensagem pós-handoff deve ficar em silêncio (sem envio)");
    const s = await getSession(phone2);
    assert.ok(!s.history.some((m) => m.content === EXPECTED_LUNCH_REPLY));
  });

  test("4. PF nunca recebe a resposta de almoço PJ, mesmo com o modo ativo", async () => {
    const phone3 = "+5512920000003";
    await seedHandedOffPF(phone3);
    await setPjLunchMode(true);

    const { calls } = await sendText(phone3, "Oi, alguma novidade?", { msgId: "wamid_lunch_pf_1" });

    assert.equal(calls.length, 0, "PF em silêncio pós-handoff não deve receber nenhum envio automático de almoço");
    const s = await getSession(phone3);
    assert.ok(!s.history.some((m) => m.content === EXPECTED_LUNCH_REPLY));
  });
});

describe("modo almoço PJ — áudio", () => {
  test("2. PJ com modo almoço ativo em mensagem de ÁUDIO recebe EXATAMENTE 1 envio", async () => {
    const phone = "+5512920000004";
    await seedHandedOffPJ(phone);
    await setPjLunchMode(true);

    const { calls } = await sendAudio(phone, { msgId: "wamid_lunch_audio_1", mediaId: "media_lunch_1" });

    assert.equal(calls.filter((c) => String(c.url).includes("/messages")).length, 1, "deve haver exatamente 1 envio de texto ao cliente");
    const texts = sentTexts(calls.filter((c) => String(c.url).includes("/messages")));
    assert.ok(texts.includes(EXPECTED_LUNCH_REPLY), "o envio deve ser a mensagem de almoço");

    const s = await getSession(phone);
    const lunchEntries = s.history.filter((m) => m.role === "assistant" && m.content === EXPECTED_LUNCH_REPLY);
    assert.equal(lunchEntries.length, 1);
    assert.equal(lunchEntries[0].pjLunchAutoReply, true);
  });
});

describe("modo almoço PJ — interação com o bypass do catálogo", () => {
  test("9. novo pedido PJ via catálogo, com modo almoço ativo, não recebe resposta duplicada de almoço", async () => {
    const phone = "+5512920000005";
    await setPjLunchMode(true);

    const { calls } = await sendText(phone, PJ_CATALOG_MSG(), { msgId: "wamid_lunch_catalog_1" });

    assert.equal(calls.length, 1, "bypass do catálogo deve enviar só a confirmação, nunca a de almoço junto");
    assert.equal(sentText(calls), EXPECTED_CATALOG_REPLY);
    assert.notEqual(sentText(calls), EXPECTED_LUNCH_REPLY);
  });
});

describe("modo almoço PJ — fluxos normais de pós-handoff continuam funcionando", () => {
  test("10a. primeira mensagem pós-handoff (sem modo almoço) recebe a resposta padrão exatamente 1x", async () => {
    const phone = "+5512920000006";
    await setPjLunchMode(false);
    await forceSetSession(phone, (s) => {
      s.history             = [];
      s.clientType           = "pf";
      s.status               = "aguardando_humano";
      s.handoffDone          = true;
      s.handoffAt            = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      s.postHandoffReplySent = false; // ainda não recebeu a resposta padrão
      s.pipelineStatus       = "novo";
    });

    const { calls } = await sendText(phone, "Oi, tudo bem?", { msgId: "wamid_default_1" });

    assert.equal(calls.length, 1);
    assert.equal(sentText(calls), POST_HANDOFF_DEFAULT_REPLY);
  });

  test("10b. mensagens seguintes ficam em silêncio total (sem nenhum envio)", async () => {
    const phone = "+5512920000006"; // mesmo telefone do teste anterior — já com postHandoffReplySent=true
    const { calls, res } = await sendText(phone, "Só mais uma pergunta.", { msgId: "wamid_default_2" });

    assert.equal(calls.length, 0);
    assert.equal(res._body, "EVENT_RECEIVED");
  });
});
