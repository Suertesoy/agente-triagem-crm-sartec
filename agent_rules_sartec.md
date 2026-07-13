# agent_rules_sartec

Arquivo oficial de regras para o projeto Sartec.

Este documento substitui referências antigas a `AGENT_RULES.md` e `AGENT_RULES_REESCRITO.md`.
A fonte oficial para orientar o agente no Antigravity / Claude Code passa a ser:

```text
agent_rules_sartec.md
```

---

## AVISO — Site público oficial

O site público da Sartec **não existe mais dentro deste repositório**. Ele está em um repositório separado e isolado:

```text
Repositório: github.com/Suertesoy/sartecpapelaria
Projeto Vercel: sartec
Domínio: https://sartecpapelaria.com.br/
```

Regras obrigatórias:

```text
Não recriar uma pasta site/ neste repositório.
Não implementar páginas, estilos ou lógica de site público aqui.
Usar o repositório isolado sartecpapelaria para qualquer ajuste do site oficial.
Funcionalidades de lista escolar com IA pelo site devem ir no repo isolado.
Ver SITE_OFICIAL.md na raiz para o mapa completo da separação.
```

---

## 1. Identidade do projeto

Este é o projeto Sartec — CRM, painel de atendimento, agente WhatsApp, webhook e APIs operacionais. O site público institucional da Sartec Papelaria vive em outro repositório (`Suertesoy/sartecpapelaria`); ver SITE_OFICIAL.md.

Este repositório possui duas frentes conectadas:

1. Agente WhatsApp e webhook de triagem
2. CRM interno de atendimento

Stack principal:

```text
Node.js serverless na Vercel
Redis via ioredis
WhatsApp Cloud API
Anthropic Claude
Frontend em HTML, CSS e JavaScript puro
```

Objetivo do produto:

```text
Cliente → WhatsApp / Site → Triagem / Lista → CRM → Atendimento humano
```

A prioridade do projeto é criar um MVP estável para organizar atendimentos PF e PJ, reduzir perda de mensagens no WhatsApp, facilitar triagem com IA e dar contexto operacional para o atendimento humano.

---

## 2. Raiz correta do projeto

A raiz correta do projeto é:

```text
C:\Users\USER\Desktop\PROJETOS\SARTEC - CRM_AGENTE\PAINEL, AGENTE
```

A raiz deve conter:

```text
.git/
.vercel/
api/
painel/
logos/
package.json
vercel.json
SITE_OFICIAL.md
PROJECT_CONTEXT.md
agent_rules_sartec.md
README.md
```

A estrutura oficial deve usar nomes em minúsculo para evitar problemas de case sensitivity no deploy da Vercel/Linux:

```text
api/
painel/
logos/
```

Nunca criar ou usar pastas paralelas antigas como:

```text
AGENTE+API/
PAINEL/
SITE/
LOGOS/
```

Se uma pasta antiga reaparecer, parar e reportar antes de mover, apagar ou copiar arquivos.

---

## 3. Frentes do produto

### 3.1 Agente WhatsApp

Responsável por:

1. Receber mensagens do WhatsApp
2. Conduzir triagem inicial
3. Salvar histórico
4. Respeitar janela de 24h
5. Enviar templates aprovados quando a janela estiver fechada
6. Encaminhar para atendimento humano
7. Preservar histórico e contexto da conversa

Arquivos principais:

```text
api/webhook.js
api/send.js
api/send-template.js
```

### 3.2 CRM interno

Responsável por:

1. Organizar atendimentos em PF e PJ
2. Exibir pipeline/Kanban
3. Exibir histórico de conversas
4. Permitir atendimento humano
5. Editar cards e dados do pedido
6. Resolver, arquivar e reabrir atendimentos
7. Controlar atendente ativo
8. Mostrar status da janela do WhatsApp

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

### 3.3 Site público (fora deste repositório)

O site público da Sartec Papelaria não faz parte deste repositório. Ele vive em `Suertesoy/sartecpapelaria`, deploy no projeto Vercel `sartec`, domínio `https://sartecpapelaria.com.br/`. Ver SITE_OFICIAL.md.

---

## 4. Mapa de escopo por tipo de tarefa

### Tarefa sobre agente WhatsApp

Priorizar:

```text
api/webhook.js
api/send.js
api/send-template.js
```

Não alterar `painel/index.html` sem necessidade explícita.

### Tarefa sobre CRM

Priorizar:

```text
painel/index.html
painel/login.html
api/queue.js
api/conversation.js
api/conversations.js
api/update-card.js
api/update-status.js
api/resolve.js
api/archive.js
api/active-attendant.js
```

Não alterar `logos/` se a tarefa for somente CRM.

### Tarefa sobre site público

O site público não existe neste repositório. Qualquer tarefa sobre site público deve ser feita no repositório `Suertesoy/sartecpapelaria`, não aqui. Ver SITE_OFICIAL.md.

### Tarefa de integração

Quando envolver `site → WhatsApp → CRM`, primeiro diagnosticar fronteiras e propor plano antes de editar. O lado "site" dessa integração está no repositório `Suertesoy/sartecpapelaria`.

Exemplo de integração futura:

```text
lista-escolar.html (repo sartecpapelaria)
→ usuário envia imagem ou PDF
→ site estrutura lista
→ envia input para WhatsApp ou CRM
→ card entra no CRM com origem = site
```

---

## 5. Arquivos críticos

Nunca alterar sem diagnóstico e plano:

```text
api/webhook.js
api/send.js
api/send-template.js
api/queue.js
api/conversation.js
api/conversations.js
api/update-card.js
api/update-status.js
api/resolve.js
api/archive.js
api/active-attendant.js
painel/index.html
painel/login.html
vercel.json
package.json
PROJECT_CONTEXT.md
agent_rules_sartec.md
```

A sessão Redis é o coração do sistema. Qualquer alteração em sessão, TTL, histórico, handoff, janela de 24h ou template precisa de cuidado especial.

---

## 6. Regras gerais de trabalho

Sempre:

1. Fazer mudanças mínimas e incrementais
2. Preservar a arquitetura atual
3. Evitar refactors estruturais sem aprovação
4. Validar impacto no fluxo real do produto
5. Separar claramente diagnóstico de implementação
6. Confirmar escopo antes de editar

Nunca quebrar:

```text
login/auth
polling
loadQueue
onboarding
drag/drop
Kanban
conversa
histórico
templates
janela de 24h
mobile view
resumo operacional
modal de atendimento
envio humano
reabertura por template
```

---

## 7. Fluxo obrigatório antes de implementar

Antes de editar código, entregar um plano curto com:

```text
Estimativa de tempo
Arquivos afetados
CSS afetado, se houver
JS afetado, se houver
APIs afetadas, se houver
Riscos
Estratégia
Critérios de aceite
```

Antes de alterar qualquer código, sempre:

1. Confirmar a raiz correta do projeto
2. Rodar `git status`
3. Ler `PROJECT_CONTEXT.md`
4. Ler `agent_rules_sartec.md`
5. Identificar a frente afetada: agente, CRM, site ou integração
6. Listar arquivos que serão alterados
7. Explicar riscos
8. Estimar tempo
9. Aguardar aprovação quando a alteração for sensível

Se a tarefa for apenas diagnóstico, não alterar código.

Se encontrar problema fora do escopo, reportar antes de corrigir.

---

## 8. Fluxo obrigatório após implementar

Depois de implementar, entregar relatório com:

```text
Tempo gasto
Arquivos alterados
CSS alterado
Funções JS alteradas
APIs alteradas
Resultado de validação
Resumo do git diff
Riscos restantes
Confirmação se fez ou não commit
Confirmação se fez ou não push
Confirmação se fez ou não deploy
```

Mensagem final padrão quando não houver commit/push:

```text
Alteração validada. Aguardando autorização para commit e push.
```

Mensagem final padrão quando houver push:

```text
Alteração enviada. Produto pronto para teste no deploy.
```

---

## 9. Comandos permitidos sem confirmação

Estes comandos são seguros para diagnóstico, leitura e validação:

```text
pwd
ls
dir
find
grep
cat
Get-Content
Test-Path
git status
git diff
git log
git remote -v
git rev-parse
git ls-files
node --check
vercel inspect
```

Também pode ler arquivos do projeto, desde que não edite nada.

---

## 10. Comandos que exigem confirmação

Estes comandos exigem confirmação antes de executar:

```text
git add
git commit
git push
vercel deploy
vercel --prod
npm install
npm uninstall
cp
copy
mv
move
rm
rm -rf
Remove-Item
```

Também exigem confirmação:

```text
qualquer alteração em api/
qualquer alteração em painel/index.html
qualquer alteração em vercel.json
qualquer alteração em package.json
qualquer chamada de reset
qualquer limpeza de Redis
qualquer deploy manual
qualquer criação de nova função serverless
qualquer alteração em variáveis de ambiente
```

---

## 11. Ações proibidas sem autorização explícita

Nunca fazer sem autorização explícita do usuário:

```text
apagar pastas
limpar Redis
alterar variáveis de ambiente
criar nova API serverless
rodar deploy manual
commitar arquivos untracked
mover pastas principais
renomear api, painel ou logos
criar pasta AGENTE+API
alterar templates aprovados da Meta
alterar prompt do agente
trocar stack do projeto
remover código legado sem validar impacto
fazer refactor amplo em painel/index.html
```

---

## 12. Regras de Git

Nunca commitar arquivos untracked sem autorização.

Antes de qualquer commit:

```text
git status --short
git diff
confirmar arquivos staged
confirmar que não entrou .claude/
confirmar que não entrou arquivo local temporário
confirmar que não entrou arquivo sensível
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

O script `fix_card.js` é um reparo pontual e não deve ser tratado como parte operacional do projeto.

---

## 13. Regras de Vercel

Projeto correto da Vercel:

```text
agente-triagem-sartec
```

A pasta `.vercel/` não deve ser commitada.

O plano Hobby da Vercel tem, historicamente, limite de 12 Serverless Functions. Hoje `api/` contém 16 arquivos `.js`: 15 handlers e o helper `media-storage.js`, que a Vercel também conta como função por estar em `api/` sem prefixo `_`. Ver seção 7 do project_context.md para a situação real e a recomendação de mover o helper para `api/_lib/`. Antes de criar qualquer arquivo novo em `api/`, contar quantas funções já existem.

Regra crítica:

```text
Não criar api/dev-reset.js ou outra função extra sem verificar o limite de funções do plano.
```

Quando precisar adicionar funcionalidade backend, preferir integrar em API existente se fizer sentido e se não aumentar risco.

---

## 14. Regras de rotas

O `vercel.json` deste repositório usa rotas apenas para painel e API:

```text
/painel
/painel/
/painel/(.*)
/api/(.*)
```

Não há mais rotas de site público aqui — elas foram removidas porque o site público vive no repositório `Suertesoy/sartecpapelaria`, com seu próprio `vercel.json` e domínio próprio.

Por isso, as pastas devem permanecer em minúsculo:

```text
painel/
api/
```

Não alterar `vercel.json` sem validar:

```text
painel
api
produção na Vercel
case sensitivity
```

---

## 15. Regras de Redis, histórico e reset

A sessão Redis é crítica.

Nunca apagar histórico automaticamente apenas porque mudou o dia.

A janela de 24h do WhatsApp controla apenas se podemos responder livremente ou se precisamos de template. Ela não deve apagar histórico.

Histórico e sessões devem ser preservados por pelo menos 90 dias, salvo reset explícito.

Reset geral ou por número só pode ocorrer com autorização explícita.

Reset de teste deve:

```text
exigir token
atuar apenas no namespace sartec:
não apagar nada fora de sartec:
não mover cards para resolvidos
não deixar triagem incompleta residual
retornar resumo do que apagou
```

Dry-run deve ser preferido antes de reset destrutivo, exceto quando o usuário declarar explicitamente que pode apagar tudo.

---

## 16. Regras de WhatsApp, templates e janela de 24h

Nunca ignorar a janela de 24h.

Quando a janela estiver fechada, usar template aprovado.

Templates não devem ser alterados sem autorização explícita.

`attendance_resume` deve continuar atendimento existente. Não deve reiniciar triagem.

Quando cliente responder ao template de retomada:

```text
não perguntar PF/PJ de novo
não reiniciar triagem
não apagar histórico
marcar atendimento humano
atualizar handoffAt
preservar templateWaitingReply e lastTemplateType até o tratamento correto
```

---

## 17. Regras do agente de triagem

O agente deve ajudar a identificar:

```text
PF ou PJ
tipo de demanda
lista escolar
cotação PJ
xerox/impressão
produto
dúvida
outro
```

O agente deve encaminhar para humano quando:

```text
não tiver segurança
cliente pedir atendimento
pedido exigir cotação
pedido exigir análise manual
a triagem estiver completa
```

Não alterar prompt do agente sem autorização explícita.

Toda alteração no agente deve preservar:

```text
histórico
handoff
status
clientType
demandType
janela de 24h
templates
```

---

## 18. Regras do CRM e painel

O painel é área sensível.

Preservar:

```text
login/auth
polling
loadQueue
renderPipeline
buildCard
renderPipelineTab
openChat
renderModal
aba Conversas
envio de mensagem
composer
templates
modal desktop
mobile
onboarding
drag/drop
_colOrder
activeAttendant
```

Alterações em `painel/index.html` devem ser pequenas e bem localizadas.

Nunca refatorar o arquivo inteiro sem aprovação.

Se alterar UI, validar:

```text
desktop
mobile
overflow
modal
polling
clique no card
edição inline
drag/drop
envio de mensagem
template modal
```

---

## 19. Regras do site público

O site público não faz parte deste repositório. Ele é mantido em `Suertesoy/sartecpapelaria` (projeto Vercel `sartec`, domínio `https://sartecpapelaria.com.br/`). Qualquer regra de conteúdo, narrativa ou páginas do site deve ser consultada/aplicada naquele repositório, não aqui. Ver SITE_OFICIAL.md.

---

## 20. Regras de UI/UX

Direção visual obrigatória:

```text
estética premium enterprise
baixa carga cognitiva
motion suave
foco operacional
velocidade de atendimento
clareza visual
hierarquia forte
```

Referências de sensação:

```text
Linear
Notion
Slack
WhatsApp Business
```

Evitar:

```text
excesso de cards coloridos sem função
contraste fraco
microcopy confusa
botões demais
informação duplicada
UI com aparência improvisada
```

---

## 21. Regras de mobile

Toda alteração visual deve considerar:

```text
responsividade
overflow
modal mobile
toast mobile
badges mobile
composer mobile
botões com área de toque confortável
scroll
teclado virtual
```

Não quebrar mobile para resolver problema apenas desktop.

---

## 22. Regras de onboarding

O onboarding é área sensível.

Sempre validar:

```text
posicionamento
resize
scroll
re-render após polling
highlight
camada de overlay
botões próximo/voltar/concluir
```

Não alterar onboarding sem testar o fluxo completo.

---

## 23. Regras de polling

Nunca:

```text
bloquear polling
causar render duplicado
criar memory leaks
interromper loadQueue
sobrescrever edição inline em andamento
```

Sempre validar:

```text
sincronização de estado
re-render
modal aberto
aba Conversas
pipeline
cards
```

---

## 24. Organização de arquivos

Arquivos/pastas oficiais:

```text
api/
painel/
logos/
SITE_OFICIAL.md
PROJECT_CONTEXT.md
agent_rules_sartec.md
README.md
package.json
vercel.json
.gitignore
```

Arquivos/pastas locais que não devem ir para Git sem autorização:

```text
.claude/
_test_js.mjs
fix_card.js
.env
.env.local
.env.reset.tmp
```

Não apagar `logos/`. O site público não existe mais neste repositório (ver SITE_OFICIAL.md) — não recriar uma pasta `site/` aqui.

Se um arquivo parecer sobra, primeiro classificar como:

```text
necessário para deploy
necessário para desenvolvimento
local temporário
legado
risco alto de apagar
risco baixo de apagar
```

Só depois propor remoção.

---

## 25. Checklist inicial obrigatório para novas conversas no Antigravity

Ao iniciar uma nova conversa no Antigravity para este projeto, executar diagnóstico inicial:

```text
pwd
git status --short
git log --oneline -5
Test-Path .git
Test-Path .vercel/project.json
cat .vercel/project.json
ls
ls api
ls painel
```

Confirmar:

```text
raiz correta
projectName = agente-triagem-sartec
api/ com 16 arquivos .js (15 handlers + helper media-storage.js)
painel/index.html existe
site/ não existe neste repositório (site público vive em Suertesoy/sartecpapelaria)
AGENTE+API/ não existe
branch main sincronizada ou status explicado
```

Não alterar código nessa etapa.

---

## 26. Checklist final obrigatório para relatórios

Todo relatório final deve informar:

```text
Tempo gasto
Arquivos alterados
Arquivos não alterados por decisão
CSS alterado
JS alterado
APIs alteradas
Validações executadas
Resultado do git status
Riscos restantes
Se houve commit
Se houve push
Se houve deploy
Se houve reset ou limpeza de Redis
```

Se houver deploy:

```text
hash do commit
status do deploy
se ficou Ready
link de produção
```

Se houver erro:

```text
erro exato
causa provável
arquivo envolvido
correção recomendada
se precisa autorização
```

---

## 27. Pendências conhecidas e backlog

Pendências próximas:

```text
validar continuamente reabertura por attendance_resume
validar histórico após mudança de dia
organizar .gitignore para arquivos locais
atualizar PROJECT_CONTEXT.md para apontar para agent_rules_sartec.md
```

Backlog futuro:

```text
persistir ordem manual dos cards no Redis
integração lista escolar (repo sartecpapelaria) com CRM
origem do lead no CRM
fluxo estruturado para listas escolares
melhorias no histórico e arquivamento
```

---

## 28. Regra final

Mudanças mínimas.
Código previsível.
Sem refactors desnecessários.
Sem pastas paralelas.
Sem deploy sem autorização.
Sempre preservar estabilidade operacional do CRM e do agente WhatsApp. O site público é responsabilidade do repositório `Suertesoy/sartecpapelaria`.
