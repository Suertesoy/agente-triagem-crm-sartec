// ============================================================
// Sartec Papelaria — Parser de orçamento via PDF/Texto com IA
// POST /api/parse-budget-pdf
//   { mediaStorageKey, messageId, phone }   → preferencial: PDF no storage R2
//   { messageId, phone }                    → backend localiza a mensagem/storageKey no histórico
//   { extractedText, messageId?, phone? }   → texto já extraído no navegador (pdf.js)
//   { pdfBase64, messageId?, phone? }       → fallback legado, PDF inline em base64
//
// Cache leve: quando messageId+phone são informados, o JSON estruturado é
// salvo no Redis (sartec:budget_draft:{phone}:{messageId}) e reaproveitado
// em cliques futuros — evita reler o PDF e rechamar a IA para a mesma mensagem.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import Redis from "ioredis";
import { downloadMedia } from "./media-storage.js";

let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) => console.error("[Redis/parse-budget-pdf] ❌", err.message));
  }
  return redisClient;
}

const BUDGET_DRAFT_TTL = 60 * 60 * 24 * 60; // 60 dias — rascunho leve, não o PDF

function budgetDraftKey(phone, messageId) {
  return `sartec:budget_draft:${phone}:${messageId}`;
}

async function getCachedBudget(phone, messageId) {
  if (!phone || !messageId) return null;
  try {
    const raw = await getRedis().get(budgetDraftKey(phone, messageId));
    if (!raw) return null;
    const cached = JSON.parse(raw);
    return cached?.budget || null;
  } catch (err) {
    console.warn("[parse-budget-pdf] ⚠️ leitura de cache falhou:", err.message);
    return null;
  }
}

async function saveCachedBudget(phone, messageId, budget) {
  if (!phone || !messageId) return;
  try {
    await getRedis().set(
      budgetDraftKey(phone, messageId),
      JSON.stringify({ sourceMessageId: messageId, parsedAt: new Date().toISOString(), budget }),
      "EX", BUDGET_DRAFT_TTL
    );
  } catch (err) {
    console.warn("[parse-budget-pdf] ⚠️ gravação de cache falhou:", err.message);
  }
}

// Localiza a mensagem no histórico (sessão ativa) pelo metaMessageId e retorna seu mediaStorageKey.
async function findStorageKeyByMessage(phone, messageId) {
  if (!phone || !messageId) return null;
  try {
    const raw = await getRedis().get(`sartec:${phone}`);
    if (!raw) return null;
    const session = JSON.parse(raw);
    const msg = (session.history || []).find((m) => m.metaMessageId === messageId);
    return msg?.mediaStorageKey || null;
  } catch (err) {
    console.warn("[parse-budget-pdf] ⚠️ busca da mensagem no histórico falhou:", err.message);
    return null;
  }
}

const FORMAT_GUIDE = `O texto de orçamentos da loja pode aparecer em dois formatos diferentes — reconheça ambos:

1) Em linha — código, descrição, quantidade, valor unitário e total na mesma linha:
   "9999 COPO 200ML COPAZA TRANSP C/100 4 19,68 78,72"
   → code=9999, description="COPO 200ML COPAZA TRANSP C/100", quantity=4, unitValue=19,68, total=78,72

2) Quebrado por coluna — cada campo do item em uma linha separada, sempre na ordem
   código, descrição, quantidade, valor unitário, total:
   "9999"
   "COPO 200ML COPAZA TRANSP C/100"
   "4"
   "19,68"
   "78,72"
   → mesma interpretação do exemplo anterior.`;

function buildPrompt(isPdfDocument) {
  const sourceLabel = isPdfDocument ? "deste PDF de orçamento" : "do seguinte texto extraído de um PDF";
  return `Extraia os dados estruturados de orçamento ${sourceLabel}.

${FORMAT_GUIDE}

Instruções importantes:
1. Extraia APENAS o que aparece no documento, sem inventar produtos, códigos, quantidades, valores ou totais.
2. Se algum campo (endereço, telefones, vendedor, etc.) não for encontrado, retorne string vazia.
3. Se algum item estiver ambíguo ou incompleto (ex: truncado, valores que não fecham, descrição cortada), marque-o com "needsReview": true.
4. Para cada item, extraia:
   - code: Código do produto (normalmente o primeiro bloco numérico do item).
   - description: Descrição do produto.
   - quantity: Quantidade do produto.
   - unitValue: Valor unitário do produto.
   - total: Valor total do produto.
   - approved: true (booleano padrão).

Retorne um objeto JSON exatamente no seguinte formato:
{
  "number": "número do orçamento (ex: MOV 54030)",
  "date": "data do orçamento (ex: 12/06/2026)",
  "client": "nome do cliente (ex: 4885 - UNIDADE REGIONAL DE SAO JOSE DOS CAMPOS)",
  "address": "endereço do cliente",
  "phones": "telefones de contato",
  "seller": "vendedor",
  "totalProducts": "total de produtos",
  "billedTotal": "total faturado",
  "items": [
    {
      "code": "...",
      "description": "...",
      "quantity": "...",
      "unitValue": "...",
      "total": "...",
      "approved": true,
      "needsReview": false
    }
  ]
}

Responda APENAS com o JSON válido, sem qualquer texto explicativo ou marcação de bloco de código markdown.`;
}

async function parseWithAI({ pdfBase64, extractedText }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error("Chave ANTHROPIC_API_KEY não configurada no servidor."), { statusCode: 500 });
  }

  const anthropic = new Anthropic({ apiKey });
  const content = extractedText
    ? [{ type: "text", text: `${buildPrompt(false)}\n\n---\n${extractedText}\n---` }]
    : [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: buildPrompt(true) },
      ];

  const response = await anthropic.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 4000,
    system: "Você é um assistente especializado em extração de dados estruturados de PDFs e textos de orçamentos de papelaria. Você deve retornar estritamente um JSON válido no formato solicitado. Não adicione observações, explicações ou blocos de código markdown como ```json.",
    messages: [{ role: "user", content }],
  });

  const replyText = response.content[0]?.text || "";
  let cleanJsonStr = replyText.trim();
  if (cleanJsonStr.startsWith("```")) {
    cleanJsonStr = cleanJsonStr.replace(/^```(json)?/, "").replace(/```$/, "").trim();
  }
  return JSON.parse(cleanJsonStr);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const { mediaStorageKey, messageId, phone, pdfBase64: pdfBase64In, extractedText } = req.body || {};
  let pdfBase64 = pdfBase64In;

  // 1. Cache leve — mesma mensagem já processada antes: nem reler o PDF nem chamar IA de novo.
  if (messageId && phone) {
    const cached = await getCachedBudget(phone, messageId);
    if (cached) {
      console.log(`[parse-budget-pdf] cache hit messageId=${messageId}`);
      return res.status(200).json({ success: true, budget: cached, cached: true });
    }
  }

  // 2. Resolve a fonte do PDF — preferência: mediaStorageKey explícito > localizar pela mensagem.
  let resolvedStorageKey = mediaStorageKey || null;
  if (!resolvedStorageKey && !pdfBase64 && !extractedText && messageId && phone) {
    resolvedStorageKey = await findStorageKeyByMessage(phone, messageId);
  }

  if (resolvedStorageKey && !pdfBase64 && !extractedText) {
    try {
      const buffer = await downloadMedia(resolvedStorageKey);
      pdfBase64 = buffer.toString("base64");
    } catch (downloadErr) {
      console.error("[parse-budget-pdf] ❌ Erro ao buscar PDF no storage:", downloadErr);
      return res.status(502).json({ error: "Não foi possível buscar o PDF no storage do painel.", details: downloadErr.message });
    }
  }

  if (!pdfBase64 && !extractedText) {
    return res.status(400).json({ error: "Parâmetros inválidos. Envie mediaStorageKey, messageId+phone, pdfBase64 ou extractedText." });
  }

  try {
    const budget = await parseWithAI({ pdfBase64, extractedText });

    if (messageId && phone) await saveCachedBudget(phone, messageId, budget);

    return res.status(200).json({ success: true, budget });
  } catch (err) {
    console.error("[parse-budget-pdf] ❌ Erro ao processar com IA:", err);
    return res.status(err.statusCode || 500).json({ error: "Erro ao ler PDF de orçamento com IA", details: err.message });
  }
}
