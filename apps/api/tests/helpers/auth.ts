import type { FastifyInstance } from "fastify";

export interface TestUser {
  userId: string;
  email: string;
  name: string;
  accessToken: string;
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
  return { userId: body.user.id, email: body.user.email, name, accessToken: body.accessToken };
}

export function authHeaders(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.accessToken}` };
}
