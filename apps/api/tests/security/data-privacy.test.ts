import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createCleaner, getTestDatabaseUrl } from "../helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "../helpers/auth.js";
import { addMember, createGroup } from "../helpers/groups.js";
import { createAlert } from "../helpers/alerts.js";
import { createCheckin, checkinAction } from "../helpers/checkins.js";
import { createJourney, journeyAction } from "../helpers/journeys.js";
import { fakeExpoToken, registerActiveDevice } from "../helpers/push.js";
import { drainOutbox } from "../helpers/outbox.js";
import { FakePushProvider } from "../../src/infrastructure/push/fake-push-provider.js";

/**
 * Privacidade do que fica gravado e do que é logado (Phase 11).
 *
 * Um fluxo completo do produto é executado com **marcadores** (senha,
 * coordenadas, push token, e-mail, nome, destino) e depois procuramos esses
 * marcadores — e as chaves proibidas — em toda a outbox, em toda a auditoria e
 * em tudo que o logger real escreveu. A verificação é por chave de objeto
 * (recursiva) e por valor, família a família, não por uma string solta.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let captured: string[] = [];

const PASSWORD = "Senha-Marcador-Secreta-2026!";
const LATITUDE = -23.55051;
const LONGITUDE = -46.63331;
const DESTINATION = "Rua Marcador Sigilosa 123";
const PUSH_TOKEN = fakeExpoToken("marcador-privacidade");

const FORBIDDEN_KEYS = [
  "password",
  "passwordHash",
  "token",
  "pushToken",
  "refreshToken",
  "accessToken",
  "authorization",
  "latitude",
  "longitude",
  "accuracy",
  "address",
  "destinationLabel",
  "email",
  "name",
];

beforeAll(async () => {
  app = await buildApp({
    logger: true,
    databaseUrl: getTestDatabaseUrl(),
    pushProvider: new FakePushProvider(),
    checkinSchedulerAutoStart: false,
    journeySchedulerAutoStart: false,
    outboxWorkerAutoStart: false,
  });
  const stream = app.log as unknown as { [key: symbol]: unknown };
  const streamSymbol = Object.getOwnPropertySymbols(stream).find((symbol) =>
    symbol.toString().includes("stream"),
  );
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

/** Todas as chaves de um JSON, recursivamente. */
function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out.add(key);
      collectKeys(nested, out);
    }
  }
  return out;
}

async function runFullFlow(): Promise<{ owner: TestUser; member: TestUser }> {
  const email = `marcador-${randomUUID()}@example.com`;
  const register = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name: "Nome Marcador", email, password: PASSWORD },
  });
  expect(register.statusCode).toBe(201);
  const owner: TestUser = {
    userId: register.json().user.id,
    email,
    name: "Nome Marcador",
    accessToken: register.json().accessToken,
    refreshToken: register.json().refreshToken,
    password: PASSWORD,
  };
  // Login com falha (auditado) e com sucesso.
  await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: "errada-errada-errada" },
  });
  await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: PASSWORD } });

  const member = await registerUser(app, { name: "Membro Marcador" });
  const groupId = await createGroup(app, owner, "Grupo Marcador");
  await addMember(app, owner, groupId, member);
  await registerActiveDevice(app, member, { token: PUSH_TOKEN });

  const alert = await createAlert(app, owner, groupId, {
    latitude: LATITUDE,
    longitude: LONGITUDE,
    accuracy: 5,
  });
  await app.inject({
    method: "POST",
    url: `/alerts/${alert.id}/live-location/start`,
    headers: authHeaders(owner),
  });
  await app.inject({
    method: "POST",
    url: `/alerts/${alert.id}/live-location`,
    headers: authHeaders(owner),
    payload: {
      clientUpdateId: randomUUID(),
      latitude: LATITUDE,
      longitude: LONGITUDE,
      accuracy: 5,
      capturedAt: new Date().toISOString(),
    },
  });
  await app.inject({
    method: "PUT",
    url: `/alerts/${alert.id}/acknowledgement`,
    headers: authHeaders(member),
    payload: { type: "SEEN" },
  });
  await app.inject({
    method: "POST",
    url: `/alerts/${alert.id}/resolve`,
    headers: authHeaders(owner),
  });

  const checkin = await createCheckin(app, owner, groupId);
  await checkinAction(app, owner, checkin.id, "safe");
  const journey = await createJourney(app, owner, groupId, {
    destinationLabel: DESTINATION,
    liveLocationEnabled: true,
  });
  await app.inject({
    method: "POST",
    url: `/journeys/${journey.id}/live-location/start`,
    headers: authHeaders(owner),
  });
  await journeyAction(app, owner, journey.id, "arrive");

  await app.inject({ method: "GET", url: "/me/privacy/export", headers: authHeaders(owner) });
  await app.inject({
    method: "POST",
    url: "/me/sessions/revoke-others",
    headers: authHeaders(owner),
  });
  await app.inject({
    method: "POST",
    url: "/auth/refresh",
    payload: { refreshToken: owner.refreshToken },
  });

  await drainOutbox(app);
  return { owner, member };
}

describe("Outbox e auditoria não guardam dado sensível", () => {
  it("por família de evento da outbox: nenhuma chave proibida e nenhum marcador", async () => {
    const { owner, member } = await runFullFlow();
    const rows = await cleaner.sql<{ event_type: string; payload: unknown }[]>`
      SELECT event_type, payload FROM outbox_events
    `;
    // EMAIL_ entrou na Phase 13: o convite gera evento de e-mail, e o payload
    // continua sendo só id — o endereço é carregado na entrega.
    const families = { PUSH_: 0, EMAIL_: 0, REALTIME_: 0, AUDIT_: 0 };
    for (const row of rows) {
      const family = (Object.keys(families) as Array<keyof typeof families>).find((prefix) =>
        row.event_type.startsWith(prefix),
      );
      expect(family, row.event_type).toBeDefined();
      families[family!] += 1;

      const keys = collectKeys(row.payload);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys.has(forbidden), `${row.event_type} tem chave ${forbidden}`).toBe(false);
      }
      const raw = JSON.stringify(row.payload);
      for (const marker of [
        PASSWORD,
        PUSH_TOKEN,
        DESTINATION,
        owner.email,
        member.email,
        "Marcador",
      ]) {
        expect(raw, `${row.event_type} contém ${marker}`).not.toContain(marker);
      }
      expect(raw, row.event_type).not.toMatch(new RegExp(`${LATITUDE}|${LONGITUDE}`));
    }
    // A verificação só vale se cada família realmente foi exercitada.
    expect(families.PUSH_).toBeGreaterThan(0);
    expect(families.EMAIL_).toBeGreaterThan(0);
    expect(families.REALTIME_).toBeGreaterThan(0);
    expect(families.AUDIT_).toBeGreaterThan(0);
  });

  it("auditoria: só IDs, metadata allow-listed, sem IP/User-Agent, sem marcadores", async () => {
    const { owner, member } = await runFullFlow();
    const rows = await cleaner.sql<Record<string, unknown>[]>`SELECT * FROM audit_events`;
    expect(rows.length).toBeGreaterThan(5);

    const columns = new Set(Object.keys(rows[0]!));
    for (const forbidden of [
      "ip",
      "ip_address",
      "user_agent",
      "email",
      "name",
      "latitude",
      "token",
    ]) {
      expect(columns.has(forbidden), forbidden).toBe(false);
    }
    const eventTypes = new Set(rows.map((row) => row.event_type as string));
    for (const expected of [
      "AUTH_LOGIN_FAILED",
      "AUTH_LOGIN_SUCCEEDED",
      "ALERT_CREATED",
      "PRIVACY_EXPORT_REQUESTED",
      "AUTH_OTHER_SESSIONS_REVOKED",
    ]) {
      expect(eventTypes.has(expected), expected).toBe(true);
    }

    const raw = JSON.stringify(rows);
    for (const marker of [
      PASSWORD,
      PUSH_TOKEN,
      DESTINATION,
      owner.email,
      member.email,
      "Marcador",
    ]) {
      expect(raw, marker).not.toContain(marker);
    }
    expect(raw).not.toMatch(new RegExp(`${LATITUDE}|${LONGITUDE}`));
    for (const row of rows) {
      const keys = collectKeys(row.metadata);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys.has(forbidden), `${row.event_type} metadata ${forbidden}`).toBe(false);
      }
    }
  });
});

describe("Logs (logger real) não carregam segredo nem localização", () => {
  it("marcadores de senha, tokens, coordenadas, push token e destino não aparecem", async () => {
    const { owner } = await runFullFlow();
    const logged = captured.join("\n");
    expect(logged.length).toBeGreaterThan(0);

    for (const marker of [
      PASSWORD,
      PUSH_TOKEN,
      owner.refreshToken,
      owner.accessToken,
      DESTINATION,
    ]) {
      expect(logged, marker.slice(0, 12)).not.toContain(marker);
    }
    expect(logged).not.toMatch(new RegExp(`${LATITUDE}|${LONGITUDE}`));
    expect(logged).not.toContain("Bearer ");
    // O header de autorização é redigido ou removido, nunca escrito.
    expect(logged).not.toMatch(/"authorization":"[^"[]/);
  });
});
