import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { errorBodyWithoutRequestId } from "./helpers/errors.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import {
  ageLatestJourneyPoint,
  arriveIn,
  countJourneyPoints,
  createJourney,
  getJourney,
  journeyAction,
  postJourney,
  sendJourneyLocation,
  startJourneyLocation,
  syntheticJourneyPoint,
} from "./helpers/journeys.js";
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

async function countJourneys(): Promise<number> {
  const [row] = await cleaner.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM safe_journeys
  `;
  return row?.count ?? 0;
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

describe("Trajeto Seguro", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let groupId: string;

  beforeEach(async () => {
    owner = await registerUser(app, { name: "Felipe" });
    member = await registerUser(app, { name: "Maria" });
    outsider = await registerUser(app);
    groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, member);
    await createGroup(app, outsider, "Outro");
  });

  describe("POST /journeys", () => {
    it("membro cria trajeto ACTIVE (201) com destino, prazo e opt-in de localização", async () => {
      const expectedArrivalAt = arriveIn(30);
      const res = await postJourney(app, member, {
        groupId,
        destinationLabel: "  Casa  ",
        expectedArrivalAt,
        liveLocationEnabled: true,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        groupId,
        groupName: "Família",
        user: { id: member.userId, name: "Maria" },
        status: "ACTIVE",
        destinationLabel: "Casa",
        expectedArrivalAt,
        liveLocationEnabled: true,
        arrivedAt: null,
        cancelledAt: null,
        overdueAt: null,
      });
    });

    it("destino é opcional e liveLocationEnabled tem default false", async () => {
      const res = await postJourney(app, owner, { groupId, expectedArrivalAt: arriveIn(30) });
      expect(res.statusCode).toBe(201);
      expect(res.json().destinationLabel).toBeNull();
      expect(res.json().liveLocationEnabled).toBe(false);
    });

    it("destino excessivamente longo é rejeitado (400)", async () => {
      const res = await postJourney(app, owner, {
        groupId,
        destinationLabel: "x".repeat(200),
        expectedArrivalAt: arriveIn(30),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("VALIDATION_ERROR");
    });

    it("externo não cria (404 GROUP_NOT_FOUND); grupo inexistente idem", async () => {
      const res = await postJourney(app, outsider, { groupId, expectedArrivalAt: arriveIn(30) });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("GROUP_NOT_FOUND");
      const missing = await postJourney(app, owner, {
        groupId: "00000000-0000-4000-8000-000000000000",
        expectedArrivalAt: arriveIn(30),
      });
      expect(missing.statusCode).toBe(404);
      expect(await countJourneys()).toBe(0);
    });

    it("valida a chegada prevista: passada, cedo demais, longe demais e formato inválido", async () => {
      for (const [expectedArrivalAt, code] of [
        [arriveIn(-10), "INVALID_JOURNEY_EXPECTED_ARRIVAL"],
        [arriveIn(5), "INVALID_JOURNEY_EXPECTED_ARRIVAL"],
        [arriveIn(25 * 60), "INVALID_JOURNEY_EXPECTED_ARRIVAL"],
        ["amanhã", "VALIDATION_ERROR"],
      ] as const) {
        const res = await postJourney(app, owner, { groupId, expectedArrivalAt });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe(code);
      }
      // Limites aceitos: 10 minutos e 24 horas (com folga do relógio).
      expect(
        (await postJourney(app, owner, { groupId, expectedArrivalAt: arriveIn(10.1) })).statusCode,
      ).toBe(201);
    });

    it("um trajeto não-finalizado por usuário (409 JOURNEY_ALREADY_ACTIVE), garantido no banco", async () => {
      await createJourney(app, owner, groupId);
      const dup = await postJourney(app, owner, { groupId, expectedArrivalAt: arriveIn(30) });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().code).toBe("JOURNEY_ALREADY_ACTIVE");

      // Mesmo em outro grupo: continua sendo um por usuário.
      const other = await createGroup(app, owner, "Amigos");
      const dupOther = await postJourney(app, owner, {
        groupId: other,
        expectedArrivalAt: arriveIn(30),
      });
      expect(dupOther.statusCode).toBe(409);

      await expect(
        cleaner.sql`
          INSERT INTO safe_journeys (user_id, group_id, status, expected_arrival_at)
          VALUES (${owner.userId}, ${groupId}, 'ACTIVE', now() + interval '20 minutes')
        `,
      ).rejects.toMatchObject({ code: "23505" });

      // Outro membro pode ter o seu.
      expect(
        (await postJourney(app, member, { groupId, expectedArrivalAt: arriveIn(30) })).statusCode,
      ).toBe(201);
    });

    it("após chegar ou cancelar, um novo trajeto pode ser criado", async () => {
      const first = await createJourney(app, owner, groupId);
      await journeyAction(app, owner, first.id, "arrive");
      const second = await createJourney(app, owner, groupId);
      await journeyAction(app, owner, second.id, "cancel");
      expect(
        (await postJourney(app, owner, { groupId, expectedArrivalAt: arriveIn(30) })).statusCode,
      ).toBe(201);
    });

    it("idempotência: mesma chave devolve o mesmo trajeto; payload diferente → 409; ausente → 400", async () => {
      const key = randomUUID();
      const expectedArrivalAt = arriveIn(30);
      const first = await postJourney(app, owner, { groupId, expectedArrivalAt }, key);
      const retry = await postJourney(app, owner, { groupId, expectedArrivalAt }, key);
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.json().id).toBe(first.json().id);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(await countJourneys()).toBe(1);

      const reused = await postJourney(
        app,
        owner,
        { groupId, expectedArrivalAt: arriveIn(45) },
        key,
      );
      expect(reused.statusCode).toBe(409);
      expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");

      const missing = await postJourney(app, owner, { groupId, expectedArrivalAt }, null);
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("INVALID_IDEMPOTENCY_KEY");
    });

    it("exige autenticação (401)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/journeys",
        headers: { "idempotency-key": randomUUID() },
        payload: { groupId, expectedArrivalAt: arriveIn(30) },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("leitura", () => {
    it("dono e membro leem; externo e ex-membro recebem 404 JOURNEY_NOT_FOUND", async () => {
      const journey = await createJourney(app, owner, groupId);
      expect((await getJourney(app, owner, journey.id)).statusCode).toBe(200);
      const asMember = await getJourney(app, member, journey.id);
      expect(asMember.statusCode).toBe(200);
      expect(asMember.json().user.name).toBe("Felipe");

      const asOutsider = await getJourney(app, outsider, journey.id);
      expect(asOutsider.statusCode).toBe(404);
      expect(asOutsider.json().code).toBe("JOURNEY_NOT_FOUND");
      const missing = await getJourney(app, outsider, "00000000-0000-4000-8000-000000000000");
      expect(errorBodyWithoutRequestId(missing)).toEqual(errorBodyWithoutRequestId(asOutsider));
      expect((await getJourney(app, member, "nao-uuid")).statusCode).toBe(404);

      await app.inject({
        method: "DELETE",
        url: `/groups/${groupId}/members/me`,
        headers: authHeaders(member),
      });
      expect((await getJourney(app, member, journey.id)).statusCode).toBe(404);
    });

    it("GET /journeys lista só os meus (com filtro) e GET /groups/:id/journeys só do grupo autorizado", async () => {
      const mine = await createJourney(app, owner, groupId);
      const theirs = await createJourney(app, member, groupId);
      const otherGroup = await createGroup(app, outsider, "Grupo B");
      await createJourney(app, outsider, otherGroup);
      await journeyAction(app, owner, mine.id, "arrive");

      const all = await app.inject({
        method: "GET",
        url: "/journeys",
        headers: authHeaders(owner),
      });
      expect(all.json().map((j: { id: string }) => j.id)).toEqual([mine.id]);
      const active = await app.inject({
        method: "GET",
        url: "/journeys?status=ACTIVE",
        headers: authHeaders(owner),
      });
      expect(active.json()).toEqual([]);
      const arrived = await app.inject({
        method: "GET",
        url: "/journeys?status=ARRIVED",
        headers: authHeaders(owner),
      });
      expect(arrived.json().map((j: { id: string }) => j.id)).toEqual([mine.id]);

      const group = await app.inject({
        method: "GET",
        url: `/groups/${groupId}/journeys`,
        headers: authHeaders(member),
      });
      expect(group.statusCode).toBe(200);
      expect(
        group
          .json()
          .map((j: { id: string }) => j.id)
          .sort(),
      ).toEqual([mine.id, theirs.id].sort());

      const forbidden = await app.inject({
        method: "GET",
        url: `/groups/${groupId}/journeys`,
        headers: authHeaders(outsider),
      });
      expect(forbidden.statusCode).toBe(404);
      expect(forbidden.json().code).toBe("GROUP_NOT_FOUND");
    });

    it("respostas não contêm e-mail, hashes, tokens ou coordenadas", async () => {
      const journey = await createJourney(app, owner, groupId, { destinationLabel: "Casa" });
      for (const url of ["/journeys", `/journeys/${journey.id}`, `/groups/${groupId}/journeys`]) {
        const res = await app.inject({ method: "GET", url, headers: authHeaders(member) });
        expect(res.statusCode).toBe(200);
        for (const forbidden of [
          "email",
          "password",
          "refreshToken",
          "accessToken",
          "PushToken",
          "latitude",
          "longitude",
          owner.email,
        ]) {
          expect(res.payload).not.toContain(forbidden);
        }
      }
    });
  });

  describe("transições", () => {
    let journeyId: string;
    beforeEach(async () => {
      journeyId = (await createJourney(app, owner, groupId)).id;
    });

    it("ACTIVE -> ARRIVED preenche arrivedAt; repetir é idempotente", async () => {
      const first = await journeyAction(app, owner, journeyId, "arrive");
      expect(first.statusCode).toBe(200);
      expect(first.json().status).toBe("ARRIVED");
      expect(typeof first.json().arrivedAt).toBe("string");

      const again = await journeyAction(app, owner, journeyId, "arrive");
      expect(again.statusCode).toBe(200);
      expect(again.json().arrivedAt).toBe(first.json().arrivedAt);
    });

    it("ACTIVE -> CANCELLED preenche cancelledAt; repetir é idempotente; ARRIVED depois é inválido", async () => {
      const first = await journeyAction(app, owner, journeyId, "cancel");
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ status: "CANCELLED", arrivedAt: null });
      expect(typeof first.json().cancelledAt).toBe("string");

      const again = await journeyAction(app, owner, journeyId, "cancel");
      expect(again.json().cancelledAt).toBe(first.json().cancelledAt);

      const arrive = await journeyAction(app, owner, journeyId, "arrive");
      expect(arrive.statusCode).toBe(409);
      expect(arrive.json().code).toBe("INVALID_JOURNEY_TRANSITION");
    });

    it("ARRIVED -> CANCELLED é inválido", async () => {
      await journeyAction(app, owner, journeyId, "arrive");
      const cancel = await journeyAction(app, owner, journeyId, "cancel");
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json().code).toBe("INVALID_JOURNEY_TRANSITION");
    });

    it("OVERDUE -> ARRIVED e OVERDUE -> CANCELLED são permitidos", async () => {
      // Vence via scheduler.
      await cleaner.sql`
        UPDATE safe_journeys SET expected_arrival_at = now() - interval '1 minute' WHERE id = ${journeyId}
      `;
      expect(await app.journeyScheduler.runOnce()).toBe(1);
      await app.background.flush();
      expect((await getJourney(app, owner, journeyId)).json().status).toBe("OVERDUE");

      const arrive = await journeyAction(app, owner, journeyId, "arrive");
      expect(arrive.statusCode).toBe(200);
      expect(arrive.json().status).toBe("ARRIVED");
      expect(typeof arrive.json().overdueAt).toBe("string");
      expect(typeof arrive.json().arrivedAt).toBe("string");

      // Um segundo trajeto que vence pode ser cancelado a partir de OVERDUE.
      const second = (await createJourney(app, owner, groupId)).id;
      await cleaner.sql`
        UPDATE safe_journeys SET expected_arrival_at = now() - interval '1 minute' WHERE id = ${second}
      `;
      await app.journeyScheduler.runOnce();
      await app.background.flush();
      const cancel = await journeyAction(app, owner, second, "cancel");
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json().status).toBe("CANCELLED");
    });

    it("outro membro não altera (403); externo recebe 404", async () => {
      for (const action of ["arrive", "cancel"] as const) {
        const asMember = await journeyAction(app, member, journeyId, action);
        expect(asMember.statusCode).toBe(403);
        expect(asMember.json().code).toBe("FORBIDDEN");
        const asOutsider = await journeyAction(app, outsider, journeyId, action);
        expect(asOutsider.statusCode).toBe(404);
        expect(asOutsider.json().code).toBe("JOURNEY_NOT_FOUND");
      }
      expect((await getJourney(app, owner, journeyId)).json().status).toBe("ACTIVE");
    });
  });

  describe("realtime", () => {
    const isType = (type: RealtimeEvent["type"]) => (event: RealtimeEvent) => event.type === type;

    it("JOURNEY_CREATED/ARRIVED/CANCELLED chegam aos membros com payload mínimo; externo não recebe", async () => {
      const memberClient = await connectRealtime(wsUrl, member.accessToken);
      const outsiderClient = await connectRealtime(wsUrl, outsider.accessToken);
      openClients.push(memberClient, outsiderClient);

      const key = randomUUID();
      const created = await postJourney(
        app,
        owner,
        { groupId, expectedArrivalAt: arriveIn(30) },
        key,
      );
      const journeyId = created.json().id as string;
      const event = await memberClient.waitForEvent(isType("JOURNEY_CREATED"));
      expect(event.data).toEqual({ journeyId, groupId, userId: owner.userId });

      await postJourney(app, owner, { groupId, expectedArrivalAt: arriveIn(30) }, key);
      await app.background.flush();
      expect(memberClient.events.filter(isType("JOURNEY_CREATED"))).toHaveLength(1);

      await journeyAction(app, owner, journeyId, "arrive");
      const arrived = await memberClient.waitForEvent(isType("JOURNEY_ARRIVED"));
      expect(arrived.data).toEqual({ journeyId, groupId, userId: owner.userId });

      const second = await createJourney(app, owner, groupId);
      await journeyAction(app, owner, second.id, "cancel");
      const cancelled = await memberClient.waitForEvent(isType("JOURNEY_CANCELLED"));
      expect((cancelled.data as { journeyId: string }).journeyId).toBe(second.id);

      const raw = JSON.stringify(memberClient.events);
      for (const forbidden of ["email", "latitude", "longitude", "PushToken", "Felipe"]) {
        expect(raw).not.toContain(forbidden);
      }
      await outsiderClient.expectNoEvent(() => true);
      expect(outsiderClient.events).toHaveLength(0);
    });
  });

  describe("localização ao vivo do trajeto", () => {
    const isType = (type: RealtimeEvent["type"]) => (event: RealtimeEvent) => event.type === type;

    it("opt-in false não permite tracking (409 JOURNEY_LIVE_LOCATION_DISABLED)", async () => {
      const journey = await createJourney(app, owner, groupId, { liveLocationEnabled: false });
      const start = await startJourneyLocation(app, owner, journey.id);
      expect(start.statusCode).toBe(409);
      expect(start.json().code).toBe("JOURNEY_LIVE_LOCATION_DISABLED");
    });

    it("opt-in true: dono inicia e envia; membro/externo não enviam; duplicidade e throttling", async () => {
      const memberClient = await connectRealtime(wsUrl, member.accessToken);
      openClients.push(memberClient);
      const journey = await createJourney(app, owner, groupId, { liveLocationEnabled: true });

      // Membro não é dono → 403; externo → 404.
      expect((await startJourneyLocation(app, member, journey.id)).statusCode).toBe(403);
      expect((await startJourneyLocation(app, outsider, journey.id)).statusCode).toBe(404);

      const start = await startJourneyLocation(app, owner, journey.id);
      expect(start.statusCode).toBe(201);
      expect(start.json().status).toBe("ACTIVE");

      const point = syntheticJourneyPoint();
      const first = await sendJourneyLocation(app, owner, journey.id, point);
      expect(first.statusCode).toBe(201);
      // Membro vê apenas evento (sem coordenadas) e busca o estado via REST.
      const event = await memberClient.waitForEvent(isType("JOURNEY_LOCATION_UPDATED"));
      expect(event.data).toEqual({ journeyId: journey.id, groupId, userId: owner.userId });
      expect(JSON.stringify(memberClient.events)).not.toContain("latitude");

      // Retry com o mesmo clientUpdateId: replay, não duplica.
      const retry = await sendJourneyLocation(app, owner, journey.id, point);
      expect(retry.statusCode).toBe(200);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(await countJourneyPoints(cleaner.sql, journey.id)).toBe(1);

      // Throttling: novo ponto imediato → 429.
      const tooFast = await sendJourneyLocation(app, owner, journey.id, syntheticJourneyPoint(1));
      expect(tooFast.statusCode).toBe(429);
      expect(tooFast.json().code).toBe("LOCATION_UPDATE_TOO_FREQUENT");

      // Membro lê estado com a posição; externo recebe 404.
      const state = await app.inject({
        method: "GET",
        url: `/journeys/${journey.id}/live-location`,
        headers: authHeaders(member),
      });
      expect(state.statusCode).toBe(200);
      expect(state.json().latest.latitude).toBeCloseTo(point.latitude as number);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/journeys/${journey.id}/live-location`,
            headers: authHeaders(outsider),
          })
        ).statusCode,
      ).toBe(404);
    });

    it("chegar/cancelar encerra o tracking; OVERDUE mantém enquanto não finalizado", async () => {
      const journey = await createJourney(app, owner, groupId, { liveLocationEnabled: true });
      await startJourneyLocation(app, owner, journey.id);
      await ageLatestJourneyPoint(cleaner.sql, journey.id);

      // Vence: continua podendo enviar (OVERDUE ainda é "em andamento").
      await cleaner.sql`
        UPDATE safe_journeys SET expected_arrival_at = now() - interval '1 minute' WHERE id = ${journey.id}
      `;
      await app.journeyScheduler.runOnce();
      await app.background.flush();
      const whileOverdue = await sendJourneyLocation(
        app,
        owner,
        journey.id,
        syntheticJourneyPoint(2),
      );
      expect(whileOverdue.statusCode).toBe(201);

      // Chega: sessão encerrada; novos envios recusados.
      const arrive = await journeyAction(app, owner, journey.id, "arrive");
      expect(arrive.statusCode).toBe(200);
      const [session] = await cleaner.sql<{ status: string }[]>`
        SELECT status FROM journey_location_sessions WHERE journey_id = ${journey.id}
      `;
      expect(session?.status).toBe("STOPPED");
      await ageLatestJourneyPoint(cleaner.sql, journey.id);
      const afterArrive = await sendJourneyLocation(
        app,
        owner,
        journey.id,
        syntheticJourneyPoint(3),
      );
      expect(afterArrive.statusCode).toBe(409);
      // Trajeto finalizado: recusa antes mesmo de olhar a sessão.
      expect(afterArrive.json().code).toBe("JOURNEY_NOT_ACTIVE");
    });
  });
});
