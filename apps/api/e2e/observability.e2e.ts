import { randomUUID } from "node:crypto";
import { describe, expect, inject, it } from "vitest";
import { E2eClient, uniqueEmail } from "./harness.js";

/**
 * E2E — Smoke de observabilidade (Phase 12 §79): /health, /ready, /metrics,
 * requestId em toda resposta, errorId em 500, e as famílias de métricas
 * (HTTP, outbox, scheduler, segurança) presentes no processo real.
 */
const api = new E2eClient(inject("apiUrl"));

describe("E2E observabilidade", () => {
  it("/health e /ready respondem sem revelar topologia", async () => {
    const health = await api.call<{ status: string }>("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ status: "ok" });

    const ready = await api.call<{ status: string; checks: unknown[]; version?: string }>(
      "GET",
      "/ready",
    );
    expect(ready.status).toBe(200);
    expect(ready.json.status).toBe("ok");
    expect(JSON.stringify(ready.json)).not.toMatch(/postgres:|localhost|5432|password/i);
    expect(ready.json.version).toBe("0.1.0-rc.1");
  });

  it("toda resposta tem X-Request-Id; um requestId válido do cliente é preservado", async () => {
    const res = await api.call("GET", "/health");
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const mine = randomUUID();
    const echoed = await api.call("GET", "/health", { headers: { "x-request-id": mine } });
    expect(echoed.headers.get("x-request-id")).toBe(mine);

    const forged = await api.call("GET", "/health", {
      headers: { "x-request-id": "nao-e-uuid\n" },
    });
    expect(forged.headers.get("x-request-id")).not.toContain("nao-e-uuid");
  });

  it("erro de cliente carrega requestId e código estável; 404 é uniforme", async () => {
    const user = await api.register("Obs", uniqueEmail("obs"));
    const notFound = await api.call<{ code: string; requestId: string }>(
      "GET",
      `/alerts/${randomUUID()}`,
      { token: user.accessToken },
    );
    expect(notFound.status).toBe(404);
    expect(notFound.json.code).toBe("ALERT_NOT_FOUND");
    expect(notFound.json.requestId).toBe(notFound.headers.get("x-request-id"));

    const route = await api.call<{ code: string }>("GET", "/rota-inexistente");
    expect(route.status).toBe(404);
    expect(route.json.code).toBe("NOT_FOUND");
  });

  it("/metrics expõe as famílias esperadas e nenhum identificador em label", async () => {
    const metrics = await fetch(`${api.baseUrl}/metrics`).then((r) => r.text());
    for (const family of [
      "safecircle_http_requests_total",
      "safecircle_http_request_duration_seconds",
      "safecircle_outbox_processed_total",
      "safecircle_outbox_backlog",
      "safecircle_scheduler_runs_total",
      "safecircle_auth_login_attempts_total",
      "safecircle_security_rate_limited_total",
      "safecircle_realtime_connections",
    ]) {
      expect(metrics, family).toContain(family);
    }
    const labelLines = metrics
      .split("\n")
      .filter((line) => line.startsWith("safecircle_") && line.includes("{"));
    for (const line of labelLines) {
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(line).not.toMatch(/email|user_id|group_id|request_id/);
    }
    // Schedulers reais rodando no processo (intervalo de 1 s no E2E).
    expect(metrics).toMatch(
      /safecircle_scheduler_runs_total\{[^}]*scheduler="checkins"[^}]*\} [1-9]/,
    );
    expect(metrics).toMatch(
      /safecircle_scheduler_runs_total\{[^}]*scheduler="journeys"[^}]*\} [1-9]/,
    );
  });
});
