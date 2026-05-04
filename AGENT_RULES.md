# AGENT_RULES — Sartec CRM

## Idioma e comunicação
- Sempre responder em português do Brasil
- Ser direto, claro e objetivo
- Evitar explicações desnecessárias
- Usar linguagem técnica quando fizer sentido

---

## Antes de alterar código
- Sempre explicar o que será feito antes de qualquer modificação
- Listar quais arquivos serão alterados
- Aguardar confirmação do usuário antes de aplicar mudanças

---

## Alterações no projeto
- Fazer mudanças mínimas necessárias (evitar refatorações grandes sem pedido)
- Não alterar código que já está funcionando sem motivo claro
- Manter consistência com o padrão já existente no projeto
- Evitar criar novos arquivos se for possível reutilizar os existentes

---

## Backend (API / Vercel)
- Seguir padrão das rotas existentes em `/api`
- Manter estrutura de handlers consistente
- Sempre tratar erros com `try/catch`
- Validar inputs antes de processar
- Nunca expor variáveis de ambiente

---

## Redis e estado
- Manter padrão de chave: `sartec:{phone}`
- Respeitar TTL definido no projeto
- Não criar novas estruturas sem necessidade clara
- Sempre preservar integridade do histórico

---

## Frontend (painel)
- Priorizar usabilidade e clareza
- Evitar comportamentos que interrompam o fluxo do usuário
- Sempre garantir feedback visual (loading, sucesso, erro)
- Melhorar microinterações quando possível (ex: edição inline)

---

## Integração com WhatsApp
- Nunca quebrar o fluxo do webhook
- Manter compatibilidade com a API da Meta
- Garantir que respostas sempre tenham fallback em caso de erro

---

## Uso de IA (Claude)
- Usar IA para:
  - Resumo de conversas
  - Classificação de intenção
  - Apoio ao atendimento humano
- Nunca permitir que a IA execute ações críticas sem validação

---

## Git e deploy
- Antes de commit:
  - Revisar alterações
  - Garantir que não há segredos no código
- Mensagens de commit devem ser claras e descritivas
- Sempre explicar o que será feito antes de executar `git push`

## Git Behavior
Não sugerir nem executar comandos de Git automaticamente quando:

* Não houver alterações recentes feitas pelo próprio agente
* O repositório estiver limpo (working tree clean)
* O usuário não pediu explicitamente algo relacionado a Git

Evitar loops de validação como:
git status
git log
git pull

Após um push bem-sucedido, considerar o fluxo de Git finalizado.

Só interagir com Git novamente se:

* O usuário pedir
* Uma nova alteração de código for feita

---

## Prioridades do projeto
1. Estabilidade do sistema
2. Clareza do fluxo de atendimento
3. Experiência do usuário (UX)
4. Performance
5. Novas funcionalidades

---

## Regra geral
Se houver dúvida:
- Não assumir
- Perguntar antes de agir
