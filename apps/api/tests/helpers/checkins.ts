import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import postgres from "postgres";
import { authHeaders, type TestUser } from "./auth.js";

/** ISO de `minutes` minutos a partir de agora. */
export function dueIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function postCheckin(
  app: FastifyInstance,
  user: TestUser,
  payload: Record<string, unknown>,
  idempotencyKey: string | null = randomUUID(),
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...authHeaders(user) };
  if (idempotencyKey !== null) {
    headers["idempotency-key"] = idempotencyKey;
  }
  return app.inject({ method: "POST", url: "/checkins", headers, payload });
}

/** Cria um check-in ACTIVE (falha se não for 201) e devolve o corpo. */
export async function createCheckin(
  app: FastifyInstance,
  user: TestUser,
  groupId: string,
  minutes = 30,
) {
  const res = await postCheckin(app, user, { groupId, dueAt: dueIn(minutes) });
  if (res.statusCode !== 201) {
    throw new Error(`Falha ao criar check-in: ${res.statusCode} ${res.payload}`);
  }
  return res.json();
}

/** Faz o prazo do check-in "vencer" no banco (sem sleep). */
export async function expireCheckin(sql: postgres.Sql, checkinId: string): Promise<void> {
  await sql`
    UPDATE safety_checkins SET due_at = now() - interval '1 minute' WHERE id = ${checkinId}
  `;
}

export function checkinAction(
  app: FastifyInstance,
  user: TestUser,
  checkinId: string,
  action: "safe" | "cancel",
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/checkins/${checkinId}/${action}`,
    headers: authHeaders(user),
  });
}

export function getCheckin(
  app: FastifyInstance,
  user: TestUser,
  checkinId: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url: `/checkins/${checkinId}`,
    headers: authHeaders(user),
  });
}
