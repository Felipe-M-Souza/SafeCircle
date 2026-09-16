import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { E2eClient, SYNTHETIC_POINT, connectWs, uniqueEmail, waitUntil } from "./harness.js";

/**
 * E2E — Trajeto (Phase 12 §29, §31): A inicia → B vê → localização ao vivo
 * opt-in (A envia ponto, B recebe atualização sem coordenada no realtime e
 * lê a posição pelo REST) → A confirma ARRIVED → B vê ARRIVED; e o atraso
 * acelerado pelo scheduler real.
 */
const api = new E2eClient(inject("apiUrl"));
const sql = postgres(inject("databaseUrl"), { max: 1 });

const arriveIn = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe("E2E trajeto", () => {
  it("inicia, compartilha localização, o grupo acompanha, chega em segurança", async () => {
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const bruno = await api.register("Bruno", uniqueEmail("bruno"));
    const groupId = await api.createGroupWith(ana, "Família", [bruno]);
    const socketBruno = await connectWs(api.baseUrl, bruno.accessToken);

    const created = await api.call<{ id: string; status: string }>("POST", "/journeys", {
      token: ana.accessToken,
      body: {
        groupId,
        destinationLabel: "Destino sintético",
        expectedArrivalAt: arriveIn(30),
        liveLocationEnabled: true,
      },
      idempotencyKey: randomUUID(),
    });
    expect(created.status).toBe(201);
    const journeyId = created.json.id;
    await socketBruno.waitFor((e) => e.type === "JOURNEY_CREATED");

    // A ativa a localização ao vivo e envia um ponto.
    const start = await api.call("POST", `/journeys/${journeyId}/live-location/start`, {
      token: ana.accessToken,
    });
    expect(start.status).toBe(201);
    const point = await api.call("POST", `/journeys/${journeyId}/live-location`, {
      token: ana.accessToken,
      body: {
        clientUpdateId: randomUUID(),
        ...SYNTHETIC_POINT,
        capturedAt: new Date().toISOString(),
      },
    });
    expect(point.status).toBe(201);

    // B recebe a atualização (só ids) e lê a posição pelo REST.
    const update = await socketBruno.waitFor((e) => e.type === "JOURNEY_LOCATION_UPDATED");
    expect(JSON.stringify(update)).not.toContain(String(SYNTHETIC_POINT.latitude));
    const live = await api.call<{ status: string; latest: { latitude: number } | null }>(
      "GET",
      `/journeys/${journeyId}/live-location`,
      { token: bruno.accessToken },
    );
    expect(live.json.status).toBe("ACTIVE");
    expect(live.json.latest?.latitude).toBe(SYNTHETIC_POINT.latitude);

    // Só a dona envia ponto; Bruno recebe 403.
    const forbidden = await api.call("POST", `/journeys/${journeyId}/live-location`, {
      token: bruno.accessToken,
      body: {
        clientUpdateId: randomUUID(),
        ...SYNTHETIC_POINT,
        capturedAt: new Date().toISOString(),
      },
    });
    expect(forbidden.status).toBe(403);

    // A chega; a sessão de localização encerra junto; B vê ARRIVED.
    const arrived = await api.call<{ status: string }>("POST", `/journeys/${journeyId}/arrive`, {
      token: ana.accessToken,
    });
    expect(arrived.json.status).toBe("ARRIVED");
    await socketBruno.waitFor((e) => e.type === "JOURNEY_ARRIVED");
    const after = await api.call<{ status: string }>(
      "GET",
      `/journeys/${journeyId}/live-location`,
      { token: bruno.accessToken },
    );
    expect(after.json.status).toBe("STOPPED");
    const view = await api.call<{ status: string }>("GET", `/journeys/${journeyId}`, {
      token: bruno.accessToken,
    });
    expect(view.json.status).toBe("ARRIVED");
    expect(JSON.stringify(socketBruno.events)).not.toMatch(/latitude|longitude/);
    await socketBruno.close();
  });

  it("atraso acelerado: scheduler marca OVERDUE, grupo é avisado, push sai pela outbox", async () => {
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const bruno = await api.register("Bruno", uniqueEmail("bruno"));
    const groupId = await api.createGroupWith(ana, "Família", [bruno]);
    const socketBruno = await connectWs(api.baseUrl, bruno.accessToken);

    const created = await api.call<{ id: string }>("POST", "/journeys", {
      token: ana.accessToken,
      body: { groupId, expectedArrivalAt: arriveIn(15) },
      idempotencyKey: randomUUID(),
    });
    const journeyId = created.json.id;
    await sql`UPDATE safe_journeys SET expected_arrival_at = now() - interval '1 minute' WHERE id = ${journeyId}`;

    await socketBruno.waitFor((e) => e.type === "JOURNEY_OVERDUE", 20_000);
    const overdue = await api.call<{ status: string }>("GET", `/journeys/${journeyId}`, {
      token: bruno.accessToken,
    });
    expect(overdue.json.status).toBe("OVERDUE");
    await waitUntil(async () => {
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM outbox_events
         WHERE aggregate_id = ${journeyId} AND event_type = 'PUSH_JOURNEY_OVERDUE'
      `;
      return row?.status === "PROCESSED";
    }, 20_000);

    // Atraso não vira SOS: nenhum alerta foi criado.
    const alerts = await api.call<unknown[]>("GET", "/alerts", { token: bruno.accessToken });
    expect(alerts.json).toEqual([]);

    const arrived = await api.call<{ status: string }>("POST", `/journeys/${journeyId}/arrive`, {
      token: ana.accessToken,
    });
    expect(arrived.json.status).toBe("ARRIVED");
    await socketBruno.close();
  });
});
