// ============================================================
// Sartec Papelaria — Webhook + Agente IA
// Vercel Serverless Function: /api/webhook.js
//
// Env vars necessárias:
//   WHATSAPP_VERIFY_TOKEN    → token definido no Meta Dashboard
//   WHATSAPP_ACCESS_TOKEN    → System User Token permanente
//   WHATSAPP_PHONE_NUMBER_ID → ID do número registrado na Meta
//   ANTHROPIC_API_KEY        → chave da API da Anthropic
//   REDIS_URL                → URL de conexão Redis
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import Redis from "ioredis";

// ============================================================
// REDIS
// ============================================================
let redisClient = null;

function getRedis() {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL, {
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
    });
    redisClient.on("error", (err) =>
      console.error("[Redis] ❌", err.message)
    );
  }
  return redisClient;
}

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 dias — alinhado com ARCHIVE_TTL

// ============================================================
// ANTHROPIC
// ============================================================
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// SYSTEM PROMPT — v7.2
// ============================================================
const SYSTEM_PROMPT = `# SARTEC PAPELARIA — Agente de Triagem v7.2

## IDENTIDADE
Atendente virtual da **Sartec Papelaria** (SJC/SP).
Função exclusiva: **triar** e **encaminhar**. Não vende, não cota, não confirma estoque.
Nunca assina com nome próprio.

---

## REGRA MESTRE
Se a informação não está EXPLICITAMENTE neste prompt, você não sabe.
Não deduza, não infira, não confirme produtos fora do CATÁLOGO.
Em caso de dúvida: "Vou checar com a equipe 🤝"

Você pode confirmar sem escalar:
- Endereço e horário
- Formas de pagamento
- Política de entrega
- Valores de xerox (só se o cliente perguntar)
- Itens do CATÁLOGO CONHECIDO (só se o cliente perguntar diretamente)
- Restrições de serviço (contact, embrulho)

---

## INFORMAÇÕES DA LOJA

**Endereço:** Av. Andrômeda, 1805 — Jardim Satélite, SJC/SP — ao lado do Banco do Brasil
**Tel geral:** (12) 3934-1666 | **Xerox:** https://wa.me/551239341666
**Horário:** Seg-sex 8h30-18h30 | Sáb 9h-14h | Dom fechado
⚠️ Feriados e datas futuras: nunca confirme. Você não tem acesso ao calendário.

**Pagamento:** PIX (CNPJ 06.241.041/0001-56, BB), dinheiro, débito, crédito à vista, parcelado até 3x (mín R$50/parcela), boleto 28 dias (só empresas cadastradas). Cheque: não aceitamos.

**Entrega em SJC:**
- Acima de R$100: grátis
- R$50,01–R$99,99: R$5
- Abaixo de R$50: R$10

Quando o cliente mencionar bairro ou cidade: informe as condições acima e diga que fora de SJC a equipe avalia. Não tente identificar se é SJC ou não.

**Descontos de 10%** (comprovação pela equipe): empresas cadastradas, profissionais liberais, aposentados.

---

## CATÁLOGO CONHECIDO
Use esta lista SOMENTE quando o cliente perguntar diretamente se vocês têm um produto.
Nunca use para verificar itens de uma lista enviada pelo cliente.

Cadernos (incluindo desenho e música), lápis de cor, lápis grafite, giz de cera, borrachas, apontadores, réguas, estojos, mochilas, cola (branca, transparente, tecido, madeira, isopor), tintas (óleo, guache, tecido, aquarela), papéis (vergê, opaline, kraft/pardo, triplex, duplex, seda, mágico, moldura, textura visual, sulfite A3, canson A3, carbon, contact, sulfite, canson, presente), EVA, argila, pincéis, rolo de pintura, baldinho de praia, slime, copos descartáveis, transparência, stencil, plástico bolha, caixa de presente, mouse, teclado, fone de ouvido, mousepad, lapiseiras, livros infantis, canetas (permanente, marca-texto, posca, tecido), corretivo, agendas, planners, quadro branco, quadro negro, telas de pintura, fitas (crepe, dupla face, durex, demarcação, espuma, massa acrílica), blocos adesivos.

**Resposta quando cliente pergunta diretamente:**
- Item na lista: "Tem sim! Precisa de mais alguma coisa?"
- Variação específica (cor/marca/modelo): "Tem [item] sim! Sobre [variação], vou checar com a equipe. Precisa de mais alguma coisa?"
- Item fora da lista: "Vou checar com a equipe se temos esse item. Precisa de mais alguma coisa?"

**Como vendemos (só mencione se o cliente perguntar):**
- Papel contact: 0,5m em 0,5m ou rolo inteiro
- Papel kraft: folha, metro ou rolo
- Plástico bolha: metro ou rolo fechado
- Papel sulfite: resma 100, resma 500 ou caixa

**Restrições de serviço (alerte sempre que o produto for mencionado):**
- Papel contact: vendemos, mas não aplicamos
- Papel de presente: vendemos, mas não embrulhamos

---

## FLUXO DE ATENDIMENTO

### Primeira mensagem
Sempre responda exatamente assim:
> "Oi, tudo bem? 😊 Aqui é da Sartec Papelaria! Em que posso te ajudar?
> Antes, só pra agilizar, você é cliente pessoa física ou pessoa jurídica?"

Aguarde a resposta do cliente. Não faça mais nenhuma pergunta antes de receber.

Com base na resposta:
- Se PF (pessoa física, cliente comum, uso pessoal, escola, artesanato etc.) → siga o fluxo normal de atendimento PF
- Se PJ (empresa, CNPJ, escritório, razão social etc.) → inicie imediatamente o **Fluxo PJ** (Passo 1 — Verificar cadastro)
- Se a resposta não ficou clara → pergunte uma vez mais: "Só para confirmar — você está comprando para uso pessoal ou para uma empresa?"

### Identificando a intenção

Após o cliente responder, classifique:

**PEDIDO** — quer comprar produto(s)

⚠️ **Regra de triagem PF/PJ:** a pergunta PF/PJ é feita na **primeira mensagem**, antes de qualquer outra interação. A partir da resposta, o fluxo já segue o caminho correto (PF ou PJ) sem repetir essa pergunta em nenhum momento da conversa.

**Classificação automática como PJ** — vá direto para o Fluxo PJ SEM fazer a pergunta PF/PJ se o cliente:
- Apresentar CNPJ explícito
- Enviar documento com cabeçalho de empresa ou órgão público
- Mencionar prefeitura, secretaria, câmara, autarquia, escola estadual/municipal, hospital público
- Usar os termos "razão social", "para a empresa", "para o escritório", "para minha firma", "em nome de", "nota fiscal", "faturamento", "DANFE"
- Pedir cotação formal por escrito

Nesses casos: registre internamente como PJ e execute o **Fluxo PJ** diretamente.

- Se o cliente indicou que quer comprar mas **ainda não enviou a lista**:
  > "Claro! Pode me mandar a lista dos itens que você precisa? Pode ser texto, foto ou documento 😊
  > (Só não consigo ouvir áudios — se preferir, manda escrito!)"
  Aguarde a lista. Não faça nenhuma outra pergunta antes de recebê-la.

- Se mandou lista por **texto**:
  1. Leia e liste os itens identificados de forma simples
  2. Confirme com o cliente:
     > "Anotei esses itens: [lista dos itens]. Tem mais alguma coisa? 😊"
  3. Aguarde confirmação. Somente após o cliente confirmar que não tem mais nada (respostas como "não", "só isso", "pode mandar", "é isso"):
     - Se PF (já identificado no início) → handoff: "Anotado! Vou passar para a equipe checar disponibilidade e preço em instantes 🤝"
     - Se PJ (já identificado no início) → siga o **Fluxo PJ** abaixo.

- Se mandou lista por **foto ou PDF**:
  1. Leia o conteúdo e confirme de forma resumida o que identificou:
     > "Recebi seu arquivo! Vi que você precisa de: [itens identificados]. É isso mesmo? Tem mais alguma coisa? 😊"
  2. Se o conteúdo não for legível:
     > "Recebi seu arquivo 📎 Consegui ver que é uma lista de produtos. Pode me confirmar os itens?"
  3. Aguarde confirmação. Somente após confirmar:
     - Se PF (já identificado no início) → handoff
     - Se PJ (já identificado no início) → Fluxo PJ

- Se a imagem for foto de produto (não lista):
  > "Vi que você mandou a foto de um [produto]. Você tem alguma dúvida sobre ele? 😊"
  Aguarde resposta. Após resolver, pergunte se precisa de mais algo e encaminhe.

**PJ** — empresa, CNPJ, nota fiscal, volume

Sempre que identificar que é uma empresa, use o **Fluxo PJ**:

**Passo 1 — Verificar cadastro:**
> "Entendido! Para agilizar seu atendimento — sua empresa já tem cadastro conosco?"

**Se já tem cadastro:**
> "Ótimo! Para eu já identificar sua empresa aqui, pode me passar o CNPJ? Assim quando a equipe assumir já vai ter todo o histórico de vocês em mãos 🤝"

Após receber o CNPJ:
> "Perfeito! Vou passar você para nossa equipe agora 🤝"
[handoff]

**Se não tem cadastro:**
> "Sem problema! Temos ótimas condições para empresas cadastradas: 10% de desconto em todas as compras e opção de faturamento com boleto 28 dias. Se quiser já aproveitar, posso coletar os dados agora enquanto te passo para nossa equipe. Quer fazer o cadastro?"

- Se quiser cadastro: colete razão social e CNPJ, informe que a equipe finalizará o cadastro, faça handoff.
- Se não quiser: handoff direto.

⚠️ **Nunca pedir no bot:** Inscrição Estadual, referências comerciais, contrato social, dados de DANFE.
⚠️ O agente não valida CNPJ nem confirma se o cadastro existe — isso é função da equipe.

**XEROX / IMPRESSÃO / ENCADERNAÇÃO / PLASTIFICAÇÃO**
- Encaminhe direto para o setor, sem desenvolver conversa:
  > "Para xerox, encadernação e plastificação, fala direto com nosso setor pelo WhatsApp: https://wa.me/551239341666 📎 Eles te atendem por lá!"
- Se o cliente perguntar valor antes, responda só o item perguntado:
  - Cópia P&B: A4 R$0,50 | A3 R$1,00 | (≥100 do mesmo) R$0,30
  - Impressão P&B: A4 R$1,50 | A3 R$3,00
  - Impressão Color: A4 R$3,50 | A3 R$6,00
  - Impressão Canson P&B: A4 R$2 | A3 R$4
  - Impressão Canson Color: A4 R$4 | A3 R$8
  - Impressão Foto P&B: A4 R$2,25 | Color A4 R$4,50
  - Encadernação: até 100fl R$10 | até 300fl R$15 | até 500fl R$20
  - Plastificação: Doc R$7 | A5 R$8 | A4 R$10 | A3 R$15
  - Escaneamento: R$4 a cada 5 páginas (1 arquivo)
  - Corte: consultar

**FORNECEDOR** — quer vender para a Sartec
- Encaminhe para compras.

**DÚVIDA** — horário, endereço, pagamento etc.
- Responda com as informações do bloco acima e ofereça mais ajuda.

**Se a intenção não ficou clara**, use o menu:
> "Pode me contar melhor? Você está procurando:
> • Produtos (material escolar, artesanato, escritório...)
> • Orçamento para empresa
> • Xerox, impressão ou encadernação
> • Outra coisa"

---

## CADASTRO PJ (quando cliente aceita fazer o cadastro)

Colete apenas:
1. Razão social
2. CNPJ

Informe: "A nossa equipe vai entrar em contato para finalizar o cadastro com os dados adicionais."
Após coletar, faça handoff.

**Nunca pedir no cadastro via bot:** Inscrição Estadual, referências comerciais, contrato social, DANFE.

---

## SITUAÇÕES ESPECIAIS

**Fora do horário:**
> "Estamos fechados agora 🕐 Eu sou o assistente virtual da Sartec e posso adiantar seu atendimento por aqui. Me manda o que você precisa, que eu organizo as informações para a equipe continuar quando a loja abrir."

**Cliente pede humano:**
> "Claro! Vou passar você para nossa equipe agora 🤝"

**Cliente irritado:**
> "Entendo, peço desculpas 🙏 Vou chamar nossa equipe para te atender diretamente 🤝"

**Anexo não reconhecido (Word, zip, localização):**
> "Recebi seu arquivo 📎 Vou passar para a equipe dar uma olhada 🤝"

**Mensagem vazia, emoji, figurinha:**
Use a saudação inicial.

**Pós-handoff:**
- Se a conversa foi retomada por template aprovado (ex: retomar_atendimento), você NÃO deve continuar a triagem nem responder automaticamente.
- Perguntas sobre endereço, horário ou pagamento: responda normalmente.
- Qualquer outra mensagem (primeira vez): "Nossa equipe já está ciente e vai te atender em breve 🤝".
- Mensagens seguintes: silêncio total.

---

## USO DE EMOJIS
- Máximo de **1 emoji por mensagem**
- Usar apenas no início ou fim da mensagem, nunca no meio
- **Proibido** em mensagens técnicas: confirmação de dados, solicitação de documentos, handoff formal, erros
- **Permitidos** (use com moderação): 😊 👇 🤝 ✅ 📍 🕐 💳 🚚 📎 🙏
- **Proibidos:** todos os outros emojis

---

## TOM E FORMATO
- "Você" sempre. Nunca "senhor/senhora" ou abreviações (vc, tb, pgto)
- Cordial, direto, humano
- Máximo 2 mensagens por resposta — uma é o ideal

---

## ESTRUTURA INTERNA (não mostre ao cliente)
tipo: PF | PJ | Fornecedor | Indefinido
intencao: lista | cotacao | xerox | duvida | cadastro | outro
setor: atendimento | empresas | compras | resolvido_bot
dados: [coletados]
resumo: [1 frase]
status: resolvido | escalado
`;

// ============================================================
// SESSÃO — Redis com reset por data calendário
// ============================================================

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function createEmptySession() {
  return {
    history: [],
    handoffDone: false,
    postHandoffReplySent: false,
    audioCount: 0,
    lastDate: todayDate(),
    lastActivityAt:   new Date().toISOString(),
    // Janela de atendimento WhatsApp (24h a partir da última msg do cliente)
    lastUserMessageAt: null,
    windowExpiresAt:   null,
  };
}

async function loadSession(phone) {
  try {
    const raw = await getRedis().get(`sartec:${phone}`);
    if (!raw) return createEmptySession();

    const session = JSON.parse(raw);

    // Reset por data calendário — não por 24h corridas
    if (session.lastDate !== todayDate()) {
      console.log(`[Sessão] 📅 Novo dia — resetando +${phone}`);
      return createEmptySession();
    }

    return session;
  } catch (err) {
    console.error("[Sessão] ❌ Erro ao carregar:", err.message);
    return createEmptySession();
  }
}

async function saveSession(phone, session) {
  try {
    session.lastDate       = todayDate();
    session.lastActivityAt = new Date().toISOString();
    await getRedis().set(
      `sartec:${phone}`,
      JSON.stringify(session),
      "EX",
      SESSION_TTL
    );
    await upsertContact(getRedis(), phone, {
      clientName:             session.clientName,
      clientType:             session.clientType,
      demandType:             session.demandType,
      lastConversationStatus: session.status,
      lastPipelineStatus:     session.pipelineStatus,
    });
  } catch (err) {
    console.error("[Sessão] ❌ Erro ao salvar:", err.message);
  }
}

async function upsertContact(redis, phone, incoming) {
  const key = `sartec:contact:${phone}`;
  const now = new Date().toISOString();
  try {
    const raw  = await redis.get(key);
    const prev = raw ? JSON.parse(raw) : {};
    const updated = {
      phone,
      whatsappName:           incoming.whatsappName           || prev.whatsappName           || "",
      clientName:             incoming.clientName             || prev.clientName             || prev.whatsappName || "",
      clientType:             incoming.clientType             || prev.clientType             || "",
      demandType:             incoming.demandType             || prev.demandType             || "",
      firstSeenAt:            prev.firstSeenAt                || now,
      lastSeenAt:             now,
      lastActivityAt:         now,
      lastConversationStatus: incoming.lastConversationStatus || prev.lastConversationStatus || "",
      lastPipelineStatus:     incoming.lastPipelineStatus     || prev.lastPipelineStatus     || "",
      updatedAt:              now,
    };
    await redis.set(key, JSON.stringify(updated));
  } catch (err) {
    console.error("[Contact] ❌ upsertContact:", err.message);
  }
}

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
  console.warn(`[Lock] ⚠️ Timeout +${phone}`);
  return fn();
}

// ============================================================
// JANELA DE CONVERSA — 24h (WhatsApp Cloud API)
// ============================================================

/**
 * Calcula o status da janela de 24h a partir dos campos da sessão.
 * Regra: a janela começa/reinicia a cada mensagem do CLIENTE.
 * Mensagens do bot/atendente NÃO reiniciam a janela.
 *
 * Campos lidos:
 *   session.lastUserMessageAt — ISO string da última msg do cliente
 *   session.windowExpiresAt   — lastUserMessageAt + 24h
 *   session.templateSentAt    — (opcional) ISO da última vez que um template foi enviado
 *
 * Retorna: { lastUserMessageAt, windowExpiresAt, conversationWindowStatus, windowRemainingMs }
 *   conversationWindowStatus: "open" | "closed" | "waiting_template_reply"
 */
function computeWindowInfo(session) {
  const now        = Date.now();
  const lastUserAt = session.lastUserMessageAt
    ? new Date(session.lastUserMessageAt).getTime()
    : null;
  const expiresAt  = session.windowExpiresAt
    ? new Date(session.windowExpiresAt).getTime()
    : null;

  if (!lastUserAt) {
    return {
      lastUserMessageAt:        null,
      windowExpiresAt:          null,
      conversationWindowStatus: "closed",
      windowRemainingMs:        0,
    };
  }

  if (expiresAt && now < expiresAt) {
    return {
      lastUserMessageAt:        session.lastUserMessageAt,
      windowExpiresAt:          session.windowExpiresAt,
      conversationWindowStatus: "open",
      windowRemainingMs:        expiresAt - now,
    };
  }

  // Janela fechada — verifica se template foi enviado APÓS última msg do cliente
  if (session.templateSentAt) {
    const templateAt = new Date(session.templateSentAt).getTime();
    if (templateAt > lastUserAt) {
      return {
        lastUserMessageAt:        session.lastUserMessageAt,
        windowExpiresAt:          session.windowExpiresAt,
        conversationWindowStatus: "waiting_template_reply",
        windowRemainingMs:        0,
      };
    }
  }

  return {
    lastUserMessageAt:        session.lastUserMessageAt,
    windowExpiresAt:          session.windowExpiresAt,
    conversationWindowStatus: "closed",
    windowRemainingMs:        0,
  };
}

// ============================================================
// HISTÓRICO
// ============================================================

const MAX_MESSAGES = 20;

function isHandoff(content) {
  const signals = [
    "vou passar para a equipe",
    "vou passar você para",
    "vou chamar nossa equipe",
    "equipe vai te atender",
  ];
  const lower = content.toLowerCase();
  if (lower.includes("wa.me/551239341666")) return false; // xerox redirect ≠ handoff
  return signals.some((s) => lower.includes(s));
}

function inferDemandType(history) {
  const text = history
    .filter((m) => m.role === "user")
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content))
        return m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ");
      return "";
    })
    .join(" ")
    .toLowerCase();

  if (
    text.includes("cnpj") || text.includes("nota fiscal") ||
    text.includes("cotação") || text.includes("cotacao") ||
    text.includes("faturado") || text.includes("danfe") ||
    text.includes("empresa") || text.includes("razão social") ||
    text.includes("razao social") || text.includes("prefeitura") ||
    text.includes("secretaria") || text.includes("câmara")
  ) return "cotacao_pj";
  if (
    text.includes("xerox") || text.includes("impressão") || text.includes("impressao") ||
    text.includes("encadernação") || text.includes("encadernacao") ||
    text.includes("plastificação") || text.includes("plastificacao")
  ) return "xerox";
  if (
    text.includes("lista") || text.includes("comprar") || text.includes("preciso de") ||
    text.includes("quero") || text.includes("itens")
  ) return "lista";
  if (text.includes("tem ") || text.includes("vende") || text.includes("produto")) return "produto";
  if (
    text.includes("horário") || text.includes("horario") || text.includes("endereço") ||
    text.includes("endereco") || text.includes("pagamento") || text.includes("entrega") ||
    text.includes("frete")
  ) return "duvida";
  return "outro";
}

/**
 * Detecta sinais claros de PJ no texto do usuário.
 * Quando detectado, salva imediatamente clientType e demandType na sessão.
 */
function detectPJSignals(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const signals = [
    /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/,   // CNPJ
    "para a empresa",
    "para o escritório",
    "para minha firma",
    "em nome de",
    "prefeitura",
    "secretaria",
    "câmara municipal",
    "camara municipal",
    "escola estadual",
    "escola municipal",
    "hospital público",
    "hospital publico",
    "razão social",
    "razao social",
    "nota fiscal",
    "faturamento",
    "danfe",
  ];
  return signals.some((s) =>
    typeof s === "string" ? lower.includes(s) : s.test(lower)
  );
}

/**
 * Gera título sintético do card no momento do handoff.
 * Estratégia: pega a mensagem mais substantiva do cliente,
 * remove saudações/locuções introdutórias e resume o pedido.
 * Exemplos: "Lista Escolar — caneta + bloco A4"
 *           "Cotação PJ — resma A4 e papel contact"
 *           "Xerox/Impressão — frente e verso colorido"
 */
function generateCardTitle(session) {
  const demandLabels = {
    lista:      "Lista Escolar",
    cotacao_pj: "Cotação PJ",
    xerox:      "Xerox/Impressão",
    produto:    "Produtos",
    duvida:     "Dúvida",
    outro:      "Pedido",
  };

  const label  = demandLabels[session.demandType] || "Pedido";
  const isPJ   = session.clientType === "pj";
  // Para cotação_pj o label já carrega "PJ"; para os demais, adiciona o sufixo
  const prefix = (isPJ && !label.includes("PJ")) ? `${label} PJ` : label;

  // --- Para Lista Escolar: escola + série são mais relevantes que o texto livre ---
  if (session.demandType === "lista" && session.escola) {
    const serie = session.serie ? ` ${session.serie}` : "";
    return `${prefix} — ${session.escola}${serie}`;
  }

  // --- Extrai todas as mensagens substanciais do cliente (> 12 chars) ---
  const userMsgs = session.history
    .filter((m) => m.role === "user")
    .map((m) =>
      typeof m.content === "string"
        ? m.content.trim()
        : Array.isArray(m.content)
          ? m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").trim()
          : ""
    )
    .filter((t) => t.length > 12);

  if (!userMsgs.length) return prefix;

  // --- Escolhe a mensagem mais longa das últimas 4 (tende a ter mais detalhes) ---
  const best = [...userMsgs.slice(-4)].sort((a, b) => b.length - a.length)[0];

  // --- Remove saudações e locuções introdutórias comuns em português ---
  const cleaned = best
    .replace(/^(olá|ola|oi|bom\s+dia|boa\s+tarde|boa\s+noite)[,!.\s]*/gi, "")
    .replace(/^(gostaria\s+de|preciso\s+de|quero\s+pedir|queria|vim\s+pedir|poderia|pode\s+me)\s+/gi, "")
    .replace(/^(pedir|solicitar|comprar|encomendar|fazer\s+(?:um\s+)?pedido\s+de)\s+/gi, "")
    .replace(/^(solicito|necessito|estou\s+precisando\s+de|tenho\s+interesse\s+em)\s+/gi, "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || cleaned.length < 4) return prefix;

  // --- Capitaliza e limita a 52 chars ---
  const summary = cleaned.substring(0, 52).trim();
  const titled  = summary.charAt(0).toUpperCase() + summary.slice(1);

  return `${prefix} — ${titled}`;
}

function addMessage(session, role, content) {
  session.history.push({ role, content });

  if (role === "assistant" && isHandoff(content)) {
    session.handoffDone = true;
    session.postHandoffReplySent = false;
    session.status    = "aguardando_humano";
    if (!session.demandType)  session.demandType  = inferDemandType(session.history);
    if (!session.handoffAt)   session.handoffAt   = new Date().toISOString();
    if (!session.cardTitle)   session.cardTitle   = generateCardTitle(session);
  }

  if (session.history.length > MAX_MESSAGES) trimHistory(session);
}

function trimHistory(session) {
  const recent  = session.history.slice(-10);
  const older   = session.history.slice(0, -10);
  const summary = older
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : "[mídia]"))
    .join(" | ")
    .substring(0, 300);

  session.history = [
    { role: "user",      content: `[RESUMO ANTERIOR] Cliente mencionou: ${summary}...` },
    { role: "assistant", content: "Entendido, continuando o atendimento." },
    ...recent,
  ];
}

function getMessages(session) {
  return session.history.filter((m) => m.role !== "system");
}

function shouldRespond(session, text) {
  if (!session.handoffDone) return true;

  const basicKeywords = [
    "endereço", "endereco", "onde fica",
    "horário", "horario", "aberto", "que horas",
    "pagamento", "pix", "cartão", "cartao", "dinheiro", "boleto",
  ];
  if (basicKeywords.some((kw) => text.toLowerCase().includes(kw))) return true;
  if (session.postHandoffReplySent) return false;
  return "post_handoff_default";
}

// ============================================================
// DOWNLOAD DE MÍDIA DA META
// ============================================================

async function downloadMedia(mediaId) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { url, mime_type } = await metaRes.json();

  const fileRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const buffer = await fileRes.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  return { base64, mimeType: mime_type };
}

// ============================================================
// AGENTE
// ============================================================

async function chatWithAgent(phone, userText, mediaPayload = null, name = "") {
  return withSessionLock(getRedis(), phone, async () => {
  const session  = await loadSession(phone);

  // ── Janela de 24h ─────────────────────────────────────────────────────────
  // Toda mensagem vinda do cliente reinicia o contador.
  // Mensagens do bot/atendente NÃO chamam chatWithAgent, logo não reiniciam.
  const _now = new Date();
  session.lastUserMessageAt = _now.toISOString();
  session.windowExpiresAt   = new Date(_now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  // Detecta se é resposta a template de retomada
  const isResumeReply = session.templateWaitingReply && session.lastTemplateType === "attendance_resume";

  // Se havia template aguardando resposta, o cliente acabou de responder → limpa a flag
  if (session.templateWaitingReply) {
    session.templateWaitingReply = false;
    console.log(`[Agente] 🔓 Template respondido — janela reaberta: +${phone}`);
  }

  // Se for retomada, paramos aqui (humano assume)
  if (isResumeReply) {
    console.log(`[Agente] 🔄 Retomada de atendimento — silenciando bot para +${phone}`);
    session.handoffDone          = true;
    session.status               = "aguardando_humano";
    session.postHandoffReplySent = true; // Evita a mensagem padrão de "já estamos ciente"
    session.handoffAt            = new Date().toISOString(); // Atualiza timestamp na fila

    // Se o card estiver em status terminal ou sem pipelineStatus, move para em_atendimento
    if (!session.pipelineStatus || session.pipelineStatus === "finalizado" || session.pipelineStatus === "entregue") {
      session.pipelineStatus = "em_atendimento";
    }

    // Registra a mensagem no histórico antes de sair
    const userContent = mediaPayload
      ? [
          {
            type: mediaPayload.mimeType === "application/pdf" ? "document" : "image",
            source: {
              type:       "base64",
              media_type: mediaPayload.mimeType,
              data:       mediaPayload.base64,
            },
          },
          { type: "text", text: userText || "O cliente enviou este arquivo." },
        ]
      : userText;

    addMessage(session, "user", userContent);
    await saveSession(phone, session);
    return null; // Encerra sem chamar Claude e sem resposta automática
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Mantém dados de identificação na sessão
  if (name) session.clientName = name;
  session.clientPhone = phone;

  // Detecta sinais PJ imediatamente, antes de chamar Claude
  const textToCheck = userText || "";
  if (!session.clientType && detectPJSignals(textToCheck)) {
    session.clientType  = "pj";
    session.demandType  = "cotacao_pj";
    console.log(`[Agente] 🏢 PJ detectado em +${phone}`);
  }

  const decision = shouldRespond(session, textToCheck);

  if (decision === "post_handoff_default") {
    const reply = "Nossa equipe já está ciente e vai te atender em breve 🤝";
    addMessage(session, "user",      textToCheck || "[mensagem]");
    addMessage(session, "assistant", reply);
    session.postHandoffReplySent = true;
    await saveSession(phone, session);
    return reply;
  }

  if (decision === false) {
    await saveSession(phone, session);
    return null;
  }

  // Monta conteúdo — texto simples ou mídia
  const userContent = mediaPayload
    ? [
        {
          type: mediaPayload.mimeType === "application/pdf" ? "document" : "image",
          source: {
            type:       "base64",
            media_type: mediaPayload.mimeType,
            data:       mediaPayload.base64,
          },
        },
        { type: "text", text: userText || "O cliente enviou este arquivo." },
      ]
    : userText;

  addMessage(session, "user", userContent);

  console.log(`[Agente] 🤖 +${phone} | ${getMessages(session).length} msgs`);

  const aiResponse = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system:     SYSTEM_PROMPT,
    messages:   getMessages(session),
  });

  const reply = aiResponse.content[0]?.type === "text" ? aiResponse.content[0].text : "";

  addMessage(session, "assistant", reply);
  await saveSession(phone, session);

  console.log(
    `[Agente] ✅ "${reply.substring(0, 80)}..." | ` +
    `${aiResponse.usage?.input_tokens}in/${aiResponse.usage?.output_tokens}out`
  );

  return reply;
  });
}

// ============================================================
// WEBHOOK
// ============================================================

export default async function handler(req, res) {
  if (req.method === "GET" && req.query.reset) return await handleReset(req, res);
  if (req.method === "GET")  return handleVerification(req, res);
  if (req.method === "POST") return await handleIncomingMessage(req, res);
  return res.status(405).json({ error: "Method Not Allowed" });
}

async function handleReset(req, res) {
  const { reset, phone } = req.query;

  if (reset !== process.env.WHATSAPP_VERIFY_TOKEN) {
    console.warn("[Reset] ❌ Token inválido");
    return res.status(403).json({ error: "Forbidden" });
  }

  if (!phone) {
    return res.status(400).json({ error: "Parâmetro phone obrigatório" });
  }

  try {
    await getRedis().del(`sartec:${phone}`);
    console.log(`[Reset] ✅ Sessão deletada: +${phone}`);
    return res.status(200).json({ ok: true, message: `Sessão de +${phone} resetada.` });
  } catch (err) {
    return res.status(500).json({ error: "Erro ao resetar sessão" });
  }
}

function handleVerification(req, res) {
  const {
    "hub.mode":         mode,
    "hub.verify_token": token,
    "hub.challenge":    challenge,
  } = req.query;
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[Webhook] ✅ Verificação OK");
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: "Forbidden" });
}

async function handleIncomingMessage(req, res) {
  const body = req.body;

  if (body?.object !== "whatsapp_business_account") {
    return res.status(200).send("EVENT_RECEIVED");
  }

  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;

        for (const s of value?.statuses ?? []) {
          console.log(`[Status] ${s.status} — ${s.id}`);
        }

        if (!value?.messages?.length) continue;

        for (const message of value.messages) {
          const from = message.from;
          const type = message.type;
          const name = value.contacts?.find((c) => c.wa_id === from)?.profile?.name ?? "—";

          console.log(`[Msg] +${from} (${name}) tipo: ${type}`);

          await upsertContact(getRedis(), from, { whatsappName: name !== "—" ? name : null });

          // ── ÁUDIO — dois estágios, sem chamar Claude ─────────
          if (type === "audio") {
            const audioReply = await withSessionLock(getRedis(), from, async () => {
              const session = await loadSession(from);
              // Áudio é mensagem do cliente → reinicia janela de 24h
              const _audioNow = new Date();
              session.lastUserMessageAt = _audioNow.toISOString();
              session.windowExpiresAt   = new Date(_audioNow.getTime() + 24 * 60 * 60 * 1000).toISOString();
              if (session.templateWaitingReply) {
                const isResume = session.lastTemplateType === "attendance_resume";
                session.templateWaitingReply = false;
                console.log(`[Audio] 🔓 Template respondido (áudio) — janela reaberta: +${from}`);

                if (isResume) {
                  console.log(`[Audio] 🔄 Retomada via áudio — silenciando bot para +${from}`);
                  session.handoffDone          = true;
                  session.status               = "aguardando_humano";
                  session.postHandoffReplySent = true;
                  session.handoffAt            = new Date().toISOString(); // Atualiza timestamp na fila
                  if (!session.pipelineStatus || session.pipelineStatus === "finalizado" || session.pipelineStatus === "entregue") {
                    session.pipelineStatus = "em_atendimento";
                  }
                  addMessage(session, "user", "[áudio]");
                  await saveSession(from, session);
                  return null; // Silêncio total
                }
              }
              session.audioCount = (session.audioCount || 0) + 1;

              let reply;
              if (session.audioCount === 1) {
                reply = "Tive dificuldade pra entender seu áudio 🙏 Consegue mandar por escrito?";
              } else {
                reply = "Não consigo ouvir áudios por aqui 🙏 Vou te passar para nossa equipe que vai te atender diretamente 🤝";
                session.handoffDone          = true;
                session.postHandoffReplySent = false;
                session.status               = "aguardando_humano";
                session.clientName           = name;
                session.clientPhone          = from;
                session.demandType           = session.demandType || "outro";
                session.handoffAt            = session.handoffAt  || new Date().toISOString();
                if (!session.cardTitle)      session.cardTitle    = generateCardTitle(session);
              }

              await saveSession(from, session);
              return reply;
            });
            await sendTextMessage(from, audioReply);
            continue;
          }

          // ── IMAGEM — envia para Claude processar ─────────────
          if (type === "image") {
            try {
              const media   = await downloadMedia(message.image.id);
              const caption = message.image.caption || "";
              const reply   = await chatWithAgent(from, caption || "O cliente enviou uma imagem.", media, name);
              if (reply) await sendTextMessage(from, reply);
            } catch (err) {
              console.error("[Imagem] ❌", err.message);
              await sendTextMessage(from, "Recebi sua imagem 📎 Vou passar para a equipe dar uma olhada 🤝");
            }
            continue;
          }

          // ── PDF — envia para Claude processar ────────────────
          if (type === "document" && message.document?.mime_type === "application/pdf") {
            try {
              const media = await downloadMedia(message.document.id);
              const reply = await chatWithAgent(from, "O cliente enviou um PDF.", media, name);
              if (reply) await sendTextMessage(from, reply);
            } catch (err) {
              console.error("[PDF] ❌", err.message);
              await sendTextMessage(from, "Recebi seu PDF 📎 Vou passar para a equipe dar uma olhada 🤝");
            }
            continue;
          }

          // ── OUTROS DOCUMENTOS (Word, zip, etc.) ──────────────
          if (type === "document") {
            // Mensagem do cliente → reinicia janela de 24h
            try {
              await withSessionLock(getRedis(), from, async () => {
                const _docSession = await loadSession(from);
                const _docNow = new Date();
                _docSession.lastUserMessageAt = _docNow.toISOString();
                _docSession.windowExpiresAt   = new Date(_docNow.getTime() + 24 * 60 * 60 * 1000).toISOString();
                if (_docSession.templateWaitingReply) {
                  const isResume = _docSession.lastTemplateType === "attendance_resume";
                  _docSession.templateWaitingReply = false;
                  console.log(`[Doc] 🔓 Template respondido (doc) — janela reaberta: +${from}`);

                  if (isResume) {
                    console.log(`[Doc] 🔄 Retomada via doc — silenciando bot para +${from}`);
                    _docSession.handoffDone          = true;
                    _docSession.status               = "aguardando_humano";
                    _docSession.postHandoffReplySent = true;
                    _docSession.handoffAt            = new Date().toISOString(); // Atualiza timestamp na fila
                    if (!_docSession.pipelineStatus || _docSession.pipelineStatus === "finalizado" || _docSession.pipelineStatus === "entregue") {
                      _docSession.pipelineStatus = "em_atendimento";
                    }
                    _docSession._stopFlow = true; // Flag temporária para o handler
                  }
                }
                await saveSession(from, _docSession);
                if (_docSession._stopFlow) {
                  // Limpa a flag temporária e sinaliza para o handler não enviar mensagem
                  delete _docSession._stopFlow;
                  throw new Error("STOP_FLOW"); 
                }
              });
            } catch (_e) { 
              if (_e.message === "STOP_FLOW") continue;
              console.error("[Doc/window] ❌", _e.message); 
            }
            await sendTextMessage(from, "Recebi seu arquivo 📎 Vou passar para a equipe dar uma olhada 🤝");
            continue;
          }

          // ── TEXTO ─────────────────────────────────────────────
          if (type === "text") {
            const text = message.text?.body ?? "";
            console.log(`[Msg] "${text}"`);

            let reply;
            try {
              reply = await chatWithAgent(from, text, null, name);
            } catch (err) {
              console.error("[Agente] ❌", err.message);
              reply = "Desculpe, tive um problema técnico. Nossa equipe vai te atender em breve 🤝";
            }

            if (reply === null) {
              console.log("[Agente] 🔇 Silêncio pós-handoff");
              continue;
            }

            await sendTextMessage(from, reply);
            continue;
          }

          console.log(`[Msg] Tipo ignorado: ${type}`);
        }
      }
    }
  } catch (err) {
    console.error("[Webhook] ❌ Erro geral:", err.message);
  }

  return res.status(200).send("EVENT_RECEIVED");
}

// ============================================================
// ENVIO
// ============================================================

async function sendTextMessage(to, text) {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.error("[Send] ❌ Env vars ausentes — abortando.");
    return;
  }

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type:    "individual",
        to,
        type: "text",
        text: { preview_url: false, body: text },
      }),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    console.error(`[Send] ❌ Meta erro ${data?.error?.code}: ${data?.error?.message}`);
  } else {
    console.log(`[Send] ✅ ID: ${data?.messages?.[0]?.id}`);
  }
}
