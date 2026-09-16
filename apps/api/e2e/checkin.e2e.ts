import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { E2eClient, connectWs, uniqueEmail, waitUntil } from "./harness.js";

/**
 * E2E — Check-in (Phase 12 §30): A cria → B vê → A confirma SAFE → B vê SAFE;
 * e o vencimento acelerado: A cria → prazo "vence" no banco → scheduler real
 * (1 s no ambiente E2E) marca OVERDUE → B recebe realtime e push (noop) →
 * A confirma depois. Ninguém espera 15 minutos aqui.
 */
const api = new E2eClient(inject("apiUrl"));
const sql = postgres(inject("databaseUrl"), { max: 1 });

const dueIn = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe("E2E check-in", () => {
  it("cria, o grupo vê, confirma SAFE, o grupo vê SAFE", async () => {
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const bruno = await api.register("Bruno", uniqueEmail("bruno"));
    const groupId = await api.createGroupWith(ana, "Família", [bruno]);
    const socketBruno = await connectWs(api.baseUrl, bruno.accessToken);

    const created = await api.call<{ id: string; status: string }>("POST", "/checkins", {
      token: ana.accessToken,
      body: { groupId, dueAt: dueIn(30) },
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe(201);
    const checkinId = created.json.id;
    await socketBruno.waitFor((e) => e.type === "CHECKIN_CREATED");

    const seen = await api.call<{ status: string; user: { id: string } }>(
      "GET",
      `/checkins/${checkinId}`,
      { token: bruno.accessToken },
    );
    expect(seen.json.status).toBe("ACTIVE");
    expect(seen.json.user.id).toBe(ana.id);

    // Bruno não confirma o check-in da Ana (autoria), só lê.
    const forbidden = await api.call<{ code: string }>("POST", `/checkins/${checkinId}/safe`, {
      token: bruno.accessToken,
    });
    expect(forbidden.status).toBe(403);

    const safe = await api.call<{ status: string }>("POST", `/checkins/${checkinId}/safe`, {
      token: ana.accessToken,
    });
    expect(safe.json.status).toBe("SAFE");
    await socketBruno.waitFor((e) => e.type === "CHECKIN_SAFE");
    const list = await api.call<Array<{ id: string; status: string }>>(
      "GET",
      `/groups/${groupId}/checkins`,
      { token: bruno.accessToken },
    );
    expect(list.json.find((c) => c.id === checkinId)?.status).toBe("SAFE");
    await socketBruno.close();
  });

  it("vencimento acelerado: o scheduler real marca OVERDUE, o grupo é avisado, A confirma depois", async () => {
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const bruno = await api.register("Bruno", uniqueEmail("bruno"));
    const groupId = await api.createGroupWith(ana, "Família", [bruno]);
    await api.call("POST", "/me/push-devices", {
      token: bruno.accessToken,
      body: {
        token: `ExponentPushToken[e2e${randomUUID().replace(/-/g, "")}]`,
        platform: "IOS",
        deviceId: randomUUID(),
      },
    });
    const socketBruno = await connectWs(api.baseUrl, bruno.accessToken);

    const created = await api.call<{ id: string }>("POST", "/checkins", {
      token: ana.accessToken,
      body: { groupId, dueAt: dueIn(10) },
      idempotencyKey: randomUUID(),
    });
    const checkinId = created.json.id;

    // Relógio do servidor é a autoridade: o prazo "vence" no banco, não no cliente.
    await sql`UPDATE safety_checkins SET due_at = now() - interval '1 minute' WHERE id = ${checkinId}`;

    await socketBruno.waitFor((e) => e.type === "CHECKIN_OVERDUE", 20_000);
    const overdue = await api.call<{ status: string; overdueAt: string | null }>(
      "GET",
      `/checkins/${checkinId}`,
      { token: bruno.accessToken },
    );
    expect(overdue.json.status).toBe("OVERDUE");
    expect(overdue.json.overdueAt).not.toBeNull();

    // O push do vencimento saiu pela outbox (provedor noop marca como enviado).
    await waitUntil(async () => {
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM outbox_events
         WHERE aggregate_id = ${checkinId} AND event_type = 'PUSH_CHECKIN_OVERDUE'
      `;
      return row?.status === "PROCESSED";
    }, 20_000);

    // Confirmar depois de vencido continua possível.
    const safe = await api.call<{ status: string }>("POST", `/checkins/${checkinId}/safe`, {
      token: ana.accessToken,
    });
    expect(safe.status).toBe(200);
    expect(safe.json.status).toBe("SAFE");
    await socketBruno.waitFor((e) => e.type === "CHECKIN_SAFE");
    await socketBruno.close();
  });

  it("retry idempotente do POST não cria segundo check-in", async () => {
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const groupId = await api.createGroupWith(ana, "Só eu");
    const key = randomUUID();
    const dueAt = dueIn(20);
    const first = await api.call<{ id: string }>("POST", "/checkins", {
      token: ana.accessToken,
      body: { groupId, dueAt },
      idempotencyKey: key,
    });
    const retry = await api.call<{ id: string }>("POST", "/checkins", {
      token: ana.accessToken,
      body: { groupId, dueAt },
      idempotencyKey: key,
    });
    expect(retry.json.id).toBe(first.json.id);
    const mine = await api.call<Array<{ id: string }>>("GET", "/checkins", {
      token: ana.accessToken,
    });
    expect(mine.json.filter((c) => c.id === first.json.id)).toHaveLength(1);
    await api.call("POST", `/checkins/${first.json.id}/cancel`, { token: ana.accessToken });
  });
});
