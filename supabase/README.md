# Schema Supabase — Sartec CRM

Este diretório versiona o schema já aplicado ao projeto **Sartec CRM** (`uzwyzwbybtnvgjjhimwy`, `sa-east-1`). Ele foi reconstruído a partir do histórico de migrations e do catálogo remoto em 17/08/2026.

Estas migrations representam o estado remoto existente. Não execute `db push`, `db reset`, `migration repair` ou reaplique os arquivos contra produção sem uma revisão explícita do histórico remoto.

O acesso permanece exclusivamente server-side: RLS está habilitado, não há policies públicas e `anon`/`authenticated` não têm privilégios diretos nas tabelas `crm_*`.

Este projeto **não é o Supabase do site da Sartec** e não deve reutilizar suas credenciais.
