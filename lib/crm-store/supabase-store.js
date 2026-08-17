import { getSupabaseCrmClient } from "../supabase-server.js";

function throwIfError(context, error) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export class SupabaseCrmStore {
  constructor(client = getSupabaseCrmClient()) {
    this.client = client;
  }

  async startMigrationRun({ source, counters, checksum, notes }) {
    const { data, error } = await this.client
      .from("crm_migration_runs")
      .insert({
        migration_type: "redis_to_supabase",
        source,
        status: "running",
        counters,
        checksum,
        notes,
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    throwIfError("Falha ao iniciar crm_migration_runs", error);
    return data.id;
  }

  async finishMigrationRun(id, { status, counters, checksum, notes }) {
    const { error } = await this.client
      .from("crm_migration_runs")
      .update({
        status,
        counters,
        checksum,
        notes,
        completed_at: new Date().toISOString(),
      })
      .eq("id", id);
    throwIfError("Falha ao finalizar crm_migration_runs", error);
  }

  async upsertCustomer(customer) {
    const { data, error } = await this.client
      .from("crm_customers")
      .upsert(customer, { onConflict: "phone" })
      .select("id")
      .single();
    throwIfError(`Falha ao importar cliente ${customer.phone}`, error);
    return data.id;
  }

  async upsertConversation(conversation) {
    const { data, error } = await this.client
      .from("crm_conversations")
      .upsert(conversation, { onConflict: "redis_key" })
      .select("id")
      .single();
    throwIfError(`Falha ao importar conversa ${conversation.redis_key}`, error);
    return data.id;
  }

  async upsertMessages(messages, chunkSize = 200) {
    for (let index = 0; index < messages.length; index += chunkSize) {
      const chunk = messages.slice(index, index + chunkSize);
      const { error } = await this.client
        .from("crm_messages")
        .upsert(chunk, { onConflict: "id" });
      throwIfError(`Falha ao importar lote de mensagens ${index / chunkSize + 1}`, error);
    }
  }

  async upsertPipelineOrder(rows) {
    if (!rows.length) return;
    const { error } = await this.client
      .from("crm_pipeline_order")
      .upsert(rows, { onConflict: "client_type,column_key" });
    throwIfError("Falha ao importar ordem do pipeline", error);
  }
}
