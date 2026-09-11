import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { createTestApp } from "./helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "./helpers/test-db.js";

const cleaner = createCleaner();
const sql = postgres(getTestDatabaseUrl(), { max: 1 });

let app: FastifyInstance;

const validUser = {
  name: "Felipe Souza",
  email: "felipe@example.com",
  password: "senhaSegura123",
};

async function register(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/auth/register", payload: body });
}
async function login(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/auth/login", payload: body });
}

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
  await cleaner.close();
  await sql.end({ timeout: 5 });
});

beforeEach(async () => {
  await cleaner.truncate();
});

describe("POST /auth/register", () => {
  it("cria conta válida e retorna tokens (201)", async () => {
    const res = await register(validUser);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ name: "Felipe Souza", email: "felipe@example.com" });
    expect(typeof body.user.id).toBe("string");
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
  });

  it("normaliza o e-mail (trim + lowercase)", async () => {
    const res = await register({ ...validUser, email: "  Felipe@Example.COM " });
    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe("felipe@example.com");
  });

  it("rejeita e-mail duplicado com EMAIL_ALREADY_IN_USE", async () => {
    await register(validUser);
    const res = await register({ ...validUser, email: "FELIPE@example.com" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("EMAIL_ALREADY_IN_USE");
  });

  it("rejeita senha curta com VALIDATION_ERROR", async () => {
    const res = await register({ ...validUser, password: "123" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("nunca expõe passwordHash na resposta", async () => {
    const res = await register(validUser);
    expect(res.payload).not.toContain("passwordHash");
    expect(res.payload).not.toContain("password_hash");
    expect(res.payload).not.toContain("$argon2");
  });

  it("persiste a senha apenas como hash argon2id", async () => {
    await register(validUser);
    const rows = await sql`SELECT password_hash FROM users WHERE email = ${validUser.email}`;
    expect(rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0]?.password_hash).not.toContain(validUser.password);
  });
});

describe("POST /auth/login", () => {
  beforeEach(async () => {
    await register(validUser);
  });

  it("autentica com credenciais válidas", async () => {
    const res = await login({ email: validUser.email, password: validUser.password });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.email).toBe("felipe@example.com");
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
  });

  it("e-mail inexistente retorna INVALID_CREDENTIALS (não USER_NOT_FOUND)", async () => {
    const res = await login({ email: "naoexiste@example.com", password: validUser.password });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("INVALID_CREDENTIALS");
    expect(res.payload).not.toContain("USER_NOT_FOUND");
  });

  it("senha incorreta retorna INVALID_CREDENTIALS", async () => {
    const res = await login({ email: validUser.email, password: "senhaErrada999" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("INVALID_CREDENTIALS");
  });

  it("trata e-mail case-insensitive no login", async () => {
    const res = await login({ email: "FELIPE@EXAMPLE.com", password: validUser.password });
    expect(res.statusCode).toBe(200);
  });

  it("nunca expõe hash da senha", async () => {
    const res = await login({ email: validUser.email, password: validUser.password });
    expect(res.payload).not.toContain("$argon2");
    expect(res.payload).not.toContain("passwordHash");
  });
});

describe("POST /auth/refresh", () => {
  let refreshToken: string;

  beforeEach(async () => {
    const res = await register(validUser);
    refreshToken = res.json().refreshToken;
  });

  it("gera novos tokens com refresh válido", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(body.refreshToken).not.toBe(refreshToken);
  });

  it("invalida o refresh token antigo após rotação", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);

    const reused = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json().code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("rejeita refresh token inválido", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: "token-invalido" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("rejeita sessão expirada com SESSION_EXPIRED", async () => {
    await sql`UPDATE auth_sessions SET expires_at = now() - interval '1 hour'`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_EXPIRED");
  });

  it("rejeita sessão revogada com SESSION_REVOKED", async () => {
    await sql`UPDATE auth_sessions SET revoked_at = now()`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SESSION_REVOKED");
  });
});

describe("POST /auth/logout", () => {
  let refreshToken: string;

  beforeEach(async () => {
    const res = await register(validUser);
    refreshToken = res.json().refreshToken;
  });

  it("revoga a sessão e impede refresh posterior", async () => {
    const out = await app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken },
    });
    expect(out.statusCode).toBe(204);

    const res = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
    expect(["SESSION_REVOKED", "INVALID_REFRESH_TOKEN"]).toContain(res.json().code);
  });

  it("é idempotente (logout repetido continua 204)", async () => {
    await app.inject({ method: "POST", url: "/auth/logout", payload: { refreshToken } });
    const second = await app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken },
    });
    expect(second.statusCode).toBe(204);
  });
});

// Silencia lint sobre hook não usado quando não há teardown adicional.
afterEach(async () => {});
