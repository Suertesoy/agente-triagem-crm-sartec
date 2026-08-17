create table public.crm_customers (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  whatsapp_name text,
  client_name text,
  client_type text not null default 'unknown' check (client_type in ('pf','pj','unknown')),
  demand_type text not null default 'outro' check (demand_type in ('outro','lista','cotacao_pj','xerox','produto','duvida')),
  contact_notes text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  last_activity_at timestamptz,
  last_conversation_status text,
  last_pipeline_status text,
  legacy_contact jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crm_attendants (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  name text not null,
  is_active boolean not null default true,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crm_channel_accounts (
  id uuid primary key default gen_random_uuid(),
  channel text not null default 'whatsapp',
  business_name text not null default 'Sartec Papelaria',
  business_phone text,
  mode text not null check (mode in ('cloud_api_legacy','business_app_transition','coexistence','other')),
  meta_waba_id text,
  meta_phone_number_id text,
  meta_app_id text,
  is_active boolean not null default false,
  started_at timestamptz,
  ended_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crm_conversations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.crm_customers(id) on delete restrict,
  redis_key text unique,
  status text not null default 'ativo',
  pipeline_status text not null default 'novo',
  demand_type text not null default 'outro',
  client_type text not null default 'unknown' check (client_type in ('pf','pj','unknown')),
  card_title text,
  priority_manual text,
  data_limite text,
  forma_entrega text,
  endereco text,
  observacoes text,
  escola text,
  serie text,
  school_list jsonb,
  handoff_done boolean not null default false,
  handoff_at timestamptz,
  post_handoff_reply_sent boolean not null default false,
  resolved_at timestamptz,
  archived_at timestamptz,
  last_activity_at timestamptz,
  last_user_message_at timestamptz,
  window_expires_at timestamptz,
  template_waiting_reply boolean not null default false,
  template_sent_at timestamptz,
  last_template_type text,
  last_template_name text,
  last_template_message_id text,
  last_template_delivery_status text,
  last_template_status_at timestamptz,
  last_template_error jsonb,
  active_attendant jsonb,
  active_attendant_at timestamptz,
  source_mode text not null default 'cloud_api_legacy',
  legacy_session jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.crm_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.crm_conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound','system')),
  role text not null check (role in ('user','assistant','system')),
  source text not null default 'cloud_api' check (source in ('cloud_api','whatsapp_business_app','history_sync','site','agent','human_crm','template','system','legacy_import')),
  message_type text not null default 'text',
  content text,
  content_json jsonb,
  meta_message_id text,
  reply_to_meta_message_id text,
  reply_to_from text,
  sent_by_human boolean not null default false,
  attendant_id uuid references public.crm_attendants(id) on delete set null,
  attendant_external_id text,
  attendant_name text,
  media_type text,
  media_mime_type text,
  media_filename text,
  media_storage_key text,
  media_storage_provider text,
  media_storage_failed boolean not null default false,
  media_deleted boolean not null default false,
  media_unavailable boolean not null default false,
  transcription text,
  transcription_error boolean not null default false,
  delivery_status text,
  delivery_status_at timestamptz,
  delivery_error text,
  template_type text,
  template_name text,
  template_label text,
  template_text text,
  sent_by_template boolean not null default false,
  reactions jsonb,
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create table public.crm_pipeline_order (
  id uuid primary key default gen_random_uuid(),
  client_type text not null check (client_type in ('pf','pj')),
  column_key text not null,
  phone_order jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_type, column_key)
);

create table public.crm_migration_runs (
  id uuid primary key default gen_random_uuid(),
  migration_type text not null,
  source text not null,
  status text not null check (status in ('planned','running','completed','failed','rolled_back')),
  counters jsonb not null default '{}'::jsonb,
  checksum text,
  notes text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index crm_messages_meta_message_id_uidx
  on public.crm_messages(meta_message_id)
  where meta_message_id is not null;

create index crm_customers_last_activity_idx on public.crm_customers(last_activity_at desc nulls last);
create index crm_conversations_customer_idx on public.crm_conversations(customer_id);
create index crm_conversations_status_idx on public.crm_conversations(status, pipeline_status);
create index crm_conversations_activity_idx on public.crm_conversations(last_activity_at desc nulls last);
create index crm_messages_conversation_created_idx on public.crm_messages(conversation_id, created_at);
create index crm_messages_source_idx on public.crm_messages(source, created_at desc);
create index crm_messages_delivery_status_idx on public.crm_messages(delivery_status) where delivery_status is not null;
create unique index crm_channel_accounts_one_active_whatsapp_uidx
  on public.crm_channel_accounts(channel)
  where is_active = true;

alter table public.crm_customers enable row level security;
alter table public.crm_attendants enable row level security;
alter table public.crm_channel_accounts enable row level security;
alter table public.crm_conversations enable row level security;
alter table public.crm_messages enable row level security;
alter table public.crm_pipeline_order enable row level security;
alter table public.crm_migration_runs enable row level security;

comment on table public.crm_customers is 'Fonte institucional de clientes/contatos do CRM Sartec.';
comment on table public.crm_conversations is 'Atendimentos do CRM, separados do estado efemero mantido no Redis durante a transicao.';
comment on table public.crm_messages is 'Historico permanente de mensagens, com origem preparada para Cloud API e futura Coexistence.';
comment on table public.crm_channel_accounts is 'Historico das identidades/canais Meta usados pelo numero comercial da Sartec.';
comment on table public.crm_migration_runs is 'Auditoria das importacoes Redis e futuras migracoes de canal.';
