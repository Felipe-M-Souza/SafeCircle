import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { authHeaders, type TestUser } from "./auth.js";

/**
 * Helpers de push para testes. Tokens são SINTÉTICOS (formato Expo, conteúdo
 * aleatório) — nenhum push token real é usado ou versionado.
 */

let counter = 0;

export function fakeExpoToken(label = "token"): string {
  counter += 1;
  return `ExponentPushToken[${label}-${counter}-${randomUUID().replace(/-/g, "").slice(0, 16)}]`;
}

export function newDeviceId(): string {
  return randomUUID();
}

export function registerDevice(
  app: FastifyInstance,
  user: TestUser,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/me/push-devices",
    headers: authHeaders(user),
    payload,
  });
}

/** Registra um dispositivo ativo para o usuário e devolve o token usado. */
export async function registerActiveDevice(
  app: FastifyInstance,
  user: TestUser,
  overrides: Partial<{ token: string; platform: "IOS" | "ANDROID"; deviceId: string }> = {},
): Promise<{ token: string; deviceId: string; id: string }> {
  const token = overrides.token ?? fakeExpoToken();
  const deviceId = overrides.deviceId ?? newDeviceId();
  const res = await registerDevice(app, user, {
    token,
    platform: overrides.platform ?? "ANDROID",
    deviceId,
  });
  if (res.statusCode !== 201 && res.statusCode !== 200) {
    throw new Error(`Falha ao registrar push device: ${res.statusCode} ${res.payload}`);
  }
  return { token, deviceId, id: res.json().id };
}
