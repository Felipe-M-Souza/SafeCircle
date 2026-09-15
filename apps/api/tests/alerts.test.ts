import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { errorBodyWithoutRequestId } from "./helpers/errors.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { SYNTHETIC_LOCATION, createAlert, newIdempotencyKey, postAlert } from "./helpers/alerts.js";

const cleaner = createCleaner();
let app: FastifyInstance;

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

async function countAlerts(): Promise<number> {
  const [row] = await cleaner.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM emergency_alerts
  `;
  return row?.count ?? 0;
}

describe("POST /alerts — criação", () => {
  let owner: TestUser;
  let member: TestUser;
  let groupId: string;

  beforeEach(async () => {
    owner = await registerUser(app, { name: "Felipe" });
    member = await registerUser(app);
    groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, member);
  });

  it("membro cria alerta ACTIVE sem localização (201)", async () => {
    const res = await postAlert(app, member, { groupId });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      groupId,
      groupName: "Família",
      status: "ACTIVE",
      createdBy: { id: member.userId, name: member.name },
      resolvedAt: null,
      cancelledAt: null,
      location: null,
    });
    expect(typeof body.id).toBe("string");
    expect(new Date(body.activatedAt).getTime()).not.toBeNaN();
    expect(res.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("persiste a localização inicial quando fornecida", async () => {
    const res = await postAlert(app, owner, { groupId, location: SYNTHETIC_LOCATION });
    expect(res.statusCode).toBe(201);
    expect(res.json().location).toEqual({
      latitude: SYNTHETIC_LOCATION.latitude,
      longitude: SYNTHETIC_LOCATION.longitude,
      accuracy: SYNTHETIC_LOCATION.accuracy,
      capturedAt: SYNTHETIC_LOCATION.capturedAt,
    });

    const [row] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM alert_locations
    `;
    expect(row?.count).toBe(1);
  });

  it("aceita localização sem accuracy/capturedAt e localização nula", async () => {
    const minimal = await postAlert(app, owner, {
      groupId,
      location: { latitude: 10.5, longitude: 20.25 },
    });
    expect(minimal.statusCode).toBe(201);
    expect(minimal.json().location).toMatchObject({ latitude: 10.5, longitude: 20.25 });
    expect(minimal.json().location.accuracy).toBeNull();
    expect(typeof minimal.json().location.capturedAt).toBe("string");

    const withNull = await postAlert(app, member, { groupId, location: null });
    expect(withNull.statusCode).toBe(201);
    expect(withNull.json().location).toBeNull();
  });

  it("exige autenticação (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { "idempotency-key": newIdempotencyKey() },
      payload: { groupId },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("não membro não cria alerta (404 GROUP_NOT_FOUND, anti-IDOR)", async () => {
    const outsider = await registerUser(app);
    const res = await postAlert(app, outsider, { groupId });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("GROUP_NOT_FOUND");
    expect(await countAlerts()).toBe(0);
  });

  it("grupo inexistente (404 GROUP_NOT_FOUND)", async () => {
    const res = await postAlert(app, owner, { groupId: "00000000-0000-4000-8000-000000000000" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("GROUP_NOT_FOUND");
  });

  it("groupId inválido e localização inválida (400 VALIDATION_ERROR)", async () => {
    const badGroup = await postAlert(app, owner, { groupId: "nao-e-uuid" });
    expect(badGroup.statusCode).toBe(400);
    expect(badGroup.json().code).toBe("VALIDATION_ERROR");

    const badLat = await postAlert(app, owner, {
      groupId,
      location: { latitude: 91, longitude: 0 },
    });
    expect(badLat.statusCode).toBe(400);
    expect(badLat.json().code).toBe("VALIDATION_ERROR");
    // Mensagem de erro não ecoa coordenadas. O `requestId` fica de fora da
    // comparação: é um UUID aleatório e pode conter "91" por acaso.
    expect(JSON.stringify(errorBodyWithoutRequestId(badLat))).not.toContain("91");

    const badDate = await postAlert(app, owner, {
      groupId,
      location: { latitude: 0, longitude: 0, capturedAt: "ontem" },
    });
    expect(badDate.statusCode).toBe(400);

    expect(await countAlerts()).toBe(0);
  });

  it("resposta não vaza dados sensíveis", async () => {
    const res = await postAlert(app, owner, { groupId, location: SYNTHETIC_LOCATION });
    expect(res.statusCode).toBe(201);
    const raw = res.payload;
    for (const forbidden of [
      "email",
      "password",
      "passwordHash",
      "refreshToken",
      "refreshTokenHash",
      "requestHash",
      "sessionId",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    expect(raw).not.toContain(owner.email);
  });
});

describe("POST /alerts — idempotência", () => {
  let owner: TestUser;
  let member: TestUser;
  let groupId: string;

  beforeEach(async () => {
    owner = await registerUser(app);
    member = await registerUser(app);
    groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);
  });

  it("retry com a mesma chave devolve o mesmo alerta e não cria segundo registro", async () => {
    const key = newIdempotencyKey();
    const first = await postAlert(app, owner, { groupId, location: SYNTHETIC_LOCATION }, key);
    const retry = await postAlert(app, owner, { groupId, location: SYNTHETIC_LOCATION }, key);

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.json().id);
    expect(retry.json()).toEqual(first.json());
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(await countAlerts()).toBe(1);
  });

  it("mesma chave com payload diferente é rejeitada (409 IDEMPOTENCY_KEY_REUSED)", async () => {
    const otherGroup = await createGroup(app, owner, "Amigos");
    const key = newIdempotencyKey();
    expect((await postAlert(app, owner, { groupId }, key)).statusCode).toBe(201);

    const reused = await postAlert(app, owner, { groupId: otherGroup }, key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await countAlerts()).toBe(1);
  });

  it("a mesma chave usada por outro usuário não interfere", async () => {
    const key = "chave-compartilhada-0001";
    const a = await postAlert(app, owner, { groupId }, key);
    const b = await postAlert(app, member, { groupId }, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
    expect(b.headers["idempotent-replayed"]).toBeUndefined();
    expect(await countAlerts()).toBe(2);
  });

  it("chave ausente ou inválida é rejeitada (400 INVALID_IDEMPOTENCY_KEY)", async () => {
    const missing = await postAlert(app, owner, { groupId }, null);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe("INVALID_IDEMPOTENCY_KEY");

    for (const invalid of ["curta", "com espaço na chave", "chave!invalida#", "x".repeat(129)]) {
      const res = await postAlert(app, owner, { groupId }, invalid);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("INVALID_IDEMPOTENCY_KEY");
    }
    expect(await countAlerts()).toBe(0);
  });

  it("chave inválida não consome chave nem cria alerta quando o payload é inválido", async () => {
    const key = newIdempotencyKey();
    const bad = await postAlert(app, owner, { groupId: "invalido" }, key);
    expect(bad.statusCode).toBe(400);
    const ok = await postAlert(app, owner, { groupId }, key);
    expect(ok.statusCode).toBe(201);
    expect(ok.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("idempotência é persistida no banco e sobrevive a uma nova instância da API", async () => {
    const key = newIdempotencyKey();
    const first = await postAlert(app, owner, { groupId }, key);
    expect(first.statusCode).toBe(201);

    const rows = await cleaner.sql<{ key: string; scope: string; resource_id: string }[]>`
      SELECT key, scope, resource_id FROM idempotency_keys WHERE user_id = ${owner.userId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key, scope: "alerts.create", resource_id: first.json().id });

    // "Reinício": outra instância da API, sem estado em memória compartilhado.
    const restarted = await createTestApp();
    try {
      const retry = await restarted.inject({
        method: "POST",
        url: "/alerts",
        headers: { ...authHeaders(owner), "idempotency-key": key },
        payload: { groupId },
      });
      expect(retry.statusCode).toBe(201);
      expect(retry.json().id).toBe(first.json().id);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
    } finally {
      await restarted.close();
    }
    expect(await countAlerts()).toBe(1);
  });

  it("requisições concorrentes com a mesma chave criam um único alerta", async () => {
    const key = newIdempotencyKey();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postAlert(app, owner, { groupId }, key)),
    );
    for (const res of responses) {
      expect(res.statusCode).toBe(201);
    }
    const ids = new Set(responses.map((res) => res.json().id));
    expect(ids.size).toBe(1);
    expect(await countAlerts()).toBe(1);
  });

  it("requisições concorrentes com chaves diferentes criam um único alerta ACTIVE", async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postAlert(app, owner, { groupId })),
    );
    const created = responses.filter((res) => res.statusCode === 201);
    const rejected = responses.filter((res) => res.statusCode === 409);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const res of rejected) {
      expect(res.json().code).toBe("ALERT_ALREADY_ACTIVE");
    }
    expect(await countAlerts()).toBe(1);
  });
});

describe("Alerta ativo único por usuário/grupo", () => {
  let owner: TestUser;
  let groupId: string;

  beforeEach(async () => {
    owner = await registerUser(app);
    groupId = await createGroup(app, owner);
  });

  it("segundo ACTIVE para o mesmo usuário/grupo é rejeitado (409 ALERT_ALREADY_ACTIVE)", async () => {
    expect((await postAlert(app, owner, { groupId })).statusCode).toBe(201);
    const second = await postAlert(app, owner, { groupId });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("ALERT_ALREADY_ACTIVE");
    expect(await countAlerts()).toBe(1);
  });

  it("após resolver, um novo alerta pode ser criado no mesmo grupo", async () => {
    const first = await createAlert(app, owner, groupId);
    const resolve = await app.inject({
      method: "POST",
      url: `/alerts/${first.id}/resolve`,
      headers: authHeaders(owner),
    });
    expect(resolve.statusCode).toBe(200);
    const second = await postAlert(app, owner, { groupId });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(first.id);
  });

  it("o mesmo usuário pode ter alertas ativos em grupos diferentes", async () => {
    const otherGroup = await createGroup(app, owner, "Amigos");
    expect((await postAlert(app, owner, { groupId })).statusCode).toBe(201);
    expect((await postAlert(app, owner, { groupId: otherGroup })).statusCode).toBe(201);
  });

  it("a proteção existe no banco (índice único parcial)", async () => {
    await createAlert(app, owner, groupId);
    await expect(
      cleaner.sql`
        INSERT INTO emergency_alerts (group_id, created_by_user_id, status)
        VALUES (${groupId}, ${owner.userId}, 'ACTIVE')
      `,
    ).rejects.toMatchObject({ code: "23505" });

    // Alertas encerrados não colidem com o índice parcial.
    await cleaner.sql`
      INSERT INTO emergency_alerts (group_id, created_by_user_id, status, resolved_at)
      VALUES (${groupId}, ${owner.userId}, 'RESOLVED', now())
    `;
    expect(await countAlerts()).toBe(2);
  });
});

describe("POST /alerts/:alertId/resolve", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let groupId: string;
  let alertId: string;

  beforeEach(async () => {
    owner = await registerUser(app);
    member = await registerUser(app);
    outsider = await registerUser(app);
    groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);
    alertId = (await createAlert(app, member, groupId)).id;
  });

  it("criador resolve alerta ACTIVE (200) com resolvedAt e sem cancelledAt", async () => {
    const before = Date.now();
    const res = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/resolve`,
      headers: authHeaders(member),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("RESOLVED");
    expect(body.cancelledAt).toBeNull();
    expect(new Date(body.resolvedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(new Date(body.resolvedAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("outro membro (inclusive OWNER) não resolve (403 FORBIDDEN)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/resolve`,
      headers: authHeaders(owner),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");

    const check = await app.inject({
      method: "GET",
      url: `/alerts/${alertId}`,
      headers: authHeaders(owner),
    });
    expect(check.json().status).toBe("ACTIVE");
  });

  it("usuário externo não resolve e não descobre o alerta (404 ALERT_NOT_FOUND)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/resolve`,
      headers: authHeaders(outsider),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("ALERT_NOT_FOUND");
  });

  it("transição inválida falha sem alterar timestamps (409 INVALID_ALERT_TRANSITION)", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/resolve`,
      headers: authHeaders(member),
    });
    expect(first.statusCode).toBe(200);

    const again = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/resolve`,
      headers: authHeaders(member),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("INVALID_ALERT_TRANSITION");

    const cancel = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/cancel`,
      headers: authHeaders(member),
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().code).toBe("INVALID_ALERT_TRANSITION");

    const check = await app.inject({
      method: "GET",
      url: `/alerts/${alertId}`,
      headers: authHeaders(member),
    });
    expect(check.json()).toMatchObject({
      status: "RESOLVED",
      resolvedAt: first.json().resolvedAt,
      cancelledAt: null,
    });
  });

  it("id inválido ou inexistente (404 ALERT_NOT_FOUND)", async () => {
    for (const id of ["nao-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const res = await app.inject({
        method: "POST",
        url: `/alerts/${id}/resolve`,
        headers: authHeaders(member),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("ALERT_NOT_FOUND");
    }
  });
});

describe("POST /alerts/:alertId/cancel", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let groupId: string;
  let alertId: string;

  beforeEach(async () => {
    owner = await registerUser(app);
    member = await registerUser(app);
    outsider = await registerUser(app);
    groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);
    alertId = (await createAlert(app, member, groupId)).id;
  });

  it("criador cancela alerta ACTIVE (200) com cancelledAt e sem resolvedAt", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/cancel`,
      headers: authHeaders(member),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("CANCELLED");
    expect(res.json().resolvedAt).toBeNull();
    expect(new Date(res.json().cancelledAt).getTime()).not.toBeNaN();
  });

  it("outro membro não cancela (403 FORBIDDEN)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/cancel`,
      headers: authHeaders(owner),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });

  it("usuário externo não cancela (404 ALERT_NOT_FOUND)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/cancel`,
      headers: authHeaders(outsider),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("ALERT_NOT_FOUND");
  });

  it("alerta já encerrado não muda de estado", async () => {
    const cancel = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/cancel`,
      headers: authHeaders(member),
    });
    expect(cancel.statusCode).toBe(200);

    const resolve = await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/resolve`,
      headers: authHeaders(member),
    });
    expect(resolve.statusCode).toBe(409);
    expect(resolve.json().code).toBe("INVALID_ALERT_TRANSITION");

    const check = await app.inject({
      method: "GET",
      url: `/alerts/${alertId}`,
      headers: authHeaders(member),
    });
    expect(check.json()).toMatchObject({
      status: "CANCELLED",
      resolvedAt: null,
      cancelledAt: cancel.json().cancelledAt,
    });
  });
});

describe("GET /alerts", () => {
  it("usuário enxerga somente alertas de grupos onde é membro", async () => {
    const userA = await registerUser(app, { name: "Ana" });
    const userB = await registerUser(app, { name: "Bruno" });
    const userC = await registerUser(app, { name: "Carla" });
    const groupA = await createGroup(app, userA, "Grupo A");
    const groupB = await createGroup(app, userB, "Grupo B");
    await addMember(app, userA, groupA, userC);
    await addMember(app, userB, groupB, userC);

    const alertA = await createAlert(app, userA, groupA, SYNTHETIC_LOCATION);
    const alertB = await createAlert(app, userB, groupB);

    const listA = await app.inject({ method: "GET", url: "/alerts", headers: authHeaders(userA) });
    expect(listA.statusCode).toBe(200);
    expect(listA.json().map((a: { id: string }) => a.id)).toEqual([alertA.id]);
    expect(listA.json()[0]).toMatchObject({
      groupName: "Grupo A",
      createdBy: { id: userA.userId, name: "Ana" },
      location: { latitude: SYNTHETIC_LOCATION.latitude },
    });

    const listB = await app.inject({ method: "GET", url: "/alerts", headers: authHeaders(userB) });
    expect(listB.json().map((a: { id: string }) => a.id)).toEqual([alertB.id]);

    const listC = await app.inject({ method: "GET", url: "/alerts", headers: authHeaders(userC) });
    expect(
      listC
        .json()
        .map((a: { id: string }) => a.id)
        .sort(),
    ).toEqual([alertA.id, alertB.id].sort());
  });

  it("retorna apenas ACTIVE por padrão e aceita filtro por status", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const resolved = await createAlert(app, owner, groupId);
    await app.inject({
      method: "POST",
      url: `/alerts/${resolved.id}/resolve`,
      headers: authHeaders(owner),
    });
    const active = await createAlert(app, owner, groupId);

    const defaults = await app.inject({
      method: "GET",
      url: "/alerts",
      headers: authHeaders(owner),
    });
    expect(defaults.json().map((a: { id: string }) => a.id)).toEqual([active.id]);

    const resolvedList = await app.inject({
      method: "GET",
      url: "/alerts?status=RESOLVED",
      headers: authHeaders(owner),
    });
    expect(resolvedList.json().map((a: { id: string }) => a.id)).toEqual([resolved.id]);

    const invalid = await app.inject({
      method: "GET",
      url: "/alerts?status=ATIVO",
      headers: authHeaders(owner),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("VALIDATION_ERROR");
  });

  it("exige autenticação (401)", async () => {
    const res = await app.inject({ method: "GET", url: "/alerts" });
    expect(res.statusCode).toBe(401);
  });
});
