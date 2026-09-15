import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createTestApp } from "../helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "../helpers/test-db.js";
import { authHeaders, registerUser, sessionIdOf, type TestUser } from "../helpers/auth.js";
import { addMember, createGroup } from "../helpers/groups.js";
import { createAlert, SYNTHETIC_LOCATION } from "../helpers/alerts.js";
import { createCheckin } from "../helpers/checkins.js";
import { createJourney } from "../helpers/journeys.js";
import { registerActiveDevice } from "../helpers/push.js";
import { drainOutbox } from "../helpers/outbox.js";
import { FakePushProvider } from "../../src/infrastructure/push/fake-push-provider.js";

/**
 * Exportação dos próprios dados (Phase 11): só o que é do usuário, nunca
 * segredo, nunca terceiro, nunca interno operacional.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let groupId: string;
let memberToken: string;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
  owner = await registerUser(app, { name: "Felipe Dono" });
  member = await registerUser(app, { name: "Maria Membro" });
  outsider = await registerUser(app, { name: "Otávio Fora" });
  groupId = await createGroup(app, owner, "Família");
  await addMember(app, owner, groupId, member);
  memberToken = (await registerActiveDevice(app, member)).token;
  await registerActiveDevice(app, owner);
  await drainOutbox(app);
});

const exportFor = (user: TestUser) =>
  app.inject({ method: "GET", url: "/me/privacy/export", headers: authHeaders(user) });

describe("GET /me/privacy/export", () => {
  it("exige autenticação", async () => {
    expect((await app.inject({ method: "GET", url: "/me/privacy/export" })).statusCode).toBe(401);
  });

  it("devolve só os dados do próprio usuário, com contexto mínimo", async () => {
    const ownAlert = await createAlert(app, owner, groupId, SYNTHETIC_LOCATION);
    // O membro também cria alerta e check-in: nada disso pode aparecer para o dono.
    const memberAlert = await createAlert(app, member, groupId, {
      latitude: -22.9,
      longitude: -43.2,
      accuracy: 10,
    });
    await createCheckin(app, member, groupId);
    const ownCheckin = await createCheckin(app, owner, groupId);
    const ownJourney = await createJourney(app, owner, groupId, { destinationLabel: "Casa" });
    await drainOutbox(app);

    const res = await exportFor(owner);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();

    expect(body.version).toBe(1);
    expect(body.profile).toEqual({
      id: owner.userId,
      name: owner.name,
      email: owner.email,
      createdAt: expect.any(String),
    });
    expect(body.memberships).toEqual([
      { groupId, groupName: "Família", role: "OWNER", since: expect.any(String) },
    ]);

    expect(body.alerts.map((a: { id: string }) => a.id)).toEqual([ownAlert.id]);
    expect(body.alerts[0].initialLocation).toEqual({
      latitude: SYNTHETIC_LOCATION.latitude,
      longitude: SYNTHETIC_LOCATION.longitude,
      accuracy: SYNTHETIC_LOCATION.accuracy,
    });
    expect(body.checkins.map((c: { id: string }) => c.id)).toEqual([ownCheckin.id]);
    expect(body.journeys.map((j: { id: string }) => j.id)).toEqual([ownJourney.id]);
    expect(body.journeys[0].destinationLabel).toBe("Casa");
    expect(body.sessions).toEqual([
      expect.objectContaining({ sessionId: sessionIdOf(owner), current: true }),
    ]);
    expect(body.pushDevices).toHaveLength(1);
    expect(body.pushDevices[0]).toEqual({
      id: expect.any(String),
      platform: expect.any(String),
      deviceId: expect.any(String),
      isActive: true,
      createdAt: expect.any(String),
    });

    // Nada de terceiros: alerta, check-in, localização, e-mail ou nome alheios.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(memberAlert.id);
    expect(raw).not.toContain(member.email);
    expect(raw).not.toContain(member.name);
    expect(raw).not.toContain(outsider.email);
    expect(raw).not.toMatch(/-22\.9\b/);
    expect(raw).not.toMatch(/-43\.2\b/);
  });

  it("nunca inclui segredos, tokens, hashes nem internos da outbox/auditoria", async () => {
    await createAlert(app, owner, groupId);
    await drainOutbox(app);
    const res = await exportFor(owner);
    const raw = JSON.stringify(res.json());

    for (const forbidden of [
      "passwordHash",
      "password_hash",
      "argon2",
      "refreshToken",
      "refresh_token",
      "tokenHash",
      "token_hash",
      "accessToken",
      "ExponentPushToken",
      "ExpoPushToken",
      memberToken,
      owner.refreshToken,
      owner.accessToken,
      "outbox",
      "audit",
      "attemptCount",
      "lastErrorCode",
      "metrics",
      "authorization",
    ]) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
    // A chave `token` não existe em nenhum objeto (dispositivos são sanitizados).
    expect(raw).not.toMatch(/"token"\s*:/);
  });

  it("membro do grupo não recebe a localização do alerta do dono pela exportação", async () => {
    await createAlert(app, owner, groupId, SYNTHETIC_LOCATION);
    await drainOutbox(app);
    const res = await exportFor(member);
    const body = res.json();
    expect(body.alerts).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${SYNTHETIC_LOCATION.latitude}\\b`));
    // A membership dele aparece, com o nome do grupo (contexto mínimo).
    expect(body.memberships).toEqual([
      { groupId, groupName: "Família", role: "MEMBER", since: expect.any(String) },
    ]);
  });

  it("convites destinados ao usuário aparecem sem revelar quem convidou", async () => {
    const invited = await registerUser(app);
    const inv = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/invitations`,
      headers: authHeaders(owner),
      payload: { email: invited.email },
    });
    expect(inv.statusCode).toBe(201);

    const body = (await exportFor(invited)).json();
    expect(body.invitations).toEqual([
      {
        groupId,
        groupName: "Família",
        status: "PENDING",
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(owner.userId);
    expect(JSON.stringify(body)).not.toContain(owner.email);
  });

  it("registra PRIVACY_EXPORT_REQUESTED na auditoria, sem conteúdo", async () => {
    await exportFor(owner);
    await drainOutbox(app);
    const rows = await cleaner.sql<{ actor_user_id: string; metadata: unknown }[]>`
      SELECT actor_user_id, metadata FROM audit_events WHERE event_type = 'PRIVACY_EXPORT_REQUESTED'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(owner.userId);
    expect(rows[0]?.metadata).toBeNull();
  });

  it("tem rate limit próprio", async () => {
    const strict = await buildApp({
      logger: false,
      databaseUrl: getTestDatabaseUrl(),
      pushProvider: new FakePushProvider(),
      checkinSchedulerAutoStart: false,
      journeySchedulerAutoStart: false,
      outboxWorkerAutoStart: false,
      rateLimitProfile: "production",
    });
    await strict.ready();
    try {
      const user = await registerUser(strict);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await strict.inject({
          method: "GET",
          url: "/me/privacy/export",
          headers: authHeaders(user),
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      expect(statuses[5]).toBe(429);
    } finally {
      await strict.close();
    }
  });
});
