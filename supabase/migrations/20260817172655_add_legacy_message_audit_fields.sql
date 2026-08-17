alter table public.crm_messages
  alter column created_at drop not null,
  add column legacy_history_index integer,
  add column legacy_payload_hash text;

create index crm_messages_conversation_legacy_history_idx
  on public.crm_messages (conversation_id, legacy_history_index)
  where legacy_history_index is not null;
