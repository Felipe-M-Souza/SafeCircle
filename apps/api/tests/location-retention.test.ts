import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { createGroup } from "./helpers/groups.js";
import { SYNTHETIC_LOCATION, createAlert } from "./helpers/alerts.js";
import {
  LOCATION_RETENTION_DAYS,
  deleteExpiredLocationData,
} from "../src/modules/alerts/live-location.service.js";

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

async function counts() {
  const [row] = await cleaner.sql<
    { alerts: number; sessions: number; updates: number; initial: number; acks: number }[]
  >`
    SELECT
      (SELECT count(*)::int FROM emergency_alerts) AS alerts,
      (SELECT count(*)::int FROM alert_location_sessions) AS sessions,
      (SELECT count(*)::int FROM alert_location_updates) AS updates,
      (SELECT count(*)::int FROM alert_locations) AS initial,
      (SELECT count(*)::int FROM alert_acknowledgements) AS acks
  `;
  return row!;
}

/** Cria alerta com localização inicial, sessão ao vivo e um ponto (coordenadas sintéticas). */
async function alertWithLocation(user: TestUser, groupId: string): Promise<string> {
  const alert = await createAlert(app, user, groupId, SYNTHETIC_LOCATION);
  await app.inject({
    method: "POST",
    url: `/alerts/${alert.id}/live-location/start`,
    headers: authHeaders(user),
  });
  const sent = await app.inject({
    method: "POST",
    url: `/alerts/${alert.id}/live-location`,
    headers: authHeaders(user),
    payload: {
      clientUpdateId: randomUUID(),
      latitude: -23,
      longitude: -46,
      capturedAt: new Date().toISOString(),
    },
  });
  if (sent.statusCode !== 201) {
    throw new Error(`Falha ao enviar ponto: ${sent.statusCode} ${sent.payload}`);
  }
  return alert.id;
}

describe("Retenção de dados de localização", () => {
  it("apaga apenas dados de localização de alertas encerrados há mais de 30 dias", async () => {
    const user = await registerUser(app);
    const groupId = await createGroup(app, user);

    const oldAlert = await alertWithLocation(user, groupId);
    await app.inject({
      method: "POST",
      url: `/alerts/${oldAlert}/resolve`,
      headers: authHeaders(user),
    });
    // Encerrado há 31 dias.
    await cleaner.sql`
      UPDATE emergency_alerts SET resolved_at = now() - interval '31 days' WHERE id = ${oldAlert}
    `;

    const recentAlert = await alertWithLocation(user, groupId);
    await app.inject({
      method: "POST",
      url: `/alerts/${recentAlert}/cancel`,
      headers: authHeaders(user),
    });

    const activeGroup = await createGroup(app, user, "Outro");
    await alertWithLocation(user, activeGroup);

    const before = await counts();
    expect(before).toMatchObject({ alerts: 3, sessions: 3, updates: 3, initial: 3 });

    const summary = await deleteExpiredLocationData(app.db, new Date(), LOCATION_RETENTION_DAYS);
    expect(summary).toEqual({ alerts: 1, updates: 1, sessions: 1, initialLocations: 1 });

    const after = await counts();
    // Alertas nunca são apagados; só a localização do alerta antigo sumiu.
    expect(after).toMatchObject({ alerts: 3, sessions: 2, updates: 2, initial: 2 });
    const [remaining] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM alert_locations WHERE alert_id = ${oldAlert}
    `;
    expect(remaining?.count).toBe(0);

    // Idempotente: rodar de novo reprocessa o alerta expirado sem apagar mais nada.
    expect(await deleteExpiredLocationData(app.db)).toEqual({
      alerts: 1,
      updates: 0,
      sessions: 0,
      initialLocations: 0,
    });
  });

  it("alertas ativos ou encerrados recentemente nunca são afetados", async () => {
    const user = await registerUser(app);
    const groupId = await createGroup(app, user);
    await alertWithLocation(user, groupId);
    const summary = await deleteExpiredLocationData(app.db);
    expect(summary.alerts).toBe(0);
    expect((await counts()).updates).toBe(1);
  });
});
