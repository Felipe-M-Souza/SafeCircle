import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { SYNTHETIC_LOCATION, createAlert, newIdempotencyKey, postAlert } from "./helpers/alerts.js";
import {
  connectRealtime,
  expectHandshakeRejected,
  startRealtimeServer,
  waitUntil,
  type RealtimeTestClient,
} from "./helpers/realtime.js";
import { REALTIME_CLOSE_CODES } from "../src/infrastructure/realtime/realtime-hub.js";
import type { RealtimeEvent } from "../src/infrastructure/realtime/events.js";

const cleaner = createCleaner();
let app: FastifyInstance;
let wsUrl: string;
const openClients: RealtimeTestClient[] = [];

async function connect(user: TestUser): Promise<RealtimeTestClient> {
  const client = await connectRealtime(wsUrl, user.accessToken);
  openClients.push(client);
  return client;
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

const isType = (type: RealtimeEvent["type"]) => (event: RealtimeEvent) => event.type === type;

describe("GET /realtime — conexão", () => {
  it("aceita conexão autenticada e limpa ao desconectar", async () => {
    const user = await registerUser(app);
    const client = await connect(user);
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 1);

    await client.close();
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 0);
  });

  it("rejeita conexão sem token, com token inválido e com token expirado (401)", async () => {
    expect(await expectHandshakeRejected(wsUrl)).toBe(401);
    expect(await expectHandshakeRejected(wsUrl, "token-invalido")).toBe(401);

    const user = await registerUser(app);
    const expired = app.jwt.sign({ sub: user.userId, sid: "sessao" }, { expiresIn: "-10s" });
    expect(await expectHandshakeRejected(wsUrl, expired)).toBe(401);
    expect(app.realtimeHub.connectionCount()).toBe(0);
  });

  it("token com assinatura de outro segredo é rejeitado", async () => {
    const forged =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAiLCJzaWQiOiJ4In0." +
      "assinatura-invalida";
    expect(await expectHandshakeRejected(wsUrl, forged)).toBe(401);
  });

  it("fecha a conexão quando o access token expira (4401) e permite reconectar com token novo", async () => {
    const user = await registerUser(app);
    const shortLived = app.jwt.sign({ sub: user.userId, sid: "sessao" }, { expiresIn: "1s" });
    const client = await connectRealtime(wsUrl, shortLived);
    openClients.push(client);

    const closed = await client.waitForClose(5000);
    expect(closed.code).toBe(REALTIME_CLOSE_CODES.TOKEN_EXPIRED);
    expect(closed.reason).toBe("TOKEN_EXPIRED");
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 0);

    // Reconexão com o access token válido (após "refresh" via REST).
    const reconnected = await connect(user);
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 1);
    await reconnected.close();
  });

  it("mensagens do cliente são ignoradas (server-push only) e a conexão permanece aberta", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const client = await connect(owner);

    client.socket.send(JSON.stringify({ action: "resolveAlert", alertId: "qualquer" }));
    client.socket.send("lixo");

    // O socket continua funcional: recebe o próximo evento normalmente.
    await createAlert(app, owner, groupId);
    await client.waitForEvent(isType("ALERT_CREATED"));
    expect(app.realtimeHub.connectionCount(owner.userId)).toBe(1);
  });

  it("limita conexões por usuário fechando a mais antiga (4429)", async () => {
    const user = await registerUser(app);
    const first = await connect(user);
    for (let i = 0; i < 5; i += 1) {
      await connect(user);
    }
    const closed = await first.waitForClose();
    expect(closed.code).toBe(REALTIME_CLOSE_CODES.TOO_MANY_CONNECTIONS);
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 5);
  });
});

describe("Eventos realtime — alertas", () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let groupId: string;

  beforeEach(async () => {
    owner = await registerUser(app, { name: "Felipe" });
    member = await registerUser(app);
    outsider = await registerUser(app);
    groupId = await createGroup(app, owner, "Família");
    await addMember(app, owner, groupId, member);
    await createGroup(app, outsider, "Grupo B");
  });

  it("criação publica ALERT_CREATED com envelope versionado aos membros (inclusive criador); externo não recebe", async () => {
    const ownerClient = await connect(owner);
    const memberClient = await connect(member);
    const outsiderClient = await connect(outsider);

    const res = await postAlert(app, owner, { groupId, location: SYNTHETIC_LOCATION });
    expect(res.statusCode).toBe(201);
    const alertId = res.json().id as string;

    const event = await memberClient.waitForEvent(isType("ALERT_CREATED"));
    expect(event).toMatchObject({
      version: 1,
      type: "ALERT_CREATED",
      data: { alertId, groupId },
    });
    expect(typeof event.eventId).toBe("string");
    expect(new Date(event.occurredAt).getTime()).not.toBeNaN();

    const ownEvent = await ownerClient.waitForEvent(isType("ALERT_CREATED"));
    expect(ownEvent.eventId).toBe(event.eventId);

    await outsiderClient.expectNoEvent(() => true);
    expect(outsiderClient.events).toHaveLength(0);
  });

  it("um usuário com duas conexões recebe em ambas", async () => {
    const a = await connect(member);
    const b = await connect(member);
    await createAlert(app, owner, groupId);
    const [eventA, eventB] = await Promise.all([
      a.waitForEvent(isType("ALERT_CREATED")),
      b.waitForEvent(isType("ALERT_CREATED")),
    ]);
    expect(eventA.eventId).toBe(eventB.eventId);
  });

  it("replay idempotente não publica segundo ALERT_CREATED", async () => {
    const client = await connect(member);
    const key = newIdempotencyKey();
    expect((await postAlert(app, owner, { groupId }, key)).statusCode).toBe(201);
    expect((await postAlert(app, owner, { groupId }, key)).statusCode).toBe(201);
    await app.background.flush();

    await client.waitForEvent(isType("ALERT_CREATED"));
    await client.expectNoEvent((e) => e.type === "ALERT_CREATED" && client.events.indexOf(e) > 0);
    expect(client.events.filter(isType("ALERT_CREATED"))).toHaveLength(1);
  });

  it("resolve publica ALERT_RESOLVED e cancel publica ALERT_CANCELLED; transição inválida não publica", async () => {
    const client = await connect(member);
    const first = await createAlert(app, owner, groupId);
    const resolve = await app.inject({
      method: "POST",
      url: `/alerts/${first.id}/resolve`,
      headers: authHeaders(owner),
    });
    expect(resolve.statusCode).toBe(200);
    const resolved = await client.waitForEvent(isType("ALERT_RESOLVED"));
    expect(resolved.data).toEqual({ alertId: first.id, groupId });

    // Transição inválida (já resolvido): nenhum evento.
    const again = await app.inject({
      method: "POST",
      url: `/alerts/${first.id}/cancel`,
      headers: authHeaders(owner),
    });
    expect(again.statusCode).toBe(409);
    await app.background.flush();
    await client.expectNoEvent(isType("ALERT_CANCELLED"));

    const second = await createAlert(app, owner, groupId);
    const cancel = await app.inject({
      method: "POST",
      url: `/alerts/${second.id}/cancel`,
      headers: authHeaders(owner),
    });
    expect(cancel.statusCode).toBe(200);
    const cancelled = await client.waitForEvent(isType("ALERT_CANCELLED"));
    expect(cancelled.data).toEqual({ alertId: second.id, groupId });
  });

  it("falha na publicação realtime não desfaz a operação REST", async () => {
    const client = await connect(member);
    const originalSend = app.realtimeHub.send.bind(app.realtimeHub);
    app.realtimeHub.send = () => {
      throw new Error("hub indisponível");
    };
    try {
      const res = await postAlert(app, owner, { groupId });
      expect(res.statusCode).toBe(201);
      await app.background.flush();
      const check = await app.inject({
        method: "GET",
        url: `/alerts/${res.json().id}`,
        headers: authHeaders(member),
      });
      expect(check.statusCode).toBe(200);
      expect(check.json().status).toBe("ACTIVE");
      expect(client.events).toHaveLength(0);
    } finally {
      app.realtimeHub.send = originalSend;
    }
    // O hub volta a funcionar normalmente depois.
    const alert = await createAlert(app, member, groupId);
    const event = await client.waitForEvent(isType("ALERT_CREATED"));
    expect(event.data).toMatchObject({ alertId: alert.id });
  });

  it("quem sai do grupo recebe GROUP_MEMBERSHIP_CHANGED e deixa de receber eventos do grupo", async () => {
    const client = await connect(member);
    const leave = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/members/me`,
      headers: authHeaders(member),
    });
    expect(leave.statusCode).toBe(204);
    const changed = await client.waitForEvent(isType("GROUP_MEMBERSHIP_CHANGED"));
    expect(changed.data).toEqual({ groupId, userId: member.userId });

    await createAlert(app, owner, groupId);
    await app.background.flush();
    await client.expectNoEvent(isType("ALERT_CREATED"));
  });

  it("eventos não contêm dados sensíveis", async () => {
    const client = await connect(member);
    const alert = await createAlert(app, owner, groupId, SYNTHETIC_LOCATION);
    await app.inject({
      method: "PUT",
      url: `/alerts/${alert.id}/acknowledgement`,
      headers: authHeaders(member),
      payload: { type: "GOING_TO_HELP" },
    });
    await client.waitForEvent(isType("ALERT_ACKNOWLEDGEMENT_CHANGED"));

    const raw = JSON.stringify(client.events);
    for (const forbidden of [
      "email",
      "password",
      "refreshToken",
      "accessToken",
      "PushToken",
      "latitude",
      "longitude",
      String(SYNTHETIC_LOCATION.latitude),
      "Felipe",
      owner.email,
      member.email,
      owner.accessToken,
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
