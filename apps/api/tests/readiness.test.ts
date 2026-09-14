import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "./helpers/test-db.js";
import { buildApp } from "../src/app.js";
import { checkDatabase, evaluateReadiness } from "../src/observability/health.js";
import { createDatabase } from "../src/infrastructure/database/client.js";

const cleaner = createCleaner();
let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});

describe("GET /health (liveness)", () => {
  it("responde 200 sem depender do banco", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("continua respondendo 200 mesmo em instância sem DATABASE_URL", async () => {
    // String vazia força o modo sem banco, mesmo com DATABASE_URL no ambiente.
    const noDb = await buildApp({ logger: false, databaseUrl: "" });
    try {
      // Sem banco a app não registra rotas de negócio, mas segue viva.
      const res = await noDb.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    } finally {
      await noDb.close();
    }
  });
});

describe("GET /ready (readiness)", () => {
  it("com banco disponível responde 200 e lista as verificações", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual(
      expect.arrayContaining([
        { name: "startup", status: "ok" },
        { name: "database", status: "ok" },
      ]),
    );
  });

  it("sem banco configurado responde 503", async () => {
    const noDb = await buildApp({ logger: false, databaseUrl: "" });
    try {
      const res = await noDb.inject({ method: "GET", url: "/ready" });
      expect(res.statusCode).toBe(503);
      expect(res.json().status).toBe("degraded");
    } finally {
      await noDb.close();
    }
  });

  it("banco indisponível responde 503", async () => {
    // Porta sem PostgreSQL: a conexão falha e a readiness cai.
    const unreachable = createDatabase("postgres://safecircle@127.0.0.1:59999/nao-existe");
    try {
      const result = await evaluateReadiness({ db: unreachable.db, started: true, timeoutMs: 800 });
      expect(result.statusCode).toBe(503);
      expect(result.status).toBe("degraded");
      expect(result.checks).toContainEqual({ name: "database", status: "fail" });
    } finally {
      await unreachable.close().catch(() => {});
    }
  }, 20_000);

  it("consulta lenta estoura o timeout e conta como falha", async () => {
    const handle = createDatabase(getTestDatabaseUrl());
    try {
      // Timeout impossível de cumprir: o resultado precisa ser falha, não espera.
      expect(await checkDatabase(handle.db, 0)).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("inicialização incompleta torna a instância not-ready", async () => {
    const result = await evaluateReadiness({ started: false });
    expect(result.statusCode).toBe(503);
    expect(result.checks).toContainEqual({ name: "startup", status: "fail" });
  });

  it("a resposta não expõe connection string, host ou detalhe do driver", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    const payload = res.payload.toLowerCase();
    for (const leak of [
      "postgres://",
      "password",
      "localhost",
      "127.0.0.1",
      "5434",
      "safecircle_test",
      "econnrefused",
    ]) {
      expect(payload).not.toContain(leak);
    }
  });
});
