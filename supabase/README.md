# Schema Supabase — Sartec CRM

Este diretório versiona o schema já aplicado ao projeto **Sartec CRM** (`uzwyzwbybtnvgjjhimwy`, `sa-east-1`). Ele foi reconstruído a partir do histórico de migrations e do catálogo remoto em 17/08/2026.

As quatro migrations representam o estado remoto existente. A migration incremental foi registrada remotamente como `20260817175639_add_legacy_message_audit_fields` e o arquivo local usa o mesmo timestamp.

Não execute `db push`, `db reset`, `migration repair` ou aplique qualquer migration contra produção sem uma autorização explícita.

O acesso permanece exclusivamente server-side: RLS está habilitado, não há policies públicas e `anon`/`authenticated` não têm privilégios diretos nas tabelas `crm_*`.

Este projeto **não é o Supabase do site da Sartec** e não deve reutilizar suas credenciais.
