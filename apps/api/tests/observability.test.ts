import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser } from "./helpers/auth.js";
import { createGroup } from "./helpers/groups.js";
import { metricValue, registry } from "../src/observability/metrics.js";
import { isValidRequestId, resolveRequestId } from "../src/observability/request-context.js";

const cleaner = createCleaner();
let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp({ exposeTestErrorRoute: true });
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
});

describe("Request ID", () => {
  it("gera um UUID por requisição e devolve em X-Request-Id", async () => {
    const first = await app.inject({ method: "GET", url: "/health" });
    const second = await app.inject({ method: "GET", url: "/health" });

    const a = first.headers["x-request-id"] as string;
    const b = second.headers["x-request-id"] as string;
    expect(isValidRequestId(a)).toBe(true);
    expect(isValidRequestId(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it("aceita X-Request-Id do cliente quando é UUID válido", async () => {
    const provided = randomUUID();
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": provided },
    });
    expect(res.headers["x-request-id"]).toBe(provided);
  });

  it("substitui X-Request-Id inválido — inclusive tentativas de log injection", async () => {
    const hostile = [
      "nao-e-uuid",
      "../../etc/passwd",
      "a".repeat(500),
      "11111111-1111-4111-8111-111111111111\nfake: injected",
      "[31mvermelho[0m",
      "",
    ];
    for (const value of hostile) {
      const res = await app.inject({
        method: "GET",
        url: "/health",
        headers: { "x-request-id": value },
      });
      const returned = res.headers["x-request-id"] as string;
      expect(isValidRequestId(returned)).toBe(true);
      expect(returned).not.toBe(value);
      expect(returned).not.toContain("\n");
    }
  });

  it("resolveRequestId ignora arrays e valores fora do formato", () => {
    const valid = randomUUID();
    expect(resolveRequestId(valid)).toBe(valid);
    expect(isValidRequestId(resolveRequestId(["x", valid]))).toBe(true);
    expect(resolveRequestId(["x", valid])).not.toBe("x");
    expect(isValidRequestId(resolveRequestId(undefined))).toBe(true);
    expect(isValidRequestId(resolveRequestId(12345))).toBe(true);
  });

  it("respostas de erro carregam requestId igual ao header", async () => {
    const res = await app.inject({ method: "GET", url: "/checkins" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
    expect(res.json().requestId).toBe(res.headers["x-request-id"]);
  });

  it("rota inexistente responde no formato padrão, com requestId e sem ecoar a URL", async () => {
    const res = await app.inject({ method: "GET", url: `/rota-que-nao-existe/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.message).toBe("Recurso não encontrado.");
    expect(body.requestId).toBe(res.headers["x-request-id"]);
    // A resposta padrão do Fastify ecoaria método e URL; a nossa não.
    expect(res.payload).not.toContain("rota-que-nao-existe");
    expect(res.payload).not.toContain("GET:");
  });

  it("erro de validação e erro de domínio também carregam requestId", async () => {
    const user = await registerUser(app);
    const invalid = await app.inject({
      method: "POST",
      url: "/checkins",
      headers: { ...authHeaders(user), "idempotency-key": randomUUID() },
      payload: { groupId: "nao-uuid", dueAt: "amanhã" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("VALIDATION_ERROR");
    expect(isValidRequestId(invalid.json().requestId)).toBe(true);

    const notFound = await app.inject({
      method: "GET",
      url: `/checkins/${randomUUID()}`,
      headers: authHeaders(user),
    });
    expect(notFound.statusCode).toBe(404);
    expect(isValidRequestId(notFound.json().requestId)).toBe(true);
  });
});

describe("Error ID", () => {
  it("falha interna responde 500 com errorId e requestId, sem stack", async () => {
    const res = await app.inject({ method: "GET", url: "/__test__/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("Erro interno.");
    expect(isValidRequestId(body.errorId)).toBe(true);
    expect(body.requestId).toBe(res.headers["x-request-id"]);
    // Nada de detalhe interno vaza para o cliente.
    for (const leak of ["stack", "at Object", "sintética", "Error:", "node_modules"]) {
      expect(res.payload).not.toContain(leak);
    }
  });

  it("cada falha recebe um errorId próprio", async () => {
    const a = await app.inject({ method: "GET", url: "/__test__/boom" });
    const b = await app.inject({ method: "GET", url: "/__test__/boom" });
    expect(a.json().errorId).not.toBe(b.json().errorId);
  });

  it("a rota sintética de erro não existe fora de NODE_ENV=test", async () => {
    // A instância padrão dos testes não a expõe (option desligada).
    const plain = await createTestApp();
    try {
      const res = await plain.inject({ method: "GET", url: "/__test__/boom" });
      expect(res.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe("Métricas HTTP", () => {
  it("contabiliza requisições com rota-template e classe de status", async () => {
    const user = await registerUser(app);
    const groupId = await createGroup(app, user, "Família");
    const before = await metricValue("safecircle_http_requests_total", {
      method: "GET",
      route: "/groups/:groupId",
      status_class: "2xx",
    });

    await app.inject({
      method: "GET",
      url: `/groups/${groupId}`,
      headers: authHeaders(user),
    });

    const after = await metricValue("safecircle_http_requests_total", {
      method: "GET",
      route: "/groups/:groupId",
      status_class: "2xx",
    });
    expect(after).toBe(before + 1);

    // A duração também é observada para a mesma série.
    const count = await metricValue("safecircle_http_request_duration_seconds_count", {
      method: "GET",
      route: "/groups/:groupId",
      status_class: "2xx",
    });
    expect(count).toBeGreaterThan(0);
  });

  it("requisições sem rota casada não criam série por URL", async () => {
    const before = await metricValue("safecircle_http_requests_total", { route: "unmatched" });
    await app.inject({ method: "GET", url: `/rota-inexistente/${randomUUID()}` });
    const after = await metricValue("safecircle_http_requests_total", { route: "unmatched" });
    expect(after).toBe(before + 1);
  });

  it("in-flight volta a zero depois das requisições", async () => {
    await app.inject({ method: "GET", url: "/health" });
    expect(await metricValue("safecircle_http_requests_in_flight")).toBe(0);
  });
});

describe("Cardinalidade das métricas", () => {
  it("nenhum label carrega UUID ou identificador de recurso", async () => {
    // Exercita rotas com IDs reais para forçar séries.
    const user = await registerUser(app);
    const groupId = await createGroup(app, user, "Família");
    await app.inject({ method: "GET", url: `/groups/${groupId}`, headers: authHeaders(user) });
    await app.inject({
      method: "GET",
      url: `/checkins/${randomUUID()}`,
      headers: authHeaders(user),
    });
    await app.inject({ method: "GET", url: `/nao-existe/${randomUUID()}` });

    const json = await registry.getMetricsAsJSON();
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const forbiddenLabels = [
      "user_id",
      "userId",
      "group_id",
      "groupId",
      "alert_id",
      "checkin_id",
      "journey_id",
      "request_id",
      "error_id",
      "token",
      "url",
    ];

    for (const metric of json) {
      const values =
        (metric as { values?: Array<{ labels: Record<string, unknown> }> }).values ?? [];
      for (const entry of values) {
        for (const [label, value] of Object.entries(entry.labels)) {
          expect(forbiddenLabels).not.toContain(label);
          if (typeof value === "string") {
            expect(uuid.test(value), `${metric.name} label ${label}=${value}`).toBe(false);
            // Valores de label são curtos e controlados.
            expect(value.length).toBeLessThanOrEqual(60);
          }
        }
      }
    }
  });

  it("toda métrica customizada usa o prefixo safecircle_", async () => {
    const json = await registry.getMetricsAsJSON();
    expect(json.length).toBeGreaterThan(0);
    for (const metric of json) {
      expect(metric.name.startsWith("safecircle_")).toBe(true);
    }
  });
});
