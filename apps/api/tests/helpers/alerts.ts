import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { authHeaders, type TestUser } from "./auth.js";

/**
 * Coordenadas SINTÉTICAS para testes (README §5.5): nunca usar localização
 * pessoal real. O ponto abaixo é fictício e não corresponde a nenhum endereço.
 */
export const SYNTHETIC_LOCATION = {
  latitude: -23,
  longitude: -46,
  accuracy: 15,
  capturedAt: "2026-09-11T20:30:00.000Z",
};

export interface AlertLocationPayload {
  latitude: number;
  longitude: number;
  accuracy?: number;
  capturedAt?: string;
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

/**
 * POST /alerts com header Idempotency-Key (gerado por padrão).
 * Passe `null` para omitir o header deliberadamente.
 */
export function postAlert(
  app: FastifyInstance,
  user: TestUser,
  payload: Record<string, unknown>,
  idempotencyKey: string | null = newIdempotencyKey(),
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...authHeaders(user) };
  if (idempotencyKey !== null) {
    headers["idempotency-key"] = idempotencyKey;
  }
  return app.inject({ method: "POST", url: "/alerts", headers, payload });
}

/** Cria um alerta e devolve o corpo (falha se não for 201). */
export async function createAlert(
  app: FastifyInstance,
  user: TestUser,
  groupId: string,
  location?: AlertLocationPayload | null,
) {
  const payload = location === undefined ? { groupId } : { groupId, location };
  const res = await postAlert(app, user, payload);
  if (res.statusCode !== 201) {
    throw new Error(`Falha ao criar alerta: ${res.statusCode} ${res.payload}`);
  }
  return res.json();
}
