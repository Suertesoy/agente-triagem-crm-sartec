alter table public.crm_customers
  add column shadow_revision bigint not null default 0 check (shadow_revision >= 0);

alter table public.crm_conversations
  add column shadow_revision bigint not null default 0 check (shadow_revision >= 0);

alter table public.crm_messages
  add column shadow_revision bigint not null default 0 check (shadow_revision >= 0);

alter table public.crm_pipeline_order
  add column shadow_revision bigint not null default 0 check (shadow_revision >= 0);

create table public.crm_settings (
  key text primary key,
  value jsonb not null,
  shadow_revision bigint not null default 0 check (shadow_revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.crm_settings enable row level security;

revoke all privileges on table public.crm_settings from public, anon, authenticated;
grant select, insert, update on table public.crm_customers to service_role;
grant select, insert, update on table public.crm_conversations to service_role;
grant select, insert, update on table public.crm_messages to service_role;
grant select, insert, update on table public.crm_pipeline_order to service_role;
grant select, insert, update on table public.crm_settings to service_role;

create or replace function public.crm_shadow_upsert_customer(
  p_payload jsonb,
  p_shadow_revision bigint
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_shadow_revision < 0 then raise exception 'shadow revision must be non-negative'; end if;
  insert into public.crm_customers (
    id, phone, whatsapp_name, client_name, client_type, demand_type, contact_notes,
    first_seen_at, last_seen_at, last_activity_at, last_conversation_status,
    last_pipeline_status, legacy_contact, created_at, updated_at, shadow_revision
  ) values (
    (p_payload->>'id')::uuid,
    p_payload->>'phone',
    p_payload->>'whatsapp_name',
    p_payload->>'client_name',
    coalesce(p_payload->>'client_type', 'unknown'),
    coalesce(p_payload->>'demand_type', 'outro'),
    p_payload->>'contact_notes',
    (p_payload->>'first_seen_at')::timestamptz,
    (p_payload->>'last_seen_at')::timestamptz,
    (p_payload->>'last_activity_at')::timestamptz,
    p_payload->>'last_conversation_status',
    p_payload->>'last_pipeline_status',
    p_payload->'legacy_contact',
    coalesce((p_payload->>'created_at')::timestamptz, now()),
    coalesce((p_payload->>'updated_at')::timestamptz, now()),
    p_shadow_revision
  )
  on conflict (phone) do update set
    whatsapp_name = excluded.whatsapp_name,
    client_name = excluded.client_name,
    client_type = excluded.client_type,
    demand_type = excluded.demand_type,
    contact_notes = excluded.contact_notes,
    first_seen_at = excluded.first_seen_at,
    last_seen_at = excluded.last_seen_at,
    last_activity_at = excluded.last_activity_at,
    last_conversation_status = excluded.last_conversation_status,
    last_pipeline_status = excluded.last_pipeline_status,
    legacy_contact = coalesce(excluded.legacy_contact, public.crm_customers.legacy_contact),
    updated_at = excluded.updated_at,
    shadow_revision = excluded.shadow_revision
  where excluded.shadow_revision > public.crm_customers.shadow_revision;
  get diagnostics affected = row_count;
  return case when affected = 0 then 'stale_ignored' else 'applied' end;
end;
$$;

create or replace function public.crm_shadow_upsert_conversation(
  p_payload jsonb,
  p_shadow_revision bigint
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_shadow_revision < 0 then raise exception 'shadow revision must be non-negative'; end if;
  insert into public.crm_conversations (
    id, customer_id, redis_key, status, pipeline_status, demand_type, client_type,
    card_title, priority_manual, data_limite, forma_entrega, endereco, observacoes,
    escola, serie, school_list, handoff_done, handoff_at, post_handoff_reply_sent,
    resolved_at, archived_at, last_activity_at, last_user_message_at, window_expires_at,
    template_waiting_reply, template_sent_at, last_template_type, last_template_name,
    last_template_message_id, last_template_delivery_status, last_template_status_at,
    last_template_error, active_attendant, active_attendant_at, source_mode,
    legacy_session, created_at, updated_at, shadow_revision
  ) values (
    (p_payload->>'id')::uuid,
    (p_payload->>'customer_id')::uuid,
    p_payload->>'redis_key',
    coalesce(p_payload->>'status', 'ativo'),
    coalesce(p_payload->>'pipeline_status', 'novo'),
    coalesce(p_payload->>'demand_type', 'outro'),
    coalesce(p_payload->>'client_type', 'unknown'),
    p_payload->>'card_title',
    p_payload->>'priority_manual',
    p_payload->>'data_limite',
    p_payload->>'forma_entrega',
    p_payload->>'endereco',
    p_payload->>'observacoes',
    p_payload->>'escola',
    p_payload->>'serie',
    p_payload->'school_list',
    coalesce((p_payload->>'handoff_done')::boolean, false),
    (p_payload->>'handoff_at')::timestamptz,
    coalesce((p_payload->>'post_handoff_reply_sent')::boolean, false),
    (p_payload->>'resolved_at')::timestamptz,
    (p_payload->>'archived_at')::timestamptz,
    (p_payload->>'last_activity_at')::timestamptz,
    (p_payload->>'last_user_message_at')::timestamptz,
    (p_payload->>'window_expires_at')::timestamptz,
    coalesce((p_payload->>'template_waiting_reply')::boolean, false),
    (p_payload->>'template_sent_at')::timestamptz,
    p_payload->>'last_template_type',
    p_payload->>'last_template_name',
    p_payload->>'last_template_message_id',
    p_payload->>'last_template_delivery_status',
    (p_payload->>'last_template_status_at')::timestamptz,
    p_payload->'last_template_error',
    p_payload->'active_attendant',
    (p_payload->>'active_attendant_at')::timestamptz,
    coalesce(p_payload->>'source_mode', 'cloud_api_legacy'),
    p_payload->'legacy_session',
    coalesce((p_payload->>'created_at')::timestamptz, now()),
    coalesce((p_payload->>'updated_at')::timestamptz, now()),
    p_shadow_revision
  )
  on conflict (redis_key) do update set
    customer_id = excluded.customer_id,
    status = excluded.status,
    pipeline_status = excluded.pipeline_status,
    demand_type = excluded.demand_type,
    client_type = excluded.client_type,
    card_title = excluded.card_title,
    priority_manual = excluded.priority_manual,
    data_limite = excluded.data_limite,
    forma_entrega = excluded.forma_entrega,
    endereco = excluded.endereco,
    observacoes = excluded.observacoes,
    escola = excluded.escola,
    serie = excluded.serie,
    school_list = excluded.school_list,
    handoff_done = excluded.handoff_done,
    handoff_at = excluded.handoff_at,
    post_handoff_reply_sent = excluded.post_handoff_reply_sent,
    resolved_at = excluded.resolved_at,
    archived_at = excluded.archived_at,
    last_activity_at = excluded.last_activity_at,
    last_user_message_at = excluded.last_user_message_at,
    window_expires_at = excluded.window_expires_at,
    template_waiting_reply = excluded.template_waiting_reply,
    template_sent_at = excluded.template_sent_at,
    last_template_type = excluded.last_template_type,
    last_template_name = excluded.last_template_name,
    last_template_message_id = excluded.last_template_message_id,
    last_template_delivery_status = excluded.last_template_delivery_status,
    last_template_status_at = excluded.last_template_status_at,
    last_template_error = excluded.last_template_error,
    active_attendant = excluded.active_attendant,
    active_attendant_at = excluded.active_attendant_at,
    source_mode = excluded.source_mode,
    legacy_session = coalesce(excluded.legacy_session, public.crm_conversations.legacy_session),
    updated_at = excluded.updated_at,
    shadow_revision = excluded.shadow_revision
  where excluded.shadow_revision > public.crm_conversations.shadow_revision;
  get diagnostics affected = row_count;
  return case when affected = 0 then 'stale_ignored' else 'applied' end;
end;
$$;

create or replace function public.crm_shadow_upsert_message(
  p_payload jsonb,
  p_shadow_revision bigint
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
  legacy_id uuid;
  legacy_revision bigint;
begin
  if p_shadow_revision < 0 then raise exception 'shadow revision must be non-negative'; end if;
  -- Uma mensagem historica sem Meta ID usa o indice legado como identidade. Quando
  -- o mesmo item recebe seu Meta ID no fluxo live, promove a linha existente para o
  -- UUID deterministico de Meta antes do upsert, sem criar uma segunda mensagem.
  if p_payload->>'meta_message_id' is not null
     and p_payload->>'legacy_history_index' is not null then
    select candidate.id, candidate.shadow_revision
    into legacy_id, legacy_revision
    from public.crm_messages candidate
    where candidate.conversation_id = (p_payload->>'conversation_id')::uuid
      and candidate.legacy_history_index = (p_payload->>'legacy_history_index')::integer
      and candidate.meta_message_id is null
    order by candidate.created_at nulls last, candidate.id
    limit 1;

    if legacy_id is not null and p_shadow_revision <= legacy_revision then
      return 'stale_ignored';
    end if;
    if legacy_id is not null and not exists (
      select 1 from public.crm_messages target
      where target.id = (p_payload->>'id')::uuid
    ) then
      update public.crm_messages
      set id = (p_payload->>'id')::uuid
      where id = legacy_id;
    end if;
  end if;
  insert into public.crm_messages (
    id, conversation_id, direction, role, source, message_type, content, content_json,
    meta_message_id, reply_to_meta_message_id, reply_to_from, sent_by_human,
    attendant_id, attendant_external_id, attendant_name, media_type, media_mime_type,
    media_filename, media_storage_key, media_storage_provider, media_storage_failed,
    media_deleted, media_unavailable, transcription, transcription_error, delivery_status,
    delivery_status_at, delivery_error, template_type, template_name, template_label,
    template_text, sent_by_template, reactions, raw_payload, created_at,
    legacy_history_index, legacy_payload_hash, shadow_revision
  ) values (
    (p_payload->>'id')::uuid,
    (p_payload->>'conversation_id')::uuid,
    p_payload->>'direction',
    p_payload->>'role',
    coalesce(p_payload->>'source', 'cloud_api'),
    coalesce(p_payload->>'message_type', 'text'),
    p_payload->>'content',
    p_payload->'content_json',
    p_payload->>'meta_message_id',
    p_payload->>'reply_to_meta_message_id',
    p_payload->>'reply_to_from',
    coalesce((p_payload->>'sent_by_human')::boolean, false),
    (p_payload->>'attendant_id')::uuid,
    p_payload->>'attendant_external_id',
    p_payload->>'attendant_name',
    p_payload->>'media_type',
    p_payload->>'media_mime_type',
    p_payload->>'media_filename',
    p_payload->>'media_storage_key',
    p_payload->>'media_storage_provider',
    coalesce((p_payload->>'media_storage_failed')::boolean, false),
    coalesce((p_payload->>'media_deleted')::boolean, false),
    coalesce((p_payload->>'media_unavailable')::boolean, false),
    p_payload->>'transcription',
    coalesce((p_payload->>'transcription_error')::boolean, false),
    p_payload->>'delivery_status',
    (p_payload->>'delivery_status_at')::timestamptz,
    p_payload->>'delivery_error',
    p_payload->>'template_type',
    p_payload->>'template_name',
    p_payload->>'template_label',
    p_payload->>'template_text',
    coalesce((p_payload->>'sent_by_template')::boolean, false),
    p_payload->'reactions',
    p_payload->'raw_payload',
    (p_payload->>'created_at')::timestamptz,
    (p_payload->>'legacy_history_index')::integer,
    p_payload->>'legacy_payload_hash',
    p_shadow_revision
  )
  on conflict (id) do update set
    conversation_id = excluded.conversation_id,
    direction = excluded.direction,
    role = excluded.role,
    source = excluded.source,
    message_type = excluded.message_type,
    content = excluded.content,
    content_json = excluded.content_json,
    meta_message_id = excluded.meta_message_id,
    reply_to_meta_message_id = excluded.reply_to_meta_message_id,
    reply_to_from = excluded.reply_to_from,
    sent_by_human = excluded.sent_by_human,
    attendant_id = excluded.attendant_id,
    attendant_external_id = excluded.attendant_external_id,
    attendant_name = excluded.attendant_name,
    media_type = excluded.media_type,
    media_mime_type = excluded.media_mime_type,
    media_filename = excluded.media_filename,
    media_storage_key = excluded.media_storage_key,
    media_storage_provider = excluded.media_storage_provider,
    media_storage_failed = excluded.media_storage_failed,
    media_deleted = excluded.media_deleted,
    media_unavailable = excluded.media_unavailable,
    transcription = excluded.transcription,
    transcription_error = excluded.transcription_error,
    delivery_status = excluded.delivery_status,
    delivery_status_at = excluded.delivery_status_at,
    delivery_error = excluded.delivery_error,
    template_type = excluded.template_type,
    template_name = excluded.template_name,
    template_label = excluded.template_label,
    template_text = excluded.template_text,
    sent_by_template = excluded.sent_by_template,
    reactions = excluded.reactions,
    raw_payload = excluded.raw_payload,
    created_at = excluded.created_at,
    legacy_history_index = excluded.legacy_history_index,
    legacy_payload_hash = excluded.legacy_payload_hash,
    shadow_revision = excluded.shadow_revision
  where excluded.shadow_revision > public.crm_messages.shadow_revision;
  get diagnostics affected = row_count;
  return case when affected = 0 then 'stale_ignored' else 'applied' end;
end;
$$;

create or replace function public.crm_shadow_upsert_pipeline_order(
  p_payload jsonb,
  p_shadow_revision bigint
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_shadow_revision < 0 then raise exception 'shadow revision must be non-negative'; end if;
  insert into public.crm_pipeline_order (
    client_type, column_key, phone_order, created_at, updated_at, shadow_revision
  ) values (
    p_payload->>'client_type',
    p_payload->>'column_key',
    coalesce(p_payload->'phone_order', '[]'::jsonb),
    coalesce((p_payload->>'created_at')::timestamptz, now()),
    coalesce((p_payload->>'updated_at')::timestamptz, now()),
    p_shadow_revision
  )
  on conflict (client_type, column_key) do update set
    phone_order = excluded.phone_order,
    updated_at = excluded.updated_at,
    shadow_revision = excluded.shadow_revision
  where excluded.shadow_revision > public.crm_pipeline_order.shadow_revision;
  get diagnostics affected = row_count;
  return case when affected = 0 then 'stale_ignored' else 'applied' end;
end;
$$;

create or replace function public.crm_shadow_upsert_setting(
  p_payload jsonb,
  p_shadow_revision bigint
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_shadow_revision < 0 then raise exception 'shadow revision must be non-negative'; end if;
  insert into public.crm_settings (key, value, created_at, updated_at, shadow_revision)
  values (
    p_payload->>'key',
    coalesce(p_payload->'value', 'null'::jsonb),
    coalesce((p_payload->>'created_at')::timestamptz, now()),
    coalesce((p_payload->>'updated_at')::timestamptz, now()),
    p_shadow_revision
  )
  on conflict (key) do update set
    value = excluded.value,
    updated_at = excluded.updated_at,
    shadow_revision = excluded.shadow_revision
  where excluded.shadow_revision > public.crm_settings.shadow_revision;
  get diagnostics affected = row_count;
  return case when affected = 0 then 'stale_ignored' else 'applied' end;
end;
$$;

revoke execute on function public.crm_shadow_upsert_customer(jsonb, bigint) from public, anon, authenticated;
revoke execute on function public.crm_shadow_upsert_conversation(jsonb, bigint) from public, anon, authenticated;
revoke execute on function public.crm_shadow_upsert_message(jsonb, bigint) from public, anon, authenticated;
revoke execute on function public.crm_shadow_upsert_pipeline_order(jsonb, bigint) from public, anon, authenticated;
revoke execute on function public.crm_shadow_upsert_setting(jsonb, bigint) from public, anon, authenticated;

grant execute on function public.crm_shadow_upsert_customer(jsonb, bigint) to service_role;
grant execute on function public.crm_shadow_upsert_conversation(jsonb, bigint) to service_role;
grant execute on function public.crm_shadow_upsert_message(jsonb, bigint) to service_role;
grant execute on function public.crm_shadow_upsert_pipeline_order(jsonb, bigint) to service_role;
grant execute on function public.crm_shadow_upsert_setting(jsonb, bigint) to service_role;

comment on column public.crm_customers.shadow_revision is 'Revisao monotônica por entidade para rejeitar shadow writes fora de ordem.';
comment on table public.crm_settings is 'Configuracoes institucionais do CRM; acesso exclusivo do backend service_role.';
