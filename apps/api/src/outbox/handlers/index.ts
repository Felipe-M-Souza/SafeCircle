import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../infrastructure/database/client.js";
import type { PushProvider } from "../../infrastructure/push/push-provider.js";
import type { RealtimePublisher } from "../../infrastructure/realtime/realtime-publisher.js";
import type { OutboxEvent } from "../../infrastructure/database/schema.js";
import {
  familyOf,
  payloadSchemaFor,
  permanent,
  type AuditOutboxEventType,
  type HandlerResult,
  type PushEventType,
  type RealtimeEventType,
} from "../outbox.types.js";
import { handleAuditEvent } from "./audit.handler.js";
import { handlePushEvent } from "./push.handler.js";
import { handleRealtimeEvent } from "./realtime.handler.js";

/**
 * Despacho de eventos da outbox (Phase 10).
 *
 * As dependências são explícitas e nada aqui conhece Fastify, request ou reply:
 * é o que permite mover este módulo para um processo separado no futuro sem
 * reescrever handler nenhum.
 */
export interface OutboxHandlerContext {
  db: Database;
  pushProvider: PushProvider;
  realtime: RealtimePublisher;
  log: FastifyBaseLogger;
  /** Id do evento da outbox: correlação, dedupe realtime e idempotência do audit. */
  eventId: string;
}

export interface HandlerDependencies {
  db: Database;
  pushProvider: PushProvider;
  realtime: RealtimePublisher;
  log: FastifyBaseLogger;
}

/**
 * Valida o payload e chama o handler da família.
 *
 * Payload inválido ou versão desconhecida é falha **permanente**: o evento
 * nunca vai processar, então retry seria só desperdício e ruído.
 */
export async function dispatchOutboxEvent(
  deps: HandlerDependencies,
  event: OutboxEvent,
): Promise<HandlerResult> {
  const family = familyOf(event.eventType);
  if (!family) return permanent("UNKNOWN_EVENT_TYPE");

  const parsed = payloadSchemaFor(family).safeParse(event.payload);
  if (!parsed.success) {
    // Distinguimos versão incompatível de payload corrompido para o operador.
    const versionIssue = parsed.error.issues.some((issue) => issue.path[0] === "version");
    return permanent(versionIssue ? "UNSUPPORTED_EVENT_VERSION" : "PAYLOAD_INVALID");
  }

  const ctx: OutboxHandlerContext = { ...deps, eventId: event.id };

  if (family === "push") {
    return handlePushEvent(
      ctx,
      event.eventType as PushEventType,
      parsed.data as Parameters<typeof handlePushEvent>[2],
    );
  }
  if (family === "realtime") {
    return handleRealtimeEvent(
      ctx,
      event.eventType as RealtimeEventType,
      parsed.data as Parameters<typeof handleRealtimeEvent>[2],
      event.createdAt,
    );
  }
  return handleAuditEvent(
    ctx,
    event.eventType as AuditOutboxEventType,
    parsed.data as Parameters<typeof handleAuditEvent>[2],
    event.requestId,
  );
}
