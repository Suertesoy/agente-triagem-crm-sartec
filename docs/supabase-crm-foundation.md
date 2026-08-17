# Fundação Supabase do CRM Sartec

## Separação de responsabilidades

- **Redis** continua sendo a fonte operacional do CRM nesta etapa. Sessões, locks, janela de 24 horas, debounce, configurações e ordem do pipeline não mudaram.
- **Supabase CRM** será a persistência institucional de clientes, conversas, mensagens, atendentes, canal, pipeline e auditoria. A integração criada aqui é administrativa; nenhum endpoint atual depende dela.
- **Cloudflare R2** continua armazenando imagens, áudios, PDFs e outros documentos. O Supabase armazena apenas referências e metadados. Não foi criado Supabase Storage.

Projeto de destino: **Sartec CRM**, ref `uzwyzwbybtnvgjjhimwy`, região `sa-east-1`, organização Sartec Digital.

> Este projeto **não é o Supabase do site da Sartec**. Não reutilize URL, service role ou qualquer outra credencial do site.

## Feature flag e variáveis

```dotenv
SUPABASE_CRM_ENABLED=false
SUPABASE_CRM_URL=https://uzwyzwbybtnvgjjhimwy.supabase.co
SUPABASE_CRM_SERVICE_ROLE_KEY=replace-with-sartec-crm-service-role-key
```

O padrão é desligado. O cliente só é criado server-side, com persistência e renovação de sessão desativadas. A service role não pode usar prefixo `NEXT_PUBLIC_`, aparecer no painel ou ser registrada em logs.

Além da flag, o cliente recusa qualquer URL cujo host não seja `uzwyzwbybtnvgjjhimwy.supabase.co`. Essa trava evita apontar acidentalmente para o Supabase do site ou para outro projeto.

## Chaves Redis auditadas

| Chave | Papel atual | Destino previsto |
|---|---|---|
| `sartec:{phone}` | sessão e histórico principal (TTL 90 dias) | `crm_conversations` + `crm_messages` |
| `sartec:contact:{phone}` | identidade e resumo permanente do contato | `crm_customers` |
| `sartec:pipelineOrder` | ordem manual por `clientType:columnKey` | `crm_pipeline_order` |
| `sartec:pending_status:{metaMessageId}` | corrida temporária de callbacks Meta | permanece Redis |
| `sartec:settings:pjLunchMode` | configuração operacional temporária | permanece Redis |
| `sartec:settings:quickMessages` | respostas rápidas do painel | permanece Redis nesta etapa |
| `sartec:budget_draft:{phone}:{messageId}` | rascunho temporário de orçamento | permanece Redis |
| `sartec:archive:{phone}:{timestamp}` | formato legado de arquivo, sem novas gravações | legível pelo migrador apenas em etapa futura |
| `lock:sartec:{phone}` e `lock:sartec:settings:quickMessages` | coordenação/concorrência | permanece Redis |

O migrador desta etapa lê somente contatos, sessões principais e `sartec:pipelineOrder`. Archives, settings, locks, pendências e rascunhos não são tratados como sessões.

## Mapeamento

- O telefone é normalizado para 10–15 dígitos, preservando o formato numérico usado nas chaves atuais.
- `sartec:contact:{phone}` vira uma linha de `crm_customers`; o JSON original fica em `legacy_contact`.
- `sartec:{phone}` vira uma linha de `crm_conversations`; `legacy_session` preserva os demais campos originais, mas não duplica `history`. Em seu lugar ficam `legacyHistoryAudit.count` e o checksum SHA-256 canônico do histórico.
- Cada item de `session.history` vira uma linha de `crm_messages`, com a posição original em `legacy_history_index`. Mensagens sem timestamp enviam `created_at: null`, sem inventar data.
- `metaMessageId` é a identidade preferencial da mensagem. Sem ele, o mapper usa de forma determinística `legacy:{phone}:{legacyHistoryIndex}`. O SHA-256 canônico do payload original fica separado em `legacy_payload_hash` para auditoria.
- IDs determinísticos de cliente, conversa e mensagem tornam reexecuções idempotentes. O banco também mantém índices únicos em `phone`, `redis_key` e `meta_message_id` quando presente.
- IDs de atendente do painel são preservados em `attendant_external_id`; não são forçados para o UUID institucional de `crm_attendants`.
- `mediaStorageKey` e `mediaStorageProvider` continuam apontando para o R2. Base64 legado não entra em `raw_payload`, `content_json` nem `legacy_session`; em seu lugar ficam presença, tamanho em bytes, SHA-256 e a referência de storage. A origem Redis não é alterada pelo dry-run. Base64 sem referência R2 válida bloqueia `--commit`.

Foram encontrados **12 formatos lógicos possíveis** no histórico: texto inbound, texto outbound do agente, texto outbound humano, nota interna `internal_note`, imagem inbound, imagem outbound humana, documento inbound, documento outbound humano, áudio inbound, template, evento `template_status` e evento `reaction_event`.

Campos observados sem coluna normalizada dedicada ficam preservados no JSON legado e aparecem no dry-run. Entre eles:

- sessão: `audioCount`, `lastDate`, `historySummary`, `lastHumanReply`, `previousResolvedAt`, `currentCycleStartedAt`, `proactiveNote`, `requestSource`, `pjLunchAutoReplySentFor` e `pjLunchAutoReplySentAt`;
- mensagem: `mediaData` (persistido somente como metadados de auditoria), `mediaSize`, `sentMedia`, `pjLunchAutoReply`, `templateStatus`, `relatedMessageId`, campos avulsos de `reaction_event` e metadados de remoção da mídia.

Esses campos não exigem alteração imediata do banco porque continuam preservados em `legacy_session`/`raw_payload`. Antes do dual write, vale decidir se metadados de exclusão e eventos de reação/template merecem colunas próprias.

Repetições normalizadas equivalentes do mesmo ID são consolidadas e contadas como `exactDuplicates`. Diferenças materiais são contadas como `duplicateConflicts`, com amostras no diagnóstico, e bloqueiam `--commit`. IDs repetidos entre conversas também bloqueiam a importação.

## Janela de 24 horas e templates

`lastUserMessageAt` e `windowExpiresAt` são copiados sem recalcular. No sistema atual, somente mensagens do cliente renovam a janela; mensagens do bot ou atendente não renovam. Se a janela expirou e existe um template posterior à última mensagem do cliente, o painel mostra `waiting_template_reply`. Nada disso foi alterado.

Templates preservam tipo, nome, rótulo, texto renderizado, Meta ID e estados `accepted`, `sent`, `delivered`, `read` ou `failed`. Callbacks podem ser guardados temporariamente em `sartec:pending_status:*` antes de a mensagem aparecer no histórico.

## Dry-run e importação futura

Com as variáveis do Redis disponíveis:

```bash
node scripts/migrate-redis-to-supabase.js
```

Esse comando somente lê o Redis e imprime contagens, inválidos, campos sem mapeamento, duplicatas exatas/conflitantes, métricas de base64 legado e checksum. Ele não cria o cliente Supabase.

Uma escrita futura exige as três variáveis específicas do CRM e duas confirmações explícitas:

```bash
SUPABASE_CRM_ENABLED=true node scripts/migrate-redis-to-supabase.js --commit
```

O modo commit registra início, conclusão/falha, contadores e checksum em `crm_migration_runs`. Ele é recusado se houver JSON, sessão, item de histórico ou pipeline inválido; duplicata entre conversas; duplicata conflitante; ou base64 legado sem R2 válido. Não execute antes de revisar o dry-run e validar as credenciais do projeto `uzwyzwbybtnvgjjhimwy`.

## Resgate administrativo de mídia legada

`node scripts/rescue-legacy-media-to-r2.js` é sempre dry-run por padrão. Ele inventaria somente mensagens que ainda contêm base64 e não têm referência R2 válida, valida o SHA-256, resolve MIME/extensão segura e gera uma chave determinística no bucket R2 já configurado.

Uma execução futura com `--commit` fará `HEAD` antes do upload, reutilizará apenas objetos com tamanho, MIME e SHA compatíveis e atualizará o Redis sob `lock:sartec:{phone}`. A sessão é relida antes e depois do upload; uma referência que apareça durante a operação nunca é sobrescrita. `mediaData` e `content[].source.data` permanecem no Redis nesta primeira etapa para rollback.

## Schema versionado

As quatro migrations em `supabase/migrations` correspondem ao histórico remoto aplicado. A incremental `20260817175639_add_legacy_message_audit_fields.sql` torna `crm_messages.created_at` anulável mantendo seu default, adiciona os dois campos de auditoria legada e o índice por conversa/posição. RLS permanece ativo, não há policies públicas e privilégios diretos de `anon`/`authenticated` permanecem revogados.
