# project_context — Sartec

## 1. Visão geral

Este é o projeto digital da Sartec Papelaria. Este repositório (`agente-triagem-crm-sartec`) reúne o agente de triagem do WhatsApp e o CRM interno de atendimento. O site público institucional da Sartec Papelaria vive em outro repositório separado (`Suertesoy/sartecpapelaria`) — ver SITE_OFICIAL.md.

```text
Cliente → WhatsApp ou site → triagem / entrada estruturada → CRM → atendimento humano
```

O objetivo principal é reduzir perda de mensagens, organizar atendimentos de pessoa física e pessoa jurídica, preservar histórico, acelerar respostas e criar uma base para futuras entradas vindas do site (mantido em repositório separado), especialmente listas escolares.

## 2. Arquivo de regras obrigatório

Antes de qualquer alteração, o agente deve ler:

```text
agent_rules_sartec.md
```

Este é o arquivo oficial de regras operacionais do projeto. Ele substitui referências antigas a:

```text
AGENT_RULES.md
AGENT_RULES_REESCRITO.md
```

Se algum arquivo antigo de regras aparecer no projeto, ele não deve ser usado como fonte principal sem confirmação do usuário.

## 3. Raiz oficial do projeto

A raiz correta do projeto é:

```text
C:\Users\USER\Desktop\PROJETOS\SARTEC - CRM_AGENTE\PAINEL, AGENTE
```

Esta pasta deve conter o projeto completo com Git, Vercel, APIs, painel e documentação. O site público fica em repositório separado (ver SITE_OFICIAL.md).

Estrutura oficial esperada:

```text
PAINEL, AGENTE E SITE/
  .git/
  .vercel/
  .claude/
  api/
  painel/
  logos/
  .gitignore
  package.json
  vercel.json
  SITE_OFICIAL.md
  PROJECT_CONTEXT.md ou project_context.md
  agent_rules_sartec.md
  README.md
```

As pastas operacionais devem permanecer em minúsculo:

```text
api/
painel/
logos/
```

Isso evita problemas de case sensitivity no deploy da Vercel/Linux.

Nunca recriar pastas antigas ou paralelas como:

```text
AGENTE+API/
PAINEL/
SITE/
LOGOS/
```

## 4. Frentes do projeto

### 4.1 Agente WhatsApp e webhook

Responsável por receber mensagens do WhatsApp, conduzir a triagem inicial, salvar sessão, preservar histórico, respeitar a janela de 24h da Meta, enviar templates aprovados e encaminhar para atendimento humano quando necessário.

Arquivos principais:

```text
api/webhook.js
api/send.js
api/send-template.js
```

Funções principais desta frente:

```text
Receber POST do WhatsApp Cloud API
Validar webhook da Meta
Carregar e salvar sessão no Redis
Chamar o agente Claude quando apropriado
Detectar handoff para humano
Controlar templateWaitingReply e lastTemplateType
Preservar histórico por pelo menos 90 dias
Controlar reset de teste dentro do webhook
Baixar mídia da Meta e armazenar no Cloudflare R2 (via api/media-storage.js)
Transcrever áudio recebido com OpenAI gpt-4o-mini-transcribe
```

### 4.2 CRM interno

Responsável pelo painel operacional da Sartec. É a central de atendimento humano para organizar conversas, separar PF/PJ, visualizar histórico, responder clientes, acompanhar status, atualizar dados do pedido e resolver atendimentos.

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
api/contacts.js
api/active-attendant.js
api/metrics.js
api/delete-media.js
api/parse-budget-pdf.js
```

Principais recursos atuais:

```text
Login simples por sessionStorage
Kanban PF e PJ
Aba Conversas
Histórico completo da conversa
Envio humano de texto, imagem, PDF e documento
Templates quando janela de 24h está fechada
Cards com prioridade manual e automática
Status por pipeline
Dados do pedido no modal
Resumo operacional
Resolver e reabrir atendimento
Indicador de janela WhatsApp aberta, fechada ou aguardando template
Chip de atendente ativo
Botão Assumir atendimento
Aviso quando outra aba ou outro atendente está na conversa
Polling para atualização do painel
```

### 4.3 Site público (fora deste repositório)

O site público da Sartec não faz parte deste repositório. Ele é mantido em `Suertesoy/sartecpapelaria`, projeto Vercel `sartec`, domínio `https://sartecpapelaria.com.br/`. Ver SITE_OFICIAL.md para o mapa completo da separação.

Integração futura entre site e CRM (lado CRM fica aqui, lado site fica no repo separado):

```text
Usuário acessa página de lista escolar (repo sartecpapelaria)
Envia foto ou PDF da lista
Seleciona itens desejados
Sistema estrutura a lista
Entrada segue para WhatsApp ou CRM de forma mais organizada
Card pode entrar no CRM já com origem = site
```

O foco principal deste repositório continua sendo o MVP do CRM e do agente.

## 5. Arquitetura técnica

Stack atual:

```text
Node.js serverless na Vercel
Redis via ioredis
WhatsApp Cloud API
Anthropic Claude
OpenAI (transcrição de áudio)
Cloudflare R2 via SDK S3 (armazenamento de mídia)
Frontend em HTML, CSS e JavaScript puro
GitHub como repositório
Vercel como deploy
```

Dependências principais (package.json):

```text
@anthropic-ai/sdk               — agente de triagem e parser de orçamento
@aws-sdk/client-s3              — Cloudflare R2 (armazenamento de mídia)
@aws-sdk/s3-request-presigner   — URLs assinadas para mídia no R2
ioredis                         — sessões, histórico e filas no Redis
```

O projeto usa `type: module` no `package.json`.

### 5.1 Endpoints reais em api/

Hoje existem 16 arquivos `.js` em `api/`: 15 handlers serverless e 1 helper sem handler.

```text
api/active-attendant.js   — controle de atendente ativo por conversa
api/archive.js            — arquivamento de atendimentos
api/contacts.js           — base de contatos persistente (GET busca, POST reopen)
api/conversation.js       — histórico de uma conversa
api/conversations.js      — lista de conversas
api/delete-media.js       — remoção manual de mídia (R2 e/ou Redis) pelo painel
api/metrics.js            — métricas do CRM (período, PF/PJ, atendente, categoria)
api/parse-budget-pdf.js   — parser de orçamento em PDF/texto com IA (Claude)
api/queue.js              — fila/Kanban do painel
api/resolve.js            — resolver/reabrir atendimento
api/send-template.js      — envio de templates aprovados (janela fechada)
api/send.js               — envio humano de mensagem e mídia
api/update-card.js        — edição de dados do card
api/update-status.js      — mudança de status no pipeline
api/webhook.js            — webhook da Meta, triagem, agente, reset de teste, transcrição de áudio
```

Helper sem handler (exporta funções usadas por webhook.js, send.js, conversation.js, delete-media.js e parse-budget-pdf.js):

```text
api/media-storage.js      — upload/download/delete e URL assinada de mídia no Cloudflare R2
```

### 5.2 Variáveis de ambiente usadas pelo código

```text
REDIS_URL                        — conexão Redis (usada por quase todos os handlers)
ANTHROPIC_API_KEY                — agente Claude (webhook.js, parse-budget-pdf.js)
OPENAI_API_KEY                   — transcrição de áudio gpt-4o-mini-transcribe (webhook.js, ~linha 1438)
WHATSAPP_ACCESS_TOKEN            — WhatsApp Cloud API (webhook.js, send.js, send-template.js)
WHATSAPP_PHONE_NUMBER_ID         — número da Cloud API (webhook.js, send.js, send-template.js)
WHATSAPP_VERIFY_TOKEN            — verificação do webhook da Meta; também é o token do reset de teste
TEMPLATE_ATTENDANCE_RESUME_NAME  — nome do template de retomada (send-template.js)
TEMPLATE_BUDGET_UPDATE_NAME      — nome do template de orçamento (send-template.js)
TEMPLATE_PJ_PROSPECTING_NAME     — nome do template de prospecção PJ (send-template.js)
TEMPLATE_LANGUAGE_CODE           — idioma dos templates (send-template.js)
R2_ENDPOINT                      — endpoint do Cloudflare R2 (media-storage.js)
R2_ACCESS_KEY_ID                 — credencial do R2 (media-storage.js)
R2_SECRET_ACCESS_KEY             — credencial do R2 (media-storage.js)
R2_BUCKET                        — bucket do R2 (media-storage.js)
R2_DISABLED                      — desativa o armazenamento R2 (media-storage.js)
```

Scripts locais em `scripts/` (fora do deploy) usam também `R2_ACCOUNT_ID` (r2-smoke-test.js).

## 6. Vercel e rotas

O projeto correto na Vercel é:

```text
agente-triagem-sartec
```

A pasta `.vercel/` é local e não deve ser commitada.

O `vercel.json` deste repositório controla apenas as rotas de painel e API:

```text
/painel → /painel/index.html
/painel/ → /painel/index.html
/painel/(.*) → /painel/$1
/api/(.*) → /api/$1
```

As rotas de site público foram removidas deste `vercel.json` — o site tem seu próprio `vercel.json` e domínio no repositório `Suertesoy/sartecpapelaria`.

Por isso, as pastas `painel/` e `api/` devem continuar em minúsculo.

## 7. Limite de funções serverless

O plano Hobby da Vercel tem, historicamente, limite de 12 Serverless Functions por deployment.

Situação real hoje (atualizado em 2026-07): `api/` contém 16 arquivos `.js` — 15 handlers e o helper `media-storage.js`. Como `media-storage.js` está direto em `api/` sem prefixo `_`, a Vercel o conta como função, totalizando 16 funções no deployment — acima do limite de 12 do plano Hobby. A afirmação anterior de que o projeto "já opera nesse limite" estava desatualizada.

Como os deploys recentes têm funcionado, ou o limite/plano efetivo mudou, ou a contagem real difere da esperada. Confirmar com `vercel inspect` antes de criar qualquer função nova.

Recomendação registrada (ainda não executada):

```text
Mover api/media-storage.js para api/_lib/media-storage.js (ou prefixar com _)
para que a Vercel deixe de contá-lo como função serverless.
Ajustar os imports em webhook.js, send.js, conversation.js,
delete-media.js e parse-budget-pdf.js.
```

Antes de criar qualquer novo arquivo `.js` dentro de `api/`, o agente deve:

```text
Contar as funções existentes
Verificar o limite de 12 funções
Propor integração em função existente se fizer sentido
Pedir autorização explícita antes de criar nova função
```

Decisão já tomada:

```text
api/dev-reset.js não deve existir.
A lógica de reset de teste foi integrada em api/webhook.js para manter o limite de 12 funções.
```

## 8. Redis, sessão e histórico

A sessão Redis é o coração do sistema.

A sessão deve preservar:

```text
history
clientName
clientType
demandType
pipelineStatus
status
handoffDone
handoffAt
templateWaitingReply
lastTemplateType
lastUserMessageAt
windowExpiresAt
activeAttendant
activeAttendantAt
```

Regras importantes:

```text
Não apagar histórico automaticamente por mudança de dia.
Não confundir janela de 24h com reset de sessão.
A janela de 24h controla apenas envio livre versus template.
Histórico deve durar pelo menos 90 dias.
Reset de teste deve ser explícito e protegido por token.
```

Correção importante já feita:

```text
loadSession não deve retornar createEmptySession apenas porque mudou o dia.
Quando muda o dia, atualizar lastDate sem apagar history.
```

TTLs foram padronizados para aproximadamente 90 dias nas sessões e arquivos relevantes.

## 9. Reset de teste

O projeto ainda está em fase de testes e usa números de teste da API da Meta.

O reset de teste fica dentro de:

```text
api/webhook.js
```

Endpoint base:

```text
GET /api/webhook?reset=TOKEN
```

Modos esperados:

```text
GET /api/webhook?reset=TOKEN&phone=+55NUMERO
Reset simples do número

GET /api/webhook?reset=TOKEN&phone=+55NUMERO&hard=1
Hard reset do número, incluindo sessão, arquivos e contato quando implementado

GET /api/webhook?reset=TOKEN&all=1&dryRun=1
Lista o que seria apagado sem limpar

GET /api/webhook?reset=TOKEN&all=1
Limpeza geral real do namespace sartec:, apenas com autorização explícita
```

Regras:

```text
Nunca executar reset sem autorização explícita.
Nunca expor token em relatório.
Nunca apagar fora do namespace sartec:.
Nunca executar all=1 real se o usuário não pedir claramente.
```

## 10. WhatsApp, templates e janela de 24h

A janela de 24h do WhatsApp precisa ser respeitada.

Quando a janela está aberta:

```text
Atendente pode enviar mensagem livre.
```

Quando a janela está fechada:

```text
Atendente deve enviar template aprovado.
```

Templates relevantes:

```text
attendance_resume
budget_update
pj_prospecting
```

Decisão importante:

```text
Quando o cliente responde ao template attendance_resume, o agente não deve reiniciar triagem.
Esse fluxo deve continuar atendimento humano.
Não perguntar PF/PJ novamente.
Não apagar histórico.
Não tratar como conversa nova.
```

Campos críticos:

```text
templateWaitingReply
lastTemplateType
handoffDone
handoffAt
pipelineStatus
```

## 11. CRM, painel e UX operacional

O CRM deve priorizar velocidade operacional, clareza e baixa carga cognitiva.

Áreas sensíveis do painel:

```text
login/auth
loadQueue
polling
Kanban
drag and drop
cards
modal de atendimento
aba Conversas
templates
mobile
onboarding
toasts
composer
janela de 24h
activeAttendant
```

Não alterar `painel/index.html` sem plano. O arquivo concentra HTML, CSS e JS, então alterações amplas têm risco alto.

Direção visual:

```text
premium enterprise
limpo
sóbrio
operacional
inspirado em Linear, Notion, Slack e WhatsApp Business
```

## 12. Decisões recentes já implementadas

As seguintes decisões já fazem parte do estado atual do projeto:

```text
Pasta AGENTE+API removida.
Pastas principais padronizadas em minúsculo: api, painel, logos.
Site público separado para o repositório Suertesoy/sartecpapelaria; pasta site/ removida deste repositório.
Redis de teste foi limpo e o painel ficou vazio para testes do zero.
loadSession corrigido para preservar histórico entre dias.
TTLs aumentados para 90 dias.
attendance_resume deve continuar atendimento humano sem reiniciar triagem.
Reset de teste integrado ao webhook.
api/dev-reset.js removido para respeitar limite da Vercel Hobby.
activeAttendant e activeAttendantAt expostos no queue.
Chip de atendente ativo no card.
Botão Assumir atendimento implementado e testado.
Header, cards, modal desktop, mobile e drag and drop receberam refinamentos visuais e funcionais.
```

## 13. Estado atual do MVP

Estado atual:

```text
CRM e agente estão em fase de MVP/testes.
Produto ainda não está em uso por clientes reais em escala.
Deploy da Vercel pode ser usado como ambiente principal de teste.
Fluxos principais do CRM já começaram a ser testados no deploy.
```

Testes já realizados pelo usuário:

```text
Limpeza geral do Redis funcionou.
Painel ficou vazio após limpeza.
Fluxo do zero funcionou.
Botão Assumir atendimento funcionou.
Fluxo geral após deploy funcionou.
```

Testes que continuam importantes:

```text
Reabertura por template attendance_resume em cenário real de janela fechada.
Histórico persistindo após refresh.
Histórico persistindo após mudança de dia.
Envio humano com janela aberta.
Template com janela fechada.
Concorrência entre atendentes em duas abas/perfis.
Mobile em responsive mode ou celular real.
```

## 14. Roadmap por prioridade

### Prioridade atual

```text
Finalizar MVP do CRM e agente WhatsApp.
Testar fluxo real com números de teste.
Garantir estabilidade de histórico, templates e atendimento humano.
Organizar documentação e arquivos locais.
```

### Próximas melhorias prováveis no CRM

```text
Persistir ordem manual dos cards no Redis.
Refinar aba Conversas, favoritos e arquivamento.
Melhorar leitura operacional dos cards.
Aprimorar comportamento mobile após testes reais.
Aprimorar relatórios ou filtros por status/categoria.
```

### Depois do MVP do CRM

```text
Criar fluxo de lista escolar pelo site (repositório sartecpapelaria).
Definir integração site → WhatsApp → CRM.
```

### Futuro

```text
Usar número real da Meta.
Testes com pessoas reais.
Melhorar observabilidade e logs.
Separar projetos apenas se o site ou o agente crescerem muito.
```

## 15. Organização de arquivos

Arquivos/pastas estruturais que não devem ser apagados:

```text
.git/
.vercel/
api/
painel/
logos/
package.json
vercel.json
SITE_OFICIAL.md
PROJECT_CONTEXT.md ou project_context.md
agent_rules_sartec.md
README.md
.gitignore
```

Arquivos locais que normalmente não devem entrar no Git:

```text
.claude/
_test_js.mjs
fix_card.js
.env
.env.local
.env.reset.tmp
```

`_test_js.mjs` parece ser dump/teste local do painel.

`fix_card.js` foi um script pontual de reparo e não faz parte da operação do sistema.

`.claude/` contém configurações locais do Claude/Antigravity e deve permanecer local.

## 16. README

O README atual pode estar desatualizado. Ele deve ser revisado em etapa separada.

O README deve servir para explicação humana resumida do projeto.

O `project_context.md` deve servir como contexto vivo do produto.

O `agent_rules_sartec.md` deve servir como contrato operacional do agente.

## 17. Como o agente deve iniciar uma nova sessão

Ao começar uma nova conversa no Antigravity/Claude Code, o agente deve:

```text
1. Confirmar a raiz do projeto.
2. Rodar git status.
3. Ler agent_rules_sartec.md.
4. Ler project_context.md ou PROJECT_CONTEXT.md.
5. Confirmar se está mexendo em agente, CRM ou integração (site público é repositório separado).
6. Confirmar arquivos envolvidos.
7. Não alterar nada antes de apresentar plano quando a tarefa for de implementação.
```

## 18. Regra final

Este projeto deve ser evoluído com mudanças pequenas, seguras e bem documentadas.

A prioridade é estabilidade operacional do CRM, preservação do histórico e clareza no atendimento.

O agente deve evitar criar estruturas paralelas, refatorações amplas ou soluções novas quando uma alteração incremental resolver.
