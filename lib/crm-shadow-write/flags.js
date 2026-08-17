export const DEFAULT_SHADOW_TIMEOUT_MS = 2000;

function parseBooleanFlag(name, env, logger) {
  const raw = env[name];
  if (raw == null || raw === "") return { value: false, valid: true };
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "true") return { value: true, valid: true };
  if (normalized === "false") return { value: false, valid: true };
  logger?.warn?.(`[crm-shadow] ${name} inválida; shadow write permanece desligado.`);
  return { value: false, valid: false };
}

export function getCrmShadowFlags(env = process.env, logger = console) {
  const crm = parseBooleanFlag("SUPABASE_CRM_ENABLED", env, logger);
  const dual = parseBooleanFlag("SUPABASE_DUAL_WRITE", env, logger);
  const valid = crm.valid && dual.valid && (!dual.value || crm.value);
  if (dual.value && !crm.value) {
    logger?.warn?.(
      "[crm-shadow] SUPABASE_DUAL_WRITE requer SUPABASE_CRM_ENABLED=true; shadow write permanece desligado."
    );
  }
  return {
    crmEnabled: crm.value,
    dualWriteRequested: dual.value,
    dualWriteEnabled: valid && crm.value && dual.value,
    valid,
  };
}

export function getCrmShadowTimeoutMs(env = process.env, logger = console) {
  const raw = env.SUPABASE_SHADOW_TIMEOUT_MS;
  if (raw == null || raw === "") return DEFAULT_SHADOW_TIMEOUT_MS;
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    logger?.warn?.(
      `[crm-shadow] SUPABASE_SHADOW_TIMEOUT_MS inválida; usando ${DEFAULT_SHADOW_TIMEOUT_MS}ms.`
    );
    return DEFAULT_SHADOW_TIMEOUT_MS;
  }
  return timeoutMs;
}
