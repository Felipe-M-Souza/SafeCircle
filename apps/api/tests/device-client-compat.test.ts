import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { createGroup } from "./helpers/groups.js";
import { createAlert } from "./helpers/alerts.js";
import { errorBodyWithoutRequestId } from "./helpers/errors.js";

/**
 * Compatibilidade com o cliente HTTP do app (achado em aparelho, 2026-09-16):
 * o `fetch` nativo envia `Content-Type: application/json` em TODO POST, mesmo
 * sem corpo. O parser padrão do Fastify respondia 400 (corpo JSON vazio) e o
 * app mostrava "Dados inválidos" ao resolver/cancelar alerta e ao iniciar a
 * localização ao vivo. Corpo vazio com esse header vale como "sem corpo";
 * JSON malformado ou envenenado continua sendo recusado.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let user: TestUser;
let groupId: string;

const JSON_HEADER = { "content-type": "application/json" };

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
  user = await registerUser(app);
  groupId = await createGroup(app, user);
});

describe("POST sem corpo com Content-Type: application/json (cliente do app)", () => {
  it("iniciar localização ao vivo e resolver alerta funcionam com corpo vazio", async () => {
    const alert = await createAlert(app, user, groupId);

    const start = await app.inject({
      method: "POST",
      url: `/alerts/${alert.id}/live-location/start`,
      headers: { ...authHeaders(user), ...JSON_HEADER },
      payload: "",
    });
    expect(start.statusCode).toBe(201);

    const resolve = await app.inject({
      method: "POST",
      url: `/alerts/${alert.id}/resolve`,
      headers: { ...authHeaders(user), ...JSON_HEADER },
      payload: "",
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().status).toBe("RESOLVED");
  });

  it("cancelar alerta funciona com corpo vazio", async () => {
    const alert = await createAlert(app, user, groupId);
    const cancel = await app.inject({
      method: "POST",
      url: `/alerts/${alert.id}/cancel`,
      headers: { ...authHeaders(user), ...JSON_HEADER },
      payload: "",
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("CANCELLED");
  });

  it("corpo vazio em rota que exige payload continua 400 de validação, não 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { ...authHeaders(user), ...JSON_HEADER },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("JSON malformado continua 400 sem ecoar o corpo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { ...authHeaders(user), ...JSON_HEADER },
      payload: '{"groupId": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(errorBodyWithoutRequestId(res))).not.toContain("groupId");
  });

  it("JSON com __proto__ continua recusado (parser seguro preservado)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: { ...authHeaders(user), ...JSON_HEADER },
      payload: '{"name":"Família","__proto__":{"polluted":true}}',
    });
    expect(res.statusCode).toBe(400);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("limite de tamanho do corpo continua valendo para JSON", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: { ...authHeaders(user), ...JSON_HEADER },
      payload: JSON.stringify({ name: "x".repeat(300 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
  });
});
