import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, BODY_LIMIT_BYTES } from "../../src/app.js";
import { createTestApp } from "../helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "../helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "../helpers/auth.js";
import { FakePushProvider } from "../../src/infrastructure/push/fake-push-provider.js";

/**
 * Hardening HTTP (Phase 11): cabeçalhos, CORS por allow-list, limite de corpo,
 * content-type e validação negativa determinística.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let user: TestUser;

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
});

async function strictApp(options: { origins?: string[]; hsts?: boolean } = {}) {
  const instance = await buildApp({
    logger: false,
    databaseUrl: getTestDatabaseUrl(),
    pushProvider: new FakePushProvider(),
    checkinSchedulerAutoStart: false,
    journeySchedulerAutoStart: false,
    outboxWorkerAutoStart: false,
    corsAllowedOrigins: options.origins ?? ["https://app.safecircle.example"],
    strictOrigins: true,
    hstsEnabled: options.hsts ?? false,
  });
  await instance.ready();
  return instance;
}

describe("Cabeçalhos de segurança", () => {
  it("toda resposta carrega os cabeçalhos de uma API JSON", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("erros também carregam os cabeçalhos", async () => {
    const res = await app.inject({ method: "GET", url: "/rota-que-nao-existe" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("HSTS só aparece quando explicitamente habilitado", async () => {
    const withoutHsts = await app.inject({ method: "GET", url: "/health" });
    expect(withoutHsts.headers["strict-transport-security"]).toBeUndefined();

    const hstsApp = await strictApp({ hsts: true });
    try {
      const res = await hstsApp.inject({ method: "GET", url: "/health" });
      expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
      expect(res.headers["strict-transport-security"]).not.toContain("preload");
    } finally {
      await hstsApp.close();
    }
  });
});

describe("CORS por allow-list", () => {
  it("modo estrito: origem permitida recebe o cabeçalho; origem proibida não", async () => {
    const strict = await strictApp();
    try {
      const allowed = await strict.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "https://app.safecircle.example" },
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.safecircle.example");

      const forbidden = await strict.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "https://evil.example" },
      });
      expect(forbidden.headers["access-control-allow-origin"]).toBeUndefined();

      // Nunca wildcard, nunca credenciais.
      expect(allowed.headers["access-control-allow-origin"]).not.toBe("*");
      expect(allowed.headers["access-control-allow-credentials"]).toBeUndefined();
    } finally {
      await strict.close();
    }
  });

  it("sem header Origin (cliente nativo) a requisição segue normalmente", async () => {
    const strict = await strictApp();
    try {
      const res = await strict.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await strict.close();
    }
  });

  it("modo estrito sem lista: nenhuma origem web é aceita", async () => {
    const strict = await strictApp({ origins: [] });
    try {
      const res = await strict.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "https://app.safecircle.example" },
      });
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await strict.close();
    }
  });

  it("modo relaxado (test) reflete a origem, para o app web local", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://localhost:8081" },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:8081");
  });
});

describe("Limite de corpo e content-type", () => {
  it("corpo acima do limite responde 413 PAYLOAD_TOO_LARGE sem crash", async () => {
    const huge = JSON.stringify({ name: "x".repeat(BODY_LIMIT_BYTES + 1024) });
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: { ...authHeaders(user), "content-type": "application/json" },
      payload: huge,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("PAYLOAD_TOO_LARGE");
    expect(typeof res.json().requestId).toBe("string");

    // A API continua saudável depois.
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("content-type inesperado responde 415 UNSUPPORTED_MEDIA_TYPE", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: { ...authHeaders(user), "content-type": "text/plain" },
      payload: "name=Família",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("JSON malformado responde 400 sem ecoar o corpo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: { ...authHeaders(user), "content-type": "application/json" },
      payload: '{"name": "Família"',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(res.json())).not.toContain("Família");
  });
});

describe("Validação negativa determinística", () => {
  it("UUID inválido em rotas de recurso responde 404 do domínio, nunca 500", async () => {
    for (const url of [
      "/alerts/nao-e-uuid",
      "/checkins/nao-e-uuid",
      "/journeys/nao-e-uuid",
      "/groups/nao-e-uuid",
    ]) {
      const res = await app.inject({ method: "GET", url, headers: authHeaders(user) });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code, url).toMatch(/_NOT_FOUND$/);
    }
  });

  it("enum desconhecido, string enorme e timestamp extremo são recusados com 400", async () => {
    const groupRes = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeaders(user),
      payload: { name: "Família" },
    });
    const groupId = groupRes.json().id as string;

    const badRole = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}/members/${user.userId}/role`,
      headers: authHeaders(user),
      payload: { role: "SUPERUSER" },
    });
    expect(badRole.statusCode).toBe(400);

    const hugeName = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}`,
      headers: authHeaders(user),
      payload: { name: "n".repeat(5_000) },
    });
    expect(hugeName.statusCode).toBe(400);

    const extremeDate = await app.inject({
      method: "POST",
      url: "/checkins",
      headers: { ...authHeaders(user), "idempotency-key": crypto.randomUUID() },
      payload: { groupId, dueAt: "9999-12-31T23:59:59.000Z" },
    });
    expect(extremeDate.statusCode).toBe(400);

    const notADate = await app.inject({
      method: "POST",
      url: "/checkins",
      headers: { ...authHeaders(user), "idempotency-key": crypto.randomUUID() },
      payload: { groupId, dueAt: "amanhã" },
    });
    expect(notADate.statusCode).toBe(400);
  });

  it("array enorme no lugar de objeto é recusado sem erro interno", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeaders(user),
      payload: Array.from({ length: 10_000 }, () => "x"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });
});
