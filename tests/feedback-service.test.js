// Testes unitários do subsistema de pós-venda (Gate 1): elegibilidade,
// cálculo do próximo dia útil às 10h em America/Sao_Paulo, e criação do
// registro de feedback + agendamento no sorted set sartec:feedback:due.
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import FakeRedis from "./helpers/fake-ioredis.js";
import {
  FEEDBACK_DUE_ZSET_KEY,
  FEEDBACK_TTL_SECONDS,
  MAX_PENDING_POST_SALE_FEEDBACKS,
  addPendingPostSaleFeedback,
  createScheduledFeedback,
  ensureFeedbackForResolution,
  feedbackKey,
  getNextFeedbackSchedule,
  isEligibleForFeedback,
  resolveClientTypeForFeedback,
} from "../api/_lib/feedback-service.js";

beforeEach(() => FakeRedis._reset());

describe("isEligibleForFeedback", () => {
  test("PF finalizado é elegível", () => {
    assert.equal(isEligibleForFeedback({ clientType: "pf", pipelineStatus: "finalizado" }), true);
  });
  test("PJ entregue é elegível", () => {
    assert.equal(isEligibleForFeedback({ clientType: "pj", pipelineStatus: "entregue" }), true);
  });
  test("PF em estágio intermediário não é elegível", () => {
    for (const pipelineStatus of ["novo", "em_atendimento", "orcamento_enviado", "confirmado"]) {
      assert.equal(isEligibleForFeedback({ clientType: "pf", pipelineStatus }), false);
    }
  });
  test("PJ em estágio intermediário não é elegível", () => {
    for (const pipelineStatus of ["novo", "em_cotacao", "proposta_enviada", "confirmado"]) {
      assert.equal(isEligibleForFeedback({ clientType: "pj", pipelineStatus }), false);
    }
  });
  test("PF entregue (status do outro pipeline) não é elegível", () => {
    assert.equal(isEligibleForFeedback({ clientType: "pf", pipelineStatus: "entregue" }), false);
  });
  test("PJ finalizado (status do outro pipeline) não é elegível", () => {
    assert.equal(isEligibleForFeedback({ clientType: "pj", pipelineStatus: "finalizado" }), false);
  });
});

describe("resolveClientTypeForFeedback", () => {
  test("usa session.clientType quando presente", () => {
    assert.equal(resolveClientTypeForFeedback({ clientType: "pj", demandType: "produto" }), "pj");
  });
  test("fallback para pj quando demandType é cotacao_pj", () => {
    assert.equal(resolveClientTypeForFeedback({ demandType: "cotacao_pj" }), "pj");
  });
  test("fallback para pf em qualquer outro caso", () => {
    assert.equal(resolveClientTypeForFeedback({ demandType: "lista" }), "pf");
    assert.equal(resolveClientTypeForFeedback({}), "pf");
  });
});

// Âncora verificada de forma independente: 2024-01-01 é uma segunda-feira
// (2000-01-01 é sábado — fato de referência amplamente documentado — e
// 2000-01-01 → 2024-01-01 soma 8766 dias, 8766 mod 7 = 2; sábado + 2 = segunda).
describe("getNextFeedbackSchedule — próximo dia útil às 10h em America/Sao_Paulo", () => {
  const CASES = [
    { label: "segunda → terça",  from: "2024-01-01T15:00:00-03:00", expected: "2024-01-02T13:00:00.000Z" },
    { label: "quinta → sexta",   from: "2024-01-04T09:00:00-03:00", expected: "2024-01-05T13:00:00.000Z" },
    { label: "sexta → segunda",  from: "2024-01-05T23:59:00-03:00", expected: "2024-01-08T13:00:00.000Z" },
    { label: "sábado → segunda", from: "2024-01-06T12:00:00-03:00", expected: "2024-01-08T13:00:00.000Z" },
    { label: "domingo → segunda", from: "2024-01-07T00:00:01-03:00", expected: "2024-01-08T13:00:00.000Z" },
  ];

  for (const { label, from, expected } of CASES) {
    test(label, () => {
      const result = getNextFeedbackSchedule(new Date(from));
      assert.equal(result.toISOString(), expected);
    });
  }

  test("resultado sempre cai às 13:00:00.000Z (10h São Paulo, UTC-3 fixo)", () => {
    const result = getNextFeedbackSchedule(new Date("2024-01-01T15:00:00-03:00"));
    assert.equal(result.getUTCHours(), 13);
    assert.equal(result.getUTCMinutes(), 0);
    assert.equal(result.getUTCSeconds(), 0);
  });
});

describe("createScheduledFeedback", () => {
  test("cria o registro em sartec:feedback:<id> e agenda em sartec:feedback:due", async () => {
    const redis = new FakeRedis();
    const record = await createScheduledFeedback(redis, {
      phone: "5512999990000",
      clientName: "Cliente Teste",
      clientType: "pf",
      demandType: "lista",
      saleCompletedAt: new Date("2024-01-01T15:00:00-03:00"),
    });

    assert.equal(typeof record.id, "string");
    assert.match(record.id, /^[0-9a-f-]{36}$/i);
    assert.equal(record.phone, "5512999990000");
    assert.equal(record.clientType, "pf");
    assert.equal(record.status, "scheduled");
    assert.equal(record.templateSentAt, null);
    assert.equal(record.storeRating, null);
    assert.equal(record.scheduledAt, "2024-01-02T13:00:00.000Z");

    const raw = await redis.get(feedbackKey(record.id));
    assert.deepEqual(JSON.parse(raw), record);

    const score = await redis.zscore(FEEDBACK_DUE_ZSET_KEY, record.id);
    assert.equal(Number(score), new Date(record.scheduledAt).getTime());
    assert.equal(await redis.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
  });

  test("TTL do registro é de ~365 dias e não reaproveita o TTL de sessão (90 dias)", () => {
    assert.equal(FEEDBACK_TTL_SECONDS, 60 * 60 * 24 * 365);
  });

  test("duas chamadas geram feedbackIds diferentes na fila", async () => {
    const redis = new FakeRedis();
    const a = await createScheduledFeedback(redis, { phone: "5512900000001", clientType: "pf", saleCompletedAt: new Date() });
    const b = await createScheduledFeedback(redis, { phone: "5512900000001", clientType: "pf", saleCompletedAt: new Date() });

    assert.notEqual(a.id, b.id);
    assert.equal(await redis.zcard(FEEDBACK_DUE_ZSET_KEY), 2);
  });
});

describe("ensureFeedbackForResolution — materialização idempotente por resolutionId", () => {
  test("cria registro + membro na fila quando nada existe ainda", async () => {
    const redis = new FakeRedis();
    const { record, repaired } = await ensureFeedbackForResolution(redis, {
      resolutionId: "res-a", phone: "5512900000004",
      clientType: "pj", demandType: "cotacao_pj", saleCompletedAt: new Date().toISOString(),
    });
    assert.equal(record.id, "res-a");
    assert.equal(repaired, false);
    assert.equal(await redis.get(feedbackKey("res-a")), JSON.stringify(record));
    assert.notEqual(await redis.zscore(FEEDBACK_DUE_ZSET_KEY, "res-a"), null);
    assert.equal(await redis.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
  });

  test("idempotente: chamar de novo com o mesmo resolutionId não duplica nem sobrescreve o agendamento", async () => {
    const redis = new FakeRedis();
    const first = await ensureFeedbackForResolution(redis, {
      resolutionId: "res-b", phone: "5512900000005",
      clientType: "pf", saleCompletedAt: "2024-01-01T15:00:00-03:00",
    });
    const second = await ensureFeedbackForResolution(redis, {
      resolutionId: "res-b", phone: "5512900000005",
      clientType: "pf", saleCompletedAt: new Date().toISOString(), // mesmo se a "agora" mudar
    });
    assert.equal(second.repaired, false);
    assert.deepEqual(second.record, first.record);
    assert.equal(await redis.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
  });

  test("repara a fila quando o registro existe mas o ZSET não contém o membro (falha entre SET e ZADD)", async () => {
    const redis = new FakeRedis();
    // Constrói diretamente o estado de falha parcial: registro persistido,
    // mas o ZADD correspondente nunca aconteceu (como se tivesse lançado).
    const scheduledAt = new Date("2024-01-05T13:00:00.000Z");
    const orphanRecord = {
      id: "res-c", phone: "5512900000006", clientName: null, clientType: "pf", demandType: null,
      saleCompletedAt: new Date("2024-01-04T09:00:00-03:00").toISOString(),
      scheduledAt: scheduledAt.toISOString(), status: "scheduled",
      templateSentAt: null, storeRating: null, agentRating: null, improvementComment: null,
      answeredAt: null, completedAt: null, googleInviteSentAt: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    await redis.set(feedbackKey("res-c"), JSON.stringify(orphanRecord), "EX", FEEDBACK_TTL_SECONDS);
    assert.equal(await redis.zscore(FEEDBACK_DUE_ZSET_KEY, "res-c"), null);

    const result = await ensureFeedbackForResolution(redis, {
      resolutionId: "res-c", phone: "5512900000006", clientType: "pf",
    });

    assert.equal(result.repaired, true);
    assert.equal(result.record.id, "res-c");
    assert.equal(await redis.zscore(FEEDBACK_DUE_ZSET_KEY, "res-c"), String(scheduledAt.getTime()));
    assert.equal(await redis.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
    // não duplicou nem reescreveu o registro já existente
    assert.equal(JSON.parse(await redis.get(feedbackKey("res-c"))).createdAt, orphanRecord.createdAt);
  });

  test("recria o registro quando o ZSET tem o membro mas o registro está ausente — usa o score já comprometido, sem recalcular", async () => {
    const redis = new FakeRedis();
    const scheduledAtMs = new Date("2024-01-08T13:00:00.000Z").getTime();
    await redis.zadd(FEEDBACK_DUE_ZSET_KEY, scheduledAtMs, "res-d");
    assert.equal(await redis.get(feedbackKey("res-d")), null);

    const { record, repaired } = await ensureFeedbackForResolution(redis, {
      resolutionId: "res-d", phone: "5512900000007", clientType: "pf",
      saleCompletedAt: new Date("2099-01-01T00:00:00Z"), // não deve influenciar o scheduledAt reconstruído
    });

    assert.equal(repaired, true);
    assert.equal(record.id, "res-d");
    assert.equal(record.scheduledAt, new Date(scheduledAtMs).toISOString());
    assert.equal(await redis.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
    assert.equal(JSON.parse(await redis.get(feedbackKey("res-d"))).scheduledAt, record.scheduledAt);
  });

  test("não engole erro do Redis — quem chama decide o que fazer com a falha", async () => {
    const redis = new FakeRedis();
    const originalSet = FakeRedis.prototype.set;
    FakeRedis.prototype.set = async () => { throw new Error("falha simulada no SET"); };
    try {
      await assert.rejects(
        () => ensureFeedbackForResolution(redis, { resolutionId: "res-e", phone: "5512900000008", clientType: "pf" }),
        /falha simulada no SET/,
      );
    } finally {
      FakeRedis.prototype.set = originalSet;
    }
  });

  test("Cenário 4 — duas materializações concorrentes do mesmo resolutionId convergem para 1 registro + 1 membro consistente", async () => {
    const redis = new FakeRedis();
    const context = {
      resolutionId: "res-race", phone: "5512900000009", clientType: "pf",
      saleCompletedAt: "2024-01-01T15:00:00-03:00",
    };

    const [r1, r2] = await Promise.all([
      ensureFeedbackForResolution(redis, context),
      ensureFeedbackForResolution(redis, context),
    ]);

    // 1 registro, 1 membro na fila — nenhuma das duas chamadas duplicou nada.
    assert.equal(await redis.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
    const raw = await redis.get(feedbackKey("res-race"));
    assert.ok(raw);
    const stored = JSON.parse(raw);
    assert.equal(stored.id, "res-race");

    const score = await redis.zscore(FEEDBACK_DUE_ZSET_KEY, "res-race");
    assert.equal(stored.scheduledAt, new Date(Number(score)).toISOString());

    // As duas chamadas concordam no mesmo scheduledAt, independente de qual
    // delas "venceu" a escrita — scheduledAt é função pura de saleCompletedAt.
    assert.equal(r1.record.scheduledAt, r2.record.scheduledAt);
    assert.equal(r1.record.scheduledAt, stored.scheduledAt);
    assert.equal(stored.scheduledAt, "2024-01-02T13:00:00.000Z"); // terça 10h SP
  });

  test("scheduledAt nunca é recalculado a partir de Date.now() — é sempre função pura de saleCompletedAt", async () => {
    const redis = new FakeRedis();
    // Duas chamadas com o MESMO saleCompletedAt mas resolutionIds diferentes
    // (simula duas materializações reais, não uma idempotência de retry)
    // devem produzir o mesmo scheduledAt, mesmo que "agora" seja outro
    // instante a cada chamada — a função não lê o relógio para decidir isso.
    const saleCompletedAt = "2024-01-04T09:00:00-03:00"; // quinta
    const a = await ensureFeedbackForResolution(redis, { resolutionId: "res-f1", phone: "5512900000010", clientType: "pf", saleCompletedAt });
    const b = await ensureFeedbackForResolution(redis, { resolutionId: "res-f2", phone: "5512900000010", clientType: "pf", saleCompletedAt });
    assert.equal(a.record.scheduledAt, b.record.scheduledAt);
    assert.equal(a.record.scheduledAt, "2024-01-05T13:00:00.000Z"); // sexta 10h SP
  });
});

describe("addPendingPostSaleFeedback — lista leve de pendências de ciclos anteriores", () => {
  test("adiciona a entrada preservando o que já existia", () => {
    const session = { pendingPostSaleFeedbacks: [{ resolutionId: "a", saleCompletedAt: "t0", createdAt: "t0" }] };
    addPendingPostSaleFeedback(session, { resolutionId: "b", saleCompletedAt: "t1", createdAt: "t1" }, "5512900000011");

    assert.equal(session.pendingPostSaleFeedbacks.length, 2);
    assert.deepEqual(session.pendingPostSaleFeedbacks.map((p) => p.resolutionId), ["a", "b"]);
  });

  test("cria a lista quando a sessão ainda não tinha nenhuma pendência", () => {
    const session = {};
    addPendingPostSaleFeedback(session, { resolutionId: "a", saleCompletedAt: "t0", createdAt: "t0" }, "5512900000012");
    assert.deepEqual(session.pendingPostSaleFeedbacks, [{ resolutionId: "a", saleCompletedAt: "t0", createdAt: "t0" }]);
  });

  test("nunca guarda campos de conteúdo de feedback (storeRating/agentRating/etc.) — só o mínimo para retry", () => {
    const session = {};
    addPendingPostSaleFeedback(session, { resolutionId: "a", saleCompletedAt: "t0", createdAt: "t0" }, "5512900000013");
    const entry = session.pendingPostSaleFeedbacks[0];
    assert.deepEqual(Object.keys(entry).sort(), ["createdAt", "resolutionId", "saleCompletedAt"]);
  });

  test("ao atingir o limite, loga alerta crítico mas NÃO descarta dados — a entrada nova ainda é preservada", () => {
    const session = {
      pendingPostSaleFeedbacks: Array.from({ length: MAX_PENDING_POST_SALE_FEEDBACKS }, (_, i) => (
        { resolutionId: `old-${i}`, saleCompletedAt: "t0", createdAt: "t0" }
      )),
    };

    const originalError = console.error;
    let loggedCritical = false;
    console.error = (msg) => { if (String(msg).includes("🚨")) loggedCritical = true; };
    try {
      addPendingPostSaleFeedback(session, { resolutionId: "overflow", saleCompletedAt: "t1", createdAt: "t1" }, "5512900000014");
    } finally {
      console.error = originalError;
    }

    assert.equal(loggedCritical, true);
    // Nada foi descartado: a lista pode passar do limite, mas nunca perde dados.
    assert.equal(session.pendingPostSaleFeedbacks.length, MAX_PENDING_POST_SALE_FEEDBACKS + 1);
    assert.ok(session.pendingPostSaleFeedbacks.some((p) => p.resolutionId === "overflow"));
    assert.ok(session.pendingPostSaleFeedbacks.some((p) => p.resolutionId === "old-0"));
  });

  test("abaixo do limite não loga nada", () => {
    const session = { pendingPostSaleFeedbacks: [{ resolutionId: "a", saleCompletedAt: "t0", createdAt: "t0" }] };
    const originalError = console.error;
    let called = false;
    console.error = () => { called = true; };
    try {
      addPendingPostSaleFeedback(session, { resolutionId: "b", saleCompletedAt: "t1", createdAt: "t1" }, "5512900000015");
    } finally {
      console.error = originalError;
    }
    assert.equal(called, false);
  });
});
