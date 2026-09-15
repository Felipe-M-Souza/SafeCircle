import type { FastifyInstance } from "fastify";
import { JWT_AUDIENCE, JWT_ISSUER } from "../../src/plugins/auth.js";

export interface TestUser {
  userId: string;
  email: string;
  name: string;
  accessToken: string;
  /** Refresh token da sessão criada no registro (Phase 11: testes de sessão). */
  refreshToken: string;
  password: string;
}

let counter = 0;

/**
 * Registra um usuário novo e retorna seus dados + access token.
 */
export async function registerUser(
  app: FastifyInstance,
  overrides: Partial<{ name: string; email: string; password: string }> = {},
): Promise<TestUser> {
  counter += 1;
  const name = overrides.name ?? `Usuário ${counter}`;
  const email = overrides.email ?? `user${counter}@example.com`;
  const password = overrides.password ?? "senhaSegura123";

  const res = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { name, email, password },
  });
  if (res.statusCode !== 201) {
    throw new Error(`Falha ao registrar usuário de teste: ${res.statusCode} ${res.payload}`);
  }
  const body = res.json();
  return {
    userId: body.user.id,
    email: body.user.email,
    name,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    password,
  };
}

export function authHeaders(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.accessToken}` };
}

/** Claims do access token (sem verificar assinatura — uso exclusivo em testes). */
export function decodeAccessToken(accessToken: string): Record<string, unknown> {
  const payload = accessToken.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** Id da sessão (`sid`) embutido no access token do usuário de teste. */
export function sessionIdOf(user: TestUser): string {
  return decodeAccessToken(user.accessToken).sid as string;
}

/**
 * Assina um access token de teste com o emissor e a audiência da API.
 * Passar opções por chamada ao `app.jwt.sign` descarta os padrões de `iss`/`aud`,
 * e a Phase 11 exige essas claims — por isso o helper as reinjeta.
 */
export function signTestAccessToken(
  app: FastifyInstance,
  claims: { sub: string; sid: string },
  options: { expiresIn?: string; iss?: string; aud?: string } = {},
): string {
  return app.jwt.sign(claims, {
    expiresIn: options.expiresIn ?? "15m",
    iss: options.iss ?? JWT_ISSUER,
    aud: options.aud ?? JWT_AUDIENCE,
  });
}
