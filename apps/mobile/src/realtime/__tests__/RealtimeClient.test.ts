import {
  REALTIME_CLOSE_TOKEN_EXPIRED,
  RealtimeClient,
  realtimeUrlFromApiBase,
  type RealtimeConnectionState,
  type RealtimeSocket,
} from "../RealtimeClient";
import type { RealtimeEvent } from "../events";

/** Transporte falso: nenhum WebSocket real. */
class FakeSocket implements RealtimeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
  }
  open(): void {
    this.onopen?.();
  }
  message(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  serverClose(code: number): void {
    this.onclose?.({ code });
  }
}

function event(eventId: string, type: RealtimeEvent["type"] = "ALERT_CREATED") {
  return {
    version: 1,
    type,
    eventId,
    occurredAt: "2026-09-11T20:30:00.000Z",
    data: { alertId: "a1" },
  };
}

function setup(options: { token?: string | null; random?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  let token: string | null = options.token === undefined ? "token-1" : options.token;
  const refreshAccessToken = jest.fn<Promise<string | null>, []>(async () => {
    token = "token-2";
    return token;
  });
  const createSocket = jest.fn((url: string, accessToken: string) => {
    const socket = new FakeSocket(url, accessToken);
    sockets.push(socket);
    return socket;
  });
  const client = new RealtimeClient({
    url: "ws://api.test/realtime",
    getAccessToken: () => token,
    refreshAccessToken,
    createSocket,
    random: options.random ?? (() => 0),
  });
  const states: RealtimeConnectionState[] = [];
  client.onStateChange((state) => states.push(state));
  const received: RealtimeEvent[] = [];
  client.onEvent((e) => received.push(e));
  const connected = jest.fn();
  client.onConnected(connected);
  return {
    client,
    sockets,
    createSocket,
    states,
    received,
    connected,
    refreshAccessToken,
    setToken: (value: string | null) => {
      token = value;
    },
  };
}

describe("RealtimeClient", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("deriva a URL do WebSocket da base da API", () => {
    expect(realtimeUrlFromApiBase("http://localhost:3000")).toBe("ws://localhost:3000/realtime");
    expect(realtimeUrlFromApiBase("https://api.safecircle.app/")).toBe(
      "wss://api.safecircle.app/realtime",
    );
  });

  it("conecta com o access token, muda de estado e avisa a conexão (ressincronização)", () => {
    const { client, sockets, states, connected } = setup();
    client.start();
    client.start(); // idempotente

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("ws://api.test/realtime");
    expect(sockets[0]?.token).toBe("token-1");
    expect(states).toEqual(["CONNECTING"]);

    sockets[0]?.open();
    expect(client.getState()).toBe("CONNECTED");
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it("sem access token não abre socket", () => {
    const { client, sockets } = setup({ token: null });
    client.start();
    expect(sockets).toHaveLength(0);
    expect(client.getState()).toBe("DISCONNECTED");
  });

  it("entrega eventos válidos uma única vez e ignora inválidos", () => {
    const { client, sockets, received } = setup();
    client.start();
    const socket = sockets[0]!;
    socket.open();

    socket.message(event("e1"));
    socket.message(event("e1")); // duplicado
    socket.message({ ...event("e2"), version: 99 }); // versão desconhecida
    socket.message({ ...event("e3"), type: "FUTURE_EVENT" }); // tipo desconhecido
    socket.message("{lixo"); // JSON inválido
    socket.message(event("e4", "ALERT_RESOLVED"));

    expect(received.map((e) => e.eventId)).toEqual(["e1", "e4"]);
  });

  it("reconecta com exponential backoff (1s, 2s, 4s) e zera após conexão estável", () => {
    const { client, sockets } = setup();
    client.start();
    sockets[0]!.open();

    sockets[0]!.serverClose(1006);
    expect(client.getState()).toBe("RECONNECTING");
    jest.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1]!.serverClose(1006);
    jest.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    sockets[2]!.serverClose(1006);
    jest.advanceTimersByTime(3999);
    expect(sockets).toHaveLength(3);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);

    // Conexão estável zera o backoff: a próxima queda espera 1s de novo.
    sockets[3]!.open();
    expect(client.getState()).toBe("CONNECTED");
    sockets[3]!.serverClose(1006);
    jest.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(5);
  });

  it("aplica jitter limitado ao máximo", () => {
    const { client, sockets } = setup({ random: () => 1 });
    client.start();
    sockets[0]!.open();
    sockets[0]!.serverClose(1006);
    // 1s + 100% de jitter = 2s.
    jest.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(client.nextDelayMs()).toBeLessThanOrEqual(30_000);
  });

  it("stop() fecha o socket, não reconecta e limpa o cache de dedupe", () => {
    const { client, sockets, received } = setup();
    client.start();
    sockets[0]!.open();
    sockets[0]!.message(event("e1"));

    client.stop();
    expect(sockets[0]!.closes).toEqual([{ code: 1000, reason: "client-stop" }]);
    expect(client.getState()).toBe("DISCONNECTED");
    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);

    // Após reiniciar, o mesmo eventId volta a ser entregue (cache limpo).
    client.start();
    sockets[1]!.open();
    sockets[1]!.message(event("e1"));
    expect(received).toHaveLength(2);
  });

  it("token expirado (4401): renova via REST e reconecta com o token novo", async () => {
    const { client, sockets, refreshAccessToken } = setup();
    client.start();
    sockets[0]!.open();

    sockets[0]!.serverClose(REALTIME_CLOSE_TOKEN_EXPIRED);
    expect(client.getState()).toBe("RECONNECTING");
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.token).toBe("token-2");
  });

  it("token expirado sem sessão válida: não insiste", async () => {
    const { client, sockets, refreshAccessToken } = setup();
    refreshAccessToken.mockResolvedValueOnce(null);
    client.start();
    sockets[0]!.open();
    sockets[0]!.serverClose(REALTIME_CLOSE_TOKEN_EXPIRED);
    await Promise.resolve();
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    expect(client.getState()).toBe("DISCONNECTED");
    jest.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("restart() reconecta com o access token atual", () => {
    const { client, sockets, setToken } = setup();
    client.start();
    sockets[0]!.open();
    setToken("token-renovado");
    client.restart();
    expect(sockets[0]!.closes).toHaveLength(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.token).toBe("token-renovado");
  });

  it("eventos de um socket antigo são ignorados após restart", () => {
    const { client, sockets, received } = setup();
    client.start();
    const old = sockets[0]!;
    old.open();
    client.restart();
    old.message(event("e-antigo"));
    expect(received).toHaveLength(0);
  });
});
