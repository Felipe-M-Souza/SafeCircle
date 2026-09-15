import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { drainOutbox } from "./helpers/outbox.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { checkinAction, createCheckin, expireCheckin } from "./helpers/checkins.js";
import { createJourney, expireJourney, journeyAction } from "./helpers/journeys.js";
import {
  AUDIT_RETENTION_DAYS,
  deleteExpiredAuditEvents,
  sanitizeMetadata,
} from "../src/observability/audit.js";
import { metricValue } from "../src/observability/metrics.js";
import { isValidRequestId } from "../src/observability/request-context.js";

const cleaner = createCleaner();
let app: FastifyInstance;

interface AuditRow {
  event_type: string;
  actor_user_id: string | null;
  target_type: string | null;
  target_id: string | null;
  group_id: string | null;
  outcome: string;
  request_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

async function auditRows(eventType?: string): Promise<AuditRow[]> {
  if (eventType) {
    return cleaner.sql<AuditRow[]>`
      SELECT * FROM audit_events WHERE event_type = ${eventType} ORDER BY created_at
    `;
  }
  return cleaner.sql<AuditRow[]>`SELECT * FROM audit_events ORDER BY created_at`;
}

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
});

describe("Auditoria de ações críticas", () => {
  let owner: TestUser;
  let member: TestUser;
  let groupId: string;

  beforeEach(async () => {
    owner = await registerUser(app, { name: "Felipe" });
    member = await registerUser(app, { name: "Maria" });
    groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, member);
    await drainOutbox(app);
  });

  it("login bem-sucedido registra o ator e correlaciona com a requisição", async () => {
    await cleaner.sql`DELETE FROM audit_events`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: owner.email, password: "senhaSegura123" },
    });
    expect(res.statusCode).toBe(200);
    await drainOutbox(app);

    const [row] = await auditRows("AUTH_LOGIN_SUCCEEDED");
    expect(row).toBeTruthy();
    expect(row!.actor_user_id).toBe(owner.userId);
    expect(row!.outcome).toBe("SUCCEEDED");
    expect(row!.request_id).toBe(res.headers["x-request-id"]);
    expect(isValidRequestId(row!.request_id)).toBe(true);
  });

  it("login com senha errada registra falha sem ator e sem credencial", async () => {
    await cleaner.sql`DELETE FROM audit_events`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: owner.email, password: "senhaErrada12345" },
    });
    expect(res.statusCode).toBe(401);
    await drainOutbox(app);

    const [row] = await auditRows("AUTH_LOGIN_FAILED");
    expect(row).toBeTruthy();
    expect(row!.actor_user_id).toBeNull();
    expect(row!.outcome).toBe("FAILED");
    const raw = JSON.stringify(row);
    expect(raw).not.toContain("senhaErrada12345");
    expect(raw).not.toContain(owner.email);
  });

  it("criação de grupo e mudança de papel são auditadas com alvo e grupo", async () => {
    await cleaner.sql`DELETE FROM audit_events`;
    const created = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeaders(owner),
      payload: { name: "Vizinhos" },
    });
    expect(created.statusCode).toBe(201);
    const newGroupId = created.json().id as string;

    const roleRes = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}/members/${member.userId}/role`,
      headers: authHeaders(owner),
      payload: { role: "ADMIN" },
    });
    expect(roleRes.statusCode).toBe(200);
    await drainOutbox(app);

    const [groupRow] = await auditRows("GROUP_CREATED");
    expect(groupRow!.actor_user_id).toBe(owner.userId);
    expect(groupRow!.target_type).toBe("GROUP");
    expect(groupRow!.target_id).toBe(newGroupId);

    const [roleRow] = await auditRows("GROUP_MEMBER_ROLE_CHANGED");
    expect(roleRow!.target_id).toBe(member.userId);
    expect(roleRow!.group_id).toBe(groupId);
    expect(roleRow!.metadata).toEqual({ role: "ADMIN" });
  });

  it("alerta: criação e resolução auditadas sem qualquer coordenada", async () => {
    await cleaner.sql`DELETE FROM audit_events`;
    const created = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { ...authHeaders(owner), "idempotency-key": randomUUID() },
      payload: {
        groupId,
        // Coordenadas SINTÉTICAS e marcantes.
        location: { latitude: -23.111222333, longitude: -46.444555666, accuracy: 10 },
      },
    });
    expect(created.statusCode).toBe(201);
    const alertId = created.json().id as string;

    await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/resolve`,
      headers: authHeaders(owner),
    });
    await drainOutbox(app);

    const rows = await auditRows();
    const types = rows.map((row) => row.event_type);
    expect(types).toContain("ALERT_CREATED");
    expect(types).toContain("ALERT_RESOLVED");

    const raw = JSON.stringify(rows);
    for (const forbidden of ["23.111222333", "46.444555666", "latitude", "longitude"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("check-in e trajeto: ações do dono têm ator; vencimento pelo scheduler tem ator nulo", async () => {
    await cleaner.sql`DELETE FROM audit_events`;
    const checkin = await createCheckin(app, owner, groupId, 30);
    await checkinAction(app, owner, checkin.id, "safe");

    const journey = await createJourney(app, owner, groupId);
    await journeyAction(app, owner, journey.id, "arrive");
    await drainOutbox(app);

    const [safeRow] = await auditRows("CHECKIN_MARKED_SAFE");
    expect(safeRow!.actor_user_id).toBe(owner.userId);
    expect(safeRow!.target_id).toBe(checkin.id);

    const [arrivedRow] = await auditRows("JOURNEY_ARRIVED");
    expect(arrivedRow!.actor_user_id).toBe(owner.userId);

    // Vencimento é do sistema: ator nulo.
    const overdueCheckin = await createCheckin(app, owner, groupId, 30);
    await expireCheckin(cleaner.sql, overdueCheckin.id);
    await app.checkinScheduler.runOnce();
    const overdueJourney = await createJourney(app, owner, groupId);
    await expireJourney(cleaner.sql, overdueJourney.id);
    await app.journeyScheduler.runOnce();
    await drainOutbox(app);

    const [checkinOverdue] = await auditRows("CHECKIN_OVERDUE");
    expect(checkinOverdue!.actor_user_id).toBeNull();
    expect(checkinOverdue!.metadata).toEqual({ source: "scheduler" });
    expect(checkinOverdue!.request_id).toBeNull();

    const [journeyOverdue] = await auditRows("JOURNEY_OVERDUE");
    expect(journeyOverdue!.actor_user_id).toBeNull();
  });

  it("trajeto criado audita só flags, nunca o rótulo do destino", async () => {
    await cleaner.sql`DELETE FROM audit_events`;
    await createJourney(app, owner, groupId, {
      destinationLabel: "Rua Secreta 42",
      liveLocationEnabled: true,
    });
    await drainOutbox(app);

    const [row] = await auditRows("JOURNEY_CREATED");
    expect(row!.metadata).toEqual({ hasDestination: true, liveLocationEnabled: true });
    expect(JSON.stringify(row)).not.toContain("Rua Secreta");
  });

  it("nenhuma requisição GET de leitura gera trilha", async () => {
    await cleaner.sql`DELETE FROM audit_events`;
    await app.inject({ method: "GET", url: "/checkins", headers: authHeaders(owner) });
    await app.inject({ method: "GET", url: "/journeys", headers: authHeaders(owner) });
    await app.inject({ method: "GET", url: `/groups/${groupId}`, headers: authHeaders(owner) });
    await drainOutbox(app);

    expect(await auditRows()).toHaveLength(0);
  });

  it("métricas de auditoria acompanham os eventos gravados", async () => {
    const before = await metricValue("safecircle_audit_events_total", {
      event_type: "GROUP_CREATED",
      outcome: "SUCCEEDED",
    });
    await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeaders(owner),
      payload: { name: "Outro" },
    });
    await drainOutbox(app);

    expect(
      await metricValue("safecircle_audit_events_total", {
        event_type: "GROUP_CREATED",
        outcome: "SUCCEEDED",
      }),
    ).toBe(before + 1);
  });

  it("falha ao gravar auditoria não desfaz a operação de negócio", async () => {
    const failuresBefore = await metricValue("safecircle_audit_failures_total", {
      event_type: "GROUP_CREATED",
    });

    // Torna o INSERT impossível temporariamente. NOT VALID não revalida as
    // linhas existentes, mas rejeita qualquer inserção nova.
    await cleaner.sql`
      ALTER TABLE audit_events
      ADD CONSTRAINT forced_failure CHECK (event_type = '__impossivel__') NOT VALID
    `;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/groups",
        headers: authHeaders(owner),
        payload: { name: "Resiliente" },
      });
      await drainOutbox(app);

      // A operação de negócio concluiu normalmente.
      expect(res.statusCode).toBe(201);
      const groups = await cleaner.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM trusted_groups WHERE name = 'Resiliente'
      `;
      expect(groups[0]?.count).toBe(1);
      expect(
        await metricValue("safecircle_audit_failures_total", { event_type: "GROUP_CREATED" }),
      ).toBe(failuresBefore + 1);
    } finally {
      await cleaner.sql`ALTER TABLE audit_events DROP CONSTRAINT forced_failure`;
    }
  });
});

describe("Metadata allow-listed", () => {
  it("descarta chaves fora da lista e valores perigosos", () => {
    // Chaves proibidas chegando de um chamador mal tipado (ou de JS puro):
    // o filtro é de runtime, não só de tipo.
    const hostile = {
      role: "ADMIN",
      recipientCount: 3,
      liveLocationEnabled: false,
      password: "senha123",
      latitude: -23.5,
      token: "ExponentPushToken[abc]",
      authorization: "Bearer abc",
    } as unknown as Parameters<typeof sanitizeMetadata>[0];

    expect(sanitizeMetadata(hostile)).toEqual({
      role: "ADMIN",
      recipientCount: 3,
      liveLocationEnabled: false,
    });
  });

  it("descarta strings com UUID ou caracteres fora do alfabeto seguro", () => {
    expect(sanitizeMetadata({ source: randomUUID() })).toBeNull();
    expect(sanitizeMetadata({ reason: "quebra\nde linha" })).toBeNull();
    expect(sanitizeMetadata({})).toBeNull();
    expect(sanitizeMetadata(undefined)).toBeNull();
  });
});

describe("Retenção da auditoria", () => {
  it("apaga só eventos mais antigos que 180 dias e nunca toca no domínio", async () => {
    const user = await registerUser(app);
    const groupId = await createGroup(app, user, "Família");
    await drainOutbox(app);

    await cleaner.sql`
      INSERT INTO audit_events (event_type, outcome, created_at)
      VALUES ('GROUP_CREATED', 'SUCCEEDED', now() - interval '181 days')
    `;
    const before = await auditRows();
    expect(before.length).toBeGreaterThanOrEqual(2);

    expect(await deleteExpiredAuditEvents(app.db, new Date(), AUDIT_RETENTION_DAYS)).toBe(1);
    const after = await auditRows();
    expect(after).toHaveLength(before.length - 1);
    expect(after.every((row) => row.created_at.getTime() > Date.now() - 180 * 86_400_000)).toBe(
      true,
    );

    // O grupo (domínio) continua intacto.
    const groups = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM trusted_groups WHERE id = ${groupId}
    `;
    expect(groups[0]?.count).toBe(1);
    expect(await deleteExpiredAuditEvents(app.db)).toBe(0);
  });
});
