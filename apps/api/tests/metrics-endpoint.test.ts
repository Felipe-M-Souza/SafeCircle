import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";

const cleaner = createCleaner();
const TOKEN = "token-de-teste-com-16-ou-mais";

let disabled: FastifyInstance;
let open: FastifyInstance;
let protectedApp: FastifyInstance;

beforeAll(async () => {
  disabled = await createTestApp();
  open = await createTestApp({ metricsEnabled: true });
  protectedApp = await createTestApp({ metricsEnabled: true, metricsToken: TOKEN });
});
afterAll(async () => {
  await Promise.all([disabled.close(), open.close(), protectedApp.close()]);
  await cleaner.close();
});

describe("GET /metrics", () => {
  it("desabilitado: a rota não existe (404)", async () => {
    const res = await disabled.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(404);
    // Nem confirma que há métricas por trás.
    expect(res.payload).not.toContain("safecircle_");
  });

  it("habilitado sem token: responde métricas em formato Prometheus", async () => {
    const res = await open.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.payload).toContain("safecircle_http_requests_total");
    expect(res.payload).toContain("# HELP");
  });

  it("habilitado com token: sem Authorization responde 401", async () => {
    const res = await protectedApp.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
    expect(res.payload).not.toContain("safecircle_http_requests_total");
  });

  it("habilitado com token: Bearer inválido responde 401", async () => {
    for (const header of [
      "Bearer errado",
      `Bearer ${TOKEN}x`,
      `Basic ${TOKEN}`,
      TOKEN,
      "Bearer ",
    ]) {
      const res = await protectedApp.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: header },
      });
      expect(res.statusCode, `header: ${header}`).toBe(401);
    }
  });

  it("habilitado com token: Bearer válido responde 200", async () => {
    const res = await protectedApp.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain("safecircle_");
  });

  it("a resposta não contém o token nem cabeçalhos de autorização", async () => {
    const res = await protectedApp.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.payload).not.toContain(TOKEN);
    expect(res.payload).not.toContain("authorization");
  });

  it("métricas de processo estão presentes com o prefixo do projeto", async () => {
    const res = await open.inject({ method: "GET", url: "/metrics" });
    expect(res.payload).toContain("safecircle_process_cpu_seconds_total");
    expect(res.payload).toContain("safecircle_nodejs_eventloop_lag_seconds");
  });
});
