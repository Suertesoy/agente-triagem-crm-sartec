#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { drainShadowOutbox } from "../lib/crm-shadow-write/index.js";

export async function reconcileCrmShadow({ redis, store, batchSize = 25, env, logger = console }) {
  if (!redis || !store) throw new Error("Reconciliador requer Redis e store injetados");
  return drainShadowOutbox({ redis, store, batchSize, env, logger });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(
    "Reconciliador shadow preparado para execução injetada/fake; conexão de produção permanece desabilitada nesta etapa."
  );
}
