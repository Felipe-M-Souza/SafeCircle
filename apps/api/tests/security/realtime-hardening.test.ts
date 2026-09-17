import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createTestApp } from "../helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "../helpers/test-db.js";
import { authHeaders, registerUser, sessionIdOf, type TestUser } from "../helpers/auth.js";
import {
  connectRealtime,
  RealtimeHandshakeError,
  startRealtimeServer,
  type RealtimeTestClient,
} from "../helpers/realtime.js";
import { FakePushProvider } from "../../src/infrastructure/push/fake-push-provider.js";
import {
  REALTIME_CLOSE_CODES,
  RealtimeHub,
} from "../../src/infrastructure/realtime/realtime-hub.js";
import { REALTIME_MAX_PAYLOAD_BYTES } from "../../src/plugins/realtime.js";

/**
 * WebSocket endurecido (Phase 11): Origin, sessão revogada, payload do
 * cliente, rate limit de handshake, heartbeat e backpressure.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let wsUrl: string;
const openClients: RealtimeTestClient[] = [];

beforeAll(async () => {
  app = await createTestApp();
  wsUrl = await startRealtimeServer(app);
});
afterAll(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  openClients.length = 0;
  await cleaner.truncate();
});

async function expectHandshakeStatus(promise: Promise<RealtimeTestClient>, status: number) {
  try {
    const client = await promise;
    openClients.push(client);
    throw new Error(`Handshake deveria ter sido rejeitado com ${status}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RealtimeHandshakeError);
    expect((error as RealtimeHandshakeError).statusCode).toBe(status);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Tempo esgotado aguardando condição.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Origin no handshake", () => {
  let strict: FastifyInstance;
  let strictWsUrl: string;
  let user: TestUser;

  beforeAll(async () => {
    strict = await buildApp({
      logger: false,
      databaseUrl: getTestDatabaseUrl(),
      pushProvider: new FakePushProvider(),
      checkinSchedulerAutoStart: false,
      journeySchedulerAutoStart: false,
      outboxWorkerAutoStart: false,
      corsAllowedOrigins: ["https://app.safecircle.example"],
      strictOrigins: true,
    });
    await strict.ready();
    strictWsUrl = await startRealtimeServer(strict);
  });
  afterAll(async () => {
    await strict.close();
  });
  beforeEach(async () => {
    user = await registerUser(strict);
  });

  it("origem web fora da allow-list é recusada com 403 antes de autenticar", async () => {
    await expectHandshakeStatus(
      connectRealtime(strictWsUrl, user.accessToken, "/realtime", {
        Origin: "https://evil.example",
      }),
      403,
    );
    // Sem token E origem proibida: a origem é barrada primeiro (403, não 401).
    await expectHandshakeStatus(
      connectRealtime(strictWsUrl, undefined, "/realtime", { Origin: "https://evil.example" }),
      403,
    );
  });

  it("origem permitida conecta; cliente nativo sem Origin conecta", async () => {
    const web = await connectRealtime(strictWsUrl, user.accessToken, "/realtime", {
      Origin: "https://app.safecircle.example",
    });
    openClients.push(web);
    const native = await connectRealtime(strictWsUrl, user.accessToken);
    openClients.push(native);
    await waitUntil(() => strict.realtimeHub.connectionCount(user.userId) === 2);
  });

  it("Origin igual à própria origem da API (WebSocket do React Native) conecta em modo estrito", async () => {
    // O WebSocket do React Native (Android/iOS) envia Origin = https://<host da API>.
    const selfOrigin = strictWsUrl.replace(/^ws/, "http");
    const native = await connectRealtime(strictWsUrl, user.accessToken, "/realtime", {
      Origin: selfOrigin,
    });
    openClients.push(native);
    await waitUntil(() => strict.realtimeHub.connectionCount(user.userId) === 1);

    // Same-origin é exato: outro host/porta com o mesmo prefixo continua 403.
    await expectHandshakeStatus(
      connectRealtime(strictWsUrl, user.accessToken, "/realtime", {
        Origin: selfOrigin.replace(/:(\d+)$/, (_m, port) => `:${Number(port) + 1}`),
      }),
      403,
    );
    await expectHandshakeStatus(
      connectRealtime(strictWsUrl, user.accessToken, "/realtime", {
        Origin: selfOrigin + ".evil.example",
      }),
      403,
    );
  });

  it("origem permitida não substitui autenticação", async () => {
    await expectHandshakeStatus(
      connectRealtime(strictWsUrl, undefined, "/realtime", {
        Origin: "https://app.safecircle.example",
      }),
      401,
    );
  });
});

describe("Sessão e token", () => {
  it("revogar a sessão fecha o WebSocket dela com 4403 e impede reconectar", async () => {
    const user = await registerUser(app);
    const client = await connectRealtime(wsUrl, user.accessToken);
    openClients.push(client);
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 1);

    const res = await app.inject({
      method: "DELETE",
      url: `/me/sessions/${sessionIdOf(user)}`,
      headers: authHeaders(user),
    });
    expect(res.statusCode).toBe(204);

    const closed = await client.waitForClose(5000);
    expect(closed.code).toBe(REALTIME_CLOSE_CODES.SESSION_REVOKED);
    expect(closed.reason).toBe("SESSION_REVOKED");
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 0);

    await expectHandshakeStatus(connectRealtime(wsUrl, user.accessToken), 401);
  });

  it("access token de sessão já revogada não abre conexão", async () => {
    const user = await registerUser(app);
    await cleaner.sql`UPDATE auth_sessions SET revoked_at = now() WHERE id = ${sessionIdOf(user)}`;
    await expectHandshakeStatus(connectRealtime(wsUrl, user.accessToken), 401);
  });
});

describe("Mensagens do cliente", () => {
  it("frame acima do limite fecha a conexão sem afetar o processo", async () => {
    const user = await registerUser(app);
    const client = await connectRealtime(wsUrl, user.accessToken);
    openClients.push(client);
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 1);

    client.socket.send("x".repeat(REALTIME_MAX_PAYLOAD_BYTES * 4));
    const closed = await client.waitForClose(5000);
    // 1009 = Message Too Big (fechado pelo próprio `ws`).
    expect(closed.code).toBe(1009);
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 0);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("mensagem de negócio enviada pelo cliente não executa comando nenhum", async () => {
    const user = await registerUser(app);
    const groupRes = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeaders(user),
      payload: { name: "Família" },
    });
    const groupId = groupRes.json().id as string;
    const client = await connectRealtime(wsUrl, user.accessToken);
    openClients.push(client);
    await waitUntil(() => app.realtimeHub.connectionCount(user.userId) === 1);

    client.socket.send(
      JSON.stringify({ version: 1, type: "ALERT_CREATED", data: { groupId }, action: "create" }),
    );
    client.socket.send(JSON.stringify({ type: "DELETE_GROUP", groupId }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(app.realtimeHub.connectionCount(user.userId)).toBe(1);
    const [alerts] = await cleaner.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM emergency_alerts`;
    const [groups] = await cleaner.sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM trusted_groups`;
    expect(alerts?.count).toBe(0);
    expect(groups?.count).toBe(1);
    expect(client.events).toHaveLength(0);
  });
});

describe("Rate limit de handshake", () => {
  it("tempestade de handshakes do mesmo IP recebe 429", async () => {
    const strict = await buildApp({
      logger: false,
      databaseUrl: getTestDatabaseUrl(),
      pushProvider: new FakePushProvider(),
      checkinSchedulerAutoStart: false,
      journeySchedulerAutoStart: false,
      outboxWorkerAutoStart: false,
      rateLimitProfile: "production",
    });
    await strict.ready();
    const strictWsUrl = await startRealtimeServer(strict);
    try {
      let limitedAt: number | null = null;
      for (let i = 0; i < 40; i += 1) {
        try {
          const client = await connectRealtime(strictWsUrl, undefined);
          await client.close();
        } catch (error) {
          const status = (error as RealtimeHandshakeError).statusCode;
          if (status === 429) {
            limitedAt = i;
            break;
          }
          expect(status).toBe(401);
        }
      }
      expect(limitedAt).not.toBeNull();
    } finally {
      await strict.close();
    }
  });
});

describe("Hub: heartbeat e backpressure", () => {
  type Listener = (...args: unknown[]) => void;
  function fakeSocket(overrides: Partial<{ bufferedAmount: number }> = {}) {
    const listeners = new Map<string, Listener[]>();
    const socket = {
      readyState: 1,
      bufferedAmount: overrides.bufferedAmount ?? 0,
      pings: 0,
      terminated: false,
      closedWith: null as { code: number; reason: string } | null,
      sent: [] as string[],
      on(event: string, listener: Listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      ping() {
        this.pings += 1;
      },
      terminate() {
        this.terminated = true;
      },
      close(code: number, reason: string) {
        this.closedWith = { code, reason };
      },
      send(payload: string) {
        this.sent.push(payload);
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },
    };
    return socket;
  }

  it("conexão que não responde ao ping é terminada e limpa", async () => {
    const hub = new RealtimeHub({ heartbeatIntervalMs: 20 });
    const socket = fakeSocket();
    hub.register("user-a", socket as never);
    expect(hub.connectionCount()).toBe(1);

    // 1º tick: marca `alive=false` e envia ping; 2º tick: sem pong, termina.
    await waitUntil(() => socket.terminated, 2000);
    expect(hub.connectionCount()).toBe(0);
    expect(socket.pings).toBeGreaterThanOrEqual(1);
    hub.closeAll();
  });

  it("conexão que responde ao ping permanece", async () => {
    const hub = new RealtimeHub({ heartbeatIntervalMs: 20 });
    const socket = fakeSocket();
    hub.register("user-a", socket as never);
    const originalPing = socket.ping.bind(socket);
    socket.ping = () => {
      originalPing();
      socket.emit("pong");
    };
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(hub.connectionCount()).toBe(1);
    expect(socket.terminated).toBe(false);
    hub.closeAll();
  });

  it("consumidor lento (buffer acima do limite) é fechado com 4413 em vez de acumular fila", () => {
    const hub = new RealtimeHub({ heartbeatIntervalMs: 60_000, maxBufferedBytes: 100 });
    const slow = fakeSocket({ bufferedAmount: 1_000 });
    const healthy = fakeSocket();
    hub.register("user-a", slow as never);
    hub.register("user-a", healthy as never);

    const delivered = hub.send(["user-a"], {
      version: 1,
      type: "ALERT_CREATED",
      eventId: "e1",
      occurredAt: new Date().toISOString(),
      data: {},
    } as never);

    expect(delivered).toBe(1);
    expect(slow.closedWith?.code).toBe(REALTIME_CLOSE_CODES.BACKPRESSURE);
    expect(slow.sent).toHaveLength(0);
    expect(healthy.sent).toHaveLength(1);
    expect(hub.connectionCount("user-a")).toBe(1);
    hub.closeAll();
  });

  it("closeBySession fecha só as conexões daquela sessão", () => {
    const hub = new RealtimeHub({ heartbeatIntervalMs: 60_000 });
    const a1 = fakeSocket();
    const a2 = fakeSocket();
    hub.register("user-a", a1 as never, { sessionId: "sessao-1" });
    hub.register("user-a", a2 as never, { sessionId: "sessao-2" });

    expect(
      hub.closeBySession("sessao-1", REALTIME_CLOSE_CODES.SESSION_REVOKED, "SESSION_REVOKED"),
    ).toBe(1);
    expect(a1.closedWith?.code).toBe(REALTIME_CLOSE_CODES.SESSION_REVOKED);
    expect(a2.closedWith).toBeNull();
    expect(hub.connectionCount("user-a")).toBe(1);
    hub.closeAll();
  });
});
