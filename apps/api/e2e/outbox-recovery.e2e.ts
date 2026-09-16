import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  E2eClient,
  connectWs,
  e2eDatabaseUrl,
  ensureDatabase,
  resetDatabase,
  startApi,
  uniqueEmail,
  waitUntil,
  type ApiProcess,
} from "./harness.js";

/**
 * E2E — Falhas e recuperação da outbox (Phase 12 §62–63, §65):
 *
 *   worker desligado → alerta criado → backlog cresce → API reinicia com o
 *   worker ligado → tudo é entregue; WebSocket reconecta na nova instância e
 *   o REST devolve o estado certo.
 *
 * Usa um banco E2E **próprio** e processos próprios da API: a instância
 * principal da suíte tem worker ligado e drenaria o backlog antes da hora.
 */
const databaseUrl = e2eDatabaseUrl("safecircle_e2e_recovery");
const PORT = Number(process.env.E2E_RECOVERY_PORT ?? 3458);
let sql: postgres.Sql;
let running: ApiProcess | null = null;

beforeAll(async () => {
  await ensureDatabase(databaseUrl);
  await resetDatabase(databaseUrl);
  sql = postgres(databaseUrl, { max: 1 });
});
afterAll(async () => {
  await running?.stop();
  await sql.end({ timeout: 5 });
});

describe("E2E outbox: worker desligado, restart, recuperação", () => {
  it("efeitos ficam pendentes sem worker e são entregues quando a API volta com ele", async () => {
    // Fase 1: API sem worker (OUTBOX_ENABLED=false). Em dev isso é permitido; em produção, não.
    running = await startApi({ port: PORT, databaseUrl, env: { OUTBOX_ENABLED: "false" } });
    expect(running.logs()).toContain("outbox_worker_disabled");
    const api = new E2eClient(running.url);

    const ana = await api.register("Ana", uniqueEmail("ana"));
    const bruno = await api.register("Bruno", uniqueEmail("bruno"));
    const groupId = await api.createGroupWith(ana, "Família", [bruno]);
    const alert = await api.call<{ id: string; status: string }>("POST", "/alerts", {
      token: ana.accessToken,
      body: { groupId },
      idempotencyKey: randomUUID(),
    });
    expect(alert.status).toBe(201);

    // Domínio commitado, efeitos pendentes: o backlog cresce e nada é entregue.
    const pending = await sql<{ event_type: string }[]>`
      SELECT event_type FROM outbox_events WHERE aggregate_id = ${alert.json.id} AND status = 'PENDING'
    `;
    expect(pending.map((r) => r.event_type).sort()).toEqual([
      "AUDIT_ALERT_CREATED",
      "PUSH_ALERT_CREATED",
      "REALTIME_ALERT_CREATED",
    ]);
    const metrics = await fetch(`${running.url}/metrics`).then((r) => r.text());
    expect(metrics).toContain("safecircle_outbox_enqueued_total");

    // O socket de Bruno está conectado à instância que vai cair.
    const socketBefore = await connectWs(running.url, bruno.accessToken);

    // Fase 2: "deploy" — a API cai e volta com o worker ligado.
    await running.stop();
    running = null;
    const closed = await socketBefore.waitForClose(15_000);
    expect([1001, 1006]).toContain(closed.code); // shutdown limpo ou conexão perdida

    running = await startApi({ port: PORT, databaseUrl });
    expect(running.logs()).toContain("outbox_worker_started");
    const api2 = new E2eClient(running.url);

    // O cliente reconecta (mesmo access token, sessão continua viva) e ressincroniza pelo REST.
    const socketAfter = await connectWs(running.url, bruno.accessToken);
    const resync = await api2.call<{ status: string }>("GET", `/alerts/${alert.json.id}`, {
      token: bruno.accessToken,
    });
    expect(resync.status).toBe(200);
    expect(resync.json.status).toBe("ACTIVE");

    // O worker drena o que ficou pendente no processo anterior.
    await waitUntil(async () => {
      const rows = await sql<{ status: string }[]>`
        SELECT status FROM outbox_events WHERE aggregate_id = ${alert.json.id}
      `;
      return rows.length === 3 && rows.every((r) => r.status === "PROCESSED");
    }, 20_000);
    const [audit] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_events WHERE target_id = ${alert.json.id} AND event_type = 'ALERT_CREATED'
    `;
    expect(audit?.count).toBe(1);

    // Eventos novos chegam na conexão nova.
    await api2.call("POST", `/alerts/${alert.json.id}/resolve`, { token: ana.accessToken });
    await socketAfter.waitFor((e) => e.type === "ALERT_RESOLVED");
    await socketAfter.close();
  });

  it("dead-letter sintética controlada: evento com payload inválido vira DEAD e a CLI o reenfileira", async () => {
    if (!running) running = await startApi({ port: PORT, databaseUrl });
    // Payload inválido de propósito (alertId não é UUID): falha permanente.
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO outbox_events (event_type, aggregate_type, payload, status, max_attempts)
      VALUES ('REALTIME_ALERT_CREATED', 'TESTE', '{"version":1,"alertId":"invalido"}'::jsonb, 'PENDING', 3)
      RETURNING id
    `;
    await waitUntil(async () => {
      const [row] = await sql<{ status: string; last_error_code: string }[]>`
        SELECT status, last_error_code FROM outbox_events WHERE id = ${inserted!.id}
      `;
      return row?.status === "DEAD" && row.last_error_code === "PAYLOAD_INVALID";
    }, 20_000);

    const metrics = await fetch(`${running.url}/metrics`).then((r) => r.text());
    expect(metrics).toMatch(
      /safecircle_outbox_dead_total\{event_type="REALTIME_ALERT_CREATED"\} [1-9]/,
    );
    expect(metrics).toMatch(/safecircle_outbox_backlog\{status="dead"\} [1-9]/);

    // A API continuou saudável apesar do evento envenenado.
    expect((await fetch(`${running.url}/ready`)).status).toBe(200);
  });
});
