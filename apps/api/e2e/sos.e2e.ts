import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import { E2eClient, SYNTHETIC_POINT, connectWs, uniqueEmail, waitUntil } from "./harness.js";

/**
 * E2E — SOS ponta a ponta (Phase 12 §27–28):
 * A aciona → alerta persistido → outbox → push (noop) e realtime → B vê →
 * B confirma → A vê a confirmação → A resolve → ambos veem RESOLVED.
 * Retry idempotente do POST não duplica alerta nem eventos.
 */
const api = new E2eClient(inject("apiUrl"));
const sql = postgres(inject("databaseUrl"), { max: 1 });

describe("E2E SOS", () => {
  it("cancelar alerta como o app faz: POST com Content-Type JSON e sem corpo", async () => {
    // Achado em aparelho (2026-09-16): o fetch nativo manda o header em todo POST.
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const groupId = await api.createGroupWith(ana, "Família", []);
    const created = await api.call<{ id: string }>("POST", "/alerts", {
      token: ana.accessToken,
      body: { groupId, location: SYNTHETIC_POINT },
      idempotencyKey: randomUUID(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);

    const start = await fetch(`${api.baseUrl}/alerts/${created.json.id}/live-location/start`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ana.accessToken}` },
    });
    expect(start.status).toBe(201);

    const cancel = await fetch(`${api.baseUrl}/alerts/${created.json.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ana.accessToken}` },
    });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as { status: string }).status).toBe("CANCELLED");
  });

  it("fluxo completo entre dois aparelhos, com entrega pela outbox", async () => {
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const bruno = await api.register("Bruno", uniqueEmail("bruno"));
    const groupId = await api.createGroupWith(ana, "Família", [bruno]);
    // Bruno tem um "aparelho" registrado: o push sai pelo provedor noop.
    await api.call("POST", "/me/push-devices", {
      token: bruno.accessToken,
      body: {
        token: `ExponentPushToken[e2e${randomUUID().replace(/-/g, "")}]`,
        platform: "ANDROID",
        deviceId: randomUUID(),
      },
    });
    const socketAna = await connectWs(api.baseUrl, ana.accessToken);
    const socketBruno = await connectWs(api.baseUrl, bruno.accessToken);

    // A aciona o SOS (com localização sintética).
    const key = randomUUID();
    const created = await api.call<{ id: string; status: string }>("POST", "/alerts", {
      token: ana.accessToken,
      body: { groupId, location: SYNTHETIC_POINT },
      idempotencyKey: key,
    });
    expect(created.status).toBe(201);
    const alertId = created.json.id;

    // Retry (resposta perdida): mesmo alerta, sem duplicar.
    const retry = await api.call<{ id: string }>("POST", "/alerts", {
      token: ana.accessToken,
      body: { groupId, location: SYNTHETIC_POINT },
      idempotencyKey: key,
    });
    expect(retry.status).toBe(201);
    expect(retry.json.id).toBe(alertId);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");

    // B vê pelo realtime (envelope só com ids) e pelo REST (com localização).
    const event = await socketBruno.waitFor(
      (e) => e.type === "ALERT_CREATED" && (e.data as { alertId: string }).alertId === alertId,
    );
    expect(JSON.stringify(event)).not.toContain(String(SYNTHETIC_POINT.latitude));
    const seenByBruno = await api.call<{ status: string; location: { latitude: number } }>(
      "GET",
      `/alerts/${alertId}`,
      { token: bruno.accessToken },
    );
    expect(seenByBruno.status).toBe(200);
    expect(seenByBruno.json.status).toBe("ACTIVE");
    expect(seenByBruno.json.location.latitude).toBe(SYNTHETIC_POINT.latitude);

    // Outbox entregou: push (noop) + realtime + auditoria processados, um de cada.
    await waitUntil(async () => {
      const rows = await sql<{ event_type: string; status: string }[]>`
        SELECT event_type, status FROM outbox_events WHERE aggregate_id = ${alertId}
      `;
      return (
        rows.length === 3 &&
        rows.every((r) => r.status === "PROCESSED") &&
        rows
          .map((r) => r.event_type)
          .sort()
          .join(",") === "AUDIT_ALERT_CREATED,PUSH_ALERT_CREATED,REALTIME_ALERT_CREATED"
      );
    });

    // B confirma; A vê a confirmação.
    const ack = await api.call("PUT", `/alerts/${alertId}/acknowledgement`, {
      token: bruno.accessToken,
      body: { type: "GOING_TO_HELP" },
    });
    expect(ack.status).toBe(200);
    await socketAna.waitFor((e) => e.type === "ALERT_ACKNOWLEDGEMENT_CHANGED");
    const acks = await api.call<Array<{ user: { id: string }; type: string }>>(
      "GET",
      `/alerts/${alertId}/acknowledgements`,
      { token: ana.accessToken },
    );
    expect(acks.json).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: bruno.id }),
        type: "GOING_TO_HELP",
      }),
    ]);

    // A resolve; ambos veem RESOLVED.
    const resolved = await api.call<{ status: string }>("POST", `/alerts/${alertId}/resolve`, {
      token: ana.accessToken,
    });
    expect(resolved.json.status).toBe("RESOLVED");
    await socketBruno.waitFor((e) => e.type === "ALERT_RESOLVED");
    await socketAna.waitFor((e) => e.type === "ALERT_RESOLVED");
    for (const user of [ana, bruno]) {
      const view = await api.call<{ status: string }>("GET", `/alerts/${alertId}`, {
        token: user.accessToken,
      });
      expect(view.json.status).toBe("RESOLVED");
    }

    // Nenhum evento realtime carregou coordenada.
    for (const socket of [socketAna, socketBruno]) {
      expect(JSON.stringify(socket.events)).not.toMatch(/latitude|longitude/);
      await socket.close();
    }
  });

  it("externo não vê nem encerra o alerta", async () => {
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const externo = await api.register("Externo", uniqueEmail("externo"));
    const groupId = await api.createGroupWith(ana, "Privado");
    const alert = await api.call<{ id: string }>("POST", "/alerts", {
      token: ana.accessToken,
      body: { groupId },
      idempotencyKey: randomUUID(),
    });
    const read = await api.call<{ code: string }>("GET", `/alerts/${alert.json.id}`, {
      token: externo.accessToken,
    });
    expect(read.status).toBe(404);
    expect(read.json.code).toBe("ALERT_NOT_FOUND");
    const resolve = await api.call("POST", `/alerts/${alert.json.id}/resolve`, {
      token: externo.accessToken,
    });
    expect(resolve.status).toBe(404);
    const still = await api.call<{ status: string }>("GET", `/alerts/${alert.json.id}`, {
      token: ana.accessToken,
    });
    expect(still.json.status).toBe("ACTIVE");
    await api.call("POST", `/alerts/${alert.json.id}/resolve`, { token: ana.accessToken });
  });
});
