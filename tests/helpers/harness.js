// Shared integration-test harness for api/webhook.js and api/queue.js.
//
// Loads the real handlers through the real Vercel-style entry point
// (default-exported (req, res) => ...), but redirects "ioredis" and
// "@anthropic-ai/sdk" to in-memory fakes via a module customization hook —
// no real Redis, no real Anthropic call, no real network I/O for the WhatsApp
// Graph API (global.fetch is spied on here too).
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Testes nunca devem herdar credenciais (nem valores vazios) do ambiente host.
process.env.WHATSAPP_VERIFY_TOKEN    = "test-verify-token";
process.env.WHATSAPP_ACCESS_TOKEN    = "test-access-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
process.env.ANTHROPIC_API_KEY        = "test-key";
process.env.REDIS_URL                = "redis://fake";
process.env.R2_DISABLED              = "true"; // evita chamadas reais ao S3/R2 nos testes de mídia

register(pathToFileURL(path.join(HERE, "hooks.js")).href, import.meta.url);

const REPO_ROOT          = path.resolve(HERE, "..", "..");
const WEBHOOK_URL        = pathToFileURL(path.join(REPO_ROOT, "api", "webhook.js")).href;
const QUEUE_URL          = pathToFileURL(path.join(REPO_ROOT, "api", "queue.js")).href;
const SEND_URL           = pathToFileURL(path.join(REPO_ROOT, "api", "send.js")).href;
const SEND_TEMPLATE_URL  = pathToFileURL(path.join(REPO_ROOT, "api", "send-template.js")).href;
const METRICS_URL        = pathToFileURL(path.join(REPO_ROOT, "api", "metrics.js")).href;
const FORWARD_MEDIA_URL  = pathToFileURL(path.join(REPO_ROOT, "api", "forward-media.js")).href;

export const { default: handler }             = await import(WEBHOOK_URL);
export const { default: queueHandler }        = await import(QUEUE_URL);
export const { default: sendHandler }         = await import(SEND_URL);
export const { default: sendTemplateHandler } = await import(SEND_TEMPLATE_URL);
export const { default: metricsHandler }      = await import(METRICS_URL);
export const { default: forwardMediaHandler } = await import(FORWARD_MEDIA_URL);
export const FakeRedis                 = (await import(pathToFileURL(path.join(HERE, "fake-ioredis.js")).href)).default;
export const anthropicSpy              = await import(pathToFileURL(path.join(HERE, "fake-anthropic.js")).href);

export const rawClient = new FakeRedis();

const FAKE_MEDIA_URL = "https://fake-media.local/download";

let fetchCalls = [];

globalThis.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), opts });

  // Envio de mensagem ao cliente (Graph API ".../messages")
  if (String(url).includes("graph.facebook.com") && String(url).includes("/messages")) {
    return { ok: true, json: async () => ({ messages: [{ id: "wamid_out_" + fetchCalls.length }] }) };
  }
  // Upload de mídia do atendente para a Meta (Graph API ".../media", api/send.js e api/forward-media.js)
  if (String(url).includes("graph.facebook.com") && String(url).endsWith("/media")) {
    return { ok: true, json: async () => ({ id: "media_upload_" + fetchCalls.length }) };
  }
  // Lookup de metadados de mídia recebida (Graph API "/v19.0/{mediaId}", api/webhook.js)
  if (String(url).includes("graph.facebook.com") && !String(url).includes("/messages")) {
    return { ok: true, json: async () => ({ url: FAKE_MEDIA_URL, mime_type: "audio/ogg" }) };
  }
  // Download do arquivo de mídia em si
  if (String(url) === FAKE_MEDIA_URL) {
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer };
  }
  // Qualquer outra chamada (ex.: transcrição OpenAI) — resposta genérica de sucesso
  return { ok: true, json: async () => ({}), text: async () => "" };
};

export function getFetchCalls() {
  return fetchCalls;
}
export function resetFetchCalls() {
  fetchCalls = [];
}

// Extrai o texto (`text.body`) enviado ao WhatsApp na chamada de índice `idx`.
export function sentText(calls, idx = 0) {
  try { return JSON.parse(calls[idx].opts.body).text.body; } catch { return null; }
}
// Todos os textos enviados nas chamadas fornecidas, na ordem.
export function sentTexts(calls) {
  return calls.map((_, i) => sentText(calls, i)).filter((t) => t !== null);
}

function fakeRes() {
  return {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { this._body = body; return this; },
  };
}

export function textWebhookBody(phone, text, { msgId = "wamid_" + Math.random().toString(36).slice(2), name = "Cliente Teste" } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: phone, profile: { name } }],
          messages: [{ from: phone, id: msgId, type: "text", text: { body: text } }],
        },
      }],
    }],
  };
}

// Simula o webhook de clique em Quick Reply de template ("message.type === 'button'"),
// no formato oficial da Cloud API (button.text / button.payload / context.id).
export function buttonWebhookBody(phone, {
  msgId       = "wamid_" + Math.random().toString(36).slice(2),
  name        = "Cliente Teste",
  buttonText  = "Continuar",
  buttonPayload = "attendance_resume_continue",
  contextId   = null,
} = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: phone, profile: { name } }],
          messages: [{
            from: phone,
            id: msgId,
            type: "button",
            ...(contextId ? { context: { from: "15550000000", id: contextId } } : {}),
            button: { text: buttonText, payload: buttonPayload },
          }],
        },
      }],
    }],
  };
}

export function audioWebhookBody(phone, { msgId = "wamid_" + Math.random().toString(36).slice(2), name = "Cliente Teste", mediaId = "media_" + Math.random().toString(36).slice(2) } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: phone, profile: { name } }],
          messages: [{ from: phone, id: msgId, type: "audio", audio: { id: mediaId } }],
        },
      }],
    }],
  };
}

// Envia uma mensagem de texto simulada pelo handler real do webhook.
// Retorna { res, calls } — calls são só as chamadas de fetch feitas DURANTE
// esta invocação (para checar duplicidade de envio sem ruído de chamadas anteriores).
export async function sendText(phone, text, opts) {
  resetFetchCalls();
  const req = { method: "POST", body: textWebhookBody(phone, text, opts) };
  const res = fakeRes();
  await handler(req, res);
  return { res, calls: getFetchCalls() };
}

// Envia uma mensagem de áudio simulada pelo handler real do webhook.
export async function sendAudio(phone, opts) {
  resetFetchCalls();
  const req = { method: "POST", body: audioWebhookBody(phone, opts) };
  const res = fakeRes();
  await handler(req, res);
  return { res, calls: getFetchCalls() };
}

// Envia um clique de Quick Reply simulado pelo handler real do webhook.
export async function sendButton(phone, opts) {
  resetFetchCalls();
  const req = { method: "POST", body: buttonWebhookBody(phone, opts) };
  const res = fakeRes();
  await handler(req, res);
  return { res, calls: getFetchCalls() };
}

// Chama o handler real de api/send-template.js.
export async function callSendTemplate(body) {
  resetFetchCalls();
  const req = { method: "POST", body };
  const res = fakeRes();
  await sendTemplateHandler(req, res);
  return { res, calls: getFetchCalls() };
}

export async function callQueue() {
  const req = { method: "GET" };
  const res = fakeRes();
  await queueHandler(req, res);
  return res._body;
}

// Chama o handler real de api/send.js (envio humano de texto/imagem/documento/áudio).
export async function callSend(body) {
  resetFetchCalls();
  const req = { method: "POST", body };
  const res = fakeRes();
  await sendHandler(req, res);
  return { res, calls: getFetchCalls() };
}

// Chama o handler real de api/metrics.js. query aceita period/customerType/attendant/category.
export async function callMetrics(query = {}) {
  const req = { method: "GET", query };
  const res = fakeRes();
  await metricsHandler(req, res);
  return res._body;
}

// Chama o handler real de api/forward-media.js (encaminhamento interno para Denise).
export async function callForwardMedia(body) {
  resetFetchCalls();
  const req = { method: "POST", body };
  const res = fakeRes();
  await forwardMediaHandler(req, res);
  return { res, calls: getFetchCalls() };
}

export async function getSession(phone) {
  const raw = await rawClient.get(`sartec:${phone}`);
  return raw ? JSON.parse(raw) : null;
}

export async function getContact(phone) {
  const raw = await rawClient.get(`sartec:contact:${phone}`);
  return raw ? JSON.parse(raw) : null;
}

// Aplica um patch direto numa sessão existente (ou nova) sem passar pelo
// webhook — usado para preparar estados prévios (ex.: "resolvido", "pj já
// triado com handoffDone=true") antes de simular a próxima mensagem real.
export async function forceSetSession(phone, patchFn) {
  const existingRaw = await rawClient.get(`sartec:${phone}`);
  const session = existingRaw ? JSON.parse(existingRaw) : {};
  patchFn(session);
  await rawClient.set(`sartec:${phone}`, JSON.stringify(session));
}

export async function setPjLunchMode(enabled) {
  await rawClient.set("sartec:settings:pjLunchMode", JSON.stringify({
    enabled,
    updatedAt: new Date().toISOString(),
  }));
}

export const EXPECTED_CATALOG_REPLY =
  "Recebemos sua solicitação de orçamento pelo site. Vou encaminhar sua lista diretamente para a equipe responsável.";
export const EXPECTED_LUNCH_REPLY =
  "Olá! Estou em horário de almoço agora, assim que retornar atendo a sua solicitação.";
export const POST_HANDOFF_DEFAULT_REPLY = "Nossa equipe já está ciente e vai te atender em breve 🤝";

export const PF_CATALOG_MSG = (list = "2x Caderno universitário 10 matérias\n1x Estojo escolar") =>
  `[SITE_CATALOGO_ORCAMENTO]\n[TIPO_CLIENTE:PF]\n\nOlá, montei uma lista de produtos pelo site da Sartec e gostaria de solicitar um orçamento.\n\n${list}`;

export const PJ_CATALOG_MSG = (list = "10x Resma A4\n5x Papel contact 0,5m") =>
  `[SITE_CATALOGO_ORCAMENTO]\n[TIPO_CLIENTE:PJ]\n\nOlá, montei uma lista de produtos pelo site da Sartec e gostaria de solicitar um orçamento.\n\n${list}`;

export const SCHOOL_LIST_MSG =
  "[SITE_LISTA_ESCOLAR]\n*Lista 1 - João*\n*Escola:* Colégio X\n*Ano/Série:* 5º ano\n*Itens que quero comprar:*\n2x Caderno\n1x Estojo";
