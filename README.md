# Sartec — Agente, CRM e Site

Este repositório reúne o ecossistema digital da Sartec Papelaria: agente de triagem via WhatsApp, CRM interno de atendimento e site público da loja.

O projeto ainda está em fase de MVP e testes, então a prioridade é estabilidade, clareza operacional e integração segura entre as frentes.

## Visão geral

O fluxo principal do produto é:

```text
Cliente
→ WhatsApp ou Site
→ Triagem / entrada estruturada
→ CRM interno
→ Atendimento humano
```

O objetivo é reduzir perda de mensagens no WhatsApp, organizar atendimentos de pessoa física e pessoa jurídica, preservar histórico das conversas e preparar a base para entradas futuras vindas do site, como listas escolares enviadas por imagem ou PDF.

## Frentes do projeto

### 1. Agente WhatsApp

Responsável por receber mensagens do WhatsApp, conduzir triagem inicial, respeitar a janela de 24h, salvar histórico, enviar templates aprovados e encaminhar atendimentos para o CRM.

Arquivos principais:

```text
api/webhook.js
api/send.js
api/send-template.js
```

### 2. CRM interno

Responsável pelo painel de atendimento da equipe, com Kanban PF/PJ, histórico de conversas, cards, prioridade, status, templates, atendimento ativo, resolução e organização operacional.

Arquivos principais:

```text
painel/index.html
painel/login.html
painel/manifest.json
api/queue.js
api/conversation.js
api/conversations.js
api/update-card.js
api/update-status.js
api/resolve.js
api/archive.js
api/active-attendant.js
```

### 3. Site público (pasta `/site` — LEGADA)

> **Atenção:** A pasta `/site` é uma versão legada. O site oficial atual está em:
> - Repositório: https://github.com/Suertesoy/sartecpapelaria
> - Deploy: https://sartec.vercel.app
>
> Novas funcionalidades do site — incluindo leitura de lista escolar com IA — devem ser implementadas no repositório isolado, não em `/site`.

A pasta `/site` existe neste monorepo porque o `vercel.json` ainda roteia o domínio para ela. Não alterar seu conteúdo sem coordenar com a migração das rotas.

Arquivos principais:

```text
site/
logos/
vercel.json
```

## Stack técnica

```text
Node.js serverless na Vercel
Redis via ioredis
WhatsApp Cloud API
Anthropic Claude
Frontend em HTML, CSS e JavaScript puro
```

Dependências principais:

```json
{
  "type": "module",
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "ioredis": "^5.0.0"
  }
}
```

## Estrutura oficial de pastas

A estrutura oficial usa nomes em minúsculo para evitar problemas de case sensitivity no deploy da Vercel/Linux.

```text
/
├── api/
├── painel/
├── site/
├── logos/
├── package.json
├── vercel.json
├── project_context.md
├── agent_rules_sartec.md
└── README.md
```

Não recriar pastas antigas ou paralelas, como:

```text
AGENTE+API/
PAINEL/
SITE/
LOGOS/
```

## Rotas Vercel

O `vercel.json` roteia:

```text
/                       → /site/index.html
/index.html             → /site/index.html
/assets/(.*)            → /site/assets/$1
/produtos.html          → /site/produtos.html
/lista-escolar.html     → /site/lista-escolar.html
/empresas.html          → /site/empresas.html
/escolas.html           → /site/escolas.html
/copias.html            → /site/copias.html
/painel                 → /painel/index.html
/painel/                → /painel/index.html
/painel/(.*)            → /painel/$1
/api/(.*)               → /api/$1
```

Por isso, as pastas `site/`, `painel/` e `api/` devem permanecer em minúsculo.

## APIs atuais

O projeto deve permanecer dentro do limite do plano Hobby da Vercel, que permite até 12 Serverless Functions por deployment.

Arquivos atuais em `api/`:

```text
active-attendant.js
archive.js
contacts.js
conversation.js
conversations.js
queue.js
resolve.js
send-template.js
send.js
update-card.js
update-status.js
webhook.js
```

Não criar nova função em `api/` sem verificar o limite de 12 funções.

A funcionalidade de reset de testes foi integrada em `api/webhook.js`, não em uma função separada, justamente para respeitar esse limite.

## Variáveis de ambiente

Configurar na Vercel em `Settings → Environment Variables`.

Principais variáveis:

```env
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
ANTHROPIC_API_KEY=...
REDIS_URL=...
TEMPLATE_ATTENDANCE_RESUME_NAME=retomar_atendimento_v1
TEMPLATE_BUDGET_UPDATE_NAME=...
TEMPLATE_PJ_PROSPECTING_NAME=...
TEMPLATE_LANGUAGE_CODE=pt_BR
```

Não commitar `.env`, `.env.local` ou arquivos temporários com tokens.

## Estado atual importante

Decisões e correções já realizadas:

```text
Pasta AGENTE+API/ removida.
Pastas oficiais padronizadas em minúsculo: api/, painel/, site/, logos/.
Reset de teste integrado em api/webhook.js.
api/dev-reset.js não deve ser recriado.
loadSession() foi corrigido para não apagar histórico ao mudar o dia.
TTLs foram padronizados para 90 dias.
Reabertura por template attendance_resume deve preservar histórico e não reiniciar triagem.
Redis de teste já foi limpo.
Fluxo do zero foi validado.
Botão “Assumir atendimento” foi implementado e testado.
```

## Reset de ambiente de teste

O reset fica em `api/webhook.js` e exige `WHATSAPP_VERIFY_TOKEN`.

Exemplos:

```text
GET /api/webhook?reset=TOKEN&phone=+55NUMERO
GET /api/webhook?reset=TOKEN&phone=+55NUMERO&hard=1
GET /api/webhook?reset=TOKEN&phone=+55NUMERO&hard=1&dryRun=1
GET /api/webhook?reset=TOKEN&all=1&dryRun=1
GET /api/webhook?reset=TOKEN&all=1
```

Regras:

```text
Sempre fazer dry-run antes de limpeza real, salvo autorização explícita.
Nunca expor o token em logs ou relatórios.
Nunca apagar chaves fora do namespace sartec:.
```

## Regras de trabalho para agentes

Antes de qualquer alteração, ler:

```text
project_context.md
agent_rules_sartec.md
README.md
```

O arquivo oficial de regras é:

```text
agent_rules_sartec.md
```

Arquivos antigos como `AGENT_RULES_REESCRITO.md` ou `AGENT_RULES.md` não devem ser usados como fonte principal.

## Fluxo de desenvolvimento recomendado

Para mudanças comuns:

```text
1. Diagnóstico
2. Plano curto com tempo estimado, arquivos afetados e riscos
3. Implementação mínima
4. Validação de sintaxe
5. git diff
6. Relatório final
7. Commit e push somente com autorização
8. Teste no deploy da Vercel
```

Como o produto ainda está em fase de testes, o deploy da Vercel pode ser usado como ambiente principal de validação, desde que o Git esteja limpo e a alteração tenha sido validada.

## Comandos úteis

Diagnóstico seguro:

```bash
git status --short
git log --oneline -5
git diff
node --check api/webhook.js
```

Verificar deploy/projeto:

```bash
vercel inspect
```

Ações como `git add`, `git commit`, `git push`, `vercel --prod`, `npm install`, remoção de arquivos ou limpeza de Redis exigem autorização explícita.

## Arquivos locais que não devem ir para commit

```text
.claude/
_test_js.mjs
fix_card.js
.env
.env.local
.env.reset.tmp
```

`fix_card.js` e `_test_js.mjs` são auxiliares locais e não fazem parte da operação do produto.

## Prioridades atuais

Prioridade atual do produto:

```text
1. Consolidar MVP do CRM e agente WhatsApp.
2. Validar fluxo de atendimento real com números de teste.
3. Garantir histórico, templates, janela de 24h e pipeline estáveis.
4. Organizar documentação do projeto.
5. Só depois avançar com o site público e fluxo de lista escolar.
```

Pendências futuras:

```text
Persistir ordem manual dos cards no Redis.
Finalizar e validar site público.
Integrar entrada estruturada de lista escolar pelo site.
Revisar README conforme o projeto evoluir.
```

## Cuidados críticos

```text
Não recriar AGENTE+API/.
Não recriar api/dev-reset.js.
Não criar nova Serverless Function sem contar o limite da Vercel Hobby.
Não apagar histórico por troca de dia.
Não confundir janela de 24h do WhatsApp com reset de sessão.
Não alterar templates aprovados da Meta sem validação.
Não alterar rotas em vercel.json sem validar site, painel e API.
Não mexer no site quando a tarefa for CRM, salvo integração explícita.
```
