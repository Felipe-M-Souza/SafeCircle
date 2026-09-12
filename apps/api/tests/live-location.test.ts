import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { SYNTHETIC_LOCATION, createAlert } from "./helpers/alerts.js";
import {
  connectRealtime,
  startRealtimeServer,
  type RealtimeTestClient,
} from "./helpers/realtime.js";
import type { RealtimeEvent } from "../src/infrastructure/realtime/events.js";

const cleaner = createCleaner();
let app: FastifyInstance;
let wsUrl: string;
const openClients: RealtimeTestClient[] = [];

/** Coordenadas SINTÉTICAS (nunca localização real). */
function syntheticPoint(offset = 0, overrides: Record<string, unknown> = {}) {
  return {
    clientUpdateId: randomUUID(),
    latitude: -23 + offset * 0.001,
    longitude: -46 + offset * 0.001,
    accuracy: 12.4,
    altitude: null,
    heading: null,
    speed: null,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function start(user: TestUser, alertId: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/alerts/${alertId}/live-location/start`,
    headers: authHeaders(user),
  });
}
function send(
  user: TestUser,
  alertId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/alerts/${alertId}/live-location`,
    headers: authHeaders(user),
    payload,
  });
}
function stop(user: TestUser, alertId: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/alerts/${alertId}/live-location/stop`,
    headers: authHeaders(user),
  });
}
function state(user: TestUser, alertId: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url: `/alerts/${alertId}/live-location`,
    headers: authHeaders(user),
  });
}
function history(user: TestUser, alertId: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "GET",
    url: `/alerts/${alertId}/live-location/history`,
    headers: authHeaders(user),
  });
}

async function countPoints(alertId: string): Promise<number> {
  const [row] = await cleaner.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM alert_location_updates WHERE alert_id = ${alertId}
  `;
  return row?.count ?? 0;
}
async function sessionStatuses(alertId: string): Promise<string[]> {
  const rows = await cleaner.sql<{ status: string }[]>`
    SELECT status FROM alert_location_sessions WHERE alert_id = ${alertId} ORDER BY created_at
  `;
  return rows.map((row) => row.status);
}
/** Recua o created_at do último ponto para liberar o throttling sem sleep. */
async function ageLatestPoint(alertId: string): Promise<void> {
  await cleaner.sql`
    UPDATE alert_location_updates SET created_at = created_at - interval '5 seconds'
    WHERE alert_id = ${alertId}
  `;
}

beforeAll(async () => {
  app = await createTestApp();
  wsUrl = await startRealtimeServer(app);
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  openClients.length = 0;
  await cleaner.truncate();
});

describe("Localização ao vivo", () => {
  let creator: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let groupId: string;
  let alertId: string;

  beforeEach(async () => {
    creator = await registerUser(app, { name: "Felipe" });
    member = await registerUser(app, { name: "Maria" });
    outsider = await registerUser(app);
    groupId = await createGroup(app, creator, "Família");
    await addMember(app, creator, groupId, member);
    await createGroup(app, outsider, "Outro");
    alertId = (await createAlert(app, creator, groupId, SYNTHETIC_LOCATION)).id;
  });

  describe("start", () => {
    it("criador inicia (201); retry é idempotente (200) e há uma única sessão ACTIVE", async () => {
      const first = await start(creator, alertId);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ status: "ACTIVE", stoppedAt: null });
      expect(typeof first.json().sessionId).toBe("string");

      const retry = await start(creator, alertId);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().sessionId).toBe(first.json().sessionId);
      expect(await sessionStatuses(alertId)).toEqual(["ACTIVE"]);
    });

    it("membro não inicia (403), externo recebe 404 e alerta encerrado não inicia (409)", async () => {
      const asMember = await start(member, alertId);
      expect(asMember.statusCode).toBe(403);
      expect(asMember.json().code).toBe("FORBIDDEN");

      const asOutsider = await start(outsider, alertId);
      expect(asOutsider.statusCode).toBe(404);
      expect(asOutsider.json().code).toBe("ALERT_NOT_FOUND");

      await app.inject({
        method: "POST",
        url: `/alerts/${alertId}/resolve`,
        headers: authHeaders(creator),
      });
      const closed = await start(creator, alertId);
      expect(closed.statusCode).toBe(409);
      expect(closed.json().code).toBe("ALERT_NOT_ACTIVE");
      expect(await sessionStatuses(alertId)).toEqual([]);
    });

    it("dois starts simultâneos resultam em uma sessão ACTIVE", async () => {
      const responses = await Promise.all(Array.from({ length: 4 }, () => start(creator, alertId)));
      for (const res of responses) {
        expect([200, 201]).toContain(res.statusCode);
      }
      const ids = new Set(responses.map((res) => res.json().sessionId));
      expect(ids.size).toBe(1);
      expect(await sessionStatuses(alertId)).toEqual(["ACTIVE"]);

      // O índice único parcial protege também no banco.
      await expect(
        cleaner.sql`
          INSERT INTO alert_location_sessions (alert_id, user_id, status)
          VALUES (${alertId}, ${creator.userId}, 'ACTIVE')
        `,
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("update", () => {
    beforeEach(async () => {
      await start(creator, alertId);
    });

    it("criador envia ponto válido (201) com campos opcionais nulos", async () => {
      const point = syntheticPoint();
      const res = await send(creator, alertId, point);
      expect(res.statusCode).toBe(201);
      expect(res.json().point).toMatchObject({
        latitude: point.latitude,
        longitude: point.longitude,
        accuracy: 12.4,
        altitude: null,
        heading: null,
        speed: null,
        capturedAt: point.capturedAt,
      });
      expect(typeof res.json().point.receivedAt).toBe("string");
      expect(await countPoints(alertId)).toBe(1);
    });

    it("membro e externo não enviam; sem sessão ativa e alerta encerrado falham", async () => {
      expect((await send(member, alertId, syntheticPoint())).statusCode).toBe(403);
      expect((await send(outsider, alertId, syntheticPoint())).statusCode).toBe(404);

      await stop(creator, alertId);
      const noSession = await send(creator, alertId, syntheticPoint());
      expect(noSession.statusCode).toBe(409);
      expect(noSession.json().code).toBe("LIVE_LOCATION_NOT_ACTIVE");

      await app.inject({
        method: "POST",
        url: `/alerts/${alertId}/cancel`,
        headers: authHeaders(creator),
      });
      const closed = await send(creator, alertId, syntheticPoint());
      expect(closed.statusCode).toBe(409);
      expect(closed.json().code).toBe("ALERT_NOT_ACTIVE");
      expect(await countPoints(alertId)).toBe(0);
    });

    it("rejeita coordenadas, precisão, direção, velocidade, id e timestamps inválidos (400)", async () => {
      const invalid = [
        { latitude: 91 },
        { latitude: -91 },
        { longitude: 181 },
        { latitude: "abc" },
        { latitude: Number.NaN },
        { accuracy: -1 },
        { heading: 361 },
        { speed: -3 },
        { clientUpdateId: "nao-uuid" },
        { capturedAt: "ontem" },
        { capturedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() },
        { capturedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() },
      ];
      for (const override of invalid) {
        const res = await send(creator, alertId, syntheticPoint(0, override));
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe("VALIDATION_ERROR");
        // Nenhuma coordenada ecoada na resposta de erro.
        expect(res.payload).not.toContain("-23");
      }
      expect(await countPoints(alertId)).toBe(0);
    });

    it("retry com o mesmo clientUpdateId não duplica (200 + Idempotent-Replayed)", async () => {
      const point = syntheticPoint();
      const first = await send(creator, alertId, point);
      const retry = await send(creator, alertId, point);
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(retry.json().point.receivedAt).toBe(first.json().point.receivedAt);
      expect(await countPoints(alertId)).toBe(1);

      // Retries concorrentes do mesmo ponto: uma linha.
      const another = syntheticPoint(1);
      await ageLatestPoint(alertId);
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => send(creator, alertId, another)),
      );
      expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
      expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(4);
      expect(await countPoints(alertId)).toBe(2);
    });

    it("frequência excessiva é limitada (429) sem afetar o alerta", async () => {
      expect((await send(creator, alertId, syntheticPoint())).statusCode).toBe(201);
      const tooFast = await send(creator, alertId, syntheticPoint(1));
      expect(tooFast.statusCode).toBe(429);
      expect(tooFast.json().code).toBe("LOCATION_UPDATE_TOO_FREQUENT");
      expect(await countPoints(alertId)).toBe(1);

      await ageLatestPoint(alertId);
      expect((await send(creator, alertId, syntheticPoint(2))).statusCode).toBe(201);

      const alert = await app.inject({
        method: "GET",
        url: `/alerts/${alertId}`,
        headers: authHeaders(creator),
      });
      expect(alert.json().status).toBe("ACTIVE");
    });
  });

  describe("leitura", () => {
    it("sem sessão retorna INACTIVE; criador e membro leem; externo 404; ex-membro não lê", async () => {
      const inactive = await state(member, alertId);
      expect(inactive.statusCode).toBe(200);
      expect(inactive.json()).toEqual({
        status: "INACTIVE",
        sessionId: null,
        startedAt: null,
        stoppedAt: null,
        latest: null,
      });

      await start(creator, alertId);
      const point = syntheticPoint();
      await send(creator, alertId, point);

      for (const user of [creator, member]) {
        const res = await state(user, alertId);
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe("ACTIVE");
        expect(res.json().latest).toMatchObject({
          latitude: point.latitude,
          longitude: point.longitude,
          accuracy: 12.4,
        });
      }

      const asOutsider = await state(outsider, alertId);
      expect(asOutsider.statusCode).toBe(404);
      expect(asOutsider.json().code).toBe("ALERT_NOT_FOUND");
      expect(asOutsider.payload).not.toContain("latitude");
      expect((await history(outsider, alertId)).statusCode).toBe(404);

      await app.inject({
        method: "DELETE",
        url: `/groups/${groupId}/members/me`,
        headers: authHeaders(member),
      });
      expect((await state(member, alertId)).statusCode).toBe(404);
      expect((await history(member, alertId)).statusCode).toBe(404);
    });

    it("history é limitado à janela recente e ordenado cronologicamente", async () => {
      await start(creator, alertId);
      for (let i = 0; i < 3; i += 1) {
        expect((await send(creator, alertId, syntheticPoint(i))).statusCode).toBe(201);
        await ageLatestPoint(alertId);
      }
      // Um ponto antigo (fora da janela de 15 min) não aparece.
      await cleaner.sql`
        UPDATE alert_location_updates SET created_at = now() - interval '40 minutes'
        WHERE alert_id = ${alertId} AND latitude = -23
      `;

      const res = await history(member, alertId);
      expect(res.statusCode).toBe(200);
      const points = res.json().points as Array<{ latitude: number; receivedAt: string }>;
      expect(points).toHaveLength(2);
      expect(points.map((p) => p.latitude)).toEqual([-23 + 0.001, -23 + 0.002]);
      for (let i = 1; i < points.length; i += 1) {
        expect(new Date(points[i]!.receivedAt).getTime()).toBeGreaterThanOrEqual(
          new Date(points[i - 1]!.receivedAt).getTime(),
        );
      }
    });

    it("history sem sessão retorna vazio", async () => {
      const res = await history(creator, alertId);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sessionId: null, points: [] });
    });
  });

  describe("stop", () => {
    it("criador para (STOPPED), retry é idempotente, membro não para e update posterior é rejeitado", async () => {
      const started = await start(creator, alertId);
      const first = await stop(creator, alertId);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        status: "STOPPED",
        sessionId: started.json().sessionId,
      });
      expect(typeof first.json().stoppedAt).toBe("string");

      const retry = await stop(creator, alertId);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().stoppedAt).toBe(first.json().stoppedAt);

      const asMember = await stop(member, alertId);
      expect(asMember.statusCode).toBe(403);

      const after = await send(creator, alertId, syntheticPoint());
      expect(after.statusCode).toBe(409);
      expect(after.json().code).toBe("LIVE_LOCATION_NOT_ACTIVE");
    });

    it("stop concorrente é seguro e stop sem sessão devolve INACTIVE", async () => {
      expect((await stop(creator, alertId)).json().status).toBe("INACTIVE");
      await start(creator, alertId);
      const responses = await Promise.all(Array.from({ length: 4 }, () => stop(creator, alertId)));
      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe("STOPPED");
      }
      expect(await sessionStatuses(alertId)).toEqual(["STOPPED"]);
    });
  });

  describe("encerramento automático do alerta", () => {
    it("resolve para a sessão ACTIVE na mesma transação", async () => {
      await start(creator, alertId);
      const res = await app.inject({
        method: "POST",
        url: `/alerts/${alertId}/resolve`,
        headers: authHeaders(creator),
      });
      expect(res.statusCode).toBe(200);
      expect(await sessionStatuses(alertId)).toEqual(["STOPPED"]);
      expect((await state(member, alertId)).json().status).toBe("STOPPED");
    });

    it("cancel para a sessão ACTIVE", async () => {
      await start(creator, alertId);
      await app.inject({
        method: "POST",
        url: `/alerts/${alertId}/cancel`,
        headers: authHeaders(creator),
      });
      expect(await sessionStatuses(alertId)).toEqual(["STOPPED"]);
    });
  });

  describe("realtime", () => {
    const isType = (type: RealtimeEvent["type"]) => (event: RealtimeEvent) => event.type === type;

    it("start/update/stop publicam eventos sem coordenadas; externo não recebe", async () => {
      const memberClient = await connectRealtime(wsUrl, member.accessToken);
      const outsiderClient = await connectRealtime(wsUrl, outsider.accessToken);
      openClients.push(memberClient, outsiderClient);

      const started = await start(creator, alertId);
      const sessionId = started.json().sessionId as string;
      const startedEvent = await memberClient.waitForEvent(isType("ALERT_LIVE_LOCATION_STARTED"));
      expect(startedEvent.data).toEqual({ alertId, groupId, sessionId });

      const point = syntheticPoint();
      await send(creator, alertId, point);
      const updatedEvent = await memberClient.waitForEvent(isType("ALERT_LIVE_LOCATION_UPDATED"));
      expect(updatedEvent.data).toEqual({ alertId, groupId, sessionId });

      // Retry idempotente não publica segundo evento.
      await send(creator, alertId, point);
      await app.background.flush();
      expect(memberClient.events.filter(isType("ALERT_LIVE_LOCATION_UPDATED"))).toHaveLength(1);

      await stop(creator, alertId);
      const stoppedEvent = await memberClient.waitForEvent(isType("ALERT_LIVE_LOCATION_STOPPED"));
      expect(stoppedEvent.data).toEqual({ alertId, groupId, sessionId });

      const raw = JSON.stringify(memberClient.events);
      for (const forbidden of ["latitude", "longitude", "accuracy", "Felipe"]) {
        expect(raw).not.toContain(forbidden);
      }
      // Coordenadas sintéticas (-23/-46) como valores; UUIDs podem conter "-23"/"-46" como substring.
      expect(raw).not.toMatch(/-23\b/);
      expect(raw).not.toMatch(/-46\b/);
      await outsiderClient.expectNoEvent(() => true);
      expect(outsiderClient.events).toHaveLength(0);
    });

    it("resolve com sessão ativa publica ALERT_LIVE_LOCATION_STOPPED", async () => {
      const client = await connectRealtime(wsUrl, member.accessToken);
      openClients.push(client);
      await start(creator, alertId);
      await app.inject({
        method: "POST",
        url: `/alerts/${alertId}/resolve`,
        headers: authHeaders(creator),
      });
      await client.waitForEvent(isType("ALERT_RESOLVED"));
      await client.waitForEvent(isType("ALERT_LIVE_LOCATION_STOPPED"));
    });

    it("falha do publisher não desfaz a persistência do ponto", async () => {
      await start(creator, alertId);
      const original = app.realtimeHub.send.bind(app.realtimeHub);
      app.realtimeHub.send = () => {
        throw new Error("hub indisponível");
      };
      try {
        const res = await send(creator, alertId, syntheticPoint());
        expect(res.statusCode).toBe(201);
        await app.background.flush();
        expect(await countPoints(alertId)).toBe(1);
      } finally {
        app.realtimeHub.send = original;
      }
    });
  });

  describe("privacidade", () => {
    it("respostas não contêm e-mail, tokens, hashes nem localização de outro alerta", async () => {
      await start(creator, alertId);
      await send(creator, alertId, syntheticPoint());

      // Outro grupo/alerta com localização distinta.
      const otherGroup = await createGroup(app, outsider, "Grupo B");
      const otherAlert = await createAlert(app, outsider, otherGroup, {
        latitude: 10,
        longitude: 20,
      });
      await start(outsider, otherAlert.id);
      await send(outsider, otherAlert.id, syntheticPoint(0, { latitude: 10.5, longitude: 20.5 }));

      for (const res of [await state(member, alertId), await history(member, alertId)]) {
        expect(res.statusCode).toBe(200);
        for (const forbidden of [
          "email",
          "password",
          "refreshToken",
          "accessToken",
          "PushToken",
          creator.email,
          "10.5",
          "20.5",
        ]) {
          expect(res.payload).not.toContain(forbidden);
        }
      }
    });
  });
});
