import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { errorBodyWithoutRequestId } from "./helpers/errors.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { SYNTHETIC_LOCATION, createAlert } from "./helpers/alerts.js";

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

/**
 * Autorização e isolamento entre grupos para alertas (README §20):
 * Usuário B (Grupo B) NÃO pode ler, ler localização, encerrar ou cancelar
 * alerta do Grupo A — e não deve descobrir que o alerta existe.
 */
describe("GET /alerts/:alertId — autorização e anti-IDOR", () => {
  let creator: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let groupA: string;
  let alertId: string;

  beforeEach(async () => {
    creator = await registerUser(app, { name: "Felipe" });
    member = await registerUser(app);
    outsider = await registerUser(app);
    groupA = await createGroup(app, creator, "Grupo A");
    await addMember(app, creator, groupA, member);
    // O externo tem o próprio grupo: isolamento entre grupos.
    await createGroup(app, outsider, "Grupo B");
    alertId = (await createAlert(app, creator, groupA, SYNTHETIC_LOCATION)).id;
  });

  it("membro do grupo lê o alerta com localização", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/alerts/${alertId}`,
      headers: authHeaders(member),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: alertId,
      groupId: groupA,
      groupName: "Grupo A",
      status: "ACTIVE",
      createdBy: { id: creator.userId, name: "Felipe" },
      location: {
        latitude: SYNTHETIC_LOCATION.latitude,
        longitude: SYNTHETIC_LOCATION.longitude,
        accuracy: SYNTHETIC_LOCATION.accuracy,
      },
    });
  });

  it("usuário externo não lê o alerta nem recebe localização (404 ALERT_NOT_FOUND)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/alerts/${alertId}`,
      headers: authHeaders(outsider),
    });
    expect(res.statusCode).toBe(404);
    expect(errorBodyWithoutRequestId(res)).toEqual({
      code: "ALERT_NOT_FOUND",
      message: "Alerta não encontrado.",
    });
    for (const field of ["latitude", "longitude", "accuracy", "location", "groupName"]) {
      expect(res.payload).not.toContain(field);
    }
  });

  it("resposta de IDOR é indistinguível de alerta inexistente", async () => {
    const existing = await app.inject({
      method: "GET",
      url: `/alerts/${alertId}`,
      headers: authHeaders(outsider),
    });
    const missing = await app.inject({
      method: "GET",
      url: "/alerts/00000000-0000-4000-8000-000000000000",
      headers: authHeaders(outsider),
    });
    expect(existing.statusCode).toBe(missing.statusCode);
    expect(errorBodyWithoutRequestId(existing)).toEqual(errorBodyWithoutRequestId(missing));
  });

  it("id inválido resulta em 404 ALERT_NOT_FOUND (não em erro de SQL)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/alerts/nao-e-uuid",
      headers: authHeaders(member),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("ALERT_NOT_FOUND");
  });

  it("exige autenticação (401)", async () => {
    const res = await app.inject({ method: "GET", url: `/alerts/${alertId}` });
    expect(res.statusCode).toBe(401);
  });

  it("externo não resolve nem cancela alerta de outro grupo e o estado permanece ACTIVE", async () => {
    for (const action of ["resolve", "cancel"]) {
      const res = await app.inject({
        method: "POST",
        url: `/alerts/${alertId}/${action}`,
        headers: authHeaders(outsider),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("ALERT_NOT_FOUND");
    }
    const check = await app.inject({
      method: "GET",
      url: `/alerts/${alertId}`,
      headers: authHeaders(creator),
    });
    expect(check.json().status).toBe("ACTIVE");
  });

  it("listagem do externo não inclui alertas do Grupo A", async () => {
    const res = await app.inject({ method: "GET", url: "/alerts", headers: authHeaders(outsider) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("quem sai do grupo deixa de ver o alerta", async () => {
    const leave = await app.inject({
      method: "DELETE",
      url: `/groups/${groupA}/members/me`,
      headers: authHeaders(member),
    });
    expect(leave.statusCode).toBe(204);

    const res = await app.inject({
      method: "GET",
      url: `/alerts/${alertId}`,
      headers: authHeaders(member),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("ALERT_NOT_FOUND");
  });
});

describe("Não vazamento de dados sensíveis em alertas", () => {
  it("respostas de alertas não contêm e-mail nem campos de autenticação", async () => {
    const creator = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, creator);
    await addMember(app, creator, groupId, member);
    const alert = await createAlert(app, creator, groupId, SYNTHETIC_LOCATION);

    for (const url of ["/alerts", `/alerts/${alert.id}`]) {
      const res = await app.inject({ method: "GET", url, headers: authHeaders(member) });
      expect(res.statusCode).toBe(200);
      for (const forbidden of [
        "email",
        "password",
        "passwordHash",
        "refreshToken",
        "refreshTokenHash",
        "authSessions",
        "requestHash",
        "idempotency",
      ]) {
        expect(res.payload).not.toContain(forbidden);
      }
      expect(res.payload).not.toContain(creator.email);
      expect(res.payload).not.toContain(member.email);
    }
  });
});
