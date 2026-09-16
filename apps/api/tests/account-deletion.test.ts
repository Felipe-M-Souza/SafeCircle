import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTestApp } from "./helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "./helpers/test-db.js";
import { authHeaders, registerUser, sessionIdOf, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { createAlert, SYNTHETIC_LOCATION } from "./helpers/alerts.js";
import { checkinAction, createCheckin } from "./helpers/checkins.js";
import { createJourney, journeyAction } from "./helpers/journeys.js";
import { registerActiveDevice } from "./helpers/push.js";
import { drainOutbox, outboxRows } from "./helpers/outbox.js";
import {
  connectRealtime,
  startRealtimeServer,
  type RealtimeTestClient,
} from "./helpers/realtime.js";
import { FakePushProvider } from "../src/infrastructure/push/fake-push-provider.js";
import { REALTIME_CLOSE_CODES } from "../src/infrastructure/realtime/realtime-hub.js";

/**
 * Exclusão de conta (Phase 12): o RELEASE BLOCKER da Phase 11 resolvido.
 * Bloqueios explícitos, reautenticação por senha, transação única, nada de
 * terceiros apagado, auditoria anonimizada e outbox consistente.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let wsUrl: string;
const openClients: RealtimeTestClient[] = [];

beforeAll(async () => {
  app = await createTestApp();
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
});

const preview = (user: TestUser) =>
  app.inject({ method: "GET", url: "/me/account-deletion", headers: authHeaders(user) });
const deleteAccount = (user: TestUser, password = user.password) =>
  app.inject({
    method: "POST",
    url: "/me/delete-account",
    headers: authHeaders(user),
    payload: { password },
  });
const count = async (table: string, where: string): Promise<number> => {
  const [row] = await cleaner.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM ${cleaner.sql(table)} WHERE ${cleaner.sql.unsafe(where)}
  `;
  return row?.count ?? 0;
};
const login = (user: TestUser) =>
  app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: user.email, password: user.password },
  });

describe("GET /me/account-deletion (prévia)", () => {
  it("sem bloqueios: pode excluir e mostra o impacto", async () => {
    const user = await registerUser(app);
    const groupId = await createGroup(app, user, "Só eu");
    await registerActiveDevice(app, user);
    const alert = await createAlert(app, user, groupId);
    await app.inject({
      method: "POST",
      url: `/alerts/${alert.id}/resolve`,
      headers: authHeaders(user),
    });

    const res = await preview(user);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      canDelete: true,
      blockers: {
        groupsWithOtherMembers: [],
        activeAlerts: [],
        activeCheckins: [],
        activeJourneys: [],
      },
      impact: {
        soleMemberGroups: [{ groupId, name: "Só eu" }],
        membershipsLeft: 0,
        alerts: 1,
        checkins: 0,
        journeys: 0,
        pushDevices: 1,
        sessions: 1,
      },
    });
  });

  it("lista os bloqueios: grupo com outros membros e recursos em andamento", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, member);
    const alert = await createAlert(app, owner, groupId);
    const checkin = await createCheckin(app, owner, groupId);
    const journey = await createJourney(app, owner, groupId);

    const body = (await preview(owner)).json();
    expect(body.canDelete).toBe(false);
    expect(body.blockers.groupsWithOtherMembers).toEqual([
      { groupId, name: "Família", memberCount: 2 },
    ]);
    expect(body.blockers.activeAlerts).toEqual([alert.id]);
    expect(body.blockers.activeCheckins).toEqual([checkin.id]);
    expect(body.blockers.activeJourneys).toEqual([journey.id]);
    // Membro não vê bloqueio nenhum: o grupo não é dele.
    expect((await preview(member)).json().canDelete).toBe(true);
  });

  it("exige autenticação", async () => {
    expect((await app.inject({ method: "GET", url: "/me/account-deletion" })).statusCode).toBe(401);
  });
});

describe("POST /me/delete-account — bloqueios e reautenticação", () => {
  it("senha errada: 401 INVALID_CREDENTIALS e nada é apagado", async () => {
    const user = await registerUser(app);
    const res = await deleteAccount(user, "senha-errada-errada");
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("INVALID_CREDENTIALS");
    expect(await count("users", `id = '${user.userId}'`)).toBe(1);
    expect(
      (await app.inject({ method: "GET", url: "/me", headers: authHeaders(user) })).statusCode,
    ).toBe(200);
  });

  it("senha errada repetida cai no freio por conta (429), sem confirmar nada", async () => {
    const throttled = await buildApp({
      logger: false,
      databaseUrl: getTestDatabaseUrl(),
      pushProvider: new FakePushProvider(),
      checkinSchedulerAutoStart: false,
      journeySchedulerAutoStart: false,
      outboxWorkerAutoStart: false,
      loginThrottle: { maxFailures: 2, windowMs: 60_000, blockMs: 60_000 },
    });
    await throttled.ready();
    try {
      const user = await registerUser(throttled);
      const attempt = (password: string) =>
        throttled.inject({
          method: "POST",
          url: "/me/delete-account",
          headers: authHeaders(user),
          payload: { password },
        });
      expect((await attempt("errada-1-errada")).statusCode).toBe(401);
      expect((await attempt("errada-2-errada")).statusCode).toBe(401);
      const blocked = await attempt(user.password);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe("RATE_LIMITED");
      expect(await count("users", `id = '${user.userId}'`)).toBe(1);
    } finally {
      await throttled.close();
    }
  });

  it("senha ausente ou corpo inválido → 400, sem tocar na conta", async () => {
    const user = await registerUser(app);
    const res = await app.inject({
      method: "POST",
      url: "/me/delete-account",
      headers: authHeaders(user),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(await count("users", `id = '${user.userId}'`)).toBe(1);
  });

  it("OWNER de grupo com outros membros: 409 com os grupos; nada é apagado", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, member);

    const res = await deleteAccount(owner);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("ACCOUNT_DELETION_BLOCKED_BY_GROUP_OWNERSHIP");
    expect(res.json().details).toEqual({
      groups: [{ groupId, name: "Família", memberCount: 2 }],
    });
    expect(await count("users", `id = '${owner.userId}'`)).toBe(1);
    expect(await count("trusted_groups", `id = '${groupId}'`)).toBe(1);
    expect(await count("group_memberships", `group_id = '${groupId}'`)).toBe(2);
  });

  it("recurso em andamento: 409 com os ids; emergência nunca é cancelada em silêncio", async () => {
    const user = await registerUser(app);
    const groupId = await createGroup(app, user);
    const alert = await createAlert(app, user, groupId, SYNTHETIC_LOCATION);
    const checkin = await createCheckin(app, user, groupId);
    const journey = await createJourney(app, user, groupId);

    const res = await deleteAccount(user);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("ACCOUNT_DELETION_BLOCKED_BY_ACTIVE_RESOURCES");
    expect(res.json().details).toEqual({
      alerts: [alert.id],
      checkins: [checkin.id],
      journeys: [journey.id],
    });
    // O alerta continua ACTIVE; nada foi encerrado pela tentativa.
    const check = await app.inject({
      method: "GET",
      url: `/alerts/${alert.id}`,
      headers: authHeaders(user),
    });
    expect(check.json().status).toBe("ACTIVE");
    expect(await count("users", `id = '${user.userId}'`)).toBe(1);

    // Encerrando tudo, a exclusão passa.
    await app.inject({
      method: "POST",
      url: `/alerts/${alert.id}/resolve`,
      headers: authHeaders(user),
    });
    await checkinAction(app, user, checkin.id, "safe");
    await journeyAction(app, user, journey.id, "arrive");
    expect((await deleteAccount(user)).statusCode).toBe(204);
  });

  it("check-in e trajeto OVERDUE também bloqueiam (ainda estão em andamento)", async () => {
    const user = await registerUser(app);
    const groupId = await createGroup(app, user);
    const checkin = await createCheckin(app, user, groupId);
    await cleaner.sql`UPDATE safety_checkins SET status = 'OVERDUE', overdue_at = now() WHERE id = ${checkin.id}`;
    const res = await deleteAccount(user);
    expect(res.statusCode).toBe(409);
    expect(res.json().details.checkins).toEqual([checkin.id]);
  });
});

describe("POST /me/delete-account — exclusão completa", () => {
  it("apaga a conta, sessões, histórico, push devices, convites e recursos próprios; login deixa de funcionar", async () => {
    const user = await registerUser(app);
    const secondLogin = await login(user);
    const secondAccess = secondLogin.json().accessToken as string;
    const groupId = await createGroup(app, user, "Só eu");
    await registerActiveDevice(app, user);
    await registerActiveDevice(app, user, { platform: "IOS" });
    const alert = await createAlert(app, user, groupId, SYNTHETIC_LOCATION);
    await app.inject({
      method: "POST",
      url: `/alerts/${alert.id}/live-location/start`,
      headers: authHeaders(user),
    });
    await app.inject({
      method: "POST",
      url: `/alerts/${alert.id}/resolve`,
      headers: authHeaders(user),
    });
    const checkin = await createCheckin(app, user, groupId);
    await checkinAction(app, user, checkin.id, "safe");
    const journey = await createJourney(app, user, groupId);
    await journeyAction(app, user, journey.id, "arrive");
    // Rotação para existir histórico de refresh.
    await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: user.refreshToken },
    });
    // Convite endereçado a este e-mail, vindo de outra pessoa.
    const other = await registerUser(app);
    const otherGroup = await createGroup(app, other, "Outro");
    await app.inject({
      method: "POST",
      url: `/groups/${otherGroup}/invitations`,
      headers: authHeaders(other),
      payload: { email: user.email },
    });
    await drainOutbox(app);
    expect(await count("auth_refresh_token_history", `session_id = '${sessionIdOf(user)}'`)).toBe(
      1,
    );
    expect(await count("group_invitations", `invited_email = '${user.email}'`)).toBe(1);

    const res = await deleteAccount(user);
    expect(res.statusCode).toBe(204);

    // A pessoa não existe mais, nem o que era dela.
    expect(await count("users", `id = '${user.userId}'`)).toBe(0);
    expect(await count("auth_sessions", `user_id = '${user.userId}'`)).toBe(0);
    expect(await count("auth_refresh_token_history", "true")).toBe(0);
    expect(await count("push_devices", `user_id = '${user.userId}'`)).toBe(0);
    expect(await count("trusted_groups", `id = '${groupId}'`)).toBe(0);
    expect(await count("emergency_alerts", `id = '${alert.id}'`)).toBe(0);
    expect(await count("alert_locations", `alert_id = '${alert.id}'`)).toBe(0);
    expect(await count("alert_location_sessions", `alert_id = '${alert.id}'`)).toBe(0);
    expect(await count("safety_checkins", `id = '${checkin.id}'`)).toBe(0);
    expect(await count("safe_journeys", `id = '${journey.id}'`)).toBe(0);
    expect(await count("group_invitations", `invited_email = '${user.email}'`)).toBe(0);

    // Todo acesso morre: tokens das duas sessões, refresh e login.
    expect(
      (await app.inject({ method: "GET", url: "/me", headers: authHeaders(user) })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/me",
          headers: { authorization: `Bearer ${secondAccess}` },
        })
      ).statusCode,
    ).toBe(401);
    const refresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: secondLogin.json().refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
    const relogin = await login(user);
    expect(relogin.statusCode).toBe(401);
    expect(relogin.json().code).toBe("INVALID_CREDENTIALS");

    // Repetir a exclusão é seguro: sem sessão, 401 — nunca 500.
    expect((await deleteAccount(user)).statusCode).toBe(401);

    // O outro usuário e o grupo dele ficam intactos.
    expect(await count("users", `id = '${other.userId}'`)).toBe(1);
    expect(await count("trusted_groups", `id = '${otherGroup}'`)).toBe(1);
  });

  it("OWNER único de um grupo: o grupo vai junto; grupos em que era membro ficam, sem a membership", async () => {
    const user = await registerUser(app);
    const friend = await registerUser(app);
    const soloGroup = await createGroup(app, user, "Solo");
    const sharedGroup = await createGroup(app, friend, "Amigos");
    await addMember(app, friend, sharedGroup, user);
    await drainOutbox(app);

    expect((await deleteAccount(user)).statusCode).toBe(204);

    expect(await count("trusted_groups", `id = '${soloGroup}'`)).toBe(0);
    expect(await count("trusted_groups", `id = '${sharedGroup}'`)).toBe(1);
    expect(await count("group_memberships", `group_id = '${sharedGroup}'`)).toBe(1);
    const members = await app.inject({
      method: "GET",
      url: `/groups/${sharedGroup}/members`,
      headers: authHeaders(friend),
    });
    expect(members.json().map((m: { id: string }) => m.id)).toEqual([friend.userId]);

    // O grupo que ficou recebe o evento de membership e a trilha registra a saída sem ator.
    await drainOutbox(app);
    const rows = await cleaner.sql<
      { actor_user_id: string | null; metadata: { source?: string } }[]
    >`
      SELECT actor_user_id, metadata FROM audit_events
       WHERE event_type = 'GROUP_MEMBER_REMOVED' AND group_id = ${sharedGroup}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBeNull();
    expect(rows[0]?.metadata).toEqual({ source: "account_deletion" });
  });

  it("depois de transferir a propriedade, a exclusão passa e o grupo continua com o novo dono", async () => {
    const owner = await registerUser(app);
    const heir = await registerUser(app);
    const groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, heir);

    const transfer = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/transfer-ownership`,
      headers: authHeaders(owner),
      payload: { userId: heir.userId },
    });
    expect(transfer.statusCode).toBe(204);
    expect((await preview(owner)).json().canDelete).toBe(true);
    expect((await deleteAccount(owner)).statusCode).toBe(204);

    const group = await app.inject({
      method: "GET",
      url: `/groups/${groupId}`,
      headers: authHeaders(heir),
    });
    expect(group.statusCode).toBe(200);
    expect(group.json().role).toBe("OWNER");
    expect(group.json().memberCount).toBe(1);
  });

  it("nunca apaga dados de terceiros no grupo compartilhado", async () => {
    const user = await registerUser(app);
    const friend = await registerUser(app);
    const groupId = await createGroup(app, friend, "Amigos");
    await addMember(app, friend, groupId, user);
    const friendAlert = await createAlert(app, friend, groupId, SYNTHETIC_LOCATION);
    // A pessoa confirma o alerta do amigo; o amigo confirma um alerta dela.
    await app.inject({
      method: "PUT",
      url: `/alerts/${friendAlert.id}/acknowledgement`,
      headers: authHeaders(user),
      payload: { type: "SEEN" },
    });
    const userAlert = await createAlert(app, user, groupId);
    await app.inject({
      method: "PUT",
      url: `/alerts/${userAlert.id}/acknowledgement`,
      headers: authHeaders(friend),
      payload: { type: "SEEN" },
    });
    await app.inject({
      method: "POST",
      url: `/alerts/${userAlert.id}/resolve`,
      headers: authHeaders(user),
    });
    const friendCheckin = await createCheckin(app, friend, groupId);
    await drainOutbox(app);

    expect((await deleteAccount(user)).statusCode).toBe(204);

    // Do amigo, tudo fica: alerta (com localização), check-in e a própria conta.
    expect(await count("emergency_alerts", `id = '${friendAlert.id}'`)).toBe(1);
    expect(await count("alert_locations", `alert_id = '${friendAlert.id}'`)).toBe(1);
    expect(await count("safety_checkins", `id = '${friendCheckin.id}'`)).toBe(1);
    // A confirmação DA PESSOA no alerta do amigo vai embora (é dela).
    expect(await count("alert_acknowledgements", `alert_id = '${friendAlert.id}'`)).toBe(0);
    // O alerta DA PESSOA vai embora com a confirmação do amigo sobre ele.
    expect(await count("emergency_alerts", `id = '${userAlert.id}'`)).toBe(0);
    expect(await count("alert_acknowledgements", `alert_id = '${userAlert.id}'`)).toBe(0);
    const friendView = await app.inject({
      method: "GET",
      url: `/alerts/${friendAlert.id}`,
      headers: authHeaders(friend),
    });
    expect(friendView.statusCode).toBe(200);
  });

  it("fecha o WebSocket da pessoa na hora", async () => {
    const user = await registerUser(app);
    const client = await connectRealtime(wsUrl, user.accessToken);
    openClients.push(client);
    const deadline = Date.now() + 3000;
    while (app.realtimeHub.connectionCount(user.userId) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await deleteAccount(user)).statusCode).toBe(204);
    const closed = await client.waitForClose(5000);
    expect(closed.code).toBe(REALTIME_CLOSE_CODES.SESSION_REVOKED);
    expect(closed.reason).toBe("ACCOUNT_DELETED");
    expect(app.realtimeHub.connectionCount(user.userId)).toBe(0);
  });
});

describe("Exclusão de conta — auditoria e outbox", () => {
  it("registra REQUESTED e COMPLETED anonimizados; a trilha antiga perde o ator, não o fato", async () => {
    const user = await registerUser(app);
    const groupId = await createGroup(app, user, "Só eu");
    const alert = await createAlert(app, user, groupId);
    await app.inject({
      method: "POST",
      url: `/alerts/${alert.id}/resolve`,
      headers: authHeaders(user),
    });
    await drainOutbox(app);
    const [before] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_events WHERE actor_user_id = ${user.userId}
    `;
    expect(before?.count).toBeGreaterThan(0);

    expect((await deleteAccount(user)).statusCode).toBe(204);
    await drainOutbox(app);

    const rows = await cleaner.sql<
      {
        event_type: string;
        actor_user_id: string | null;
        target_id: string | null;
        metadata: unknown;
      }[]
    >`
      SELECT event_type, actor_user_id, target_id, metadata FROM audit_events
       WHERE event_type IN ('ACCOUNT_DELETION_REQUESTED', 'ACCOUNT_DELETION_COMPLETED')
       ORDER BY created_at
    `;
    expect(rows.map((r) => r.event_type)).toEqual([
      "ACCOUNT_DELETION_REQUESTED",
      "ACCOUNT_DELETION_COMPLETED",
    ]);
    for (const row of rows) {
      expect(row.actor_user_id).toBeNull();
      expect(row.target_id).toBe(user.userId);
    }
    expect(rows[1]?.metadata).toEqual({ groupsDeleted: 1 });

    // Nenhuma linha antiga aponta mais para a pessoa; os eventos continuam lá.
    const [after] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_events WHERE actor_user_id = ${user.userId}
    `;
    expect(after?.count).toBe(0);
    const [created] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_events WHERE event_type = 'ALERT_CREATED'
    `;
    expect(created?.count).toBe(1);
    const raw = JSON.stringify(await cleaner.sql`SELECT metadata FROM audit_events`);
    expect(raw).not.toContain(user.email);
    expect(raw).not.toContain(user.name);
  });

  it("evento pendente na outbox que cita a pessoa é entregue anonimizado, nunca vira DEAD", async () => {
    const user = await registerUser(app);
    await drainOutbox(app);
    // Login cria um AUDIT_AUTH_LOGIN_SUCCEEDED que fica PENDING (sem drenar).
    expect((await login(user)).statusCode).toBe(200);
    const pending = (await outboxRows(cleaner.sql)).filter((row) => row.status === "PENDING");
    expect(pending.some((row) => row.event_type === "AUDIT_AUTH_LOGIN_SUCCEEDED")).toBe(true);

    expect((await deleteAccount(user)).statusCode).toBe(204);
    await drainOutbox(app);

    const rows = await outboxRows(cleaner.sql);
    expect(rows.filter((row) => row.status === "DEAD")).toHaveLength(0);
    expect(rows.filter((row) => row.status === "PENDING")).toHaveLength(0);
    const [loginAudit] = await cleaner.sql<{ actor_user_id: string | null }[]>`
      SELECT actor_user_id FROM audit_events WHERE event_type = 'AUTH_LOGIN_SUCCEEDED'
       ORDER BY created_at DESC LIMIT 1
    `;
    expect(loginAudit).toBeDefined();
    expect(loginAudit?.actor_user_id).toBeNull();
  });

  it("duas exclusões concorrentes: uma vence, a outra recebe 401, e o estado final é um só", async () => {
    const user = await registerUser(app);
    await createGroup(app, user, "Só eu");
    const results = await Promise.all([deleteAccount(user), deleteAccount(user)]);
    const statuses = results.map((res) => res.statusCode).sort();
    expect(statuses).toEqual([204, 401]);
    expect(await count("users", `id = '${user.userId}'`)).toBe(0);
    const [completed] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM outbox_events WHERE event_type = 'AUDIT_ACCOUNT_DELETION_COMPLETED'
    `;
    expect(completed?.count).toBe(1);
  });
});
