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
    to,
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
    const phoneNorm = String(to).replace(/\D/g, "");
    console.log(
      `[send-template] ✅ "${templateName}" → +${phoneNorm} | accepted | msg_id: ${msgId}`
    );

    // ── Persiste estado de espera na sessão Redis ─────────────────────────
    await markTemplateSent(to, templateType, { clientName, clientType, variables, msgId, templateName });

    return res.status(200).json({ success: true, templateName, messageId: msgId });

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
    handoffDone:          false,
    postHandoffReplySent: false,
    audioCount:           0,
    lastDate:             now.toISOString().slice(0, 10),
    lastActivityAt:       now.toISOString(),
    clientName:           clientName || "—",
    clientPhone:          phone,
    clientType:           clientType || "pf",
    status:               "ativo",
    // Janela fechada até o cliente responder ao template
    lastUserMessageAt:    null,
    windowExpiresAt:      null,
    // Indica que a conversa foi iniciada proativamente (usada em conversations.js)
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
// Registra templateSentAt (usado por computeWindowInfo para derivar
// conversationWindowStatus = "waiting_template_reply" enquanto
// templateSentAt > lastUserMessageAt).
//
// Se a sessão não existe (número novo), cria uma sessão inicial.
// clientName / clientType só sobrescrevem se a sessão for nova ou os campos estiverem vazios.
async function markTemplateSent(phone, templateType, { clientName, clientType, variables = [], msgId = null, templateName = "" } = {}) {
  try {
    const redis = getRedis();
    const raw   = await redis.get(`sartec:${phone}`);

    let session;
    let isNew = false;

    if (raw) {
      session = JSON.parse(raw);
    } else {
      // Número novo — cria sessão proativa
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

    session.templateSentAt            = now;        // chave para computeWindowInfo
    session.lastTemplateType          = templateType;
    session.templateWaitingReply      = true;       // flag de conveniência
    session.lastActivityAt            = now;
    // Campos de rastreamento de entrega — atualizados pelo webhook de status da Meta
    session.lastTemplateMessageId     = msgId    || null;
    session.lastTemplateName          = templateName;
    session.lastTemplateDeliveryStatus = "accepted"; // Meta aceitou; confirmação real vem pelo webhook
    session.lastTemplateStatusAt      = now;
    session.lastTemplateError         = null;

    // Nota interna visível na aba Conversas antes do cliente responder
    const templateLabels = {
      attendance_resume: "Retomar atendimento",
      budget_update:     "Orçamento",
      pj_prospecting:    "Prospecção PJ",
    };
    session.proactiveNote = `Template enviado: ${templateLabels[templateType] || templateType} — aguardando resposta do cliente`;

    // Registra evento de template no histórico do chat
    if (!Array.isArray(session.history)) session.history = [];
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
      // Status inicial — atualizado pelo webhook de status da Meta
      deliveryStatus:   "accepted",
      deliveryStatusAt: now,
      deliveryError:    null,
    };
    if (msgId) _tmplEntry.metaMessageId = msgId;
    session.history.push(_tmplEntry);

    await redis.set(
      `sartec:${phone}`,
      JSON.stringify(session),
      "EX",
      SESSION_TTL
    );
    console.log(
      `[send-template] 💾 +${phone} → ${isNew ? "nova sessão" : "atualizada"} | waiting_template_reply (${templateType})`
    );
  } catch (err) {
    console.error("[send-template/markTemplateSent] ❌", err.message);
  }
}
