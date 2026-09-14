import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { drainOutbox } from "./helpers/outbox.js";
import { errorBodyWithoutRequestId } from "./helpers/errors.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import {
  checkinAction,
  createCheckin,
  dueIn,
  expireCheckin,
  getCheckin,
  postCheckin,
} from "./helpers/checkins.js";
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

async function countCheckins(): Promise<number> {
  const [row] = await cleaner.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM safety_checkins
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

describe("Check-in de Segurança", () => {
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
    // Entrega os eventos do preparo antes das asserções do teste.
    await drainOutbox(app);
  });

  describe("POST /checkins", () => {
    it("membro cria check-in ACTIVE (201) com prazo válido", async () => {
      const dueAt = dueIn(30);
      const res = await postCheckin(app, member, { groupId, dueAt });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        groupId,
        groupName: "Família",
        user: { id: member.userId, name: "Maria" },
        status: "ACTIVE",
        dueAt,
        confirmedAt: null,
        cancelledAt: null,
        overdueAt: null,
      });
      expect(typeof res.json().id).toBe("string");
      expect(typeof res.json().createdAt).toBe("string");
    });

    it("externo não cria (404 GROUP_NOT_FOUND); grupo inexistente idem", async () => {
      const res = await postCheckin(app, outsider, { groupId, dueAt: dueIn(30) });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("GROUP_NOT_FOUND");
      const missing = await postCheckin(app, owner, {
        groupId: "00000000-0000-4000-8000-000000000000",
        dueAt: dueIn(30),
      });
      expect(missing.statusCode).toBe(404);
      expect(await countCheckins()).toBe(0);
    });

    it("valida o prazo: passado, cedo demais, longe demais e formato inválido", async () => {
      for (const [dueAt, code] of [
        [dueIn(-10), "INVALID_CHECKIN_DUE_AT"],
        [dueIn(2), "INVALID_CHECKIN_DUE_AT"],
        [dueIn(25 * 60), "INVALID_CHECKIN_DUE_AT"],
        ["amanhã", "VALIDATION_ERROR"],
      ] as const) {
        const res = await postCheckin(app, owner, { groupId, dueAt });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe(code);
      }
      // Limites aceitos: 5 minutos e 24 horas (com pequena folga do relógio).
      expect((await postCheckin(app, owner, { groupId, dueAt: dueIn(5.1) })).statusCode).toBe(201);
      const other = await createGroup(app, owner, "Amigos");
      expect(
        (await postCheckin(app, owner, { groupId: other, dueAt: dueIn(23 * 60 + 59) })).statusCode,
      ).toBe(201);
      expect(await countCheckins()).toBe(2);
    });

    it("um ACTIVE por usuário/grupo (409 CHECKIN_ALREADY_ACTIVE), garantido no banco", async () => {
      await createCheckin(app, owner, groupId);
      const dup = await postCheckin(app, owner, { groupId, dueAt: dueIn(30) });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().code).toBe("CHECKIN_ALREADY_ACTIVE");

      await expect(
        cleaner.sql`
          INSERT INTO safety_checkins (user_id, group_id, status, due_at)
          VALUES (${owner.userId}, ${groupId}, 'ACTIVE', now() + interval '10 minutes')
        `,
      ).rejects.toMatchObject({ code: "23505" });

      // Outro membro no mesmo grupo e o mesmo usuário em outro grupo podem.
      expect((await postCheckin(app, member, { groupId, dueAt: dueIn(30) })).statusCode).toBe(201);
      const other = await createGroup(app, owner, "Amigos");
      expect((await postCheckin(app, owner, { groupId: other, dueAt: dueIn(30) })).statusCode).toBe(
        201,
      );
    });

    it("após cancelar ou confirmar, um novo check-in pode ser criado", async () => {
      const first = await createCheckin(app, owner, groupId);
      await checkinAction(app, owner, first.id, "cancel");
      const second = await createCheckin(app, owner, groupId);
      await checkinAction(app, owner, second.id, "safe");
      expect((await postCheckin(app, owner, { groupId, dueAt: dueIn(30) })).statusCode).toBe(201);
    });

    it("idempotência: mesma chave devolve o mesmo check-in; payload diferente → 409; chave ausente → 400", async () => {
      const key = randomUUID();
      const dueAt = dueIn(30);
      const first = await postCheckin(app, owner, { groupId, dueAt }, key);
      const retry = await postCheckin(app, owner, { groupId, dueAt }, key);
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.json().id).toBe(first.json().id);
      expect(retry.headers["idempotent-replayed"]).toBe("true");
      expect(await countCheckins()).toBe(1);

      const reused = await postCheckin(app, owner, { groupId, dueAt: dueIn(45) }, key);
      expect(reused.statusCode).toBe(409);
      expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSED");

      const missing = await postCheckin(app, owner, { groupId, dueAt }, null);
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("INVALID_IDEMPOTENCY_KEY");

      // Concorrência com a mesma chave: um único check-in.
      await checkinAction(app, owner, first.json().id, "cancel");
      const key2 = randomUUID();
      const dueAt2 = dueIn(40);
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => postCheckin(app, owner, { groupId, dueAt: dueAt2 }, key2)),
      );
      expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
      expect(await countCheckins()).toBe(2);
    });

    it("exige autenticação (401)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/checkins",
        headers: { "idempotency-key": randomUUID() },
        payload: { groupId, dueAt: dueIn(30) },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("leitura", () => {
    it("dono e membro leem; externo e ex-membro recebem 404 CHECKIN_NOT_FOUND", async () => {
      const checkin = await createCheckin(app, owner, groupId);
      expect((await getCheckin(app, owner, checkin.id)).statusCode).toBe(200);
      const asMember = await getCheckin(app, member, checkin.id);
      expect(asMember.statusCode).toBe(200);
      expect(asMember.json().user.name).toBe("Felipe");

      const asOutsider = await getCheckin(app, outsider, checkin.id);
      expect(asOutsider.statusCode).toBe(404);
      expect(asOutsider.json().code).toBe("CHECKIN_NOT_FOUND");
      const missing = await getCheckin(app, outsider, "00000000-0000-4000-8000-000000000000");
      expect(errorBodyWithoutRequestId(missing)).toEqual(errorBodyWithoutRequestId(asOutsider));
      expect((await getCheckin(app, member, "nao-uuid")).statusCode).toBe(404);

      await app.inject({
        method: "DELETE",
        url: `/groups/${groupId}/members/me`,
        headers: authHeaders(member),
      });
      expect((await getCheckin(app, member, checkin.id)).statusCode).toBe(404);
    });

    it("GET /checkins lista só os meus (com filtro) e GET /groups/:id/checkins só do grupo autorizado", async () => {
      const mine = await createCheckin(app, owner, groupId);
      const theirs = await createCheckin(app, member, groupId);
      const otherGroup = await createGroup(app, outsider, "Grupo B");
      await createCheckin(app, outsider, otherGroup);
      await checkinAction(app, owner, mine.id, "safe");

      const all = await app.inject({
        method: "GET",
        url: "/checkins",
        headers: authHeaders(owner),
      });
      expect(all.json().map((c: { id: string }) => c.id)).toEqual([mine.id]);
      const active = await app.inject({
        method: "GET",
        url: "/checkins?status=ACTIVE",
        headers: authHeaders(owner),
      });
      expect(active.json()).toEqual([]);
      const safe = await app.inject({
        method: "GET",
        url: "/checkins?status=SAFE",
        headers: authHeaders(owner),
      });
      expect(safe.json().map((c: { id: string }) => c.id)).toEqual([mine.id]);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/checkins?status=X",
            headers: authHeaders(owner),
          })
        ).statusCode,
      ).toBe(400);

      const group = await app.inject({
        method: "GET",
        url: `/groups/${groupId}/checkins`,
        headers: authHeaders(member),
      });
      expect(group.statusCode).toBe(200);
      expect(
        group
          .json()
          .map((c: { id: string }) => c.id)
          .sort(),
      ).toEqual([mine.id, theirs.id].sort());

      const forbidden = await app.inject({
        method: "GET",
        url: `/groups/${groupId}/checkins`,
        headers: authHeaders(outsider),
      });
      expect(forbidden.statusCode).toBe(404);
      expect(forbidden.json().code).toBe("GROUP_NOT_FOUND");
    });

    it("respostas não contêm e-mail, hashes, tokens ou localização", async () => {
      const checkin = await createCheckin(app, owner, groupId);
      for (const url of ["/checkins", `/checkins/${checkin.id}`, `/groups/${groupId}/checkins`]) {
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
    let checkinId: string;
    beforeEach(async () => {
      checkinId = (await createCheckin(app, owner, groupId)).id;
    });

    it("ACTIVE -> SAFE preenche confirmedAt; repetir é idempotente", async () => {
      const first = await checkinAction(app, owner, checkinId, "safe");
      expect(first.statusCode).toBe(200);
      expect(first.json().status).toBe("SAFE");
      expect(typeof first.json().confirmedAt).toBe("string");

      const again = await checkinAction(app, owner, checkinId, "safe");
      expect(again.statusCode).toBe(200);
      expect(again.json().confirmedAt).toBe(first.json().confirmedAt);
    });

    it("ACTIVE -> CANCELLED preenche cancelledAt; repetir é idempotente; SAFE depois é inválido", async () => {
      const first = await checkinAction(app, owner, checkinId, "cancel");
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ status: "CANCELLED", confirmedAt: null });
      expect(typeof first.json().cancelledAt).toBe("string");

      const again = await checkinAction(app, owner, checkinId, "cancel");
      expect(again.statusCode).toBe(200);
      expect(again.json().cancelledAt).toBe(first.json().cancelledAt);

      const safe = await checkinAction(app, owner, checkinId, "safe");
      expect(safe.statusCode).toBe(409);
      expect(safe.json().code).toBe("INVALID_CHECKIN_TRANSITION");
    });

    it("SAFE -> CANCELLED é inválido", async () => {
      await checkinAction(app, owner, checkinId, "safe");
      const cancel = await checkinAction(app, owner, checkinId, "cancel");
      expect(cancel.statusCode).toBe(409);
      expect(cancel.json().code).toBe("INVALID_CHECKIN_TRANSITION");
    });

    it("OVERDUE -> SAFE é permitido; OVERDUE -> CANCELLED não", async () => {
      await expireCheckin(cleaner.sql, checkinId);
      expect(await app.checkinScheduler.runOnce()).toBe(1);
      await drainOutbox(app);
      expect((await getCheckin(app, owner, checkinId)).json().status).toBe("OVERDUE");

      const cancel = await checkinAction(app, owner, checkinId, "cancel");
      expect(cancel.statusCode).toBe(409);

      const safe = await checkinAction(app, owner, checkinId, "safe");
      expect(safe.statusCode).toBe(200);
      expect(safe.json().status).toBe("SAFE");
      expect(typeof safe.json().overdueAt).toBe("string");
      expect(typeof safe.json().confirmedAt).toBe("string");
    });

    it("outro membro não confirma nem cancela (403); externo recebe 404", async () => {
      for (const action of ["safe", "cancel"] as const) {
        const asMember = await checkinAction(app, member, checkinId, action);
        expect(asMember.statusCode).toBe(403);
        expect(asMember.json().code).toBe("FORBIDDEN");
        const asOutsider = await checkinAction(app, outsider, checkinId, action);
        expect(asOutsider.statusCode).toBe(404);
        expect(asOutsider.json().code).toBe("CHECKIN_NOT_FOUND");
      }
      expect((await getCheckin(app, owner, checkinId)).json().status).toBe("ACTIVE");
    });
  });

  describe("realtime", () => {
    const isType = (type: RealtimeEvent["type"]) => (event: RealtimeEvent) => event.type === type;

    it("CHECKIN_CREATED/SAFE/CANCELLED chegam aos membros com payload mínimo; externo não recebe", async () => {
      const memberClient = await connectRealtime(wsUrl, member.accessToken);
      const outsiderClient = await connectRealtime(wsUrl, outsider.accessToken);
      openClients.push(memberClient, outsiderClient);

      const key = randomUUID();
      const dueAt = dueIn(30);
      const created = await postCheckin(app, owner, { groupId, dueAt }, key);
      const checkinId = created.json().id as string;
      await drainOutbox(app);
      const event = await memberClient.waitForEvent(isType("CHECKIN_CREATED"));
      expect(event.data).toEqual({ checkinId, groupId, userId: owner.userId });

      // Replay idempotente não publica de novo.
      await postCheckin(app, owner, { groupId, dueAt }, key);
      await drainOutbox(app);
      expect(memberClient.events.filter(isType("CHECKIN_CREATED"))).toHaveLength(1);

      await checkinAction(app, owner, checkinId, "safe");
      await drainOutbox(app);
      const safe = await memberClient.waitForEvent(isType("CHECKIN_SAFE"));
      expect(safe.data).toEqual({ checkinId, groupId, userId: owner.userId });
      await checkinAction(app, owner, checkinId, "safe");
      await drainOutbox(app);
      expect(memberClient.events.filter(isType("CHECKIN_SAFE"))).toHaveLength(1);

      const second = await createCheckin(app, owner, groupId);
      await checkinAction(app, owner, second.id, "cancel");
      await drainOutbox(app);
      const cancelled = await memberClient.waitForEvent(isType("CHECKIN_CANCELLED"));
      expect((cancelled.data as { checkinId: string }).checkinId).toBe(second.id);

      const raw = JSON.stringify(memberClient.events);
      for (const forbidden of ["email", "latitude", "longitude", "PushToken", "Felipe"]) {
        expect(raw).not.toContain(forbidden);
      }
      await drainOutbox(app);
      await outsiderClient.expectNoEvent(() => true);
      expect(outsiderClient.events).toHaveLength(0);
    });
  });
});
