import { createClient } from "@supabase/supabase-js";
import { getCrmShadowFlags } from "./crm-shadow-write/flags.js";

let supabaseCrmClient = null;
export const SUPABASE_CRM_PROJECT_REF = "uzwyzwbybtnvgjjhimwy";

export function isSupabaseCrmEnabled(env = process.env) {
  return String(env.SUPABASE_CRM_ENABLED || "").toLowerCase() === "true";
}

export function isSupabaseDualWriteEnabled(env = process.env, logger = console) {
  return getCrmShadowFlags(env, logger).dualWriteEnabled;
}

export function assertSupabaseCrmTarget(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("SUPABASE_CRM_URL inválida.");
  }
  if (hostname !== `${SUPABASE_CRM_PROJECT_REF}.supabase.co`) {
    throw new Error(
      `Destino Supabase recusado: esperado o projeto Sartec CRM (${SUPABASE_CRM_PROJECT_REF}).`
    );
  }
}

export function getSupabaseCrmClient() {
  if (!isSupabaseCrmEnabled()) {
    throw new Error(
      "Supabase CRM está desabilitado. Defina SUPABASE_CRM_ENABLED=true somente em uma execução administrativa autorizada."
    );
  }

  const url = process.env.SUPABASE_CRM_URL;
  const serviceRoleKey = process.env.SUPABASE_CRM_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Configuração do Supabase CRM incompleta: SUPABASE_CRM_URL e SUPABASE_CRM_SERVICE_ROLE_KEY são obrigatórias."
    );
  }
  assertSupabaseCrmTarget(url);

  if (!supabaseCrmClient) {
    supabaseCrmClient = createClient(url, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }

  return supabaseCrmClient;
}
