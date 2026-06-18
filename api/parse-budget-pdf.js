// ============================================================
// Sartec Papelaria — Parser de orçamento via PDF/Texto com IA
// POST /api/parse-budget-pdf  { pdfBase64, extractedText, pdfUrl }
// ============================================================

import Anthropic from "@anthropic-ai/sdk";

// Aceita apenas URLs do nosso próprio storage R2 (mesma fonte usada pelos
// botões "Visualizar"/"Baixar" do painel) — evita SSRF para hosts arbitrários.
function isAllowedMediaUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "https:") return false;
    const r2Endpoint = process.env.R2_ENDPOINT ? new URL(process.env.R2_ENDPOINT).hostname : null;
    if (r2Endpoint && u.hostname === r2Endpoint) return true;
    return /\.r2\.cloudflarestorage\.com$/.test(u.hostname);
  } catch (_e) {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  let { pdfBase64, extractedText, pdfUrl } = req.body || {};

  if (!pdfBase64 && !extractedText && !pdfUrl) {
    return res.status(400).json({ error: "Parâmetros inválidos. Envie pdfBase64, extractedText ou pdfUrl." });
  }

  if (!pdfBase64 && !extractedText && pdfUrl) {
    if (!isAllowedMediaUrl(pdfUrl)) {
      return res.status(400).json({ error: "URL de mídia não permitida." });
    }
    try {
      const mediaRes = await fetch(pdfUrl);
      if (!mediaRes.ok) throw new Error(`HTTP ${mediaRes.status}`);
      const arrayBuffer = await mediaRes.arrayBuffer();
      pdfBase64 = Buffer.from(arrayBuffer).toString("base64");
    } catch (fetchErr) {
      console.error("[parse-budget-pdf] ❌ Erro ao buscar PDF via pdfUrl:", fetchErr);
      return res.status(502).json({ error: "Não foi possível baixar o PDF da fonte do painel.", details: fetchErr.message });
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Chave ANTHROPIC_API_KEY não configurada no servidor." });
  }

  const anthropic = new Anthropic({ apiKey });

  try {
    let content = [];

    if (extractedText) {
      content.push({
        type: "text",
        text: `Extraia os dados estruturados de orçamento do seguinte texto extraído de um PDF:

---
${extractedText}
---

Instruções importantes:
1. Extraia APENAS o que aparece no texto, sem inventar produtos, códigos, quantidades, valores ou totais.
2. Se algum campo (como endereço, telefones, vendedor, etc.) não for encontrado, retorne string vazia.
3. Se algum item estiver ambíguo ou necessitar de revisão (por exemplo, informações incompletas ou truncadas), marque o item correspondente adicionando "needsReview": true.
4. Para cada item, extraia:
   - code: Código do produto (normalmente o primeiro bloco numérico da linha).
   - description: Descrição do produto (tudo entre o código e a quantidade).
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
      "approved": true
    }
  ]
}

Responda APENAS com o JSON válido, sem qualquer texto explicativo ou marcação de bloco de código markdown.`
      });
    } else {
      // PDF base64
      content.push(
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: pdfBase64
          }
        },
        {
          type: "text",
          text: `Extraia os dados estruturados deste PDF de orçamento.

Instruções importantes:
1. Extraia APENAS o que aparece no PDF, sem inventar produtos, códigos, quantidades, valores ou totais.
2. Se algum campo não for encontrado, retorne string vazia.
3. Se algum item estiver ambíguo ou necessitar de revisão, adicione "needsReview": true nele.
4. Para cada item, extraia:
   - code: Código do produto.
   - description: Descrição do produto.
   - quantity: Quantidade.
   - unitValue: Valor unitário.
   - total: Valor total.
   - approved: true.

Retorne um objeto JSON exatamente no seguinte formato:
{
  "number": "número do orçamento",
  "date": "data",
  "client": "cliente",
  "address": "endereço",
  "phones": "telefones",
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
      "approved": true
    }
  ]
}

Responda APENAS com o JSON válido, sem qualquer texto explicativo ou marcação de bloco de código markdown.`
        }
      );
    }

    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 4000,
      system: "Você é um assistente especializado em extração de dados estruturados de PDFs e textos de orçamentos de papelaria. Você deve retornar estritamente um JSON válido no formato solicitado. Não adicione observações, explicações ou blocos de código markdown como ```json.",
      messages: [
        {
          role: "user",
          content: content
        }
      ]
    });

    const replyText = response.content[0]?.text || "";
    let cleanJsonStr = replyText.trim();
    
    // Limpeza de blocos markdown ```json ... ``` se existirem
    if (cleanJsonStr.startsWith("```")) {
      cleanJsonStr = cleanJsonStr.replace(/^```(json)?/, "").replace(/```$/, "").trim();
    }

    const budget = JSON.parse(cleanJsonStr);

    return res.status(200).json({
      success: true,
      budget: budget
    });

  } catch (err) {
    console.error("[parse-budget-pdf] ❌ Erro ao processar com IA:", err);
    return res.status(500).json({ error: "Erro ao ler PDF de orçamento com IA", details: err.message });
  }
}
