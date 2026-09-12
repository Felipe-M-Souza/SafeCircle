import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import postgres from "postgres";
import { authHeaders, type TestUser } from "./auth.js";

/** ISO de `minutes` minutos a partir de agora. */
export function arriveIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function postJourney(
  app: FastifyInstance,
  user: TestUser,
  payload: Record<string, unknown>,
  idempotencyKey: string | null = randomUUID(),
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...authHeaders(user) };
  if (idempotencyKey !== null) {
    headers["idempotency-key"] = idempotencyKey;
  }
  return app.inject({ method: "POST", url: "/journeys", headers, payload });
}

/** Cria um trajeto ACTIVE (falha se não for 201) e devolve o corpo. */
export async function createJourney(
  app: FastifyInstance,
  user: TestUser,
  groupId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await postJourney(app, user, {
    groupId,
    expectedArrivalAt: arriveIn(30),
    ...overrides,
  });
  if (res.statusCode !== 201) {
    throw new Error(`Falha ao criar trajeto: ${res.statusCode} ${res.payload}`);
  }
  return res.json();
}

/** Faz o prazo do trajeto "vencer" no banco (sem sleep). */
export async function expireJourney(sql: postgres.Sql, journeyId: string): Promise<void> {
  await sql`
    UPDATE safe_journeys SET expected_arrival_at = now() - interval '1 minute' WHERE id = ${journeyId}
  `;
}

export function journeyAction(
  app: FastifyInstance,
  user: TestUser,
  journeyId: string,
  action: "arrive" | "cancel",
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/journeys/${journeyId}/${action}`,
    headers: authHeaders(user),
  });
}

export function getJourney(
  app: FastifyInstance,
  user: TestUser,
  journeyId: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url: `/journeys/${journeyId}`,
    headers: authHeaders(user),
  });
}

/** Ponto de localização sintético (coordenadas fictícias). */
export function syntheticJourneyPoint(
  seq = 0,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    clientUpdateId: randomUUID(),
    latitude: -23.5 + seq * 0.001,
    longitude: -46.6 + seq * 0.001,
    accuracy: 12,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function startJourneyLocation(
  app: FastifyInstance,
  user: TestUser,
  journeyId: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/journeys/${journeyId}/live-location/start`,
    headers: authHeaders(user),
  });
}

export function sendJourneyLocation(
  app: FastifyInstance,
  user: TestUser,
  journeyId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/journeys/${journeyId}/live-location`,
    headers: authHeaders(user),
    payload,
  });
}

/** Envelhece o último ponto para driblar o throttling de 2 s nos testes. */
export async function ageLatestJourneyPoint(sql: postgres.Sql, journeyId: string): Promise<void> {
  await sql`
    UPDATE journey_location_updates SET created_at = created_at - interval '5 seconds'
    WHERE journey_id = ${journeyId}
  `;
}

export async function countJourneyPoints(sql: postgres.Sql, journeyId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM journey_location_updates WHERE journey_id = ${journeyId}
  `;
  return row?.count ?? 0;
}
