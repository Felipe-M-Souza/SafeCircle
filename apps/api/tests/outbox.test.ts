import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "./helpers/test-db.js";
import { registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { registerActiveDevice } from "./helpers/push.js";
import { newIdempotencyKey, postAlert } from "./helpers/alerts.js";
import {
  drainOutbox,
  makeClaimable,
  outboxRow,
  outboxRows,
  simulateStalledClaim,
  type OutboxRow,
} from "./helpers/outbox.js";
import { FakePushProvider } from "../src/infrastructure/push/fake-push-provider.js";
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffDelayMs,
  claimOutboxEvents,
  deleteExpiredOutboxEvents,
  enqueueOutboxEvent,
  getOutboxBacklog,
  listDeadEvents,
  retryDeadEvent,
} from "../src/outbox/outbox.service.js";
import { OUTBOX_POLICIES, type OutboxEventType } from "../src/outbox/outbox.types.js";
import { metricValue, registry } from "../src/observability/metrics.js";
import type { RealtimeEvent } from "../src/infrastructure/realtime/events.js";

const cleaner = createCleaner();
const push = new FakePushProvider();
let app: FastifyInstance;

let owner: TestUser;
let member: TestUser;
let groupId: string;
let memberToken: string;

beforeAll(async () => {
  app = await createTestApp({ pushProvider: push });
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
  push.reset();
  owner = await registerUser(app, { name: "Felipe" });
  member = await registerUser(app, { name: "Maria" });
  groupId = await createGroup(app, owner, "Família");
  await addMember(app, owner, groupId, member);
  memberToken = (await registerActiveDevice(app, member)).token;
  // O preparo também gera efeitos. Entrega tudo e limpa a tabela: a outbox é um
  // log durável, então eventos já processados continuariam visíveis e poluiriam
  // as contagens de cada teste.
  await drainOutbox(app);
  await cleaner.sql`DELETE FROM outbox_events`;
  push.reset();
});

/** Enfileira um evento avulso na outbox, como o domínio faria. */
async function enqueue(
  eventType: OutboxEventType,
  payload: Record<string, unknown>,
  overrides: { maxAttempts?: number; ttlMs?: number | null } = {},
): Promise<string> {
  return app.db.transaction((tx) =>
    enqueueOutboxEvent(tx, {
      eventType,
      aggregateType: "TESTE",
      aggregateId: randomUUID(),
      groupId,
      payload,
      ...overrides,
    }),
  );
}

function pushPayload(): Record<string, unknown> {
  return { actorUserId: owner.userId, groupId, resourceId: randomUUID() };
}

/** Substitui `publishToGroup` para observar as publicações, e devolve o restore. */
function spyOnRealtime(instance: FastifyInstance): {
  published: RealtimeEvent[];
  restore: () => void;
} {
  const published: RealtimeEvent[] = [];
  const original = instance.realtime.publishToGroup.bind(instance.realtime);
  instance.realtime.publishToGroup = async (group, event, options) => {
    published.push(event);
    return original(group, event, options);
  };
  return {
    published,
    restore: () => {
      instance.realtime.publishToGroup = original;
    },
  };
}

// ==================================================================
// Atomicidade
// ==================================================================

describe("Atomicidade entre domínio e outbox", () => {
  it("rollback do domínio não deixa evento na outbox", async () => {
    await expect(
      app.db.transaction(async (tx) => {
        await enqueueOutboxEvent(tx, {
          eventType: "REALTIME_ALERT_CREATED",
          aggregateType: "ALERT",
          aggregateId: randomUUID(),
          groupId,
          payload: { alertId: randomUUID(), groupId },
        });
        throw new Error("falha do domínio depois do enfileiramento");
      }),
    ).rejects.toThrow("falha do domínio");

    expect(await outboxRows(cleaner.sql)).toHaveLength(0);
  });

  it("o commit do alerta grava push, realtime e auditoria no mesmo COMMIT", async () => {
    const res = await postAlert(app, owner, { groupId });
    expect(res.statusCode).toBe(201);

    // Worker não rodou: os efeitos existem, duráveis, esperando entrega.
    const rows = await outboxRows(cleaner.sql);
    expect(rows.map((row) => row.event_type).sort()).toEqual([
      "AUDIT_ALERT_CREATED",
      "PUSH_ALERT_CREATED",
      "REALTIME_ALERT_CREATED",
    ]);
    expect(rows.every((row) => row.status === "PENDING")).toBe(true);
    expect(rows.every((row) => row.attempt_count === 0)).toBe(true);
    expect(push.batches).toHaveLength(0);
  });

  it("ação de domínio rejeitada não enfileira efeito nenhum", async () => {
    const first = await postAlert(app, owner, { groupId });
    expect(first.statusCode).toBe(201);
    const afterFirst = (await outboxRows(cleaner.sql)).length;

    // Já existe alerta ACTIVE do mesmo usuário no grupo: a criação falha.
    const duplicate = await postAlert(app, owner, { groupId });
    expect(duplicate.statusCode).toBe(409);
    expect(await outboxRows(cleaner.sql)).toHaveLength(afterFirst);
  });
});

// ==================================================================
// Janela de perda pós-commit
// ==================================================================

describe("Janela de perda pós-commit", () => {
  it("processo derrubado antes da entrega: o evento sobrevive e é entregue depois", async () => {
    const provider = new FakePushProvider();
    const crashing = await createTestApp({ pushProvider: provider });
    const res = await postAlert(crashing, owner, { groupId });
    expect(res.statusCode).toBe(201);

    // "Queda" do processo: nada foi entregue.
    await crashing.close();
    expect(provider.batches).toHaveLength(0);
    const pending = await outboxRows(cleaner.sql, "PUSH_ALERT_CREATED");
    expect(pending[0]?.status).toBe("PENDING");

    // Processo novo assume o trabalho que ficou no banco.
    const recovered = await createTestApp({ pushProvider: provider });
    try {
      await drainOutbox(recovered);
      expect(provider.recipients).toEqual([memberToken]);
      const delivered = await outboxRows(cleaner.sql, "PUSH_ALERT_CREATED");
      expect(delivered[0]?.status).toBe("PROCESSED");
      expect(delivered[0]?.processed_at).not.toBeNull();
    } finally {
      await recovered.close();
    }
  });
});

// ==================================================================
// Claim concorrente e lease
// ==================================================================

describe("Claim concorrente e recuperação de lease", () => {
  it("dois workers sobre a mesma fila não pegam o mesmo evento", async () => {
    const total = 40;
    for (let i = 0; i < total; i += 1) {
      await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });
    }

    const [first, second] = await Promise.all([
      claimOutboxEvents(app.db, { batchSize: 25, lockedBy: "worker-a", leaseMs: 60_000 }),
      claimOutboxEvents(app.db, { batchSize: 25, lockedBy: "worker-b", leaseMs: 60_000 }),
    ]);

    const ids = [...first, ...second].map((event) => event.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(total);
    expect(first.every((event) => event.status === "PROCESSING")).toBe(true);
    expect(first.every((event) => event.lockedBy === "worker-a")).toBe(true);
  });

  it("evento com lease vencido volta a ser reivindicável; com lease válido, não", async () => {
    const stalled = await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });
    const healthy = await enqueue("REALTIME_ALERT_RESOLVED", { alertId: randomUUID(), groupId });

    // `stalled` ficou preso num worker que morreu; `healthy` acabou de ser pego.
    await simulateStalledClaim(cleaner.sql, stalled, 10);
    await cleaner.sql`
      UPDATE outbox_events SET status = 'PROCESSING', locked_at = now(), locked_by = 'worker-vivo'
       WHERE id = ${healthy}
    `;

    const claimed = await claimOutboxEvents(app.db, {
      batchSize: 10,
      lockedBy: "worker-novo",
      leaseMs: 60_000,
    });

    expect(claimed.map((event) => event.id)).toEqual([stalled]);
    expect(claimed[0]?.lockedBy).toBe("worker-novo");
  });

  it("evento agendado para o futuro não é reivindicado antes da hora", async () => {
    const id = await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });
    await cleaner.sql`
      UPDATE outbox_events SET available_at = now() + interval '1 hour' WHERE id = ${id}
    `;

    const claimed = await claimOutboxEvents(app.db, {
      batchSize: 10,
      lockedBy: "worker",
      leaseMs: 60_000,
    });
    expect(claimed).toHaveLength(0);

    await makeClaimable(cleaner.sql, id);
    const later = await claimOutboxEvents(app.db, {
      batchSize: 10,
      lockedBy: "worker",
      leaseMs: 60_000,
    });
    expect(later.map((event) => event.id)).toEqual([id]);
  });
});

// ==================================================================
// Retry, backoff e dead-letter
// ==================================================================

describe("Backoff exponencial com jitter", () => {
  it("cresce exponencialmente, respeita o teto e aplica jitter de ±20%", () => {
    const noJitter = () => 0.5;
    expect(backoffDelayMs(1, noJitter)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelayMs(2, noJitter)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelayMs(3, noJitter)).toBe(BACKOFF_BASE_MS * 4);
    // Teto: nenhuma tentativa espera mais que o limite, mesmo muito longe.
    expect(backoffDelayMs(50, noJitter)).toBe(BACKOFF_CAP_MS);

    // Jitter nos extremos: -20% e +20% do valor exponencial.
    expect(backoffDelayMs(2, () => 0)).toBe(BACKOFF_BASE_MS * 2 * 0.8);
    expect(backoffDelayMs(2, () => 1)).toBe(BACKOFF_BASE_MS * 2 * 1.2);
    expect(backoffDelayMs(1, () => 0)).toBeGreaterThanOrEqual(1_000);
  });
});

describe("Falha transitória e dead-letter", () => {
  it("falha total do provedor agenda retry persistente com backoff", async () => {
    push.setResult(memberToken, "failed", "MessageRateExceeded");
    const id = await enqueue("PUSH_ALERT_CREATED", pushPayload());

    const retriesBefore = await metricValue("safecircle_outbox_retries_total", {
      event_type: "PUSH_ALERT_CREATED",
    });
    await app.outboxWorker.runOnce();

    const row = await outboxRow(cleaner.sql, id);
    expect(row?.status).toBe("PENDING");
    expect(row?.attempt_count).toBe(1);
    expect(row?.last_error_code).toBe("PUSH_PROVIDER_FAILED");
    expect(row?.locked_at).toBeNull();
    // O retry está agendado no banco: sobrevive ao restart do processo.
    expect(new Date(row?.available_at ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(
      await metricValue("safecircle_outbox_retries_total", { event_type: "PUSH_ALERT_CREATED" }),
    ).toBe(retriesBefore + 1);
  });

  it("ao atingir maxAttempts o evento vira DEAD e para de ser tentado", async () => {
    push.setResult(memberToken, "failed", "MessageRateExceeded");
    const id = await enqueue("PUSH_ALERT_CREATED", pushPayload(), { maxAttempts: 2 });

    await app.outboxWorker.runOnce();
    expect((await outboxRow(cleaner.sql, id))?.status).toBe("PENDING");

    await makeClaimable(cleaner.sql, id);
    await app.outboxWorker.runOnce();

    const dead = await outboxRow(cleaner.sql, id);
    expect(dead?.status).toBe("DEAD");
    expect(dead?.attempt_count).toBe(2);
    expect(dead?.dead_lettered_at).not.toBeNull();
    expect(dead?.last_error_code).toBe("PUSH_PROVIDER_FAILED");

    // DEAD não é reivindicado de novo.
    const batchesBefore = push.batches.length;
    await makeClaimable(cleaner.sql, id);
    await app.outboxWorker.runOnce();
    expect(push.batches).toHaveLength(batchesBefore);
    expect((await outboxRow(cleaner.sql, id))?.status).toBe("DEAD");
  });

  it("payload inválido é falha permanente: DEAD na primeira tentativa, sem retry", async () => {
    const id = await enqueue("REALTIME_ALERT_CREATED", { alertId: "não-é-uuid", groupId });
    await app.outboxWorker.runOnce();

    const row = await outboxRow(cleaner.sql, id);
    expect(row?.status).toBe("DEAD");
    expect(row?.last_error_code).toBe("PAYLOAD_INVALID");
    expect(row?.attempt_count).toBe(1);
  });

  it("versão de payload desconhecida é falha permanente e identificável", async () => {
    const id = await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });
    await cleaner.sql`
      UPDATE outbox_events
         SET payload = jsonb_set(payload, '{version}', '999'::jsonb)
       WHERE id = ${id}
    `;
    await app.outboxWorker.runOnce();

    const row = await outboxRow(cleaner.sql, id);
    expect(row?.status).toBe("DEAD");
    expect(row?.last_error_code).toBe("UNSUPPORTED_EVENT_VERSION");
  });

  it("last_error_code é sempre um código curto e controlado", async () => {
    push.setResult(memberToken, "failed", "MessageRateExceeded");
    await enqueue("PUSH_ALERT_CREATED", pushPayload());
    await enqueue("REALTIME_ALERT_CREATED", { alertId: "inválido", groupId });
    await app.outboxWorker.runOnce();

    const codes = (await outboxRows(cleaner.sql))
      .map((row) => row.last_error_code)
      .filter((code): code is string => code !== null);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z_]{1,40}$/);
      expect(code).not.toContain("Error");
      expect(code).not.toContain("at ");
    }
  });
});

// ==================================================================
// Expiração
// ==================================================================

describe("Expiração por família", () => {
  it("as políticas gravadas seguem a família do evento", async () => {
    const realtimeId = await enqueue("REALTIME_ALERT_CREATED", {
      alertId: randomUUID(),
      groupId,
    });
    const pushId = await enqueue("PUSH_ALERT_CREATED", pushPayload());
    const auditId = await enqueue("AUDIT_ALERT_CREATED", {
      actorUserId: owner.userId,
      targetType: "ALERT",
      targetId: randomUUID(),
      groupId,
    });

    const realtime = await outboxRow(cleaner.sql, realtimeId);
    const pushRow = await outboxRow(cleaner.sql, pushId);
    const audit = await outboxRow(cleaner.sql, auditId);

    expect(realtime?.max_attempts).toBe(OUTBOX_POLICIES.realtime.maxAttempts);
    expect(pushRow?.max_attempts).toBe(OUTBOX_POLICIES.push.maxAttempts);
    expect(audit?.max_attempts).toBe(OUTBOX_POLICIES.audit.maxAttempts);
    // Auditoria nunca expira: perder trilha é o pior desfecho possível.
    expect(audit?.expires_at).toBeNull();
    expect(realtime?.expires_at).not.toBeNull();
    expect(pushRow?.expires_at).not.toBeNull();
  });

  it("evento realtime expirado é encerrado sem publicar", async () => {
    const id = await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });
    await cleaner.sql`UPDATE outbox_events SET expires_at = now() - interval '1 minute' WHERE id = ${id}`;

    const expiredBefore = await metricValue("safecircle_outbox_expired_total", {
      event_type: "REALTIME_ALERT_CREATED",
    });
    const spy = spyOnRealtime(app);
    try {
      await app.outboxWorker.runOnce();
    } finally {
      spy.restore();
    }

    expect(spy.published).toHaveLength(0);
    const row = await outboxRow(cleaner.sql, id);
    expect(row?.status).toBe("PROCESSED");
    expect(row?.processed_at).not.toBeNull();
    expect(
      await metricValue("safecircle_outbox_expired_total", {
        event_type: "REALTIME_ALERT_CREATED",
      }),
    ).toBe(expiredBefore + 1);
  });

  it("push expirado não é enviado: aviso velho confunde em vez de ajudar", async () => {
    const id = await enqueue("PUSH_ALERT_CREATED", pushPayload());
    await cleaner.sql`UPDATE outbox_events SET expires_at = now() - interval '1 minute' WHERE id = ${id}`;

    await app.outboxWorker.runOnce();

    expect(push.batches).toHaveLength(0);
    expect((await outboxRow(cleaner.sql, id))?.status).toBe("PROCESSED");
  });
});

// ==================================================================
// Idempotência (at-least-once)
// ==================================================================

describe("Idempotência sob entrega at-least-once", () => {
  it("reentrega do mesmo evento de auditoria grava um único registro", async () => {
    const targetId = randomUUID();
    const id = await enqueue("AUDIT_ALERT_CREATED", {
      actorUserId: owner.userId,
      targetType: "ALERT",
      targetId,
      groupId,
    });

    await app.outboxWorker.runOnce();
    // Simula a janela do at-least-once: o efeito aconteceu, a marcação não.
    await cleaner.sql`
      UPDATE outbox_events
         SET status = 'PENDING', processed_at = NULL, available_at = now() - interval '1 second'
       WHERE id = ${id}
    `;
    await app.outboxWorker.runOnce();

    const audits = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_events WHERE source_outbox_event_id = ${id}
    `;
    expect(audits[0]?.count).toBe(1);
    expect((await outboxRow(cleaner.sql, id))?.status).toBe("PROCESSED");
  });

  it("realtime reentregue mantém o mesmo eventId, permitindo dedupe no cliente", async () => {
    const id = await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });

    const spy = spyOnRealtime(app);
    try {
      await app.outboxWorker.runOnce();
      await cleaner.sql`
        UPDATE outbox_events
           SET status = 'PENDING', processed_at = NULL, available_at = now() - interval '1 second'
         WHERE id = ${id}
      `;
      await app.outboxWorker.runOnce();
    } finally {
      spy.restore();
    }

    expect(spy.published).toHaveLength(2);
    expect(spy.published[0]?.eventId).toBe(id);
    expect(spy.published[1]?.eventId).toBe(id);
  });

  it("replay idempotente do domínio não enfileira o efeito de novo", async () => {
    const key = newIdempotencyKey();
    const first = await postAlert(app, owner, { groupId }, key);
    const retry = await postAlert(app, owner, { groupId }, key);

    expect(first.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    expect(await outboxRows(cleaner.sql, "PUSH_ALERT_CREATED")).toHaveLength(1);
    expect(await outboxRows(cleaner.sql, "REALTIME_ALERT_CREATED")).toHaveLength(1);
  });
});

// ==================================================================
// Handler de push
// ==================================================================

describe("Handler de push", () => {
  it("sucesso parcial conclui o evento: reenviar o lote duplicaria quem recebeu", async () => {
    const other = await registerUser(app);
    await addMember(app, owner, groupId, other);
    const otherToken = (await registerActiveDevice(app, other)).token;
    await drainOutbox(app);
    push.reset();
    push.setResult(otherToken, "failed", "MessageRateExceeded");

    const id = await enqueue("PUSH_ALERT_CREATED", pushPayload());
    await app.outboxWorker.runOnce();

    const row = await outboxRow(cleaner.sql, id);
    expect(row?.status).toBe("PROCESSED");
    expect(row?.attempt_count).toBe(0);
    expect(push.recipients.sort()).toEqual([memberToken, otherToken].sort());
  });

  it("grupo sem dispositivo ativo conclui sem envio e sem erro", async () => {
    const lonely = await registerUser(app);
    const soloGroup = await createGroup(app, lonely, "Solo");
    const id = await app.db.transaction((tx) =>
      enqueueOutboxEvent(tx, {
        eventType: "PUSH_ALERT_CREATED",
        aggregateType: "ALERT",
        aggregateId: randomUUID(),
        groupId: soloGroup,
        payload: { actorUserId: lonely.userId, groupId: soloGroup, resourceId: randomUUID() },
      }),
    );

    await app.outboxWorker.runOnce();

    expect(push.batches).toHaveLength(0);
    expect((await outboxRow(cleaner.sql, id))?.status).toBe("PROCESSED");
  });

  it("destinatários são resolvidos na entrega: quem saiu do grupo não recebe", async () => {
    const id = await enqueue("PUSH_ALERT_CREATED", pushPayload());
    // Entre o commit e a entrega, o membro sai do grupo.
    await cleaner.sql`
      DELETE FROM group_memberships WHERE group_id = ${groupId} AND user_id = ${member.userId}
    `;

    await app.outboxWorker.runOnce();

    expect(push.batches).toHaveLength(0);
    expect((await outboxRow(cleaner.sql, id))?.status).toBe("PROCESSED");
  });
});

// ==================================================================
// Privacidade do que fica gravado
// ==================================================================

describe("Privacidade da outbox", () => {
  it("o payload guarda só identificadores: nada de coordenada, token ou credencial", async () => {
    const res = await postAlert(app, owner, {
      groupId,
      location: { latitude: -23.55, longitude: -46.63, accuracy: 12 },
    });
    expect(res.statusCode).toBe(201);

    const raw = JSON.stringify(await outboxRows(cleaner.sql));
    for (const forbidden of [
      "latitude",
      "longitude",
      "accuracy",
      "password",
      "refreshToken",
      "accessToken",
      "Bearer",
      "ExponentPushToken",
      "authorization",
      "Felipe",
      "Maria",
      owner.email,
      member.email,
      memberToken,
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).not.toMatch(/-23\.55\b/);
    expect(raw).not.toMatch(/-46\.63\b/);
  });
});

// ==================================================================
// Métricas
// ==================================================================

describe("Métricas da outbox", () => {
  it("conta enfileiramento, processamento e backlog pendente", async () => {
    const enqueuedBefore = await metricValue("safecircle_outbox_enqueued_total", {
      event_type: "REALTIME_ALERT_CREATED",
    });
    const processedBefore = await metricValue("safecircle_outbox_processed_total", {
      event_type: "REALTIME_ALERT_CREATED",
      result: "success",
    });

    // Ação real de domínio: é o caminho que incrementa a métrica.
    expect((await postAlert(app, owner, { groupId })).statusCode).toBe(201);
    const future = await enqueue("REALTIME_ALERT_RESOLVED", { alertId: randomUUID(), groupId });
    await cleaner.sql`
      UPDATE outbox_events SET available_at = now() + interval '1 hour' WHERE id = ${future}
    `;

    expect(
      await metricValue("safecircle_outbox_enqueued_total", {
        event_type: "REALTIME_ALERT_CREATED",
      }),
    ).toBe(enqueuedBefore + 1);

    await app.outboxWorker.runOnce();

    expect(
      await metricValue("safecircle_outbox_processed_total", {
        event_type: "REALTIME_ALERT_CREATED",
        result: "success",
      }),
    ).toBe(processedBefore + 1);
    // O evento agendado para o futuro continua no backlog.
    expect(await metricValue("safecircle_outbox_backlog", { status: "pending" })).toBe(1);
    expect(
      await metricValue("safecircle_outbox_oldest_pending_age_seconds"),
    ).toBeGreaterThanOrEqual(0);
  });

  it("nenhum identificador vira label: a cardinalidade permanece baixa", async () => {
    await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });
    await app.outboxWorker.runOnce();

    const exposed = await registry.metrics();
    const outboxLines = exposed
      .split("\n")
      .filter((line) => line.startsWith("safecircle_outbox") && !line.startsWith("#"));
    expect(outboxLines.length).toBeGreaterThan(0);
    for (const line of outboxLines) {
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
      expect(line).not.toContain("request_id");
      expect(line).not.toContain("group_id");
      expect(line).not.toContain("user_id");
    }
  });
});

// ==================================================================
// Retenção
// ==================================================================

describe("Retenção da outbox", () => {
  async function age(id: string, column: string, days: number): Promise<void> {
    await cleaner.sql`
      UPDATE outbox_events
         SET ${cleaner.sql(column)} = now() - (${days} * interval '1 day')
       WHERE id = ${id}
    `;
  }

  it("apaga concluídos e dead-letter antigos, e nunca trabalho pendente", async () => {
    const processed = await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });
    const dead = await enqueue("REALTIME_ALERT_RESOLVED", { alertId: randomUUID(), groupId });
    const recent = await enqueue("REALTIME_ALERT_CANCELLED", { alertId: randomUUID(), groupId });
    const pending = await enqueue("REALTIME_CHECKIN_CREATED", {
      checkinId: randomUUID(),
      groupId,
    });
    const processing = await enqueue("REALTIME_CHECKIN_SAFE", {
      checkinId: randomUUID(),
      groupId,
    });

    await cleaner.sql`UPDATE outbox_events SET status = 'PROCESSED', processed_at = now() WHERE id IN (${processed}, ${recent})`;
    await cleaner.sql`UPDATE outbox_events SET status = 'DEAD', dead_lettered_at = now() WHERE id = ${dead}`;
    await cleaner.sql`UPDATE outbox_events SET status = 'PROCESSING', locked_at = now() WHERE id = ${processing}`;
    await age(processed, "processed_at", 40);
    await age(dead, "dead_lettered_at", 120);
    // `pending` e `processing` são antigos, mas continuam sendo trabalho a fazer.
    await age(pending, "created_at", 400);

    const summary = await deleteExpiredOutboxEvents(app.db);
    expect(summary).toEqual({ processed: 1, dead: 1 });

    const remaining = (await outboxRows(cleaner.sql)).map((row) => row.id).sort();
    expect(remaining).toEqual([recent, pending, processing].sort());
  });
});

// ==================================================================
// Operação (CLI)
// ==================================================================

describe("Operação da outbox", () => {
  const require_ = createRequire(import.meta.url);
  const tsxCli = require_.resolve("tsx/cli");

  function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [tsxCli, "src/scripts/outbox-cli.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: getTestDatabaseUrl() },
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it("retry-dead só reenfileira DEAD e preserva o payload", async () => {
    const id = await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });

    // PENDING não é reenfileirável: criaria processamento concorrente.
    expect(await retryDeadEvent(app.db, id)).toBe(false);
    expect((await outboxRow(cleaner.sql, id))?.status).toBe("PENDING");

    await cleaner.sql`
      UPDATE outbox_events
         SET status = 'DEAD', dead_lettered_at = now(), attempt_count = 3,
             last_error_code = 'REALTIME_PUBLISH_FAILED'
       WHERE id = ${id}
    `;
    const before = await outboxRow(cleaner.sql, id);

    expect(await retryDeadEvent(app.db, id)).toBe(true);
    const after = await outboxRow(cleaner.sql, id);
    expect(after?.status).toBe("PENDING");
    expect(after?.attempt_count).toBe(0);
    expect(after?.dead_lettered_at).toBeNull();
    // O histórico não é reescrito: a CLI reprocessa, não edita.
    expect(after?.payload).toEqual(before?.payload);
    expect(after?.event_type).toBe(before?.event_type);
  });

  it("listagem e backlog refletem os estados do banco", async () => {
    const dead = await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });
    await enqueue("REALTIME_ALERT_RESOLVED", { alertId: randomUUID(), groupId });
    await cleaner.sql`
      UPDATE outbox_events SET status = 'DEAD', dead_lettered_at = now(),
             attempt_count = 3, last_error_code = 'REALTIME_PUBLISH_FAILED'
       WHERE id = ${dead}
    `;

    const listed = await listDeadEvents(app.db);
    expect(listed.map((event) => event.id)).toEqual([dead]);
    expect(listed[0]?.lastErrorCode).toBe("REALTIME_PUBLISH_FAILED");

    const backlog = await getOutboxBacklog(app.db);
    expect(backlog.pending).toBe(1);
    expect(backlog.dead).toBe(1);
    expect(backlog.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("a CLI recusa UUID inválido e não altera nada", async () => {
    const result = runCli(["retry-dead", "--id", "não-é-uuid"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("UUID válido");
  });

  it("a CLI reenfileira um evento em dead-letter", async () => {
    const id = await enqueue("REALTIME_ALERT_CREATED", { alertId: randomUUID(), groupId });
    await cleaner.sql`
      UPDATE outbox_events SET status = 'DEAD', dead_lettered_at = now() WHERE id = ${id}
    `;

    const result = runCli(["retry-dead", "--id", id]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("reenfileirado");
    expect((await outboxRow(cleaner.sql, id))?.status).toBe("PENDING");
  });
}, 60_000);

// ==================================================================
// Contrato dos eventos
// ==================================================================

describe("Contrato dos eventos", () => {
  it("todo evento enfileirado carrega a versão do payload", async () => {
    await postAlert(app, owner, { groupId });
    const rows: OutboxRow[] = await outboxRows(cleaner.sql);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.payload.version).toBe(1);
    }
  });

  it("tipo de evento fora do conjunto fechado falha no enfileiramento", async () => {
    await expect(
      app.db.transaction((tx) =>
        enqueueOutboxEvent(tx, {
          eventType: "PUSH_INVENTADO" as OutboxEventType,
          aggregateType: "TESTE",
          payload: {},
        }),
      ),
    ).rejects.toThrow("desconhecido");
    expect(await outboxRows(cleaner.sql)).toHaveLength(0);
  });
});
