import { getSupabaseCrmClient } from "../supabase-server.js";

function throwIfError(context, error) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

const SHADOW_RPCS = {
  customer: "crm_shadow_upsert_customer",
  conversation: "crm_shadow_upsert_conversation",
  message: "crm_shadow_upsert_message",
  pipeline: "crm_shadow_upsert_pipeline_order",
  setting: "crm_shadow_upsert_setting",
};

async function resolveRpc(client, rpc, args, signal) {
  let request = client.rpc(rpc, args);
  if (signal && typeof request?.abortSignal === "function") request = request.abortSignal(signal);
  return request;
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
    await this.writeShadowEntity("customer", customer, customer.shadow_revision ?? 0);
    return customer.id;
  }

  async upsertConversation(conversation) {
    await this.writeShadowEntity("conversation", conversation, conversation.shadow_revision ?? 0);
    return conversation.id;
  }

  async upsertMessages(messages, chunkSize = 200) {
    for (let index = 0; index < messages.length; index += chunkSize) {
      const chunk = messages.slice(index, index + chunkSize);
      await Promise.all(chunk.map((message) => this.writeShadowEntity(
        "message",
        message,
        message.shadow_revision ?? 0
      )));
    }
  }

  async upsertPipelineOrder(rows) {
    await Promise.all(rows.map((row) => this.writeShadowEntity(
      "pipeline",
      row,
      row.shadow_revision ?? 0
    )));
  }

  async upsertSetting(setting) {
    return this.writeShadowEntity("setting", setting, setting.shadow_revision ?? 0);
  }

  async writeShadowEntity(entityType, payload, shadowRevision, { signal } = {}) {
    const rpc = SHADOW_RPCS[entityType];
    if (!rpc) throw new Error(`Entidade shadow não suportada: ${entityType}`);
    const { data, error } = await resolveRpc(this.client, rpc, {
      p_payload: payload,
      p_shadow_revision: shadowRevision,
    }, signal);
    throwIfError(`Falha no RPC ${rpc}`, error);
    const status = Array.isArray(data) ? data[0]?.status || data[0] : data?.status || data;
    if (!status) throw new Error(`RPC ${rpc} retornou resposta vazia`);
    return { status };
  }
}
