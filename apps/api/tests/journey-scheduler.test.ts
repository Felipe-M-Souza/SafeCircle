import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { createJourney, expireJourney, getJourney, journeyAction } from "./helpers/journeys.js";
import { registerActiveDevice } from "./helpers/push.js";
import {
  connectRealtime,
  startRealtimeServer,
  waitUntil,
  type RealtimeTestClient,
} from "./helpers/realtime.js";
import { FakePushProvider } from "../src/infrastructure/push/fake-push-provider.js";
import { JourneyScheduler } from "../src/modules/journeys/journey-scheduler.js";
import {
  JOURNEY_RETENTION_DAYS,
  deleteExpiredJourneys,
} from "../src/modules/journeys/journeys.service.js";
import {
  JOURNEY_OVERDUE_BODY,
  JOURNEY_OVERDUE_TITLE,
} from "../src/modules/journeys/journey-notifications.service.js";

const cleaner = createCleaner();
const push = new FakePushProvider();
let app: FastifyInstance;
let wsUrl: string;
const openClients: RealtimeTestClient[] = [];

async function statusOf(journeyId: string): Promise<{ status: string; overdue_at: Date | null }> {
  const [row] = await cleaner.sql<{ status: string; overdue_at: Date | null }[]>`
    SELECT status, overdue_at FROM safe_journeys WHERE id = ${journeyId}
  `;
  return row!;
}

beforeAll(async () => {
  app = await createTestApp({ pushProvider: push });
  wsUrl = await startRealtimeServer(app);
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  openClients.length = 0;
  await cleaner.truncate();
  push.reset();
});

describe("JourneyScheduler", () => {
  let owner: TestUser;
  let memberA: TestUser;
  let memberB: TestUser;
  let outsider: TestUser;
  let groupId: string;

  beforeEach(async () => {
    owner = await registerUser(app, { name: "Felipe" });
    memberA = await registerUser(app, { name: "Maria" });
    memberB = await registerUser(app, { name: "João" });
    outsider = await registerUser(app);
    groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, memberA);
    await addMember(app, owner, groupId, memberB);
    await createGroup(app, outsider, "Outro");
  });

  it("não está iniciado nos testes e ACTIVE com prazo futuro não muda", async () => {
    expect(app.journeyScheduler.isStarted()).toBe(false);
    const journey = await createJourney(app, owner, groupId);
    expect(await app.journeyScheduler.runOnce()).toBe(0);
    expect((await statusOf(journey.id)).status).toBe("ACTIVE");
  });

  it("prazo vencido vira OVERDUE com overdueAt; runOnce repetido não duplica efeitos", async () => {
    const tokens = {
      owner: (await registerActiveDevice(app, owner)).token,
      a: (await registerActiveDevice(app, memberA)).token,
      b: (await registerActiveDevice(app, memberB)).token,
      outsider: (await registerActiveDevice(app, outsider)).token,
    };
    const client = await connectRealtime(wsUrl, memberA.accessToken);
    const outsiderClient = await connectRealtime(wsUrl, outsider.accessToken);
    openClients.push(client, outsiderClient);

    const journey = await createJourney(app, owner, groupId);
    await client.waitForEvent((e) => e.type === "JOURNEY_CREATED");
    await expireJourney(cleaner.sql, journey.id);

    expect(await app.journeyScheduler.runOnce()).toBe(1);
    await app.background.flush();

    const row = await statusOf(journey.id);
    expect(row.status).toBe("OVERDUE");
    expect(row.overdue_at).toBeInstanceOf(Date);
    const view = await getJourney(app, memberA, journey.id);
    expect(view.json()).toMatchObject({ status: "OVERDUE" });
    expect(typeof view.json().overdueAt).toBe("string");

    const event = await client.waitForEvent((e) => e.type === "JOURNEY_OVERDUE");
    expect(event.data).toEqual({ journeyId: journey.id, groupId, userId: owner.userId });
    await outsiderClient.expectNoEvent(() => true);

    // Push: demais membros, sem o dono e sem externo; conteúdo seguro.
    expect(push.batches).toHaveLength(1);
    expect(push.recipients.sort()).toEqual([tokens.a, tokens.b].sort());
    for (const message of push.messages) {
      expect(message.title).toBe(JOURNEY_OVERDUE_TITLE);
      expect(message.body).toBe(JOURNEY_OVERDUE_BODY);
      expect(message.data).toEqual({
        type: "SAFE_JOURNEY_OVERDUE",
        journeyId: journey.id,
        groupId,
      });
    }
    const raw = JSON.stringify(push.messages.map(({ to: _to, ...rest }) => rest));
    for (const forbidden of ["Felipe", owner.email, "latitude", "emergência", "perigo"]) {
      expect(raw).not.toContain(forbidden);
    }

    expect(await app.journeyScheduler.runOnce()).toBe(0);
    await app.background.flush();
    expect(push.batches).toHaveLength(1);
    expect(client.events.filter((e) => e.type === "JOURNEY_OVERDUE")).toHaveLength(1);
  });

  it("nenhum alerta de emergência é criado ao vencer", async () => {
    const journey = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, journey.id);
    await app.journeyScheduler.runOnce();
    await app.background.flush();
    const [alerts] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM emergency_alerts
    `;
    expect(alerts?.count).toBe(0);
  });

  it("token inativo não recebe; falha do provedor não desfaz OVERDUE", async () => {
    const active = await registerActiveDevice(app, memberA);
    const inactive = await registerActiveDevice(app, memberB);
    await app.inject({
      method: "DELETE",
      url: `/me/push-devices/${inactive.deviceId}`,
      headers: authHeaders(memberB),
    });

    const first = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, first.id);
    await app.journeyScheduler.runOnce();
    await app.background.flush();
    expect(push.recipients).toEqual([active.token]);

    push.reset();
    push.failNext(new Error("Expo indisponível"));
    await journeyAction(app, owner, first.id, "arrive");
    const second = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, second.id);
    expect(await app.journeyScheduler.runOnce()).toBe(1);
    await app.background.flush();
    expect((await statusOf(second.id)).status).toBe("OVERDUE");
    expect(app.background.pendingCount()).toBe(0);
  });

  it("falha do publisher realtime não desfaz a persistência", async () => {
    const journey = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, journey.id);
    const original = app.realtimeHub.send.bind(app.realtimeHub);
    app.realtimeHub.send = () => {
      throw new Error("hub indisponível");
    };
    try {
      expect(await app.journeyScheduler.runOnce()).toBe(1);
      await app.background.flush();
      expect((await statusOf(journey.id)).status).toBe("OVERDUE");
    } finally {
      app.realtimeHub.send = original;
    }
  });

  it("processa em lote respeitando batchSize e termina os restantes na execução seguinte", async () => {
    const users = await Promise.all([registerUser(app), registerUser(app), registerUser(app)]);
    const ids: string[] = [];
    for (const user of users) {
      await addMember(app, owner, groupId, user);
      const journey = await createJourney(app, user, groupId);
      await expireJourney(cleaner.sql, journey.id);
      ids.push(journey.id);
    }
    const processed: string[] = [];
    const scheduler = new JourneyScheduler({
      db: app.db,
      log: app.log,
      batchSize: 2,
      onOverdue: (journey) => {
        processed.push(journey.id);
      },
    });
    expect(await scheduler.runOnce()).toBe(2);
    expect(await scheduler.runOnce()).toBe(1);
    expect(await scheduler.runOnce()).toBe(0);
    expect(processed.sort()).toEqual(ids.sort());
  });

  it("restart lógico: uma nova instância encontra os prazos pendentes no banco", async () => {
    const journey = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, journey.id);

    const restarted = await createTestApp({ pushProvider: new FakePushProvider() });
    try {
      expect(await restarted.journeyScheduler.runOnce()).toBe(1);
      await restarted.background.flush();
    } finally {
      await restarted.close();
    }
    expect((await statusOf(journey.id)).status).toBe("OVERDUE");
    expect(await app.journeyScheduler.runOnce()).toBe(0);
  });

  it("execuções concorrentes geram exatamente uma transição por trajeto", async () => {
    const other = await registerUser(app);
    await addMember(app, owner, groupId, other);
    const ids = [
      (await createJourney(app, owner, groupId)).id,
      (await createJourney(app, memberA, groupId)).id,
      (await createJourney(app, other, groupId)).id,
    ];
    for (const id of ids) await expireJourney(cleaner.sql, id);

    const effects: string[] = [];
    const makeScheduler = () =>
      new JourneyScheduler({
        db: app.db,
        log: app.log,
        onOverdue: (journey) => {
          effects.push(journey.id);
        },
      });
    const [a, b, c] = await Promise.all([
      makeScheduler().runOnce(),
      makeScheduler().runOnce(),
      makeScheduler().runOnce(),
    ]);
    expect(a + b + c).toBe(3);
    expect(effects.sort()).toEqual(ids.sort());
    for (const id of ids) {
      expect((await statusOf(id)).status).toBe("OVERDUE");
    }
  });

  it("start()/stop() seguem o lifecycle e chamadas sobrepostas compartilham a execução", async () => {
    const journey = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, journey.id);
    let effects = 0;
    const scheduler = new JourneyScheduler({
      db: app.db,
      log: app.log,
      intervalMs: 20,
      onOverdue: () => {
        effects += 1;
      },
    });
    scheduler.start();
    scheduler.start();
    expect(scheduler.isStarted()).toBe(true);
    await waitUntil(() => effects === 1, 5000);
    scheduler.stop();
    expect(scheduler.isStarted()).toBe(false);

    const second = await createJourney(app, memberA, groupId);
    await expireJourney(cleaner.sql, second.id);
    const [x, y] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    expect(x).toBe(1);
    expect(y).toBe(1);
    expect(effects).toBe(2);
  });
});

describe("Retenção de trajetos", () => {
  it("apaga só trajetos finalizados há mais de 90 dias; nunca ACTIVE nem OVERDUE em aberto", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);

    const oldArrived = await createJourney(app, owner, groupId);
    await journeyAction(app, owner, oldArrived.id, "arrive");
    await cleaner.sql`
      UPDATE safe_journeys SET arrived_at = now() - interval '91 days' WHERE id = ${oldArrived.id}
    `;

    const recentCancelled = await createJourney(app, owner, groupId);
    await journeyAction(app, owner, recentCancelled.id, "cancel");

    const active = await createJourney(app, owner, groupId);
    await cleaner.sql`
      UPDATE safe_journeys SET created_at = now() - interval '200 days',
        updated_at = now() - interval '200 days' WHERE id = ${active.id}
    `;

    expect(await deleteExpiredJourneys(app.db, new Date(), JOURNEY_RETENTION_DAYS)).toBe(1);
    const rows = await cleaner.sql<{ id: string }[]>`SELECT id FROM safe_journeys ORDER BY id`;
    expect(rows.map((r) => r.id).sort()).toEqual([recentCancelled.id, active.id].sort());
    expect(await deleteExpiredJourneys(app.db)).toBe(0);
  });
});
