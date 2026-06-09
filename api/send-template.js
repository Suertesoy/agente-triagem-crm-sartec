// ============================================================
// Sartec Papelaria — Envio de template WhatsApp
// POST /api/send-template
// { to, templateType, variables: ["var1", "var2"] }
//
// templateType aceito: "attendance_resume" | "budget_update" | "pj_prospecting"
//
// Nomes dos templates na Meta são configuráveis por variável de ambiente:
//   TEMPLATE_ATTENDANCE_RESUME_NAME  (padrão: "retomar_atendimento_v1")
//   TEMPLATE_BUDGET_UPDATE_NAME      (padrão: "sartec_orcamento")
//   TEMPLATE_PJ_PROSPECTING_NAME     (padrão: "sartec_prospeccao_pj")
//   TEMPLATE_LANGUAGE_CODE           (padrão: "pt_BR")
//
// Após envio com sucesso, salva na sessão Redis:
//   templateSentAt       → ISO da hora de envio
//   lastTemplateType     → tipo enviado
//   templateWaitingReply → true (limpo automaticamente quando cliente responder)
// ============================================================

import Redis from "ioredis";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) =>
      console.error("[Redis/send-template] ❌", err.message)
    );
  }
  return redisClient;
}

const SESSION_TTL = 60 * 60 * 24 * 90; // 90 dias — retenção mínima de histórico

// Normaliza telefone: remove tudo que não for dígito
function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "");
}

// Lock idêntico ao de webhook.js e resolve.js — evita race condition no Redis
async function withSessionLock(redis, phone, fn) {
  const lockKey = `lock:sartec:${phone}`;
  for (let i = 0; i < 20; i++) {
    const ok = await redis.set(lockKey, "1", "NX", "EX", 15);
    if (ok) {
      try { return await fn(); }
      finally { await redis.del(lockKey); }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.warn(`[send-template/lock] ⚠️ Timeout aguardando lock +${phone}`);
  return fn();
}

// ── Mapeamento tipo → nome aprovado na Meta ─────────────────────────────────
// Para trocar o nome do template na Meta sem alterar código: edite as env vars.
function getTemplateName(templateType) {
  const map = {
    attendance_resume: (process.env.TEMPLATE_ATTENDANCE_RESUME_NAME || "retomar_atendimento_v1").trim(),
    budget_update:     (process.env.TEMPLATE_BUDGET_UPDATE_NAME     || "sartec_orcamento").trim(),
    pj_prospecting:    (process.env.TEMPLATE_PJ_PROSPECTING_NAME    || "sartec_prospeccao_pj").trim(),
  };
  return map[templateType] ?? null;
}

function getLanguageCode() {
  return (process.env.TEMPLATE_LANGUAGE_CODE || "pt_BR").trim();
}

// Vercel: body pequeno é suficiente para templates
export const config = {
  api: { bodyParser: { sizeLimit: "512kb" } },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const body = req.body || {};
  const { to, templateType, variables = [], clientName, clientType } = body;

  if (!to || !templateType) {
    return res.status(400).json({
      error: "Campos to e templateType são obrigatórios",
    });
  }

  // Normaliza o telefone antes de qualquer operação
  const phoneNorm = normalizePhone(to);
  if (phoneNorm.length < 10) {
    return res.status(400).json({ error: "Parâmetro to inválido — deve conter DDI+DDD+número" });
  }

  const templateName = getTemplateName(templateType);
  if (!templateName) {
    return res.status(400).json({
      error: `templateType inválido: "${templateType}"`,
      valid: ["attendance_resume", "budget_update", "pj_prospecting"],
    });
  }

  // ── Bloqueio temporário de testes — remover quando budget_update/pj_prospecting forem validados ──
  const ALLOWED_IN_TESTING = ["attendance_resume"];
  if (!ALLOWED_IN_TESTING.includes(templateType)) {
    return res.status(403).json({
      error: "Template temporariamente bloqueado para testes. Apenas 'Retomar atendimento' está disponível.",
      allowed: ALLOWED_IN_TESTING,
    });
  }

  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    return res.status(500).json({ error: "Variáveis de ambiente do WhatsApp ausentes" });
  }

  // ── Monta payload do template ────────────────────────────────────────────
  const templatePayload = {
    messaging_product: "whatsapp",
    to: phoneNorm,   // sempre dígitos, sem +
    type: "template",
    template: {
      name:     templateName,
      language: { code: getLanguageCode() },
    },
  };

  // Adiciona parâmetros do corpo apenas se houver variáveis
  if (variables.length > 0) {
    templatePayload.template.components = [
      {
        type: "body",
        parameters: variables.map((v) => ({
          type: "text",
          text: String(v || " "),   // Meta rejeita string vazia
        })),
      },
    ];
  }

  console.log(`[send-template] POST to=+${phoneNorm} templateType=${templateType} templateName=${templateName}`);

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${ACCESS_TOKEN}`,
        },
        body: JSON.stringify(templatePayload),
      }
    );

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      console.error(
        `[send-template] ❌ Meta erro ${metaData?.error?.code}: ${metaData?.error?.message}`
      );
      return res.status(502).json({
        error:  "Erro ao enviar template pela Meta API",
        detail: metaData?.error?.message,
        code:   metaData?.error?.code,
      });
    }

    const msgId = metaData?.messages?.[0]?.id;
    console.log(
      `[send-template] ✅ Meta accepted | to=+${phoneNorm} | templateType=${templateType} | msg_id=${msgId}`
    );

    // ── Persiste estado de espera na sessão Redis (com lock para evitar race condition) ──
    const historyPersisted = await markTemplateSent(
      phoneNorm, templateType,
      { clientName, clientType, variables, msgId, templateName }
    );

    if (!historyPersisted) {
      console.error(`[send-template] ⚠️ Template aceito pela Meta mas NÃO persistido no Redis para +${phoneNorm}`);
    }

    return res.status(200).json({ success: true, templateName, messageId: msgId, historyPersisted });

  } catch (err) {
    console.error("[send-template] ❌", err.message);
    return res.status(500).json({
      error:  "Erro interno ao enviar template",
      detail: err.message,
    });
  }
}

// ── Cria sessão inicial para um número que ainda não existe no Redis ─────────
// Usado quando o atendente inicia proativamente uma nova conversa por template.
function buildNewProspectSession(phone, clientName, clientType) {
  const now = new Date();
  return {
    history:              [],
    handoffDone:          true,   // atendente iniciou a conversa
    postHandoffReplySent: false,
    audioCount:           0,
    lastDate:             now.toISOString().slice(0, 10),
    lastActivityAt:       now.toISOString(),
    clientName:           clientName || "—",
    clientPhone:          phone,
    clientType:           clientType || "pf",
    status:               "aguardando_humano",   // visível no pipeline
    pipelineStatus:       "novo",
    // Janela fechada até o cliente responder ao template
    lastUserMessageAt:    null,
    windowExpiresAt:      null,
    // Indica que a conversa foi iniciada proativamente
    proactivelySent:      true,
  };
}

// ── Monta texto renderizado do template substituindo variáveis ───────────────
const _TEMPLATE_BASE_TEXTS = {
  attendance_resume: "Olá, {{1}}, aqui é da Sartec Papelaria. Recebemos sua solicitação anteriormente e gostaríamos de continuar seu atendimento. Pode responder esta mensagem para continuarmos?",
  budget_update:     "Olá, {{1}}, temos uma atualização sobre seu orçamento na Sartec Papelaria. Pode responder esta mensagem para continuarmos?",
  pj_prospecting:    "Olá, {{1}}, aqui é da Sartec Papelaria. Gostaríamos de apresentar nossas condições especiais para empresas. Pode responder esta mensagem?",
};

function buildTemplateText(templateType, variables = []) {
  let text = _TEMPLATE_BASE_TEXTS[templateType] || "";
  if (!text) return "";
  variables.forEach((v, i) => {
    text = text.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, "g"), v || "");
  });
  return text.trim();
}

// ── Atualiza (ou cria) sessão Redis após envio bem-sucedido ──────────────────
// Usa withSessionLock para evitar race condition com o webhook de resposta do
// cliente — sem lock, markTemplateSent pode sobrescrever a resposta do cliente
// se ela chegar antes do SET do Redis terminar.
//
// Retorna true se a sessão foi salva com sucesso, false se houve erro.
async function markTemplateSent(phone, templateType, { clientName, clientType, variables = [], msgId = null, templateName = "" } = {}) {
  let historyPersisted = false;
  try {
    const redis = getRedis();

    await withSessionLock(redis, phone, async () => {
      const raw = await redis.get(`sartec:${phone}`);

      let session;
      let isNew = false;

      if (raw) {
        session = JSON.parse(raw);
      } else {
        isNew   = true;
        session = buildNewProspectSession(phone, clientName, clientType);
        console.log(`[send-template] 🆕 Nova sessão criada para +${phone}`);
      }

      // Atualiza clientName / clientType se vieram no request e a sessão era nova ou vazia
      if (clientName && (isNew || !session.clientName || session.clientName === "—")) {
        session.clientName = clientName;
      }
      if (clientType && (isNew || !session.clientType)) {
        session.clientType = clientType;
      }

      const now = new Date().toISOString();

      session.templateSentAt             = now;
      session.lastTemplateType           = templateType;
      session.lastActivityAt             = now;
      session.lastTemplateMessageId      = msgId    || null;
      session.lastTemplateName           = templateName;
      session.lastTemplateDeliveryStatus = "accepted";
      session.lastTemplateStatusAt       = now;
      session.lastTemplateError          = null;

      // Só ativa o flag de espera se a conversa ainda não foi reaberta pelo webhook
      // (evita sobrescrever um estado correto caso a resposta chegou muito rápido)
      if (session.status !== "aguardando_humano" || !session.lastUserMessageAt) {
        session.templateWaitingReply = true;
      }

      const templateLabels = {
        attendance_resume: "Retomar atendimento",
        budget_update:     "Orçamento",
        pj_prospecting:    "Prospecção PJ",
      };
      session.proactiveNote = `Template enviado: ${templateLabels[templateType] || templateType} — aguardando resposta do cliente`;

      // Registra evento de template no histórico — evita duplicata se mesmo msgId já estiver
      if (!Array.isArray(session.history)) session.history = [];
      const alreadySaved = msgId && session.history.some(m => m.metaMessageId === msgId);
      if (!alreadySaved) {
        const _tmplText  = buildTemplateText(templateType, variables);
        const _tmplEntry = {
          role:             "system",
          content:          `Template enviado: ${templateLabels[templateType] || templateType}`,
          messageType:      "template",
          templateType,
          templateName:     templateName || templateType,
          templateLabel:    templateLabels[templateType] || templateType,
          templateText:     _tmplText,
          sentByTemplate:   true,
          sentByHuman:      false,
          createdAt:        now,
          deliveryStatus:   "accepted",
          deliveryStatusAt: now,
          deliveryError:    null,
        };
        if (msgId) _tmplEntry.metaMessageId = msgId;
        session.history.push(_tmplEntry);
      }

      await redis.set(
        `sartec:${phone}`,
        JSON.stringify(session),
        "EX",
        SESSION_TTL
      );

      historyPersisted = true;
      console.log(
        `[send-template] 💾 sessionKey=sartec:${phone} historyLen=${session.history.length}` +
        ` lastTemplateMessageId=${msgId || "n/a"} lastTemplateType=${templateType}` +
        ` lastTemplateDeliveryStatus=accepted templateWaitingReply=${session.templateWaitingReply}` +
        ` isNew=${isNew}`
      );
    });

  } catch (err) {
    console.error("[send-template/markTemplateSent] ❌", err.message);
  }
  return historyPersisted;
}
