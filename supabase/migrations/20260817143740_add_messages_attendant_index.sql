create index crm_messages_attendant_idx on public.crm_messages(attendant_id) where attendant_id is not null;
