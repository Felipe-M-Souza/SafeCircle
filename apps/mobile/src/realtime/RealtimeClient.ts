import { parseRealtimeEvent, type RealtimeEvent } from "./events";

/**
 * Cliente WebSocket do SafeCircle (Phase 5).
 *
 * - Conecta com o access token atual (header Authorization no handshake).
 * - Recebe, valida e deduplica eventos por `eventId`.
 * - Reconecta automaticamente com exponential backoff + jitter; o backoff é
 *   zerado após uma conexão bem-sucedida.
 * - Quando o servidor fecha por token expirado (4401), renova o token via
 *   REST e reconecta.
 * - `stop()` (logout/background) fecha o socket, limpa timers e o cache de
 *   dedupe e NÃO reconecta.
 *
 * O socket nunca é fonte de verdade: quem assina `onConnected` deve
 * ressincronizar o estado pela API a cada (re)conexão.
 */

export type RealtimeConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "RECONNECTING";

/** Superfície mínima de um WebSocket (permite injetar um transporte falso nos testes). */
export interface RealtimeSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string, accessToken: string) => RealtimeSocket;

export const REALTIME_CLOSE_TOKEN_EXPIRED = 4401;

export interface RealtimeClientOptions {
  url: string;
  getAccessToken: () => string | null;
  refreshAccessToken: () => Promise<string | null>;
  createSocket?: SocketFactory;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Fonte de aleatoriedade do jitter (injetável para testes determinísticos). */
  random?: () => number;
  dedupeSize?: number;
}

type EventListener = (event: RealtimeEvent) => void;
type StateListener = (state: RealtimeConnectionState) => void;
type ConnectedListener = () => void;

/** Deriva a URL do WebSocket a partir da base HTTP da API. */
export function realtimeUrlFromApiBase(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/^http/i, "ws").replace(/\/+$/, "")}/realtime`;
}

/** Transporte padrão: WebSocket do React Native (aceita headers no handshake). */
function createNativeSocket(url: string, accessToken: string): RealtimeSocket {
  const Ctor = WebSocket as unknown as new (
    url: string,
    protocols?: string | string[] | null,
    options?: { headers?: Record<string, string> },
  ) => RealtimeSocket;
  return new Ctor(url, null, { headers: { Authorization: `Bearer ${accessToken}` } });
}

export class RealtimeClient {
  private readonly url: string;
  private readonly getAccessToken: () => string | null;
  private readonly refreshAccessToken: () => Promise<string | null>;
  private readonly createSocket: SocketFactory;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly dedupeSize: number;

  private socket: RealtimeSocket | null = null;
  private running = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private state: RealtimeConnectionState = "DISCONNECTED";
  private readonly seenEventIds: string[] = [];
  private readonly seenSet = new Set<string>();

  private readonly eventListeners = new Set<EventListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly connectedListeners = new Set<ConnectedListener>();

  constructor(options: RealtimeClientOptions) {
    this.url = options.url;
    this.getAccessToken = options.getAccessToken;
    this.refreshAccessToken = options.refreshAccessToken;
    this.createSocket = options.createSocket ?? createNativeSocket;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.random = options.random ?? Math.random;
    this.dedupeSize = options.dedupeSize ?? 200;
  }

  getState(): RealtimeConnectionState {
    return this.state;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Inicia (idempotente): uma única conexão por cliente. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  /** Para sem reconectar e limpa estado privado. */
  stop(): void {
    this.running = false;
    this.clearReconnectTimer();
    this.attempt = 0;
    this.seenEventIds.length = 0;
    this.seenSet.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close(1000, "client-stop");
      } catch {
        // Socket já fechado.
      }
    }
    this.setState("DISCONNECTED");
  }

  /** Reconecta usando o access token atual (ex.: após refresh). */
  restart(): void {
    this.stop();
    this.start();
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Disparado a cada conexão bem-sucedida: hora de ressincronizar via REST. */
  onConnected(listener: ConnectedListener): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }

  private setState(state: RealtimeConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private connect(): void {
    if (!this.running) return;
    const token = this.getAccessToken();
    if (!token) {
      // Sem credencial não há o que conectar; o provider reinicia ao obter token.
      this.setState("DISCONNECTED");
      return;
    }
    this.setState(this.attempt === 0 ? "CONNECTING" : "RECONNECTING");

    let socket: RealtimeSocket;
    try {
      socket = this.createSocket(this.url, token);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setState("CONNECTED");
      for (const listener of this.connectedListeners) listener();
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      this.handleMessage(message.data);
    };
    socket.onerror = () => {
      // O evento `close` correspondente trata a reconexão.
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.running) {
        this.setState("DISCONNECTED");
        return;
      }
      if (event.code === REALTIME_CLOSE_TOKEN_EXPIRED) {
        void this.handleTokenExpired();
        return;
      }
      this.scheduleReconnect();
    };
  }

  private async handleTokenExpired(): Promise<void> {
    this.setState("RECONNECTING");
    let refreshed: string | null = null;
    try {
      refreshed = await this.refreshAccessToken();
    } catch {
      refreshed = null;
    }
    if (!this.running) return;
    if (!refreshed) {
      // Sessão inválida: o AuthContext encerra a sessão; não insistimos.
      this.setState("DISCONNECTED");
      return;
    }
    this.attempt = 0;
    this.connect();
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.clearReconnectTimer();
    this.attempt += 1;
    this.setState("RECONNECTING");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.nextDelayMs());
  }

  /** Exponential backoff (1s, 2s, 4s, ...) limitado, com jitter de até 100%. */
  nextDelayMs(): number {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (this.attempt - 1));
    const jitter = exponential * this.random();
    return Math.min(this.maxDelayMs, Math.round(exponential + jitter));
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private handleMessage(raw: unknown): void {
    const event = parseRealtimeEvent(raw);
    if (!event) return;
    if (this.seenSet.has(event.eventId)) return;
    this.remember(event.eventId);
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Um listener com erro não derruba os demais.
      }
    }
  }

  private remember(eventId: string): void {
    this.seenSet.add(eventId);
    this.seenEventIds.push(eventId);
    while (this.seenEventIds.length > this.dedupeSize) {
      const oldest = this.seenEventIds.shift();
      if (oldest) this.seenSet.delete(oldest);
    }
  }
}
