# PROJECT_CONTEXT — Sartec CRM

Este projeto é um CRM interno com agente de IA para atendimento via WhatsApp da Sartec Papelaria.

Arquitetura:
Node.js serverless na Vercel
Redis via ioredis
WhatsApp Cloud API
Anthropic Claude
Frontend em HTML, CSS e JavaScript puro

Arquivos principais:
api/webhook.js: recebe mensagens do WhatsApp, chama o agente, salva sessão e controla handoff
api/send.js: envia mensagens humanas, imagens e documentos
api/send-template.js: envia templates aprovados do WhatsApp
api/queue.js: alimenta o pipeline PF/PJ
api/conversations.js: lista conversas ativas e arquivadas
api/conversation.js: carrega histórico completo
api/update-card.js: edita dados do card
api/update-status.js: altera status do pipeline
api/resolve.js: marca conversa como resolvida
api/archive.js: arquiva histórico
painel/index.html: CRM visual
painel/login.html: tela de acesso

Regras de trabalho:
Sempre ler AGENT_RULES.md antes de sugerir alterações
Fazer mudanças mínimas e incrementais
Não trocar a stack
Não refatorar tudo sem necessidade
Preservar a estrutura das sessões Redis
Não quebrar webhook, envio de mensagem, templates ou janela de 24h
Antes de alterar código, explicar o que será feito e quais arquivos serão modificados
Não sugerir comandos de Git se o usuário não pedir

Prioridades:
Estabilidade
Clareza do atendimento
UX do CRM
Performance
Novas funcionalidades apenas depois de validar impacto

Pontos sensíveis:
Existem TTLs diferentes em alguns arquivos. Verificar antes de alterar
A sessão Redis é o coração do sistema
O painel usa polling, então alterações de renderização precisam evitar conflito com edição inline
A janela de 24h do WhatsApp precisa ser respeitada
Templates são obrigatórios quando a janela está fechada

Objetivo do produto:
Ajudar a Sartec a organizar atendimentos PF e PJ, reduzir perda de mensagens no WhatsApp, facilitar triagem com IA e dar contexto para o atendimento humano
