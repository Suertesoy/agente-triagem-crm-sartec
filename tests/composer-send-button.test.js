// Regressão: botão "Enviar" do composer (painel/index.html) sumindo quando um
// PDF ou imagem é selecionado com o textarea vazio.
//
// Causa raiz: updateComposerSendState() decidia a classe .has-text (que o CSS
// usa para alternar MIC ↔ ENVIAR — ver `.composer-main .btn-send`/`.btn-mic`
// em painel/index.html) olhando SOMENTE para o texto digitado. Selecionar um
// PDF/imagem nunca toca o textarea, então .has-text ficava false, o CSS
// escondia o Enviar (display:none) e mostrava o mic no lugar — mesmo com um
// arquivo pronto para envio (pendingImages/pendingDocuments/pendingMedia).
//
// Como painel/index.html não é um módulo ES (arquivo único sem bundler), as
// funções são extraídas por regex do próprio arquivo fonte e avaliadas
// isoladamente — mesmo padrão de tests/audio-mic-validation.test.js — para
// garantir que o código testado é exatamente o que roda no navegador.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, "..", "painel", "index.html"), "utf8");

function extract(source, regex, label) {
  const match = source.match(regex);
  if (!match) throw new Error(`${label} não encontrado em painel/index.html — verifique se a função foi renomeada/movida`);
  return match[0];
}

const updateComposerSendStateSrc = extract(
  html,
  /function updateComposerSendState\([\s\S]*?\n\}\r?\n/,
  "updateComposerSendState()"
);
const sendMessageSrc = extract(
  html,
  /async function sendMessage\([\s\S]*?\n\}\r?\n/,
  "sendMessage()"
);

// ── DOM mínimo fake: só o suficiente para exercitar closest(".composer-row")
// + classList.toggle("has-text", ...), que é tudo que updateComposerSendState
// usa do DOM real. ──
function makeComposerRow() {
  const classes = new Set();
  return {
    classList: {
      toggle(cls, force) {
        const shouldHave = force !== undefined ? !!force : !classes.has(cls);
        if (shouldHave) classes.add(cls); else classes.delete(cls);
        return shouldHave;
      },
      contains(cls) { return classes.has(cls); },
    },
  };
}

function makeComposerDom(prefixes) {
  const inputs = {};
  const rows = {};
  for (const prefix of prefixes) {
    const row = makeComposerRow();
    rows[prefix] = row;
    inputs[`${prefix}-msg-input`] = {
      id: `${prefix}-msg-input`,
      value: "",
      focus() {},
      closest(sel) { return sel === ".composer-row" ? row : null; },
    };
  }
  return {
    rows,
    inputs,
    document: { getElementById: (id) => inputs[id] || null },
  };
}

function makeUpdateComposerSendState({ document, pendingMedia, pendingImages, pendingDocuments, _isSending }) {
  const factory = new Function(
    "document", "pendingMedia", "pendingImages", "pendingDocuments", "_isSending",
    `${updateComposerSendStateSrc}\nreturn updateComposerSendState;`
  );
  return factory(document, pendingMedia, pendingImages, pendingDocuments, _isSending);
}

describe("updateComposerSendState — visibilidade do botão Enviar (has-text)", () => {
  function setup() {
    const dom = makeComposerDom(["modal", "convs"]);
    const state = {
      pendingMedia: { modal: null, convs: null },
      pendingImages: { modal: [], convs: [] },
      pendingDocuments: { modal: [], convs: [] },
      _isSending: { modal: false, convs: false },
    };
    const updateComposerSendState = makeUpdateComposerSendState({ document: dom.document, ...state });
    return { dom, state, updateComposerSendState };
  }

  test("Estado A — texto digitado, sem mídia: Enviar visível", () => {
    const { dom, updateComposerSendState } = setup();
    dom.inputs["modal-msg-input"].value = "oi";
    updateComposerSendState(dom.inputs["modal-msg-input"]);
    assert.equal(dom.rows.modal.classList.contains("has-text"), true);
  });

  test("Estado B — PDF selecionado, textarea vazio: Enviar visível (regressão do bug)", () => {
    const { dom, state, updateComposerSendState } = setup();
    state.pendingDocuments.modal = [{ id: 1, filename: "orcamento.pdf" }];
    updateComposerSendState("modal");
    assert.equal(dom.rows.modal.classList.contains("has-text"), true);
  });

  test("Estado C — PDF + legenda: Enviar visível", () => {
    const { dom, state, updateComposerSendState } = setup();
    state.pendingDocuments.modal = [{ id: 1, filename: "orcamento.pdf" }];
    dom.inputs["modal-msg-input"].value = "segue o orçamento";
    updateComposerSendState("modal");
    assert.equal(dom.rows.modal.classList.contains("has-text"), true);
  });

  test("Estado D — imagem selecionada, textarea vazio: Enviar visível (regressão do bug)", () => {
    const { dom, state, updateComposerSendState } = setup();
    state.pendingImages.convs = [{ id: 1, previewUrl: "blob:1" }];
    updateComposerSendState("convs");
    assert.equal(dom.rows.convs.classList.contains("has-text"), true);
  });

  test("Estado E — múltiplas imagens: Enviar continua visível", () => {
    const { dom, state, updateComposerSendState } = setup();
    state.pendingImages.modal = [{ id: 1 }, { id: 2 }, { id: 3 }];
    updateComposerSendState("modal");
    assert.equal(dom.rows.modal.classList.contains("has-text"), true);
  });

  test("Estado F — anexo removido: composer volta ao estado normal (mic, sem Enviar)", () => {
    const { dom, state, updateComposerSendState } = setup();
    state.pendingDocuments.modal = [{ id: 1, filename: "a.pdf" }];
    updateComposerSendState("modal");
    assert.equal(dom.rows.modal.classList.contains("has-text"), true);

    // Remover anexo (clearImage zera as filas e re-renderiza)
    state.pendingDocuments.modal = [];
    updateComposerSendState("modal");
    assert.equal(dom.rows.modal.classList.contains("has-text"), false);
  });

  test("Estado G — envio em andamento, texto já limpo: Enviar permanece visível (só some após _isSending voltar a false)", () => {
    const { dom, state, updateComposerSendState } = setup();
    state._isSending.modal = true;
    dom.inputs["modal-msg-input"].value = ""; // sendMessage já limpou o texto
    updateComposerSendState(dom.inputs["modal-msg-input"]);
    assert.equal(dom.rows.modal.classList.contains("has-text"), true);

    state._isSending.modal = false;
    updateComposerSendState("modal");
    assert.equal(dom.rows.modal.classList.contains("has-text"), false);
  });

  test("pendingMedia (fluxo legado de retry) também mantém Enviar visível", () => {
    const { dom, state, updateComposerSendState } = setup();
    state.pendingMedia.modal = { type: "document", base64: "AAAA", mimeType: "application/pdf" };
    updateComposerSendState("modal");
    assert.equal(dom.rows.modal.classList.contains("has-text"), true);
  });

  test("mídia pendente em um prefix não vaza para o outro (modal vs convs isolados)", () => {
    const { dom, state, updateComposerSendState } = setup();
    state.pendingDocuments.modal = [{ id: 1, filename: "a.pdf" }];
    updateComposerSendState("modal");
    updateComposerSendState("convs");
    assert.equal(dom.rows.modal.classList.contains("has-text"), true);
    assert.equal(dom.rows.convs.classList.contains("has-text"), false);
  });

  test("nenhum texto, nenhuma mídia, nenhum envio em andamento: Enviar escondido (mic ativo)", () => {
    const { dom, updateComposerSendState } = setup();
    updateComposerSendState("modal");
    assert.equal(dom.rows.modal.classList.contains("has-text"), false);
  });
});

// ── sendMessage(): prova de que, com o botão visível/clicável, o clique
// realmente chega à função de envio correta (não basta o preview aparecer). ──
function makeSendMessage({ windowClosed = false, windowWaiting = false } = {}) {
  const calls = {
    sendTextMessage: [], sendImagesSequential: [], sendDocumentsSequential: [],
    sendImageMessage: [], sendDocumentMessage: [], showToast: [], openReplyWarnModal: 0,
  };
  const state = {
    pendingMedia: { modal: null, convs: null },
    pendingImages: { modal: [], convs: [] },
    pendingDocuments: { modal: [], convs: [] },
    _isSending: { modal: false, convs: false },
    _replyTarget: { modal: null, convs: null },
  };
  const sendBtn = { disabled: false };
  const msgInput = { value: "", focus() {} };
  const windowBar = (windowClosed || windowWaiting) ? {
    classList: { contains: (c) => (windowClosed && c === "ws-closed") || (windowWaiting && c === "ws-waiting") },
  } : null;
  const elements = {
    "modal-window-bar": windowBar,
    "modal-msg-input": msgInput,
    "modal-send-btn": sendBtn,
    "modal-messages": {},
  };
  const fakeDocument = { getElementById: (id) => elements[id] ?? null };

  const fns = {
    getPhoneForPrefix: () => "5511999999999",
    markCurrentChatInboundSeen: () => {},
    showToast: (msg) => calls.showToast.push(msg),
    openReplyWarnModal: () => { calls.openReplyWarnModal++; },
    autoResize: () => {},
    reopenCard: async () => {},
    sendImagesSequential: async (...args) => { calls.sendImagesSequential.push(args); },
    sendDocumentsSequential: async (...args) => { calls.sendDocumentsSequential.push(args); },
    sendImageMessage: async (...args) => { calls.sendImageMessage.push(args); },
    sendDocumentMessage: async (...args) => { calls.sendDocumentMessage.push(args); },
    sendTextMessage: async (...args) => { calls.sendTextMessage.push(args); },
    updateMediaButtonsState: () => {},
    updateComposerSendState: () => {},
  };

  const paramNames = [
    "document", "pendingMedia", "pendingImages", "pendingDocuments", "_isSending", "_replyTarget",
    "getPhoneForPrefix", "markCurrentChatInboundSeen", "showToast", "openReplyWarnModal", "autoResize",
    "allConversationsList", "allConvs", "reopenCard",
    "sendImagesSequential", "sendDocumentsSequential", "sendImageMessage", "sendDocumentMessage", "sendTextMessage",
    "updateMediaButtonsState", "updateComposerSendState",
  ];
  const factory = new Function(...paramNames, `${sendMessageSrc}\nreturn sendMessage;`);
  const sendMessage = factory(
    fakeDocument, state.pendingMedia, state.pendingImages, state.pendingDocuments, state._isSending, state._replyTarget,
    fns.getPhoneForPrefix, fns.markCurrentChatInboundSeen, fns.showToast, fns.openReplyWarnModal, fns.autoResize,
    [], [], fns.reopenCard,
    fns.sendImagesSequential, fns.sendDocumentsSequential, fns.sendImageMessage, fns.sendDocumentMessage, fns.sendTextMessage,
    fns.updateMediaButtonsState, fns.updateComposerSendState
  );
  return { sendMessage, calls, state, msgInput, sendBtn };
}

describe("sendMessage() — o clique em Enviar chega à função de envio correta", () => {
  test("texto normal → sendTextMessage", async () => {
    const { sendMessage, calls, msgInput } = makeSendMessage();
    msgInput.value = "olá, tudo bem?";
    await sendMessage("modal");
    assert.equal(calls.sendTextMessage.length, 1);
    assert.equal(calls.sendTextMessage[0][2], "olá, tudo bem?");
    assert.equal(calls.sendImagesSequential.length, 0);
    assert.equal(calls.sendDocumentsSequential.length, 0);
  });

  test("PDF sem texto → sendDocumentsSequential", async () => {
    const { sendMessage, calls, state } = makeSendMessage();
    state.pendingDocuments.modal = [{ id: 1, filename: "orcamento.pdf" }];
    await sendMessage("modal");
    assert.equal(calls.sendDocumentsSequential.length, 1);
    assert.equal(calls.sendDocumentsSequential[0][2], "");
    assert.equal(calls.sendTextMessage.length, 0);
  });

  test("imagem sem texto → sendImagesSequential", async () => {
    const { sendMessage, calls, state } = makeSendMessage();
    state.pendingImages.modal = [{ id: 1, base64: "AAAA", mimeType: "image/png" }];
    await sendMessage("modal");
    assert.equal(calls.sendImagesSequential.length, 1);
    assert.equal(calls.sendTextMessage.length, 0);
  });

  test("múltiplas imagens → uma única chamada de sendImagesSequential (envio sequencial existente)", async () => {
    const { sendMessage, calls, state } = makeSendMessage();
    state.pendingImages.modal = [{ id: 1 }, { id: 2 }, { id: 3 }];
    await sendMessage("modal");
    assert.equal(calls.sendImagesSequential.length, 1);
  });

  test("PDF + legenda → sendDocumentsSequential recebe o texto como legenda", async () => {
    const { sendMessage, calls, state, msgInput } = makeSendMessage();
    state.pendingDocuments.modal = [{ id: 1, filename: "orcamento.pdf" }];
    msgInput.value = "segue o orçamento";
    await sendMessage("modal");
    assert.equal(calls.sendDocumentsSequential.length, 1);
    assert.equal(calls.sendDocumentsSequential[0][2], "segue o orçamento");
  });

  test("janela fechada → continua bloqueada, nenhuma função de envio é chamada", async () => {
    const { sendMessage, calls, state } = makeSendMessage({ windowClosed: true });
    state.pendingDocuments.modal = [{ id: 1, filename: "orcamento.pdf" }];
    await sendMessage("modal");
    assert.equal(calls.sendDocumentsSequential.length, 0);
    assert.equal(calls.sendTextMessage.length, 0);
    assert.equal(calls.sendImagesSequential.length, 0);
    assert.ok(calls.showToast.some(m => /janela fechada/i.test(m)));
  });

  test("waiting_template_reply → continua bloqueada, nenhuma função de envio é chamada", async () => {
    const { sendMessage, calls, msgInput } = makeSendMessage({ windowWaiting: true });
    msgInput.value = "oi";
    await sendMessage("modal");
    assert.equal(calls.sendTextMessage.length, 0);
    assert.ok(calls.showToast.some(m => /janela fechada/i.test(m)));
  });

  test("envio em andamento → segunda chamada é ignorada (sem envio duplicado)", async () => {
    const { sendMessage, calls, state, msgInput } = makeSendMessage();
    state._isSending.modal = true;
    msgInput.value = "oi";
    await sendMessage("modal");
    assert.equal(calls.sendTextMessage.length, 0);
    assert.ok(calls.showToast.some(m => /envio em andamento/i.test(m)));
  });

  test("textarea vazio e sem mídia → não envia nada (guard original preservado)", async () => {
    const { sendMessage, calls } = makeSendMessage();
    await sendMessage("modal");
    assert.equal(calls.sendTextMessage.length, 0);
    assert.equal(calls.sendImagesSequential.length, 0);
    assert.equal(calls.sendDocumentsSequential.length, 0);
  });
});
