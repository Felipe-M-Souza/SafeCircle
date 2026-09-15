import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import type { RealtimeEvent } from "../../src/infrastructure/realtime/events.js";

/**
 * Helpers de WebSocket para testes: servidor real em porta efêmera (127.0.0.1),
 * cliente `ws` local — nenhum serviço externo. Esperas são por evento/condição,
 * nunca por sleep arbitrário.
 */

/** Sobe o servidor HTTP da app em porta efêmera e devolve a URL ws://. */
export async function startRealtimeServer(app: FastifyInstance): Promise<string> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return address.replace(/^http/, "ws");
}

export interface RealtimeTestClient {
  socket: WebSocket;
  events: RealtimeEvent[];
  /** Aguarda um evento que satisfaça o predicado (inclui eventos já recebidos). */
  waitForEvent(
    predicate: (event: RealtimeEvent) => boolean,
    timeoutMs?: number,
  ): Promise<RealtimeEvent>;
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  /** Garante que nenhum evento com o predicado chega em uma janela curta. */
  expectNoEvent(predicate: (event: RealtimeEvent) => boolean, windowMs?: number): Promise<void>;
  close(): Promise<void>;
}

export class RealtimeHandshakeError extends Error {
  constructor(readonly statusCode: number | undefined) {
    super(`Handshake WebSocket rejeitado: ${statusCode ?? "erro de conexão"}`);
  }
}

export function connectRealtime(
  baseWsUrl: string,
  accessToken?: string,
  path = "/realtime",
  extraHeaders: Record<string, string> = {},
): Promise<RealtimeTestClient> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (accessToken !== undefined) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    const socket = new WebSocket(`${baseWsUrl}${path}`, { headers });
    const events: RealtimeEvent[] = [];
    const waiters = new Set<() => void>();
    let closed: { code: number; reason: string } | null = null;
    const closeWaiters = new Set<() => void>();

    socket.on("message", (raw) => {
      events.push(JSON.parse(raw.toString()) as RealtimeEvent);
      for (const waiter of waiters) waiter();
    });
    socket.on("close", (code, reason) => {
      closed = { code, reason: reason.toString() };
      for (const waiter of closeWaiters) waiter();
    });
    socket.on("unexpected-response", (_req, res) => {
      reject(new RealtimeHandshakeError(res.statusCode));
      socket.terminate();
    });
    socket.on("error", (error) => reject(error));

    socket.on("open", () => {
      resolve({
        socket,
        events,
        waitForEvent(predicate, timeoutMs = 5000) {
          return new Promise((resolveEvent, rejectEvent) => {
            const check = () => {
              const found = events.find(predicate);
              if (found) {
                waiters.delete(check);
                clearTimeout(timer);
                resolveEvent(found);
              }
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              rejectEvent(new Error("Tempo esgotado aguardando evento realtime."));
            }, timeoutMs);
            waiters.add(check);
            check();
          });
        },
        waitForClose(timeoutMs = 5000) {
          return new Promise((resolveClose, rejectClose) => {
            if (closed) {
              resolveClose(closed);
              return;
            }
            const timer = setTimeout(() => {
              closeWaiters.delete(onClose);
              rejectClose(new Error("Tempo esgotado aguardando fechamento do socket."));
            }, timeoutMs);
            const onClose = () => {
              clearTimeout(timer);
              closeWaiters.delete(onClose);
              resolveClose(closed!);
            };
            closeWaiters.add(onClose);
          });
        },
        async expectNoEvent(predicate, windowMs = 300) {
          await new Promise((r) => setTimeout(r, windowMs));
          const found = events.find(predicate);
          if (found) {
            throw new Error(`Evento inesperado recebido: ${found.type}`);
          }
        },
        close() {
          return new Promise((resolveClose) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolveClose();
              return;
            }
            socket.once("close", () => resolveClose());
            socket.close(1000, "test");
          });
        },
      });
    });
  });
}

/** Tenta conectar e devolve o status HTTP da rejeição do handshake. */
export async function expectHandshakeRejected(
  baseWsUrl: string,
  accessToken?: string,
): Promise<number | undefined> {
  try {
    const client = await connectRealtime(baseWsUrl, accessToken);
    await client.close();
    throw new Error("Conexão deveria ter sido rejeitada.");
  } catch (error) {
    if (error instanceof RealtimeHandshakeError) {
      return error.statusCode;
    }
    throw error;
  }
}

/** Aguarda até que a condição seja verdadeira (polling curto), sem sleep fixo longo. */
export async function waitUntil(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Tempo esgotado aguardando condição.");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
