import {
  listShadowOutbox,
  recordShadowFailureCas,
  removeShadowReceiptCas,
} from "./redis-outbox.js";
import { withCancelableTimeout } from "./timeout.js";

const CONFIRMED_STATUSES = new Set(["applied", "stale_ignored"]);
const RECONCILIATION_STATUSES = new Set(["duplicate_requires_reconciliation", "identity_conflict"]);

export async function flushShadowReceipt({ redis, receipt, store, timeoutMs }) {
  try {
    const result = await withCancelableTimeout(
      (signal) => store.writeShadowEntity(
        receipt.entityType,
        receipt.payload,
        receipt.shadowRevision,
        { signal }
      ),
      timeoutMs
    );
    const status = result?.status || result;
    if (RECONCILIATION_STATUSES.has(status)) {
      const error = new Error(`Shadow requer reconciliação explícita: ${status}`);
      await recordShadowFailureCas(redis, receipt, error);
      return { status: "conflict", detail: status, removed: false };
    }
    if (!CONFIRMED_STATUSES.has(status)) {
      throw new Error(`Resposta shadow inesperada: ${status || "vazia"}`);
    }
    const removed = await removeShadowReceiptCas(redis, receipt);
    return { status, removed: removed === 1 };
  } catch (error) {
    await recordShadowFailureCas(redis, receipt, error);
    return { status: "failed", removed: false, error };
  }
}

export async function drainShadowOutbox({
  redis,
  store,
  timeoutMs,
  batchSize = 25,
  logger = console,
}) {
  const receipts = await listShadowOutbox(redis, { limit: batchSize });
  const summary = { scanned: receipts.length, applied: 0, staleIgnored: 0, conflicts: 0, failed: 0, removed: 0 };
  for (const receipt of receipts) {
    const result = await flushShadowReceipt({ redis, receipt, store, timeoutMs });
    if (result.status === "applied") summary.applied += 1;
    else if (result.status === "stale_ignored") summary.staleIgnored += 1;
    else if (result.status === "conflict") summary.conflicts += 1;
    else summary.failed += 1;
    if (result.removed) summary.removed += 1;
  }
  logger?.log?.(`[crm-shadow] backlog: scanned=${summary.scanned} removed=${summary.removed} failed=${summary.failed}`);
  return summary;
}
