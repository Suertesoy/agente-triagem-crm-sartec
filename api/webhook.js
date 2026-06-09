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

const SESSION_TTL = 60 * 60 * 24 * 90; // 90 dias — retenção mínima de histórico

// ============================================================
// ANTHROPIC
// ============================================================
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// SYSTEM PROMPT — v7.2
// ============================================================
const SYSTEM_PROMPT = `# SARTEC PAPELARIA — Agente de Triagem v7.3

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
> "Olá! 🙂 Aqui é da Sartec Papelaria.
>
> Para agilizar seu atendimento, você é pessoa física ou pessoa jurídica?"

Aguarde a resposta do cliente. Não faça mais nenhuma pergunta antes de receber.

Com base na identificação:

- Se PF (pessoa física, cliente comum, uso pessoal, escola, artesanato etc.):
  Registre internamente como PF e responda:
  > "Perfeito, informação registrada. Em que posso te ajudar?"
  Aguarde o cliente explicar o que precisa e siga o fluxo normal de atendimento PF.

- Se PJ (empresa, CNPJ, escritório, razão social etc.) — incluindo respostas simples como "Jurídica", "PJ", "Empresa", "Pessoa jurídica":
  Registre internamente como PJ e inicie **imediatamente** o Fluxo PJ, sem perguntar "em que posso ajudar". Responda diretamente:
  > "Entendido! Sua empresa já tem cadastro conosco?"

- Se a resposta não ficou clara → pergunte apenas uma vez: "Só para confirmar: você está comprando para uso pessoal ou para uma empresa?"

### Identificando a intenção

Após o cliente responder, classifique:

**PEDIDO** — quer comprar produto(s)

⚠️ **Regra de triagem PF/PJ:** a pergunta PF/PJ é feita na **primeira mensagem**, antes de qualquer outra interação. A partir da resposta, o fluxo já segue o caminho correto (PF ou PJ) sem repetir essa pergunta em nenhum momento da conversa.

**Classificação automática como PJ** — vá direto para o Fluxo PJ SEM fazer a pergunta PF/PJ se o cliente:
- Apresentar CNPJ explícito
- Enviar documento com cabeçalho de empresa ou órgão público
- Mencionar prefeitura, secretaria, câmara, autarquia, escola estadual/municipal, hospital público
- Usar os termos "razão social", "para a empresa", "para o escritório", "para minha firma", "em nome de", "nota fiscal", "faturamento", "DANFE"
- Se identificar como empresa, grupo, setor, departamento, compras, financeiro, fiscal, controladoria, ou falar em nome de uma organização (ex: "empresa X", "Grupo X", "setor fiscal")
- Pedir cotação formal por escrito

Nesses casos: registre internamente como PJ e execute o **Fluxo PJ** diretamente.

- Se o cliente indicou que quer comprar mas **ainda não enviou a lista**:
  > "Claro. Pode me enviar a lista dos itens que você precisa."
  Aguarde a lista. Não faça nenhuma outra pergunta antes de recebê-la.

- Se mandou lista por **texto**:
  1. Leia e liste os itens identificados de forma simples
  2. Confirme com o cliente:
     > "Anotei esses itens: [lista dos itens]. Tem mais alguma coisa? 😊"
  3. Aguarde confirmação. Somente após o cliente confirmar que não tem mais nada (respostas como "não", "só isso", "pode mandar", "é isso"):
     - Se PF (já identificado no início) → handoff: "Anotado! Vou passar para a equipe checar disponibilidade e preço em instantes 🤝"
     - Se PJ (já identificado no início) → siga o **Fluxo PJ** abaixo.
     - Se tipo **ainda não identificado** → antes de fazer handoff, pergunte exatamente:
       "Perfeito, anotei a lista.

       Só para eu te encaminhar corretamente: você é pessoa física ou pessoa jurídica?"
       Aguarde a resposta, registre internamente como PF ou PJ e siga o fluxo correspondente.

- Se mandou lista por **foto ou PDF**:
  1. Leia a imagem com atenção. Identifique e separe mentalmente:
     - Itens claramente legíveis com quantidades visíveis
     - Itens com quantidade aparentemente alterada (número escrito por cima, seta, correção manual)
     - Itens que parecem riscados ou marcados como removidos
     - Itens ilegíveis ou ambíguos
  2. **Nunca confirme em texto corrido.** Para listas com múltiplos itens, use blocos estruturados, um item por linha, com quantidade quando visível. Mostre apenas os blocos que existirem. Exemplo de formato:

     Itens identificados:
     2 cadernos espiral
     1 estojo
     …

     Itens com alteração marcada:
     [item] — quantidade alterada para [X]

     Item riscado/removido:
     [item]

     Ficou com dúvida:
     [item ilegível]
  3. Se houver marcações manuais ou riscos, não afirme que já atualizou — peça confirmação pontual:
     > "Vi algumas marcações na foto. Confirma se os ajustes estão certos antes de eu passar para a equipe?"
  4. Peça confirmação apenas dos pontos duvidosos. **Nunca peça para o cliente redigitar itens já legíveis na foto.**
  5. Se a quantidade não estiver visível, liste o item sem quantidade. Não invente nem assuma.
  6. Se a imagem estiver muito ilegível:
     > "A foto ficou difícil de ler. Pode mandar uma foto mais nítida ou me confirmar os itens principais?"
  7. Aguarde confirmação. Somente após confirmar:
     - Se PF (já identificado no início) → handoff
     - Se PJ (já identificado no início) → Fluxo PJ
     - Se tipo **ainda não identificado** → antes de fazer handoff, pergunte exatamente:
       "Perfeito, anotei a lista.

       Só para eu te encaminhar corretamente: você é pessoa física ou pessoa jurídica?"
       Aguarde a resposta, registre internamente como PF ou PJ e siga o fluxo correspondente.

- Se a imagem for foto de produto (não lista):
  > "Vi que você mandou a foto de um [produto]. Você tem alguma dúvida sobre ele? 😊"
  Aguarde resposta. Após resolver, pergunte se precisa de mais algo e encaminhe.

**PJ** — empresa, CNPJ, nota fiscal, volume

Sempre que identificar que é uma empresa, use o **Fluxo PJ**:

**Passo 1 — Verificar cadastro:**
> "Entendido! Sua empresa já tem cadastro conosco?"

**Se já tem cadastro:**
> "Ótimo! Para eu já identificar sua empresa aqui, pode me passar o CNPJ ou o nome da empresa? Assim quando a equipe assumir já vai ter todo o histórico de vocês em mãos 🤝"

Após receber o CNPJ ou nome da empresa:
> "Perfeito, obrigado pela informação. Para eu já adiantar para a equipe: o que você gostaria de cotar ou solicitar?"

Aguarde o cliente descrever a demanda. Aceite qualquer resposta — produto, serviço, quantidade, prazo, entrega. Não insista se o cliente não quiser detalhar.

Se o cliente já informou a demanda antes de passar o CNPJ/nome, não repita a pergunta. Encaminhe diretamente com o contexto já coletado.

Após receber a demanda (ou se o cliente não quiser detalhar):
> "Obrigado! Vou passar você para nossa equipe agora 🤝"
[handoff]

**Se não tem cadastro:**
> "Sem problema! Para empresas cadastradas, temos algumas condições especiais:
>
> • 10% de desconto em compras
> • Opção de faturamento com boleto em até 28 dias
>
> Se quiser, posso coletar os dados para cadastro agora.
> Ou, se preferir, sigo apenas com o seu orçamento.
>
> Você quer fazer o cadastro agora?"

- Se quiser cadastro: colete razão social e CNPJ, pergunte o que deseja cotar/solicitar se ainda não foi informado, informe que a equipe finalizará o cadastro, faça handoff.
- Se não quiser: responda "Claro! Então vamos seguir com o orçamento. O que você gostaria de cotar ou solicitar?" Aguarde a demanda e faça handoff. Se o cliente não quiser detalhar, faça handoff direto.

⚠️ **Nunca pedir no bot:** Inscrição Estadual, referências comerciais, contrato social, dados de DANFE.
⚠️ O agente não valida CNPJ nem confirma se o cadastro existe — isso é função da equipe.

**XEROX / IMPRESSÃO / ENCADERNAÇÃO / PLASTIFICAÇÃO**
- Quando o cliente falar sobre xerox, cópias, impressão, plastificação ou encadernação, use as informações e valores disponíveis abaixo se o cliente perguntar preços.
- Sempre oriente que o setor específico de cópias atende pelo número: https://wa.me/551239341666.
- Não encerre a triagem imediatamente. Pergunte se era somente esse assunto ou se o cliente também precisa de produtos, lista escolar, orçamento, material de papelaria ou outro atendimento.
- Se a pessoa tiver outra demanda além da xerox, continue a triagem normalmente.
- Se o cliente confirmar que era somente xerox/cópia/impressão/plastificação/encadernação, registre no resumo para o atendente (campo resumo da ESTRUTURA INTERNA no final) exatamente: "Cliente buscava serviço de cópia/xerox/impressão. Foi orientado a falar com o setor correto: https://wa.me/551239341666" para que o atendente possa revisar e clicar em Resolver se fizer sentido.
- Tabela de valores (responda apenas o item perguntado pelo cliente):
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
- Se o cliente perguntar se "funcionam hoje" ou sobre funcionamento em dia específico: informe o horário padrão e, se houver dúvida sobre feriado ou exceção, diga: "Nosso horário padrão é segunda a sexta das 8h30 às 18h30 e sábado das 9h às 14h. Em feriados ou datas especiais, nossa equipe confirma o funcionamento."

**Se a intenção não ficou clara**, faça uma pergunta aberta e aguarde o cliente responder naturalmente:
> "Pode me informar melhor o que você precisa para eu direcionar corretamente?"

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
- Dentro de até 5 minutos após o encaminhamento, pode responder dúvidas operacionais simples: horário, endereço, pagamento, entrega, retirada. Responda de forma breve e direta.
- Fora desse período, não responda dúvidas operacionais — encaminhe para a equipe.
- Não retome triagem, pedido de lista, coleta de dados, CNPJ, razão social ou cotação após o handoff.
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
- **Varie as confirmações.** Não repita "Perfeito" ou "Anotado" em sequência na mesma conversa. Use alternativas naturais como: "Certo.", "Recebi.", "Combinado.", "Entendido.", "Obrigado pela confirmação.", "Ok, registrei." Use com naturalidade e sem exagerar — uma confirmação curta por turno é suficiente.
- Para listas longas, prefira formatação estruturada a texto corrido. Um item por linha é mais fácil de conferir.

---

## CONTATO CONHECIDO (orientação interna — nunca mencionar ao cliente)

Se no início da conversa aparecer uma anotação como **[CONTATO CONHECIDO — tipo anterior: PF]** ou **[CONTATO CONHECIDO — tipo anterior: PJ]**, use como pista inicial:

- Tipo **PF**: se a mensagem não trouxer sinais de empresa, CNPJ, cotação formal ou faturamento, **não faça a pergunta inicial de PF/PJ** — pergunte diretamente em que pode ajudar.
- Tipo **PJ**: **não faça a pergunta inicial de PF/PJ** — inicie o Fluxo PJ diretamente.
- Se a mensagem atual trouxer sinais contrários ao histórico (ex: contato era PF mas menciona CNPJ, empresa, cotação formal, nota fiscal ou faturamento), reclassifique conforme os sinais presentes.
- Se houver ambiguidade real, pergunte uma vez de forma leve: "Só para eu te direcionar melhor: esse pedido é para você ou para uma empresa?"

Nunca diga ao cliente que existe um cadastro, histórico ou que você "já o conhece". Nunca mencione o tipo registrado.

---

## MODO ALMOÇO PJ (orientação interna — nunca mencionar diretamente ao cliente)

Se uma anotação interna indicar que o setor de Pessoa Jurídica está em horário de almoço:

- Continue a triagem normalmente para clientes PJ.
- **Somente no momento do handoff PJ**, use a seguinte mensagem exata (não adapte, não resuma):
  > "Perfeito, registrei as informações. Vou passar para nossa equipe responsável por empresas. No momento esse setor está em horário de almoço, mas sua solicitação será respondida assim que o setor retornar."
- Nunca use essa mensagem para PF.
- Nunca diga que a loja está fechada — apenas o setor PJ está em pausa.
- Não interrompa a triagem; mencione o almoço somente no handoff.
- Se o contexto interno não indicar almoço PJ, use a mensagem de handoff padrão.

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

    // Novo dia: apenas atualiza lastDate sem apagar histórico
    if (session.lastDate !== todayDate()) {
      session.lastDate = todayDate();
      console.log(`[Sessão] 📅 Novo dia — atualizando lastDate de +${phone} sem resetar`);
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
  // Lista escolar só quando há contexto escolar explícito
  if (
    text.includes("lista escolar") || text.includes("lista de material") ||
    text.includes("material escolar") || text.includes("kit escolar") ||
    (text.includes("lista") && (
      text.includes("escola") || text.includes("série") || text.includes("serie") ||
      text.includes("aluno") || text.includes("ano escolar") ||
      text.includes("colégio") || text.includes("colegio")
    ))
  ) return "lista";
  // Produto: compras genéricas sem contexto escolar
  if (
    text.includes("quero") || text.includes("comprar") || text.includes("preciso de") ||
    text.includes("itens") || text.includes("tem ") || text.includes("vende") ||
    text.includes("produto")
  ) return "produto";
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
    /\bcnpj\b/,
    /\bnf\b/,
    /\bnfe\b/,
    /\bempresa\s+\w+/,
    /\bgrupo\s+\w+/,
    /\bsetor\s+\w+/,
    /\bdepto\s+\w+/,
    /\bdepartamento\s+\w+/,
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
    "compras",
    "financeiro",
    "fiscal",
    "controladoria",
    "sou da",
    "falo pela",
    // Respostas diretas à pergunta PF/PJ
    "pessoa jurídica",
    "pessoa juridica",
    /\bjurídica\b/,
    /\bjuridica\b/,
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

function addMessage(session, role, content, meta = {}) {
  // Strip multipart content array to plain caption text to avoid storing base64 twice.
  // Binary data lives exclusively in the flat mediaData field; getMessages() rebuilds
  // the multipart structure for Claude on the fly.
  let storedContent = content;
  if (Array.isArray(content) && meta.mediaData) {
    storedContent = meta.mediaCaption !== undefined
      ? meta.mediaCaption
      : (content.find(c => c.type === "text")?.text || "");
  }
  const item = { role, content: storedContent, createdAt: new Date().toISOString() };
  if (meta.metaMessageId)      item.metaMessageId      = meta.metaMessageId;
  if (meta.replyToMsgId)       item.replyToMsgId       = meta.replyToMsgId;
  if (meta.replyToFrom)        item.replyToFrom        = meta.replyToFrom;
  if (meta.mediaType)          item.mediaType          = meta.mediaType;
  if (meta.mediaMimeType)      item.mediaMimeType      = meta.mediaMimeType;
  if (meta.mediaData)          item.mediaData          = meta.mediaData;
  if (meta.mediaFilename)      item.mediaFilename      = meta.mediaFilename;  // BUG2 FIX
  if (meta.transcription)      item.transcription      = meta.transcription;
  if (meta.transcriptionError) item.transcriptionError = meta.transcriptionError;
  if (meta.pjLunchAutoReply)   item.pjLunchAutoReply   = true;
  session.history.push(item);

  if (role === "assistant" && isHandoff(content)) {
    session.handoffDone = true;
    session.postHandoffReplySent = false;
    session.status    = "aguardando_humano";
    if (!session.demandType)  session.demandType  = inferDemandType(session.history);
    if (!session.handoffAt)   session.handoffAt   = new Date().toISOString();

    // Se clientType ainda não definido, varre histórico completo do cliente em busca de sinais PJ
    if (!session.clientType) {
      const allUserText = session.history
        .filter(m => m.role === "user" && typeof m.content === "string")
        .map(m => m.content).join(" ");
      if (detectPJSignals(allUserText)) {
        session.clientType = "pj";
        if (!session.demandType || session.demandType === "produto" || session.demandType === "outro") {
          session.demandType = "cotacao_pj";
        }
        console.log("[Agente] 🏢 clientType=pj inferido do histórico no handoff");
      }
    }

    if (!session.cardTitle)   session.cardTitle   = generateCardTitle(session);
  }

  // BUG1 FIX: session.history never truncated — only update summary for AI context
  if (session.history.length > MAX_MESSAGES) updateHistorySummary(session);
}

function hasMedia(msg) {
  if (Array.isArray(msg.content))
    return msg.content.some((p) => p.type === "image" || p.type === "document");
  return !!(msg.mediaType || msg.mediaData);
}

/**
 * BUG1 FIX: Builds/updates session.historySummary from older messages
 * WITHOUT truncating session.history. The full history is always preserved
 * in Redis so the panel always shows all messages.
 */
function updateHistorySummary(session) {
  const older = session.history.slice(0, -10);

  // Resumo textual das mensagens antigas do cliente — sem tentar serializar base64
  const newParts = older
    .filter((m) => !hasMedia(m) && m.role === "user")
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content))
        return m.content.filter((p) => p.type === "text").map((p) => p.text).join(" ");
      return "";
    })
    .filter(Boolean);

  if (newParts.length > 0) {
    const newText  = newParts.join(" | ").substring(0, 600);
    const prev     = session.historySummary || "";
    const combined = prev ? `${prev} | ${newText}` : newText;
    session.historySummary = combined.substring(0, 1000);
  }
  // session.history is intentionally NOT modified here
}

function getMessages(session) {
  // BUG1 FIX: slice to MAX_MESSAGES here for AI context only — full history stays in Redis
  const allMsgs = session.history.filter((m) => m.role !== "system");
  const contextMsgs = allMsgs.length > MAX_MESSAGES
    ? [
        // Preserve media messages from older part so Claude can still see them
        ...allMsgs.slice(0, -10).filter(hasMedia),
        ...allMsgs.slice(-10),
      ]
    : allMsgs;

  const msgs = contextMsgs.map((m) => {
      if (m.mediaType === "audio") {
        return {
          role: m.role,
          content: m.transcription
            ? `[Áudio transcrito]: ${m.transcription}`
            : "[Cliente enviou um áudio — transcrição indisponível]",
        };
      }
      // Reconstruct multipart content for Claude from flat fields (avoids double base64 in Redis).
      // Handles both new format (content=string + mediaData) and old format (content=array + mediaData).
      if (m.mediaData && (m.mediaType === "image" || m.mediaType === "document")) {
        const mediaKind = m.mediaType === "document" ? "document" : "image";
        let textContent = "";
        if (typeof m.content === "string") {
          textContent = m.content;
        } else if (Array.isArray(m.content)) {
          const tp = m.content.find(c => c.type === "text");
          textContent = tp?.text || "";
        }
        return {
          role: m.role,
          content: [
            {
              type: mediaKind,
              source: {
                type:       "base64",
                media_type: m.mediaMimeType || (mediaKind === "document" ? "application/pdf" : "image/jpeg"),
                data:       m.mediaData,
              },
            },
            { type: "text", text: textContent || "O cliente enviou esta mídia." },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

  if (!session.historySummary) return msgs;

  // Injeta resumo apenas no contexto enviado ao Claude — não entra em session.history
  return [
    { role: "user",      content: `[CONTEXTO ANTERIOR] ${session.historySummary}` },
    { role: "assistant", content: "Entendido, continuando o atendimento." },
    ...msgs,
  ];
}

function shouldRespond(session, text) {
  if (!session.handoffDone) return true;

  // Dúvidas operacionais simples permitidas somente dentro de até 5 min após handoff
  const HANDOFF_SIMPLE_WINDOW_MS = 5 * 60 * 1000;
  const handoffAt = session.handoffAt ? new Date(session.handoffAt).getTime() : null;
  const withinWindow = handoffAt && (Date.now() - handoffAt) < HANDOFF_SIMPLE_WINDOW_MS;

  if (withinWindow) {
    const operationalKeywords = [
      "endereço", "endereco", "onde fica",
      "horário", "horario", "aberto", "que horas", "funcionamento", "funciona hoje",
      "pagamento", "pix", "cartão", "cartao", "dinheiro", "boleto",
      "entrega", "taxa de entrega", "entrega hoje", "entrega no bairro", "retirada",
    ];
    if (operationalKeywords.some((kw) => text.toLowerCase().includes(kw))) return true;
  }

  if (session.postHandoffReplySent) return false;
  return "post_handoff_default";
}

// ============================================================
// RETORNO PÓS-RESOLUÇÃO
// ============================================================

/**
 * "continuation" — resolvido há < 6h no mesmo dia → reabrir sem triagem
 * "new_cycle"    — resolvido há ≥ 6h ou outro dia → novo ciclo de atendimento
 * null           — sessão não está resolvida
 */
function getResolvedReturnMode(session) {
  if (session.status !== "resolvido") return null;
  if (!session.resolvedAt) return "new_cycle";

  const resolvedMs = new Date(session.resolvedAt).getTime();
  const diffMs     = Date.now() - resolvedMs;
  const sameDay    = session.resolvedAt.slice(0, 10) === new Date().toISOString().slice(0, 10);

  if (diffMs < 6 * 60 * 60 * 1000 && sameDay) return "continuation";
  return "new_cycle";
}

/**
 * Reseta campos operacionais para novo ciclo de atendimento.
 * Preserva history (visível para o atendente), clientName, clientType e clientPhone.
 */
function resetToNewCycle(session) {
  // Campos operacionais limpos — history é preservado intencionalmente
  session.previousResolvedAt    = session.resolvedAt || null;
  session.currentCycleStartedAt = new Date().toISOString();
  session.handoffDone           = false;
  session.postHandoffReplySent  = false;
  session.handoffAt             = null;
  session.resolvedAt            = null;
  session.status                = "ativo";
  session.pipelineStatus        = "novo";
  session.cardTitle             = "";
  session.demandType            = "outro";
  session.priorityManual        = null;
  session.dataLimite            = null;
  session.formaEntrega          = null;
  session.endereco              = null;
  session.observacoes           = null;
  session.escola                = null;
  session.serie                 = null;
  session.templateWaitingReply  = false;
  session.lastTemplateType      = null;
  session.audioCount            = 0;
}

// ============================================================
// MODO ALMOÇO PJ
// ============================================================

async function getPjLunchMode() {
  try {
    const raw = await getRedis().get("sartec:settings:pjLunchMode");
    if (!raw) return { enabled: false };
    return JSON.parse(raw);
  } catch {
    return { enabled: false };
  }
}

// ============================================================
// SANITIZAÇÃO — remove bloco interno antes de enviar ao cliente
// ============================================================

/**
 * Remove o bloco de ESTRUTURA INTERNA da resposta do Claude antes de enviá-la
 * ao cliente. O bloco pode aparecer após separador "---" ou como linhas
 * consecutivas com campos tipo/intencao/setor/dados/resumo/status.
 * Não afeta mensagens normais com traços de pontuação ou listas.
 */
function sanitizeAgentReply(text) {
  if (!text) return text;

  // Campo estrutural interno (com ou sem markdown bold: tipo: | **tipo:** | **tipo**)
  const FIELD_RE = /(?:tipo|inten[cç][aã]o|setor|dados|resumo|status)[ \t]*\*{0,2}[ \t]*:/i;

  // Padrão 1: bloco após separador de 3+ traços que contenha campos estruturais
  const sepIdx = text.search(/\n[ \t]*[-─—]{3,}[ \t]*\n/);
  if (sepIdx !== -1 && FIELD_RE.test(text.slice(sepIdx))) {
    console.log("[Agente] 🔒 Bloco interno removido da resposta ao cliente");
    return text.slice(0, sepIdx).trimEnd();
  }

  // Padrão 2: 2+ linhas consecutivas com campos estruturais ao final da resposta
  const tailRe = /(\n[ \t]*\*{0,2}[ \t]*(?:tipo|inten[cç][aã]o|setor|dados|resumo|status)[ \t]*\*{0,2}[ \t]*:[^\n]*){2,}\s*$/i;
  const tailM  = tailRe.exec(text);
  if (tailM) {
    console.log("[Agente] 🔒 Bloco interno removido da resposta ao cliente (inline)");
    return text.slice(0, tailM.index).trimEnd();
  }

  return text;
}

// ============================================================
// DOWNLOAD DE MÍDIA DA META
// ============================================================

async function downloadMedia(mediaId) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    const errBody = await metaRes.text();
    throw new Error(`Meta media lookup ${metaRes.status}: ${errBody.substring(0, 200)}`);
  }
  const { url, mime_type } = await metaRes.json();
  if (!url) throw new Error("Meta media lookup: URL ausente na resposta");

  const fileRes = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!fileRes.ok) throw new Error(`Meta media download ${fileRes.status}`);

  const buffer = await fileRes.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");

  console.log(`[Media] ✅ mimeType=${mime_type} size=${buffer.byteLength}B`);

  return { base64, mimeType: mime_type };
}

// ============================================================
// TRANSCRIÇÃO DE ÁUDIO — OpenAI gpt-4o-mini-transcribe
// ============================================================

async function transcribeAudio(base64, mimeType) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY não configurada");

  const extMap = {
    "audio/ogg":  "ogg",
    "audio/mpeg": "mp3",
    "audio/mp4":  "mp4",
    "audio/aac":  "aac",
    "audio/amr":  "amr",
    "audio/webm": "webm",
  };
  const ext      = extMap[mimeType] || "ogg";
  const filename = `audio.${ext}`;

  const buffer = Buffer.from(base64, "base64");
  const blob   = new Blob([buffer], { type: mimeType || "audio/ogg" });

  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "pt");
  form.append("response_format", "text");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method:  "POST",
    headers: { Authorization: `Bearer ${key}` },
    body:    form,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`OpenAI Transcription ${res.status}: ${detail.substring(0, 200)}`);
  }

  return (await res.text()).trim();
}

// ============================================================
// TEMPLATE DE RETOMADA — tratamento centralizado
// ============================================================

async function handleTemplateResumeReply(session, phone, incomingContent, meta, now) {
  addMessage(session, "user", incomingContent, meta);
  session.templateWaitingReply = false;
  session.templateSentAt       = null;
  session.handoffDone          = true;
  session.status               = "aguardando_humano";
  session.resolvedAt           = null;
  session.postHandoffReplySent = true;
  session.handoffAt            = now.toISOString();
  if (!session.pipelineStatus ||
      ["resolvido", "finalizado", "entregue"].includes(session.pipelineStatus)) {
    session.pipelineStatus = "em_atendimento";
  }
  await saveSession(phone, session);
  console.log(`[template-resume] ✅ resposta recebida — atendimento reaberto +${phone}`);
  return null;
}

// ============================================================
// AGENTE
// ============================================================

async function chatWithAgent(phone, userText, mediaPayload = null, name = "", meta = {}) {
  // Enrich meta with flat media fields so ALL addMessage calls persist mediaType/mediaData.
  // mediaCaption stores the actual caption (userText) for clean storage without fallback text.
  if (mediaPayload) {
    meta = {
      ...meta,
      mediaType:     mediaPayload.mimeType === "application/pdf" ? "document" : "image",
      mediaMimeType: mediaPayload.mimeType,
      mediaData:     mediaPayload.base64,
      mediaCaption:  userText || "",
    };
    // mediaFilename may already be set by the caller (PDF path passes it in msgMeta)
  }

  return withSessionLock(getRedis(), phone, async () => {
  const session  = await loadSession(phone);

  // ── Janela de 24h ─────────────────────────────────────────────────────────
  // Toda mensagem vinda do cliente reinicia o contador.
  // Mensagens do bot/atendente NÃO chamam chatWithAgent, logo não reiniciam.
  const _now = new Date();
  session.lastUserMessageAt = _now.toISOString();
  session.windowExpiresAt   = new Date(_now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  // ── Template de retomada — prioridade máxima, ANTES de qualquer lógica de ciclo ──
  if (session.templateWaitingReply && session.lastTemplateType === "attendance_resume") {
    const _resumeContent = mediaPayload
      ? [
          { type: mediaPayload.mimeType === "application/pdf" ? "document" : "image",
            source: { type: "base64", media_type: mediaPayload.mimeType, data: mediaPayload.base64 } },
          { type: "text", text: userText || "O cliente enviou esta mídia." },
        ]
      : (userText || "");
    return handleTemplateResumeReply(session, phone, _resumeContent, meta, _now);
  }

  // ── Retorno pós-resolução ──────────────────────────────────────────────────
  const _resolvedMode = getResolvedReturnMode(session);
  if (_resolvedMode === "continuation") {
    const _contContent = mediaPayload
      ? [
          { type: mediaPayload.mimeType === "application/pdf" ? "document" : "image",
            source: { type: "base64", media_type: mediaPayload.mimeType, data: mediaPayload.base64 } },
          { type: "text", text: userText || "O cliente enviou este arquivo." },
        ]
      : userText;
    addMessage(session, "user", _contContent, meta);
    session.status               = "aguardando_humano";
    session.pipelineStatus       = "novo";
    session.resolvedAt           = null;
    session.handoffDone          = true;
    session.postHandoffReplySent = true;
    if (!session.handoffAt) session.handoffAt = _now.toISOString();
    await saveSession(phone, session);
    console.log(`[Agente] 🔄 Continuação pós-resolução — reaberto sem bot +${phone}`);
    return null;
  }
  if (_resolvedMode === "new_cycle") {
    console.log(`[Agente] 🆕 Novo ciclo pós-resolução — triagem reiniciada +${phone}`);
    resetToNewCycle(session);
    session.lastUserMessageAt = _now.toISOString();
    session.windowExpiresAt   = new Date(_now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }
  // ──────────────────────────────────────────────────────────────────────────

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

    addMessage(session, "user", userContent, meta);
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
    // For media messages use clean caption (possibly ""); for text use fallback "[mensagem]"
    const _phContent = meta.mediaData ? textToCheck : (textToCheck || "[mensagem]");
    addMessage(session, "user",      _phContent, meta);
    addMessage(session, "assistant", reply);
    session.postHandoffReplySent = true;
    await saveSession(phone, session);
    return reply;
  }

  if (decision === false) {
    const _silContent = meta.mediaData ? textToCheck : (textToCheck || "[mensagem]");
    addMessage(session, "user", _silContent, meta);

    // PJ Almoço — auto-resposta única para PJ já triado em silêncio pós-handoff
    if (session.clientType === "pj" && session.status !== "resolvido") {
      try {
        const _lunchSt = await getPjLunchMode();
        if (_lunchSt.enabled && session.pjLunchAutoReplySentFor !== _lunchSt.updatedAt) {
          const _lunchMsg = "Olá! Estou em horário de almoço agora, assim que retornar atendo a sua solicitação.";
          addMessage(session, "assistant", _lunchMsg, { pjLunchAutoReply: true });
          session.pjLunchAutoReplySentFor = _lunchSt.updatedAt;
          session.pjLunchAutoReplySentAt  = new Date().toISOString();
          await saveSession(phone, session);
          await sendTextMessage(phone, _lunchMsg);
          return _lunchMsg;
        }
      } catch { /* falha silenciosa */ }
    }

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

  // ── Detecta saudação fragmentada quando agente já perguntou PF/PJ ──────────
  // Evita repetir a pergunta inteira quando cliente manda "Boa noite" após "Olá"
  if (!session.clientType && !session.handoffDone && !mediaPayload) {
    const _fragGreetRE = /^(oi+|ol[aá]|hey|hi|bom\s+dia|boa\s+tarde|boa\s+noite|boas|tudo\s+bem|td\s+bem|e\s+a[íi]|eae|opa|hello)[\s!.,?]*$/i;
    if (_fragGreetRE.test(textToCheck.trim())) {
      const lastAsst = session.history.slice().reverse()
        .find(m => m.role === "assistant" && typeof m.content === "string");
      if (lastAsst?.content?.toLowerCase().includes("pessoa física ou pessoa jurídica")) {
        const lc = textToCheck.toLowerCase();
        const ack = lc.includes("noite") ? "Boa noite! 😊" :
                    lc.includes("tarde") ? "Boa tarde! 😊" :
                    lc.includes("dia")   ? "Bom dia! 😊" : "Olá! 😊";
        const shortReply = `${ack} Só para confirmar: você é pessoa física ou pessoa jurídica?`;
        addMessage(session, "user", userContent, meta);
        addMessage(session, "assistant", shortReply);
        await saveSession(phone, session);
        console.log(`[Agente] 👋 Saudação fragmentada — PF/PJ já perguntado +${phone}`);
        return shortReply;
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  addMessage(session, "user", userContent, meta);
  // Persist user message immediately so it survives even if the AI call fails below.
  await saveSession(phone, session);

  // ── Contexto de contato conhecido + Modo Almoço PJ ───────────────────────
  let _contactNote = null;
  try {
    const _rawContact = await getRedis().get(`sartec:contact:${phone}`);
    const _contact = _rawContact ? JSON.parse(_rawContact) : null;
    if (_contact?.clientType && !session.clientType) {
      session.clientType = _contact.clientType;
      console.log(`[Agente] 👤 clientType herdado do contato: ${_contact.clientType} +${phone}`);
    }
    const _noteParts = [];
    if (_contact?.clientType) _noteParts.push(`tipo anterior: ${_contact.clientType.toUpperCase()}`);
    if (_resolvedMode === "new_cycle") _noteParts.push(
      "este contato possui histórico anterior, mas a mensagem mais recente inicia uma nova demanda" +
      " — use o histórico apenas como contexto leve e priorize a solicitação atual"
    );
    if (_noteParts.length > 0) {
      _contactNote = `[CONTATO CONHECIDO — ${_noteParts.join("; ")}]`;
    }
  } catch (_ce) { /* falha silenciosa — não bloqueia o atendimento */ }

  let _lunchNote = null;
  try {
    const _lunchState = await getPjLunchMode();
    if (_lunchState.enabled) {
      _lunchNote = `[CONTEXTO INTERNO: o setor de Pessoa Jurídica está em horário de almoço. ` +
        `Se este atendimento for PJ e você for encaminhar para a equipe, use exatamente: ` +
        `"Perfeito, registrei as informações. Vou passar para nossa equipe responsável por empresas. ` +
        `No momento esse setor está em horário de almoço, mas sua solicitação será respondida assim que o setor retornar." ` +
        `Não mencione isso para PF.]`;
    }
  } catch { /* falha silenciosa */ }

  const _baseMsgs = getMessages(session);
  const _prefixPairs = [];
  if (_contactNote) _prefixPairs.push({ role: "user", content: _contactNote }, { role: "assistant", content: "Entendido." });
  if (_lunchNote)   _prefixPairs.push({ role: "user", content: _lunchNote   }, { role: "assistant", content: "Entendido." });
  const _finalMsgs = _prefixPairs.length > 0 ? [..._prefixPairs, ..._baseMsgs] : _baseMsgs;
  // ──────────────────────────────────────────────────────────────────────────

  console.log(`[Agente] 🤖 +${phone} | ${_baseMsgs.length} msgs`);

  const aiResponse = await anthropic.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system:     SYSTEM_PROMPT,
    messages:   _finalMsgs,
  });

  const reply = sanitizeAgentReply(
    aiResponse.content[0]?.type === "text" ? aiResponse.content[0].text : ""
  );

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
  const { reset, phone, hard, all, dryRun } = req.query;

  // ── Autenticação obrigatória ──────────────────────────────────────────────
  if (reset !== process.env.WHATSAPP_VERIFY_TOKEN) {
    console.warn("[Reset] ❌ Token inválido");
    return res.status(403).json({ error: "Forbidden" });
  }

  const redis     = getRedis();
  const isDryRun  = dryRun === "1" || dryRun === "true";

  // ── Opção 1: reset por número ─────────────────────────────────────────────
  if (phone && !all) {
    try {
      const sessionKey = `sartec:${phone}`;
      const contactKey = `sartec:contact:${phone}`;

      // Buscar archives do número
      const archiveKeys = [];
      let cursor = "0";
      do {
        const [nextCursor, found] = await redis.scan(
          cursor, "MATCH", `sartec:archive:${phone}:*`, "COUNT", 100
        );
        cursor = nextCursor;
        archiveKeys.push(...found);
      } while (cursor !== "0");

      const keysToDelete = [sessionKey, ...archiveKeys];
      if (hard === "1") keysToDelete.push(contactKey);

      if (isDryRun) {
        return res.status(200).json({ dryRun: true, phone, hard: hard === "1", keysToDelete, count: keysToDelete.length });
      }

      const deleted = [];
      for (const key of keysToDelete) {
        const n = await redis.del(key);
        if (n > 0) deleted.push(key);
      }
      console.log(`[Reset] ✅ +${phone}: ${deleted.length} chave(s) removida(s)`);
      return res.status(200).json({ ok: true, phone, deleted, count: deleted.length });

    } catch (err) {
      console.error("[Reset/phone] ❌", err.message);
      return res.status(500).json({ error: "Erro ao resetar número", detail: err.message });
    }
  }

  // ── Opção 2: reset geral de todos os dados sartec:* ───────────────────────
  if (all === "1") {
    try {
      const allKeys = [];
      let cursor = "0";
      do {
        const [nextCursor, found] = await redis.scan(cursor, "MATCH", "sartec:*", "COUNT", 200);
        cursor = nextCursor;
        allKeys.push(...found);
      } while (cursor !== "0");

      const sessions = allKeys.filter(k => !k.includes(":archive:") && !k.includes(":contact:"));
      const archives = allKeys.filter(k => k.includes(":archive:"));
      const contacts = allKeys.filter(k => k.includes(":contact:"));

      if (isDryRun) {
        console.log(`[Reset] 🔍 Dry-run all: ${allKeys.length} chave(s)`);
        return res.status(200).json({
          dryRun: true, total: allKeys.length,
          sessions: { count: sessions.length, sample: sessions.slice(0, 30) },
          archives: { count: archives.length, sample: archives.slice(0, 10) },
          contacts: { count: contacts.length, sample: contacts.slice(0, 10) },
          ...(sessions.length > 30 && { note: `... e mais ${sessions.length - 30} sessões omitidas` }),
        });
      }

      if (allKeys.length === 0) {
        return res.status(200).json({ ok: true, deleted: 0, message: "Nada a apagar — Redis já está vazio no namespace sartec:" });
      }

      const pipeline = redis.pipeline();
      for (const key of allKeys) pipeline.del(key);
      await pipeline.exec();

      console.log(`[Reset] ✅ Geral: ${allKeys.length} chave(s) | sessões=${sessions.length} archives=${archives.length} contatos=${contacts.length}`);
      return res.status(200).json({ ok: true, deleted: allKeys.length, breakdown: { sessions: sessions.length, archives: archives.length, contacts: contacts.length } });

    } catch (err) {
      console.error("[Reset/all] ❌", err.message);
      return res.status(500).json({ error: "Erro ao executar reset geral", detail: err.message });
    }
  }

  // ── Parâmetros inválidos — mostrar uso ─────────────────────────────────────
  return res.status(400).json({
    error: "Parâmetros inválidos",
    usage: {
      "reset simples":   "GET /api/webhook?reset=TOKEN&phone=+55NUMERO",
      "reset hard":      "GET /api/webhook?reset=TOKEN&phone=+55NUMERO&hard=1",
      "dry-run número":  "GET /api/webhook?reset=TOKEN&phone=+55NUMERO&hard=1&dryRun=1",
      "dry-run geral":   "GET /api/webhook?reset=TOKEN&all=1&dryRun=1",
      "reset geral":     "GET /api/webhook?reset=TOKEN&all=1  (CUIDADO)",
    },
  });
}

// ============================================================
// STATUS DE ENTREGA — callbacks da Meta (sent/delivered/read/failed)
// ============================================================

// Ranking: nunca rebaixa status mais avançado (ex: read → delivered)
const _STATUS_RANK = { sent: 1, delivered: 2, read: 3 };

// Aplica o status de entrega a um objeto de mensagem, respeitando o ranking
function applyStatusToMessage(msg, status, statusAt, errors) {
  const currentRank = _STATUS_RANK[msg.deliveryStatus] || 0;
  const newRank     = _STATUS_RANK[status]             || 0;

  // Nunca rebaixa (read → delivered); failed sempre registra
  if (status !== "failed" && newRank <= currentRank) return false;

  msg.deliveryStatus   = status;
  msg.deliveryStatusAt = statusAt;
  if (status === "failed") {
    msg.deliveryError = (errors?.length && errors[0]?.title) || "Falha na entrega";
  } else {
    msg.deliveryError = null;
  }
  return true;
}

// Extrai campos relevantes do array errors da Meta de forma segura.
// Retorna objeto estruturado ou null — nunca loga token/payload.
function normalizeMetaStatusError(errors) {
  if (!errors?.length) return null;
  const e       = errors[0];
  const code    = e?.code                  ?? null;
  const title   = e?.title                 ?? null;
  const message = e?.message               ?? null;
  const details = e?.error_data?.details   ?? null;
  if (!code && !title && !message && !details) return null;
  return { code, title, message, details };
}

// Log seguro para falha de template: code, title e details (truncado). Sem token/headers.
function logTemplateFailure(phone, msgId, normErr, suffix) {
  const tag   = suffix ? `[webhook/status] template failed (${suffix})` : "[webhook/status] template failed";
  const parts = [`${tag} +${phone} msgId=${msgId}`];
  if (normErr?.code)    parts.push(`code=${normErr.code}`);
  if (normErr?.title)   parts.push(`title=${normErr.title}`);
  if (normErr?.details) {
    const d = String(normErr.details).trim();
    parts.push(`details=${d.length > 180 ? d.slice(0, 180) + "…" : d}`);
  }
  if (!normErr) parts.push("(sem detalhe de erro)");
  console.log(parts.join(" | "));
}

// Aplica status de template na sessão usando apenas o msgId (sem entrada no histórico).
// Usado quando idx === -1 mas sabemos que é um template pelo lastTemplateMessageId.
function applyTemplateSessionStatusByMsgId(session, msgId, status, statusAt, errors) {
  if (session.lastTemplateMessageId !== msgId) return false;
  const normErr = normalizeMetaStatusError(errors);
  session.lastTemplateDeliveryStatus = status;
  session.lastTemplateStatusAt       = statusAt;
  session.lastTemplateError          = status === "failed" ? normErr : null;
  if (status === "failed") {
    session.templateWaitingReply = false;
    session.templateSentAt       = null;
  }
  return true;
}

// Aplica status de entrega ao nível de sessão para mensagens de template.
// Chamado após applyStatusToMessage confirmar que o status foi atualizado no histórico.
function applyTemplateSessionStatus(session, msg, status, statusAt, errors) {
  // Só aplica se a mensagem for um template
  if (!msg.messageType && !msg.sentByTemplate) return;

  const normErr = normalizeMetaStatusError(errors);
  session.lastTemplateDeliveryStatus = status;
  session.lastTemplateStatusAt       = statusAt;
  session.lastTemplateError          = status === "failed" ? normErr : null;

  if (status === "failed") {
    // Libera a UI — computeWindowInfo vai retornar "closed" em vez de "waiting_template_reply"
    session.templateWaitingReply = false;
    session.templateSentAt       = null;
  }
}

function getFriendlyTemplateErrorText(err) {
  if (!err) return null;
  let raw = null;
  if (typeof err === "string") {
    raw = err;
  } else if (err && typeof err === "object") {
    // Prioridade: details > message > title (do mais específico ao mais genérico)
    raw = err.details || err.message || err.title || null;
  }
  if (!raw) return null;
  const lower = String(raw).toLowerCase();
  // Mapeamento amigável para erros comuns da Meta
  if (lower.includes("recipient") && lower.includes("not registered")) {
    return "este número não parece estar registrado no WhatsApp.";
  }
  if (lower.includes("does not exist") || (lower.includes("invalid") && lower.includes("wa"))) {
    return "número inválido ou indisponível para WhatsApp.";
  }
  if (lower.includes("template") && (lower.includes("not found") || lower.includes("blocked"))) {
    return "template não encontrado ou bloqueado na Meta.";
  }
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return "limite de envios da Meta atingido. Aguarde alguns minutos.";
  }
  const s = String(raw);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

function injectFailedTemplateEvent(session, msgId, statusAt, errors) {
  if (!session.history) session.history = [];
  const history = session.history;

  // Encontra a mensagem de template correspondente no histórico (para herdar os dados)
  const templateMsg = history.find(m => m.metaMessageId === msgId);

  // Verifica se de fato é um evento de template (evita injetar para mensagens normais que falharem)
  const isTemplate = (templateMsg && (templateMsg.messageType === "template" || templateMsg.sentByTemplate)) ||
                     (session.lastTemplateMessageId === msgId);

  if (!isTemplate) return false;

  // 1. Evitar duplicidade
  const alreadyExists = history.some(m =>
    m.messageType === "template_status" &&
    m.templateStatus === "failed" &&
    m.relatedMessageId === msgId
  );
  if (alreadyExists) return false;

  // 2. Obter erro amigável
  const normErr = normalizeMetaStatusError(errors);
  const friendlyErr = getFriendlyTemplateErrorText(normErr);

  // 3. Montar a mensagem do evento
  const content = "Falha na entrega do template. Motivo: " + (friendlyErr || "erro desconhecido");

  // 4. Montar o item de status
  const eventItem = {
    role: "system",
    content: content,
    messageType: "template_status",
    templateStatus: "failed",
    templateType: (templateMsg && templateMsg.templateType) || session.lastTemplateType || null,
    templateName: (templateMsg && templateMsg.templateName) || session.lastTemplateName || null,
    relatedMessageId: msgId,
    deliveryError: friendlyErr || (normErr ? (normErr.details || normErr.message || normErr.title) : null) || "Falha na entrega",
    createdAt: statusAt || new Date().toISOString()
  };

  history.push(eventItem);
  return true;
}

async function handleDeliveryStatus(s) {
  const { id: msgId, status, recipient_id, timestamp, errors } = s;
  if (!msgId || !status) return;

  const phone = recipient_id;
  if (!phone) return;

  try {
    const redis = getRedis();
    const sessionKey = `sartec:${phone}`;
    const raw   = await redis.get(sessionKey);
    if (!raw) { console.log(`[Status] ⚠️ Sessão não encontrada para +${phone}`); return; }

    const session = JSON.parse(raw);
    const history = session.history || [];
    const idx     = history.findIndex(m => m.metaMessageId === msgId);

    const statusAt = timestamp
      ? new Date(parseInt(timestamp, 10) * 1000).toISOString()
      : new Date().toISOString();

    if (idx === -1) {
      // Salva temporariamente em pendentes para resolver race condition (send.js aplicará ao salvar)
      const pendingKey = `sartec:pending_status:${msgId}`;
      const deliveryError = (status === "failed" && errors?.length)
        ? (errors[0]?.title || "Falha na entrega")
        : undefined;

      // Se já houver status pendente anterior, aplica lógica de ranking para não rebaixar
      const existingRaw = await redis.get(pendingKey);
      if (existingRaw) {
        try {
          const existing = JSON.parse(existingRaw);
          const currentRank = _STATUS_RANK[existing.status] || 0;
          const newRank     = _STATUS_RANK[status]          || 0;
          
          if (status !== "failed" && newRank <= currentRank) {
            // Mantém o melhor status já existente
            return;
          }
        } catch (e) {
          console.warn(`[Status] ⚠️ Erro ao decodificar status pendente existente: ${e.message}`);
        }
      }

      const pendingPayload = {
        status,
        deliveryStatusAt: statusAt,
        deliveryError,
      };

      await redis.set(pendingKey, JSON.stringify(pendingPayload), "EX", 300);
      console.log(`[Status] ⏳ Pendente salvo — ${status} → ${msgId} (+${phone})`);

      // Recheck imediato: relê a sessão para verificar se o send.js gravou a mensagem nesse intervalo
      const latestRaw = await redis.get(sessionKey);
      if (latestRaw) {
        try {
          const latestSession = JSON.parse(latestRaw);
          const latestHistory = latestSession.history || [];
          const recheckIdx = latestHistory.findIndex(m => m.metaMessageId === msgId);

          if (recheckIdx !== -1) {
            const reMsg   = latestHistory[recheckIdx];
            const applied = applyStatusToMessage(reMsg, status, statusAt, errors);
            if (applied) {
              applyTemplateSessionStatus(latestSession, reMsg, status, statusAt, errors);
              if (status === "failed") {
                injectFailedTemplateEvent(latestSession, msgId, statusAt, errors);
              }
              latestSession.history = latestHistory;
              await redis.set(sessionKey, JSON.stringify(latestSession), "EX", SESSION_TTL);
              const isReMsg = reMsg.messageType === "template" || reMsg.sentByTemplate;
              if (status === "failed") {
                logTemplateFailure(phone, msgId, normalizeMetaStatusError(errors), "recheck");
              } else if (isReMsg) {
                console.log(`[webhook/status] template ${status} (recheck) +${phone} msgId=${msgId}`);
              } else {
                console.log(`[Status] ✅ Pendente aplicado após recheck — ${status} → ${msgId} (+${phone})`);
              }
            } else {
              console.log(`[Status] ⏳ Pendente ignorado no recheck por ranking inferior — ${status} → ${msgId} (+${phone})`);
            }
            await redis.del(pendingKey);
            return;
          }
        } catch (err) {
          console.warn(`[Status] ⚠️ Erro ao processar recheck para ${msgId}: ${err.message}`);
        }
      }

      if (status === "failed") {
        // Para failed, limpa o estado de espera do template na sessão mesmo sem
        // encontrar a mensagem no histórico — o pendente continuará e será aplicado
        // ao histórico quando send.js persistir a entrada.
        const normErr = normalizeMetaStatusError(errors);
        try {
          const freshRaw = await redis.get(sessionKey);
          if (freshRaw) {
            const freshSession = JSON.parse(freshRaw);
            const appliedByMsgId = applyTemplateSessionStatusByMsgId(
              freshSession, msgId, status, statusAt, errors
            );
            if (appliedByMsgId) {
              injectFailedTemplateEvent(freshSession, msgId, statusAt, errors);
              await redis.set(sessionKey, JSON.stringify(freshSession), "EX", SESSION_TTL);
            }
          }
        } catch (err) {
          console.warn(`[Status] ⚠️ Erro ao limpar sessão de template failed sem histórico: ${err.message}`);
        }
        logTemplateFailure(phone, msgId, normErr, "pendente-sem-historico");
      } else {
        console.log(`[Status] ⏳ Pendente mantido — ${status} → ${msgId} (+${phone})`);
      }
      return;
    }

    const msg = history[idx];
    const applied = applyStatusToMessage(msg, status, statusAt, errors);
    if (!applied) return;

    applyTemplateSessionStatus(session, msg, status, statusAt, errors);

    if (status === "failed") {
      injectFailedTemplateEvent(session, msgId, statusAt, errors);
    }

    session.history = history;
    await redis.set(sessionKey, JSON.stringify(session), "EX", SESSION_TTL);

    const isTemplate = msg.messageType === "template" || msg.sentByTemplate;
    if (isTemplate) {
      if (status === "failed") {
        logTemplateFailure(phone, msgId, normalizeMetaStatusError(errors));
      } else {
        console.log(`[webhook/status] template ${status} +${phone} msgId=${msgId}`);
      }
    } else {
      console.log(`[Status] ✅ ${status} → ${msgId} (+${phone})`);
    }
  } catch (err) {
    console.error("[Status] ❌ Erro ao salvar status:", err.message);
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
          await handleDeliveryStatus(s);
        }

        if (!value?.messages?.length) continue;

        for (const message of value.messages) {
          const from = message.from;
          const type = message.type;
          const name = value.contacts?.find((c) => c.wa_id === from)?.profile?.name ?? "—";
          const msgMeta = {
            metaMessageId: message.id            || null,
            replyToMsgId:  message.context?.id   || null,
            replyToFrom:   message.context?.from  || null,
          };

          console.log(`[Msg] +${from} (${name}) tipo: ${type}`);

          await upsertContact(getRedis(), from, { whatsappName: name !== "—" ? name : null });

          // ── ÁUDIO — baixa, transcreve, salva e responde ──────
          if (type === "audio") {
            // Fase 0: leitura rápida sem lock — decide se transcrição é necessária
            let _needsTranscription = true;
            try {
              const _snapRaw = await getRedis().get(`sartec:${from}`);
              if (_snapRaw) {
                const _snap = JSON.parse(_snapRaw);
                if (_snap.handoffDone || _snap.status === "aguardando_humano") {
                  _needsTranscription = false;
                  console.log(`[Audio] ⏭ Pós-handoff — transcrição pulada +${from}`);
                }
              }
            } catch { /* falha silenciosa — transcreve por segurança */ }

            // Fase 1a: download (sempre necessário para o player)
            let _audioTranscription  = null;
            let _audioMimeType       = null;
            let _audioBase64         = null;
            let _transcriptionFailed = false;
            let _transcriptionSkipped = !_needsTranscription;
            try {
              const _audioMedia = await downloadMedia(message.audio.id);
              _audioMimeType    = _audioMedia.mimeType;
              _audioBase64      = _audioMedia.base64;
            } catch (_dlErr) {
              console.error("[Audio] ❌ Download falhou:", _dlErr.message);
              _transcriptionFailed = true; // download falhou → agente pede texto como antes
            }

            // Fase 1b: transcrição (só pré-handoff e se download foi bem-sucedido)
            if (_needsTranscription && _audioBase64) {
              try {
                _audioTranscription = await transcribeAudio(_audioBase64, _audioMimeType);
                console.log(`[Audio] ✅ Transcrição +${from}: "${_audioTranscription.substring(0, 80)}"`);
              } catch (_txErr) {
                console.error("[Audio] ❌ Transcrição falhou:", _txErr.message);
                _transcriptionFailed = true;
              }
            }

            // Fase 2: atualiza sessão e responde (dentro do lock)
            const _audioMeta = {
              ...msgMeta,
              mediaType:    "audio",
              mediaMimeType: _audioMimeType || undefined,
              ...(_audioBase64               && { mediaData:          _audioBase64 }),
              ...((_audioTranscription)      && { transcription:      _audioTranscription }),
              ...(_transcriptionFailed       && { transcriptionError: true }),
            };

            const audioReply = await withSessionLock(getRedis(), from, async () => {
              const session = await loadSession(from);

              // Reinicia janela de 24h
              const _audioNow = new Date();
              session.lastUserMessageAt = _audioNow.toISOString();
              session.windowExpiresAt   = new Date(_audioNow.getTime() + 24 * 60 * 60 * 1000).toISOString();

              // ── Template de retomada (áudio) — prioridade máxima, ANTES de qualquer lógica de ciclo ──
              if (session.templateWaitingReply && session.lastTemplateType === "attendance_resume") {
                return handleTemplateResumeReply(session, from, "[áudio]", _audioMeta, _audioNow);
              }

              // ── Retorno pós-resolução (áudio) ──────────────────────────────────────
              const _audioResolved = getResolvedReturnMode(session);
              if (_audioResolved === "continuation") {
                addMessage(session, "user", "[áudio]", _audioMeta);
                session.status               = "aguardando_humano";
                session.pipelineStatus       = "novo";
                session.resolvedAt           = null;
                session.handoffDone          = true;
                session.postHandoffReplySent = true;
                if (!session.handoffAt) session.handoffAt = _audioNow.toISOString();
                await saveSession(from, session);
                console.log(`[Audio] 🔄 Continuação pós-resolução — reaberto sem bot +${from}`);
                return null;
              }
              if (_audioResolved === "new_cycle") {
                console.log(`[Audio] 🆕 Novo ciclo pós-resolução +${from}`);
                resetToNewCycle(session);
                session.lastUserMessageAt = _audioNow.toISOString();
                session.windowExpiresAt   = new Date(_audioNow.getTime() + 24 * 60 * 60 * 1000).toISOString();
              }
              // ──────────────────────────────────────────────────────────────────────

              // Template de retomada → humano assume
              if (session.templateWaitingReply) {
                const isResume = session.lastTemplateType === "attendance_resume";
                session.templateWaitingReply = false;
                console.log(`[Audio] 🔓 Template respondido (áudio) — janela reaberta: +${from}`);
                if (isResume) {
                  console.log(`[Audio] 🔄 Retomada via áudio — silenciando bot para +${from}`);
                  session.handoffDone          = true;
                  session.status               = "aguardando_humano";
                  session.postHandoffReplySent = true;
                  session.handoffAt            = new Date().toISOString();
                  if (!session.pipelineStatus || session.pipelineStatus === "finalizado" || session.pipelineStatus === "entregue") {
                    session.pipelineStatus = "em_atendimento";
                  }
                  addMessage(session, "user", "[áudio]", _audioMeta);
                  await saveSession(from, session);
                  return null;
                }
              }

              // Pós-handoff: registra transcrição e fica em silêncio
              if (session.handoffDone) {
                addMessage(session, "user", "[áudio]", _audioMeta);

                // PJ Almoço — auto-resposta única para PJ já triado
                if (session.clientType === "pj" && session.status !== "resolvido") {
                  try {
                    const _audioLunch = await getPjLunchMode();
                    if (_audioLunch.enabled && session.pjLunchAutoReplySentFor !== _audioLunch.updatedAt) {
                      const _lunchMsg = "Olá! Estou em horário de almoço agora, assim que retornar atendo a sua solicitação.";
                      addMessage(session, "assistant", _lunchMsg, { pjLunchAutoReply: true });
                      session.pjLunchAutoReplySentFor = _audioLunch.updatedAt;
                      session.pjLunchAutoReplySentAt  = new Date().toISOString();
                      await saveSession(from, session);
                      await sendTextMessage(from, _lunchMsg);
                      return _lunchMsg;
                    }
                  } catch { /* falha silenciosa */ }
                }

                await saveSession(from, session);
                return null;
              }

              if (name) session.clientName = name;
              session.clientPhone = from;

              // Detecta sinais PJ na transcrição
              if (!session.clientType && _audioTranscription && detectPJSignals(_audioTranscription)) {
                session.clientType = "pj";
                session.demandType = "cotacao_pj";
                console.log(`[Audio] 🏢 PJ detectado na transcrição +${from}`);
              }

              // Fallback quando transcrição falhou (não aplica quando foi intencionalmente pulada)
              if (!_transcriptionSkipped && (_transcriptionFailed || !_audioTranscription)) {
                session.audioCount = (session.audioCount || 0) + 1;
                let reply;
                if (session.audioCount === 1) {
                  reply = "Tive dificuldade pra entender seu áudio 🙏 Consegue mandar por escrito?";
                } else {
                  reply = "Não consigo ouvir áudios por aqui 🙏 Vou te passar para nossa equipe que vai te atender diretamente 🤝";
                  session.handoffDone = true;
                  session.postHandoffReplySent = false;
                  session.status    = "aguardando_humano";
                  session.demandType = session.demandType || "outro";
                  session.handoffAt  = session.handoffAt  || new Date().toISOString();
                  if (!session.cardTitle) session.cardTitle = generateCardTitle(session);
                }
                addMessage(session, "user", "[áudio]", _audioMeta);
                addMessage(session, "assistant", reply);
                await saveSession(from, session);
                return reply;
              }

              // Transcrição OK → zera contador de falhas consecutivas e decide se responde
              session.audioCount = 0;
              const decision = shouldRespond(session, _audioTranscription);

              if (decision === "post_handoff_default") {
                const reply = "Nossa equipe já está ciente e vai te atender em breve 🤝";
                addMessage(session, "user", "[áudio]", _audioMeta);
                addMessage(session, "assistant", reply);
                session.postHandoffReplySent = true;
                await saveSession(from, session);
                return reply;
              }

              if (decision === false) {
                addMessage(session, "user", "[áudio]", _audioMeta);
                await saveSession(from, session);
                return null;
              }

              // Salva mensagem com transcrição e chama Claude com texto puro
              addMessage(session, "user", "[áudio]", _audioMeta);

              console.log(`[Audio] 🤖 +${from} | ${getMessages(session).length} msgs`);
              const _aiRes = await anthropic.messages.create({
                model:      "claude-haiku-4-5-20251001",
                max_tokens: 500,
                system:     SYSTEM_PROMPT,
                messages:   getMessages(session),
              });
              const reply = sanitizeAgentReply(
                _aiRes.content[0]?.type === "text" ? _aiRes.content[0].text : ""
              );

              addMessage(session, "assistant", reply);
              await saveSession(from, session);
              console.log(`[Audio] ✅ "${reply.substring(0, 80)}..." | ${_aiRes.usage?.input_tokens}in/${_aiRes.usage?.output_tokens}out`);
              return reply;
            });

            if (audioReply) await sendTextMessage(from, audioReply);
            continue;
          }

          // ── IMAGEM — baixa, persiste e envia para Claude ─────
          if (type === "image") {
            try {
              const media   = await downloadMedia(message.image.id);
              const caption = message.image.caption || "";
              console.log(`[webhook/media] image received id=${message.image.id} mime=${media.mimeType} base64Length=${media.base64?.length || 0}`);
              const reply   = await chatWithAgent(from, caption, media, name, msgMeta);
              console.log(`[webhook/media] image saved phone=${from} hasMediaData=true`);
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
              // BUG2 FIX: pass filename in meta so it gets persisted in history
              const pdfMeta = {
                ...msgMeta,
                mediaFilename: message.document?.filename || "documento.pdf",
              };
              const reply = await chatWithAgent(from, "O cliente enviou um PDF.", media, name, pdfMeta);
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

                // ── Template de retomada (doc) — prioridade máxima, ANTES de qualquer lógica de ciclo ──
                if (_docSession.templateWaitingReply && _docSession.lastTemplateType === "attendance_resume") {
                  await handleTemplateResumeReply(_docSession, from, "[documento]", msgMeta, _docNow);
                  throw new Error("STOP_FLOW");
                }

                // ── Retorno pós-resolução (documento não-PDF) ──────────────────────────
                const _docResolved = getResolvedReturnMode(_docSession);
                if (_docResolved === "continuation") {
                  _docSession.status               = "aguardando_humano";
                  _docSession.pipelineStatus       = "novo";
                  _docSession.resolvedAt           = null;
                  _docSession.handoffDone          = true;
                  _docSession.postHandoffReplySent = true;
                  if (!_docSession.handoffAt) _docSession.handoffAt = _docNow.toISOString();
                  _docSession._stopFlow = true;
                  console.log(`[Doc] 🔄 Continuação pós-resolução — reaberto sem bot +${from}`);
                } else if (_docResolved === "new_cycle") {
                  console.log(`[Doc] 🆕 Novo ciclo pós-resolução +${from}`);
                  resetToNewCycle(_docSession);
                  _docSession.lastUserMessageAt = _docNow.toISOString();
                  _docSession.windowExpiresAt   = new Date(_docNow.getTime() + 24 * 60 * 60 * 1000).toISOString();
                }
                // ──────────────────────────────────────────────────────────────────────

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
              reply = await chatWithAgent(from, text, null, name, msgMeta);
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
