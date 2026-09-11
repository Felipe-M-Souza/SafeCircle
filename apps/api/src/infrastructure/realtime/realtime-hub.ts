import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { RealtimeEvent } from "./events.js";

/**
 * Gerenciador de conexões WebSocket em memória (Phase 5).
 *
 * - Várias conexões por usuário (vários aparelhos).
 * - Server-push only: mensagens do cliente são ignoradas.
 * - Heartbeat ping/pong para detectar conexões mortas e liberar memória.
 * - Backpressure: socket com buffer acima do limite é fechado (o cliente
 *   ressincroniza ao reconectar) — nunca acumulamos filas ilimitadas.
 * - TTL por token: a conexão é encerrada quando o access token expira
 *   (código 4401); o cliente faz refresh via REST e reconecta.
 *
 * Limitação (ADR 0006): estado em memória de uma única instância da API.
 */

export const REALTIME_CLOSE_CODES = {
  SERVER_SHUTDOWN: 1001,
  TOKEN_EXPIRED: 4401,
  HEARTBEAT_TIMEOUT: 4408,
  BACKPRESSURE: 4413,
  TOO_MANY_CONNECTIONS: 4429,
} as const;

export interface RealtimeHubOptions {
  heartbeatIntervalMs?: number;
  maxBufferedBytes?: number;
  maxConnectionsPerUser?: number;
  log?: FastifyBaseLogger;
}

export interface RegisterOptions {
  /** Instante de expiração do access token: a conexão é fechada nesse momento. */
  expiresAt?: Date;
}

interface Connection {
  id: string;
  userId: string;
  socket: WebSocket;
  alive: boolean;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

const OPEN = 1;

export class RealtimeHub {
  private readonly connections = new Map<string, Connection>();
  private readonly byUser = new Map<string, Set<string>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly maxBufferedBytes: number;
  private readonly maxConnectionsPerUser: number;
  private readonly log: FastifyBaseLogger | undefined;

  constructor(options: RealtimeHubOptions = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 256 * 1024;
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? 5;
    this.log = options.log;
  }

  /** Registra uma conexão autenticada e devolve o connectionId. */
  register(userId: string, socket: WebSocket, options: RegisterOptions = {}): string {
    const id = randomUUID();
    const connection: Connection = { id, userId, socket, alive: true, expiryTimer: null };

    // Limite por usuário: fecha a conexão mais antiga (evita zumbis bloqueando novas).
    const existing = this.byUser.get(userId);
    if (existing && existing.size >= this.maxConnectionsPerUser) {
      const oldestId = existing.values().next().value;
      if (oldestId) {
        this.close(oldestId, REALTIME_CLOSE_CODES.TOO_MANY_CONNECTIONS, "TOO_MANY_CONNECTIONS");
      }
    }

    this.connections.set(id, connection);
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(id);

    socket.on("pong", () => {
      connection.alive = true;
    });
    // Server-push only: nada que o cliente envie é interpretado como comando.
    socket.on("message", () => {});
    socket.on("close", () => this.unregister(id));
    socket.on("error", () => this.unregister(id));

    if (options.expiresAt) {
      const delay = Math.max(0, options.expiresAt.getTime() - Date.now());
      connection.expiryTimer = setTimeout(() => {
        this.close(id, REALTIME_CLOSE_CODES.TOKEN_EXPIRED, "TOKEN_EXPIRED");
      }, delay);
    }

    this.ensureHeartbeat();
    this.log?.debug({ connectionId: id, userId }, "Conexão realtime registrada");
    return id;
  }

  unregister(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }
    if (connection.expiryTimer) {
      clearTimeout(connection.expiryTimer);
    }
    this.connections.delete(connectionId);
    const set = this.byUser.get(connection.userId);
    if (set) {
      set.delete(connectionId);
      if (set.size === 0) {
        this.byUser.delete(connection.userId);
      }
    }
    if (this.connections.size === 0) {
      this.stopHeartbeat();
    }
    this.log?.debug({ connectionId, userId: connection.userId }, "Conexão realtime removida");
  }

  /** Envia o evento a todas as conexões abertas dos usuários informados. */
  send(userIds: Iterable<string>, event: RealtimeEvent): number {
    const payload = JSON.stringify(event);
    let delivered = 0;
    for (const userId of new Set(userIds)) {
      const ids = this.byUser.get(userId);
      if (!ids) {
        continue;
      }
      for (const connectionId of [...ids]) {
        const connection = this.connections.get(connectionId);
        if (!connection || connection.socket.readyState !== OPEN) {
          continue;
        }
        if (connection.socket.bufferedAmount > this.maxBufferedBytes) {
          this.close(connectionId, REALTIME_CLOSE_CODES.BACKPRESSURE, "BACKPRESSURE");
          continue;
        }
        connection.socket.send(payload);
        delivered += 1;
      }
    }
    return delivered;
  }

  connectionCount(userId?: string): number {
    if (userId === undefined) {
      return this.connections.size;
    }
    return this.byUser.get(userId)?.size ?? 0;
  }

  close(connectionId: string, code: number, reason: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }
    this.unregister(connectionId);
    try {
      connection.socket.close(code, reason);
    } catch {
      connection.socket.terminate();
    }
  }

  /** Fecha todas as conexões (shutdown) e para o heartbeat. */
  closeAll(code: number = REALTIME_CLOSE_CODES.SERVER_SHUTDOWN, reason = "SERVER_SHUTDOWN"): void {
    for (const id of [...this.connections.keys()]) {
      this.close(id, code, reason);
    }
    this.stopHeartbeat();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) {
      return;
    }
    this.heartbeat = setInterval(() => this.heartbeatTick(), this.heartbeatIntervalMs);
    // Não impede o processo de encerrar.
    if (typeof this.heartbeat === "object" && "unref" in this.heartbeat) {
      this.heartbeat.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private heartbeatTick(): void {
    for (const [id, connection] of [...this.connections]) {
      if (!connection.alive) {
        this.unregister(id);
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      try {
        connection.socket.ping();
      } catch {
        this.unregister(id);
        connection.socket.terminate();
      }
    }
  }
}
