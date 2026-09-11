import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";

const cleaner = createCleaner();
let app: FastifyInstance;

const user = {
  name: "Felipe Souza",
  email: "felipe@example.com",
  password: "senhaSegura123",
};

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

describe("GET /me", () => {
  it("retorna 401 sem token", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("retorna 401 com token inválido", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer token-invalido" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("retorna o usuário autenticado com token válido", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: user,
    });
    const accessToken = registered.json().accessToken;

    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ name: "Felipe Souza", email: "felipe@example.com" });
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");
    // Nunca retornar campos internos de autenticação.
    expect(res.payload).not.toContain("passwordHash");
    expect(res.payload).not.toContain("password_hash");
    expect(res.payload).not.toContain("refreshToken");
  });
});
