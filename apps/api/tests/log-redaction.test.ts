import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { drainOutbox } from "./helpers/outbox.js";
import { createCleaner, getTestDatabaseUrl } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { createGroup } from "./helpers/groups.js";
import { FakePushProvider } from "../src/infrastructure/push/fake-push-provider.js";
import { fakeExpoToken } from "./helpers/push.js";

/**
 * Redaction (Phase 9): o logger real é ligado e a saída capturada em memória.
 * Nada de credencial, token ou coordenada pode aparecer — nem via body, nem via
 * header, nem por um log acidental de rota.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let captured: string[] = [];

const PASSWORD = "senhaSuperSecreta123";

beforeAll(async () => {
  app = await buildApp({
    logger: true,
    databaseUrl: getTestDatabaseUrl(),
    pushProvider: new FakePushProvider(),
    checkinSchedulerAutoStart: false,
    journeySchedulerAutoStart: false,
  });
  // Captura tudo que o Pino escreveria.
  const stream = app.log as unknown as { [key: symbol]: unknown };
  const pinoSymbols = Object.getOwnPropertySymbols(stream);
  const streamSymbol = pinoSymbols.find((symbol) => symbol.toString().includes("stream"));
  if (streamSymbol) {
    (stream as Record<symbol, unknown>)[streamSymbol] = {
      write: (line: string) => {
        captured.push(line);
      },
    };
  }
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
  captured = [];
});

function loggedText(): string {
  return captured.join("\n");
}

describe("Redaction de logs", () => {
  it("senha nunca aparece no log, mesmo em registro e login", async () => {
    const email = `redaction-${randomUUID()}@example.com`;
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { name: "Teste", email, password: PASSWORD },
    });
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: PASSWORD },
    });
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "senhaErrada12345" },
    });
    await drainOutbox(app);

    expect(loggedText()).not.toContain(PASSWORD);
    expect(loggedText()).not.toContain("senhaErrada12345");
    expect(loggedText()).not.toContain("passwordHash");
  });

  it("Authorization, access token e refresh token não aparecem no log", async () => {
    const user = await registerUser(app, { password: PASSWORD });
    await app.inject({ method: "GET", url: "/me", headers: authHeaders(user) });
    await app.inject({
      method: "GET",
      url: "/checkins",
      headers: { authorization: "Bearer token-invalido-de-teste" },
    });
    await drainOutbox(app);

    const text = loggedText();
    expect(text).not.toContain(user.accessToken);
    expect(text).not.toContain("token-invalido-de-teste");
    expect(text).not.toContain("Bearer ");
  });

  it("push token não aparece no log ao registrar dispositivo", async () => {
    const user = await registerUser(app);
    const token = fakeExpoToken("redaction");
    const res = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      headers: authHeaders(user),
      payload: { token, platform: "ANDROID", deviceId: randomUUID() },
    });
    expect(res.statusCode).toBe(201);
    await drainOutbox(app);

    expect(loggedText()).not.toContain(token);
  });

  it("coordenadas não aparecem no log ao criar alerta com localização", async () => {
    const user: TestUser = await registerUser(app);
    const groupId = await createGroup(app, user, "Família");
    // Coordenadas SINTÉTICAS, com muitas casas para serem inconfundíveis no log.
    const latitude = -23.987654321;
    const longitude = -46.123456789;
    const res = await app.inject({
      method: "POST",
      url: "/alerts",
      headers: { ...authHeaders(user), "idempotency-key": randomUUID() },
      payload: {
        groupId,
        location: { latitude, longitude, accuracy: 12.5, capturedAt: new Date().toISOString() },
      },
    });
    expect(res.statusCode).toBe(201);
    await drainOutbox(app);

    const text = loggedText();
    expect(text).not.toContain("23.987654321");
    expect(text).not.toContain("46.123456789");
    expect(text).not.toContain(String(latitude));
    expect(text).not.toContain(String(longitude));
  });

  it("o log de conclusão traz correlação sem dados sensíveis", async () => {
    const user = await registerUser(app);
    await app.inject({ method: "GET", url: "/checkins", headers: authHeaders(user) });
    await drainOutbox(app);

    const completed = captured
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> => entry?.event === "http_request_completed",
      )
      .pop();

    expect(completed).toBeTruthy();
    expect(completed?.requestId).toBeTruthy();
    expect(completed?.route).toBe("/checkins");
    expect(completed?.method).toBe("GET");
    expect(completed?.statusCode).toBe(200);
    expect(completed?.userId).toBe(user.userId);
    expect(JSON.stringify(completed)).not.toContain(user.accessToken);
  });
});
