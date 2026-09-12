import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { createCheckin, expireCheckin, getCheckin } from "./helpers/checkins.js";
import { registerActiveDevice } from "./helpers/push.js";
import {
  connectRealtime,
  startRealtimeServer,
  waitUntil,
  type RealtimeTestClient,
} from "./helpers/realtime.js";
import { FakePushProvider } from "../src/infrastructure/push/fake-push-provider.js";
import { CheckinScheduler } from "../src/modules/checkins/checkin-scheduler.js";
import {
  CHECKIN_RETENTION_DAYS,
  deleteExpiredCheckins,
} from "../src/modules/checkins/checkins.service.js";
import {
  CHECKIN_OVERDUE_BODY,
  CHECKIN_OVERDUE_TITLE,
} from "../src/modules/checkins/checkin-notifications.service.js";

const cleaner = createCleaner();
const push = new FakePushProvider();
let app: FastifyInstance;
let wsUrl: string;
const openClients: RealtimeTestClient[] = [];

async function statusOf(checkinId: string): Promise<{ status: string; overdue_at: Date | null }> {
  const [row] = await cleaner.sql<{ status: string; overdue_at: Date | null }[]>`
    SELECT status, overdue_at FROM safety_checkins WHERE id = ${checkinId}
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

describe("CheckinScheduler", () => {
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
    expect(app.checkinScheduler.isStarted()).toBe(false);
    const checkin = await createCheckin(app, owner, groupId, 30);
    expect(await app.checkinScheduler.runOnce()).toBe(0);
    expect((await statusOf(checkin.id)).status).toBe("ACTIVE");
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

    const checkin = await createCheckin(app, owner, groupId, 10);
    await client.waitForEvent((e) => e.type === "CHECKIN_CREATED");
    await expireCheckin(cleaner.sql, checkin.id);

    expect(await app.checkinScheduler.runOnce()).toBe(1);
    await app.background.flush();

    const row = await statusOf(checkin.id);
    expect(row.status).toBe("OVERDUE");
    expect(row.overdue_at).toBeInstanceOf(Date);
    const view = await getCheckin(app, memberA, checkin.id);
    expect(view.json()).toMatchObject({ status: "OVERDUE" });
    expect(typeof view.json().overdueAt).toBe("string");

    // Realtime: membros recebem CHECKIN_OVERDUE; externo não.
    const event = await client.waitForEvent((e) => e.type === "CHECKIN_OVERDUE");
    expect(event.data).toEqual({ checkinId: checkin.id, groupId, userId: owner.userId });
    await outsiderClient.expectNoEvent(() => true);

    // Push: demais membros, sem o dono e sem externo; conteúdo seguro.
    expect(push.batches).toHaveLength(1);
    expect(push.recipients.sort()).toEqual([tokens.a, tokens.b].sort());
    for (const message of push.messages) {
      expect(message.title).toBe(CHECKIN_OVERDUE_TITLE);
      expect(message.body).toBe(CHECKIN_OVERDUE_BODY);
      expect(message.data).toEqual({
        type: "SAFETY_CHECKIN_OVERDUE",
        checkinId: checkin.id,
        groupId,
      });
    }
    const raw = JSON.stringify(push.messages.map(({ to: _to, ...rest }) => rest));
    for (const forbidden of ["Felipe", owner.email, "latitude", "emergência", "perigo"]) {
      expect(raw).not.toContain(forbidden);
    }

    // Segunda execução: nada a processar, nenhum push/evento a mais.
    expect(await app.checkinScheduler.runOnce()).toBe(0);
    await app.background.flush();
    expect(push.batches).toHaveLength(1);
    expect(client.events.filter((e) => e.type === "CHECKIN_OVERDUE")).toHaveLength(1);
  });

  it("nenhum alerta de emergência nem sessão de localização é criado ao vencer", async () => {
    const checkin = await createCheckin(app, owner, groupId, 10);
    await expireCheckin(cleaner.sql, checkin.id);
    await app.checkinScheduler.runOnce();
    await app.background.flush();
    const [alerts] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM emergency_alerts
    `;
    const [sessions] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM alert_location_sessions
    `;
    expect(alerts?.count).toBe(0);
    expect(sessions?.count).toBe(0);
  });

  it("token inativo não recebe; falha do provedor não desfaz OVERDUE", async () => {
    const active = await registerActiveDevice(app, memberA);
    const inactive = await registerActiveDevice(app, memberB);
    await app.inject({
      method: "DELETE",
      url: `/me/push-devices/${inactive.deviceId}`,
      headers: authHeaders(memberB),
    });

    const first = await createCheckin(app, owner, groupId, 10);
    await expireCheckin(cleaner.sql, first.id);
    await app.checkinScheduler.runOnce();
    await app.background.flush();
    expect(push.recipients).toEqual([active.token]);

    push.reset();
    push.failNext(new Error("Expo indisponível"));
    await app.inject({
      method: "POST",
      url: `/checkins/${first.id}/safe`,
      headers: authHeaders(owner),
    });
    const second = await createCheckin(app, owner, groupId, 10);
    await expireCheckin(cleaner.sql, second.id);
    expect(await app.checkinScheduler.runOnce()).toBe(1);
    await app.background.flush();
    expect((await statusOf(second.id)).status).toBe("OVERDUE");
    expect(app.background.pendingCount()).toBe(0);
  });

  it("falha do publisher realtime não desfaz a persistência", async () => {
    const checkin = await createCheckin(app, owner, groupId, 10);
    await expireCheckin(cleaner.sql, checkin.id);
    const original = app.realtimeHub.send.bind(app.realtimeHub);
    app.realtimeHub.send = () => {
      throw new Error("hub indisponível");
    };
    try {
      expect(await app.checkinScheduler.runOnce()).toBe(1);
      await app.background.flush();
      expect((await statusOf(checkin.id)).status).toBe("OVERDUE");
    } finally {
      app.realtimeHub.send = original;
    }
  });

  it("processa em lote respeitando batchSize e termina os restantes na execução seguinte", async () => {
    const users = await Promise.all([registerUser(app), registerUser(app), registerUser(app)]);
    const ids: string[] = [];
    for (const user of users) {
      await addMember(app, owner, groupId, user);
      const checkin = await createCheckin(app, user, groupId, 10);
      await expireCheckin(cleaner.sql, checkin.id);
      ids.push(checkin.id);
    }
    const processed: string[] = [];
    const scheduler = new CheckinScheduler({
      db: app.db,
      log: app.log,
      batchSize: 2,
      onOverdue: (checkin) => {
        processed.push(checkin.id);
      },
    });
    expect(await scheduler.runOnce()).toBe(2);
    expect(await scheduler.runOnce()).toBe(1);
    expect(await scheduler.runOnce()).toBe(0);
    expect(processed.sort()).toEqual(ids.sort());
  });

  it("restart lógico: uma nova instância da API encontra os prazos pendentes no banco", async () => {
    const checkin = await createCheckin(app, owner, groupId, 10);
    await expireCheckin(cleaner.sql, checkin.id);

    const restarted = await createTestApp({ pushProvider: new FakePushProvider() });
    try {
      expect(await restarted.checkinScheduler.runOnce()).toBe(1);
      await restarted.background.flush();
    } finally {
      await restarted.close();
    }
    expect((await statusOf(checkin.id)).status).toBe("OVERDUE");
    // A instância original não reprocessa.
    expect(await app.checkinScheduler.runOnce()).toBe(0);
  });

  it("execuções concorrentes (duas instâncias) geram exatamente uma transição por check-in", async () => {
    const other = await registerUser(app);
    await addMember(app, owner, groupId, other);
    const ids = [
      (await createCheckin(app, owner, groupId, 10)).id,
      (await createCheckin(app, memberA, groupId, 10)).id,
      (await createCheckin(app, other, groupId, 10)).id,
    ];
    for (const id of ids) await expireCheckin(cleaner.sql, id);

    const effects: string[] = [];
    const makeScheduler = () =>
      new CheckinScheduler({
        db: app.db,
        log: app.log,
        onOverdue: (checkin) => {
          effects.push(checkin.id);
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

  it("start()/stop() seguem o lifecycle sem timer órfão e chamadas sobrepostas compartilham a execução", async () => {
    const checkin = await createCheckin(app, owner, groupId, 10);
    await expireCheckin(cleaner.sql, checkin.id);
    let effects = 0;
    const scheduler = new CheckinScheduler({
      db: app.db,
      log: app.log,
      intervalMs: 20,
      onOverdue: () => {
        effects += 1;
      },
    });
    scheduler.start();
    scheduler.start(); // idempotente
    expect(scheduler.isStarted()).toBe(true);
    await waitUntil(() => effects === 1, 5000);
    scheduler.stop();
    expect(scheduler.isStarted()).toBe(false);

    const second = await createCheckin(app, memberA, groupId, 10);
    await expireCheckin(cleaner.sql, second.id);
    const [x, y] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
    expect(x).toBe(1);
    expect(y).toBe(1); // mesma execução compartilhada
    expect(effects).toBe(2);
  });
});

describe("Retenção de check-ins", () => {
  it("apaga só check-ins finalizados há mais de 90 dias; nunca ACTIVE nem recentes", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const other = await createGroup(app, owner, "Amigos");
    const third = await createGroup(app, owner, "Vizinhos");

    const oldSafe = await createCheckin(app, owner, groupId, 10);
    await app.inject({
      method: "POST",
      url: `/checkins/${oldSafe.id}/safe`,
      headers: authHeaders(owner),
    });
    await cleaner.sql`
      UPDATE safety_checkins SET confirmed_at = now() - interval '91 days' WHERE id = ${oldSafe.id}
    `;
    const recentCancelled = await createCheckin(app, owner, other, 10);
    await app.inject({
      method: "POST",
      url: `/checkins/${recentCancelled.id}/cancel`,
      headers: authHeaders(owner),
    });
    const active = await createCheckin(app, owner, third, 10);
    // Um ACTIVE muito antigo (prazo vencido há meses) também não pode ser apagado.
    await cleaner.sql`
      UPDATE safety_checkins SET created_at = now() - interval '200 days',
        updated_at = now() - interval '200 days' WHERE id = ${active.id}
    `;

    expect(await deleteExpiredCheckins(app.db, new Date(), CHECKIN_RETENTION_DAYS)).toBe(1);
    const rows = await cleaner.sql<{ id: string }[]>`SELECT id FROM safety_checkins ORDER BY id`;
    expect(rows.map((r) => r.id).sort()).toEqual([recentCancelled.id, active.id].sort());
    expect(await deleteExpiredCheckins(app.db)).toBe(0);
  });
});
