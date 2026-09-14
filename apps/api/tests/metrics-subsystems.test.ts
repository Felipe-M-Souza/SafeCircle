import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { registerUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { createCheckin, expireCheckin } from "./helpers/checkins.js";
import { createJourney, expireJourney } from "./helpers/journeys.js";
import { registerActiveDevice } from "./helpers/push.js";
import {
  connectRealtime,
  startRealtimeServer,
  type RealtimeTestClient,
} from "./helpers/realtime.js";
import { FakePushProvider } from "../src/infrastructure/push/fake-push-provider.js";
import { metricValue } from "../src/observability/metrics.js";

/** Espera uma métrica atingir o valor esperado (leitura é assíncrona). */
async function waitForMetric(
  name: string,
  expected: number,
  labels: Record<string, string> = {},
  timeoutMs = 5000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let current = await metricValue(name, labels);
  while (current !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = await metricValue(name, labels);
  }
  return current;
}

const cleaner = createCleaner();
const push = new FakePushProvider();
let app: FastifyInstance;
let wsUrl: string;
const openClients: RealtimeTestClient[] = [];

beforeAll(async () => {
  app = await createTestApp({ pushProvider: push });
  wsUrl = await startRealtimeServer(app);
});
afterAll(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  openClients.length = 0;
  await cleaner.truncate();
  push.reset();
});

describe("Métricas de realtime", () => {
  it("conexão incrementa o total e o gauge; desconexão decrementa", async () => {
    const user = await registerUser(app);
    const totalBefore = await metricValue("safecircle_realtime_connections_total");
    const openBefore = await metricValue("safecircle_realtime_connections");

    const client = await connectRealtime(wsUrl, user.accessToken);
    expect(await waitForMetric("safecircle_realtime_connections", openBefore + 1)).toBe(
      openBefore + 1,
    );
    expect(await metricValue("safecircle_realtime_connections_total")).toBe(totalBefore + 1);

    await client.close();
    expect(await waitForMetric("safecircle_realtime_connections", openBefore)).toBe(openBefore);
    expect(await metricValue("safecircle_realtime_disconnects_total")).toBeGreaterThan(0);
  });

  it("evento publicado incrementa o contador por tipo", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, member);

    const client = await connectRealtime(wsUrl, member.accessToken);
    openClients.push(client);

    const before = await metricValue("safecircle_realtime_events_published_total", {
      event_type: "CHECKIN_CREATED",
    });
    await createCheckin(app, owner, groupId, 30);
    await client.waitForEvent((event) => event.type === "CHECKIN_CREATED");
    await app.background.flush();

    expect(
      await metricValue("safecircle_realtime_events_published_total", {
        event_type: "CHECKIN_CREATED",
      }),
    ).toBe(before + 1);
  });

  it("falha ao publicar incrementa o contador de falhas", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    const before = await metricValue("safecircle_realtime_publish_failures_total", {
      event_type: "CHECKIN_CREATED",
    });

    const original = app.realtimeHub.send.bind(app.realtimeHub);
    app.realtimeHub.send = () => {
      throw new Error("hub indisponível");
    };
    try {
      await createCheckin(app, owner, groupId, 30);
      await app.background.flush();
    } finally {
      app.realtimeHub.send = original;
    }

    expect(
      await metricValue("safecircle_realtime_publish_failures_total", {
        event_type: "CHECKIN_CREATED",
      }),
    ).toBe(before + 1);
  });
});

describe("Métricas de tarefas em segundo plano", () => {
  it("started/completed/duração são contabilizados e pending volta a zero", async () => {
    const startedBefore = await metricValue("safecircle_background_tasks_started_total", {
      task_type: "metrics-test-ok",
    });

    app.background.run("metrics-test-ok", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(app.background.pendingCount()).toBe(1);
    await app.background.flush();

    expect(
      await metricValue("safecircle_background_tasks_started_total", {
        task_type: "metrics-test-ok",
      }),
    ).toBe(startedBefore + 1);
    expect(
      await metricValue("safecircle_background_tasks_completed_total", {
        task_type: "metrics-test-ok",
      }),
    ).toBe(1);
    expect(
      await metricValue("safecircle_background_tasks_duration_seconds_count", {
        task_type: "metrics-test-ok",
      }),
    ).toBe(1);
    expect(await metricValue("safecircle_background_tasks_pending")).toBe(0);
  });

  it("tarefa que falha incrementa failed e não derruba o processo", async () => {
    app.background.run("metrics-test-fail", async () => {
      throw new Error("falha sintética");
    });
    await app.background.flush();

    expect(
      await metricValue("safecircle_background_tasks_failed_total", {
        task_type: "metrics-test-fail",
      }),
    ).toBe(1);
    expect(
      await metricValue("safecircle_background_tasks_completed_total", {
        task_type: "metrics-test-fail",
      }),
    ).toBe(0);
  });
});

describe("Métricas de push", () => {
  it("envio bem-sucedido conta mensagens, lote e duração — sem token nos labels", async () => {
    const owner = await registerUser(app);
    const memberA = await registerUser(app);
    const memberB = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, memberA);
    await addMember(app, owner, groupId, memberB);
    const tokenA = (await registerActiveDevice(app, memberA)).token;
    await registerActiveDevice(app, memberB);

    const checkin = await createCheckin(app, owner, groupId, 10);
    await expireCheckin(cleaner.sql, checkin.id);
    await app.checkinScheduler.runOnce();
    await app.background.flush();

    const type = "SAFETY_CHECKIN_OVERDUE";
    expect(
      await metricValue("safecircle_push_dispatch_total", { message_type: type, result: "ok" }),
    ).toBe(1);
    expect(
      await metricValue("safecircle_push_messages_total", { message_type: type, result: "sent" }),
    ).toBe(2);
    expect(
      await metricValue("safecircle_push_duration_seconds_count", { message_type: type }),
    ).toBe(1);

    // O token jamais vira label.
    const { registry } = await import("../src/observability/metrics.js");
    const json = await registry.getMetricsAsJSON();
    expect(JSON.stringify(json)).not.toContain(tokenA);
  });

  it("token inválido e falha do provedor são contabilizados", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, member);
    const device = await registerActiveDevice(app, member);
    push.setResult(device.token, "invalidToken", "DeviceNotRegistered");

    const first = await createCheckin(app, owner, groupId, 10);
    await expireCheckin(cleaner.sql, first.id);
    await app.checkinScheduler.runOnce();
    await app.background.flush();

    const type = "SAFETY_CHECKIN_OVERDUE";
    expect(await metricValue("safecircle_push_invalid_tokens_total", { message_type: type })).toBe(
      1,
    );

    // Provedor indisponível: o lote inteiro conta como falha.
    push.reset();
    const other = await registerUser(app);
    await addMember(app, owner, groupId, other);
    await registerActiveDevice(app, other);
    push.failNext(new Error("Expo indisponível"));
    const second = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, second.id);
    await app.journeyScheduler.runOnce();
    await app.background.flush();

    const journeyType = "SAFE_JOURNEY_OVERDUE";
    expect(
      await metricValue("safecircle_push_dispatch_total", {
        message_type: journeyType,
        result: "failed",
      }),
    ).toBe(1);
    expect(
      await metricValue("safecircle_push_failures_total", { message_type: journeyType }),
    ).toBeGreaterThan(0);
  });
});

describe("Métricas de schedulers", () => {
  it("check-ins: execução, duração e itens processados", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    const runsBefore = await metricValue("safecircle_scheduler_runs_total", {
      scheduler: "checkins",
      result: "ok",
    });
    const itemsBefore = await metricValue("safecircle_scheduler_items_processed_total", {
      scheduler: "checkins",
    });

    const checkin = await createCheckin(app, owner, groupId, 10);
    await expireCheckin(cleaner.sql, checkin.id);
    expect(await app.checkinScheduler.runOnce()).toBe(1);
    await app.background.flush();

    expect(
      await metricValue("safecircle_scheduler_runs_total", { scheduler: "checkins", result: "ok" }),
    ).toBe(runsBefore + 1);
    expect(
      await metricValue("safecircle_scheduler_items_processed_total", { scheduler: "checkins" }),
    ).toBe(itemsBefore + 1);
    expect(
      await metricValue("safecircle_scheduler_run_duration_seconds_count", {
        scheduler: "checkins",
      }),
    ).toBeGreaterThan(0);
  });

  it("trajetos: execução e itens processados", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    const itemsBefore = await metricValue("safecircle_scheduler_items_processed_total", {
      scheduler: "journeys",
    });

    const journey = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, journey.id);
    expect(await app.journeyScheduler.runOnce()).toBe(1);
    await app.background.flush();

    expect(
      await metricValue("safecircle_scheduler_items_processed_total", { scheduler: "journeys" }),
    ).toBe(itemsBefore + 1);
    expect(
      await metricValue("safecircle_scheduler_runs_total", { scheduler: "journeys", result: "ok" }),
    ).toBeGreaterThan(0);
  });
});

describe("Métricas de domínio", () => {
  it("transições de check-in e trajeto são contabilizadas", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    const createdBefore = await metricValue("safecircle_checkin_transitions_total", {
      transition: "created",
    });
    const overdueBefore = await metricValue("safecircle_journey_transitions_total", {
      transition: "overdue",
    });

    await createCheckin(app, owner, groupId, 30);
    const journey = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, journey.id);
    await app.journeyScheduler.runOnce();
    await app.background.flush();

    expect(
      await metricValue("safecircle_checkin_transitions_total", { transition: "created" }),
    ).toBe(createdBefore + 1);
    expect(
      await metricValue("safecircle_journey_transitions_total", { transition: "overdue" }),
    ).toBe(overdueBefore + 1);
  });
});
