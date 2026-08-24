// Integração Gate 1 (pós-venda): api/resolve.js deve, apenas na transição real
// para "resolvido" de uma venda concluída (PF finalizado / PJ entregue), criar
// um registro em sartec:feedback:<id> e agendá-lo em sartec:feedback:due — sem
// nunca deixar de resolver a conversa e sem duplicar em chamadas repetidas.
//
// Cobre também a regressão dos filtros de SCAN sartec:* (queue.js/
// conversations.js) — as novas chaves não podem aparecer como conversa.
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  FakeRedis,
  rawClient,
  getSession,
  forceSetSession,
  callResolve,
  callQueue,
  callConversations,
  callMetrics,
} from "./helpers/harness.js";
import { FEEDBACK_DUE_ZSET_KEY, FEEDBACK_KEY_PREFIX } from "../api/_lib/feedback-service.js";

beforeEach(() => FakeRedis._reset());

async function seedSession(phone, overrides = {}) {
  await forceSetSession(phone, (s) => Object.assign(s, {
    history: [{ role: "user", content: "oi", createdAt: new Date().toISOString() }],
    clientName: "Cliente Teste",
    clientType: "pf",
    demandType: "lista",
    pipelineStatus: "novo",
    status: "aguardando_humano",
    ...overrides,
  }));
}

async function feedbackDueMembers() {
  return rawClient.zrange(FEEDBACK_DUE_ZSET_KEY, 0, -1);
}

async function feedbackRecordsFor(phone) {
  const members = await feedbackDueMembers();
  const records = [];
  for (const id of members) {
    const raw = await rawClient.get(`${FEEDBACK_KEY_PREFIX}${id}`);
    if (!raw) continue;
    const record = JSON.parse(raw);
    if (record.phone === phone) records.push(record);
  }
  return records;
}

describe("resolve.js — Gate 1 do pós-venda", () => {
  test("PF finalizado: resolver cria 1 feedback agendado e 1 membro em sartec:feedback:due", async () => {
    const phone = "5512900001001";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    const body = await callResolve(phone);
    assert.equal(body.success, true);

    const session = await getSession(phone);
    assert.equal(session.status, "resolvido");

    const records = await feedbackRecordsFor(phone);
    assert.equal(records.length, 1);
    assert.equal(records[0].clientType, "pf");
    assert.equal(records[0].status, "scheduled");
    assert.equal(records[0].phone, phone);
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
  });

  test("PJ entregue: resolver cria 1 feedback agendado e 1 membro em sartec:feedback:due", async () => {
    const phone = "5512900001002";
    await seedSession(phone, { clientType: "pj", demandType: "cotacao_pj", pipelineStatus: "entregue" });

    const body = await callResolve(phone);
    assert.equal(body.success, true);

    const records = await feedbackRecordsFor(phone);
    assert.equal(records.length, 1);
    assert.equal(records[0].clientType, "pj");
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
  });

  test("PF em estágio intermediário: resolver não cria feedback", async () => {
    const phone = "5512900001003";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "em_atendimento" });

    const body = await callResolve(phone);
    assert.equal(body.success, true);
    assert.equal((await getSession(phone)).status, "resolvido");
    assert.equal((await feedbackRecordsFor(phone)).length, 0);
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 0);
  });

  test("PJ em estágio intermediário: resolver não cria feedback", async () => {
    const phone = "5512900001004";
    await seedSession(phone, { clientType: "pj", demandType: "cotacao_pj", pipelineStatus: "em_cotacao" });

    const body = await callResolve(phone);
    assert.equal(body.success, true);
    assert.equal((await feedbackRecordsFor(phone)).length, 0);
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 0);
  });

  test("idempotência: resolver duas vezes a mesma conversa cria só 1 feedback", async () => {
    const phone = "5512900001005";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    await callResolve(phone);
    const second = await callResolve(phone);

    assert.equal(second.success, true);
    assert.equal((await feedbackRecordsFor(phone)).length, 1);
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
  });

  test("nova compra do mesmo telefone: reabertura + nova resolução gera um 2º feedback com id diferente", async () => {
    const phone = "5512900001006";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    await callResolve(phone);
    const firstRecords = await feedbackRecordsFor(phone);
    assert.equal(firstRecords.length, 1);

    // Reabertura (mesmo mecanismo já usado por update-status.js/webhook.js):
    // volta status para fora de "resolvido" antes da nova venda ser concluída.
    await forceSetSession(phone, (s) => {
      s.status = "aguardando_humano";
      s.resolvedAt = null;
      s.pipelineStatus = "finalizado";
    });

    await callResolve(phone);
    const allRecords = await feedbackRecordsFor(phone);

    assert.equal(allRecords.length, 2);
    assert.notEqual(allRecords[0].id, allRecords[1].id);
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 2);
  });

  test("falha ao criar feedback não impede a conversa de ser resolvida", async () => {
    const phone = "5512900001007";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    const originalZadd = FakeRedis.prototype.zadd;
    FakeRedis.prototype.zadd = async () => { throw new Error("falha simulada no Redis"); };
    try {
      const body = await callResolve(phone);
      assert.equal(body.success, true);
      assert.equal((await getSession(phone)).status, "resolvido");
      assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 0);
    } finally {
      FakeRedis.prototype.zadd = originalZadd;
    }
  });

  test("regressão: resolver conversa que não é venda continua funcionando como antes", async () => {
    const phone = "5512900001008";
    await seedSession(phone, { clientType: "pj", demandType: "cotacao_pj", pipelineStatus: "proposta_enviada" });

    const body = await callResolve(phone);
    assert.equal(body.success, true);
    assert.equal(typeof body.resolvedAt, "string");

    const session = await getSession(phone);
    assert.equal(session.status, "resolvido");
    assert.equal(session.resolvedAt, body.resolvedAt);
  });

  test("regressão: telefone inexistente continua retornando 404", async () => {
    const body = await callResolve("5512900009999");
    assert.equal(body.error, "Conversa não encontrada");
  });
});

describe("resolve.js — janela de perda do pós-venda (resolutionId + postSaleFeedback)", () => {
  test("Cenário A — falha na materialização preserva session.postSaleFeedback.state = pending com resolutionId", async () => {
    const phone = "5512900002001";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    const originalZadd = FakeRedis.prototype.zadd;
    FakeRedis.prototype.zadd = async () => { throw new Error("falha simulada no ZADD"); };
    let body;
    try {
      body = await callResolve(phone);
    } finally {
      FakeRedis.prototype.zadd = originalZadd;
    }

    // A resolução principal nunca deve virar erro por causa do pós-venda.
    assert.equal(body.success, true);

    const session = await getSession(phone);
    assert.equal(session.status, "resolvido");
    assert.equal(session.postSaleFeedback.state, "pending");
    assert.equal(typeof session.postSaleFeedback.resolutionId, "string");
    assert.ok(session.postSaleFeedback.resolutionId.length > 0);

    // O registro pode ter sido criado (SET antes do ZADD falhar) ou não —
    // o que importa é que a fila não ganhou um membro órfão sem registro.
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 0);
  });

  test("Cenário B — retry recupera: nova chamada a /api/resolve reusa o mesmo resolutionId e conclui o agendamento", async () => {
    const phone = "5512900002002";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    const originalZadd = FakeRedis.prototype.zadd;
    FakeRedis.prototype.zadd = async () => { throw new Error("falha simulada no ZADD"); };
    try {
      await callResolve(phone);
    } finally {
      FakeRedis.prototype.zadd = originalZadd;
    }

    const pendingSession = await getSession(phone);
    const resolutionId = pendingSession.postSaleFeedback.resolutionId;
    assert.equal(pendingSession.postSaleFeedback.state, "pending");

    const retryBody = await callResolve(phone);
    assert.equal(retryBody.success, true);

    const session = await getSession(phone);
    assert.equal(session.postSaleFeedback.state, "scheduled");
    assert.equal(session.postSaleFeedback.resolutionId, resolutionId);
    assert.equal(session.postSaleFeedback.feedbackId, resolutionId);

    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
    assert.notEqual(await rawClient.zscore(FEEDBACK_DUE_ZSET_KEY, resolutionId), null);
    const raw = await rawClient.get(`${FEEDBACK_KEY_PREFIX}${resolutionId}`);
    assert.equal(JSON.parse(raw).id, resolutionId);
  });

  test("Cenário C — retry não duplica: resolver 3x seguidas mantém 1 único feedback para o resolutionId", async () => {
    const phone = "5512900002003";
    await seedSession(phone, { clientType: "pj", demandType: "cotacao_pj", pipelineStatus: "entregue" });

    await callResolve(phone);
    const resolutionId = (await getSession(phone)).postSaleFeedback.resolutionId;

    await callResolve(phone);
    await callResolve(phone);

    const session = await getSession(phone);
    assert.equal(session.postSaleFeedback.state, "scheduled");
    assert.equal(session.postSaleFeedback.resolutionId, resolutionId);

    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
    assert.equal(await feedbackDueMembers().then((m) => m.filter((id) => id === resolutionId).length), 1);
    assert.equal((await feedbackRecordsFor(phone)).length, 1);
  });

  test("Cenário D — falha entre SET e ZADD: retry repara só a fila, sem duplicar o registro", async () => {
    const phone = "5512900002004";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    const originalZadd = FakeRedis.prototype.zadd;
    FakeRedis.prototype.zadd = async () => { throw new Error("falha simulada no ZADD"); };
    try {
      await callResolve(phone);
    } finally {
      FakeRedis.prototype.zadd = originalZadd;
    }

    const resolutionId = (await getSession(phone)).postSaleFeedback.resolutionId;
    const rawBefore = await rawClient.get(`${FEEDBACK_KEY_PREFIX}${resolutionId}`);
    assert.ok(rawBefore, "o registro deveria ter sido persistido antes do ZADD falhar");
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 0);

    await callResolve(phone);

    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 1);
    const rawAfter = await rawClient.get(`${FEEDBACK_KEY_PREFIX}${resolutionId}`);
    assert.equal(JSON.parse(rawAfter).createdAt, JSON.parse(rawBefore).createdAt); // mesmo registro, não recriado
    assert.equal((await feedbackRecordsFor(phone)).length, 1);
  });

  test("Cenário F — nova compra do mesmo telefone gera resolutionId novo, sem travar por telefone", async () => {
    const phone = "5512900002006";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    await callResolve(phone);
    const resolutionIdA = (await getSession(phone)).postSaleFeedback.resolutionId;
    assert.equal((await getSession(phone)).postSaleFeedback.state, "scheduled");

    // Reabertura real da sessão (mesmo mecanismo de update-status.js/webhook.js).
    await forceSetSession(phone, (s) => {
      s.status = "aguardando_humano";
      s.resolvedAt = null;
      s.pipelineStatus = "finalizado";
    });

    await callResolve(phone);
    const sessionB = await getSession(phone);
    const resolutionIdB = sessionB.postSaleFeedback.resolutionId;

    assert.notEqual(resolutionIdB, resolutionIdA);
    assert.equal(sessionB.postSaleFeedback.state, "scheduled");
    assert.equal((await feedbackRecordsFor(phone)).length, 2);
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 2);
  });

  test("Cenário G / 8 — sessão já resolvida sem marcador legado: resolvedAt não muda e nenhuma pesquisa retroativa é criada", async () => {
    const phone = "5512900002007";
    const legacyResolvedAt = "2023-05-10T12:00:00.000Z";
    // Sessão como em produção antes desta correção: já resolvida, sem postSaleFeedback.
    await seedSession(phone, {
      clientType: "pf", pipelineStatus: "finalizado",
      status: "resolvido", resolvedAt: legacyResolvedAt,
    });
    assert.equal((await getSession(phone)).postSaleFeedback, undefined);

    const body = await callResolve(phone);
    assert.equal(body.success, true);
    assert.equal(body.resolvedAt, legacyResolvedAt); // retry não fabrica um resolvedAt novo

    const session = await getSession(phone);
    assert.equal(session.status, "resolvido");
    assert.equal(session.resolvedAt, legacyResolvedAt);
    assert.equal(session.postSaleFeedback, undefined);
    assert.equal((await feedbackRecordsFor(phone)).length, 0);
    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 0);
  });

  test("Cenário 5 — retry em outro dia (ou anos depois) não muda scheduledAt, que fica ancorado no saleCompletedAt original", async () => {
    const phone = "5512900002005";
    // Simula uma resolução que já tinha ficado "pending" numa segunda-feira —
    // createdAt aqui é o saleCompletedAt congelado no primeiro momento da
    // transição (é exatamente isso que resolve.js grava em produção).
    await seedSession(phone, {
      clientType: "pf", pipelineStatus: "finalizado",
      status: "resolvido", resolvedAt: "2024-01-01T15:00:00-03:00",
      postSaleFeedback: { state: "pending", resolutionId: "res-seg", createdAt: "2024-01-01T15:00:00-03:00" },
    });

    // O retry acontece "agora" (muito depois da segunda-feira simulada) — não
    // deve importar: scheduledAt é função pura do saleCompletedAt congelado.
    const body = await callResolve(phone);
    assert.equal(body.success, true);

    const session = await getSession(phone);
    assert.equal(session.postSaleFeedback.state, "scheduled");
    assert.equal(session.postSaleFeedback.resolutionId, "res-seg");
    assert.equal(session.postSaleFeedback.scheduledAt, "2024-01-02T13:00:00.000Z"); // terça 10h SP

    const raw = await rawClient.get(`${FEEDBACK_KEY_PREFIX}res-seg`);
    assert.equal(JSON.parse(raw).scheduledAt, "2024-01-02T13:00:00.000Z");
  });

  test("Cenário 6 — retry não muda o resolvedAt original da sessão", async () => {
    const phone = "5512900002008";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    const originalZadd = FakeRedis.prototype.zadd;
    FakeRedis.prototype.zadd = async () => { throw new Error("falha simulada"); };
    let firstBody;
    try {
      firstBody = await callResolve(phone);
    } finally {
      FakeRedis.prototype.zadd = originalZadd;
    }
    const resolvedAtOriginal = firstBody.resolvedAt;
    assert.equal(typeof resolvedAtOriginal, "string");

    const retryBody = await callResolve(phone);
    assert.equal(retryBody.success, true);
    assert.equal(retryBody.resolvedAt, resolvedAtOriginal);

    const session = await getSession(phone);
    assert.equal(session.resolvedAt, resolvedAtOriginal);
  });

  test("Cenário 7 — nova compra após reabertura recebe um resolvedAt novo (não confundir com retry)", async () => {
    const phone = "5512900002009";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    const bodyA = await callResolve(phone);
    const resolvedAtA = bodyA.resolvedAt;

    // Reabertura real + nova venda, com uma pequena espera para garantir que
    // "agora" realmente avança entre as duas resoluções (evita flakiness de
    // duas chamadas caindo no mesmo milissegundo).
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 5));
    await forceSetSession(phone, (s) => {
      s.status = "aguardando_humano";
      s.resolvedAt = null;
      s.pipelineStatus = "finalizado";
    });

    const bodyB = await callResolve(phone);
    const resolvedAtB = bodyB.resolvedAt;

    assert.notEqual(resolvedAtB, resolvedAtA);
    const session = await getSession(phone);
    assert.equal(session.resolvedAt, resolvedAtB);

    // Cada feedback referencia o saleCompletedAt/resolvedAt da sua própria venda.
    const records = await feedbackRecordsFor(phone);
    assert.equal(records.length, 2);
    const saleDates = records.map((r) => r.saleCompletedAt).sort();
    assert.deepEqual(saleDates, [resolvedAtA, resolvedAtB].sort());
  });
});

describe("resolve.js — pendências de pós-venda sobrevivem a múltiplos ciclos (Gate 1.1)", () => {
  // Venda A fica "pending" (falha simulada). Depois a sessão reabre e uma
  // nova venda B é resolvida — mas a tentativa de recuperar A best-effort,
  // embutida nesse mesmo /api/resolve, também continua falhando (só para A),
  // simulando uma indisponibilidade específica que persiste por mais um ciclo.
  async function setupOrphanedAWithScheduledB(phone) {
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });

    const originalZadd = FakeRedis.prototype.zadd;
    FakeRedis.prototype.zadd = async () => { throw new Error("falha simulada — venda A"); };
    try {
      await callResolve(phone); // Venda A: fica pending
    } finally {
      FakeRedis.prototype.zadd = originalZadd;
    }
    const resolutionIdA = (await getSession(phone)).postSaleFeedback.resolutionId;

    // Reabertura real da sessão (mesmo mecanismo de update-status.js/webhook.js).
    await forceSetSession(phone, (s) => {
      s.status = "aguardando_humano";
      s.resolvedAt = null;
      s.pipelineStatus = "finalizado";
    });

    FakeRedis.prototype.zadd = async function (key, score, member) {
      if (member === resolutionIdA) throw new Error("A ainda indisponível");
      return originalZadd.call(this, key, score, member);
    };
    try {
      await callResolve(phone); // Venda B
    } finally {
      FakeRedis.prototype.zadd = originalZadd;
    }
    const resolutionIdB = (await getSession(phone)).postSaleFeedback.resolutionId;

    return { resolutionIdA, resolutionIdB };
  }

  test("Cenário 1 — pending A sobrevive à nova compra B (não é apagado por um resolutionId novo)", async () => {
    const phone = "5512900003001";
    const { resolutionIdA, resolutionIdB } = await setupOrphanedAWithScheduledB(phone);

    assert.notEqual(resolutionIdA, resolutionIdB);
    const session = await getSession(phone);
    assert.equal(session.postSaleFeedback.resolutionId, resolutionIdB);
    assert.ok(Array.isArray(session.pendingPostSaleFeedbacks));
    const orphan = session.pendingPostSaleFeedbacks.find((p) => p.resolutionId === resolutionIdA);
    assert.ok(orphan, "resolutionId A deveria continuar referenciado como pendência antiga");
  });

  test("Cenário 2 — B agenda normalmente mesmo com A ainda pending", async () => {
    const phone = "5512900003002";
    const { resolutionIdA, resolutionIdB } = await setupOrphanedAWithScheduledB(phone);

    const session = await getSession(phone);
    assert.equal(session.postSaleFeedback.state, "scheduled");
    assert.equal(session.postSaleFeedback.resolutionId, resolutionIdB);

    const rawB = await rawClient.get(`${FEEDBACK_KEY_PREFIX}${resolutionIdB}`);
    assert.ok(rawB);
    assert.equal(JSON.parse(rawB).status, "scheduled");
    assert.notEqual(await rawClient.zscore(FEEDBACK_DUE_ZSET_KEY, resolutionIdB), null);

    // A continua pendente de recuperação: a fila ainda não tem o membro de A.
    assert.equal(await rawClient.zscore(FEEDBACK_DUE_ZSET_KEY, resolutionIdA), null);
    assert.ok(session.pendingPostSaleFeedbacks.some((p) => p.resolutionId === resolutionIdA));
  });

  test("Cenário 3 — recuperar A (chamada subsequente) não afeta o estado de B", async () => {
    const phone = "5512900003003";
    const { resolutionIdA, resolutionIdB } = await setupOrphanedAWithScheduledB(phone);

    // Nova chamada a /api/resolve com o Redis totalmente saudável: recupera A
    // best-effort, sem que isso seja uma "nova venda" (sessão já é B).
    const body = await callResolve(phone);
    assert.equal(body.success, true);

    const session = await getSession(phone);

    const rawA = await rawClient.get(`${FEEDBACK_KEY_PREFIX}${resolutionIdA}`);
    assert.ok(rawA);
    assert.equal(JSON.parse(rawA).status, "scheduled");
    assert.notEqual(await rawClient.zscore(FEEDBACK_DUE_ZSET_KEY, resolutionIdA), null);
    assert.ok(!(session.pendingPostSaleFeedbacks || []).some((p) => p.resolutionId === resolutionIdA));

    // B permanece intacto — mesmo resolutionId, mesmo estado scheduled.
    assert.equal(session.postSaleFeedback.resolutionId, resolutionIdB);
    assert.equal(session.postSaleFeedback.state, "scheduled");
    const rawB = await rawClient.get(`${FEEDBACK_KEY_PREFIX}${resolutionIdB}`);
    assert.ok(rawB);
    assert.equal(JSON.parse(rawB).status, "scheduled");

    assert.equal(await rawClient.zcard(FEEDBACK_DUE_ZSET_KEY), 2);
  });
});

describe("regressão de SCAN sartec:* — chaves de feedback não aparecem como conversa", () => {
  test("api/queue.js ignora sartec:feedback:*", async () => {
    const phone = "5512900001101";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado", status: "aguardando_humano" });
    await callResolve(phone);

    const { conversations } = await callQueue();
    for (const conv of conversations) {
      assert.ok(!String(conv.phone).startsWith("feedback:"), `conversa vazando chave de feedback: ${conv.phone}`);
    }
  });

  test("api/conversations.js ignora sartec:feedback:*", async () => {
    const phone = "5512900001102";
    await seedSession(phone, { clientType: "pj", demandType: "cotacao_pj", pipelineStatus: "entregue" });
    await callResolve(phone);

    const { conversations } = await callConversations();
    for (const conv of conversations) {
      assert.ok(!String(conv.phone).startsWith("feedback:"), `conversa vazando chave de feedback: ${conv.phone}`);
    }
    // A própria conversa resolvida continua aparecendo normalmente.
    assert.ok(conversations.some((c) => c.phone === phone));
  });

  test("api/metrics.js não trava nem conta chaves de feedback como sessão", async () => {
    const phone = "5512900001103";
    await seedSession(phone, { clientType: "pf", pipelineStatus: "finalizado" });
    await callResolve(phone);

    const result = await callMetrics({ period: "tudo" });
    assert.ok(result.summary);
    assert.equal(result.summary.resolvedChats, 1);
  });
});
