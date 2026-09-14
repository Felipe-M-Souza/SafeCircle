import { auditEvents } from "../../infrastructure/database/schema.js";
import { auditEventsTotal, auditFailuresTotal } from "../../observability/metrics.js";
import { sanitizeMetadata, type AuditEventType } from "../../observability/audit.js";
import { isValidRequestId } from "../../observability/request-context.js";
import {
  success,
  transient,
  type AuditOutboxEventType,
  type AuditPayload,
  type HandlerResult,
} from "../outbox.types.js";
import type { OutboxHandlerContext } from "./index.js";

/**
 * Materialização da trilha de auditoria a partir da outbox (Phase 10).
 *
 * **Idempotência por construção**: `audit_events.source_outbox_event_id` é
 * UNIQUE e recebe o id do evento da outbox. Com entrega at-least-once, o mesmo
 * evento pode ser processado duas vezes; o `ON CONFLICT DO NOTHING` faz a
 * segunda passagem virar no-op em vez de duplicar a linha.
 *
 * Diferente da Phase 9, aqui uma falha de INSERT é **transitória**: o evento
 * volta para a fila com backoff e tenta de novo. A intenção de auditar já
 * sobreviveu ao commit — não há mais por que aceitar perdê-la.
 */

/** `AUDIT_CHECKIN_MARKED_SAFE` → `CHECKIN_MARKED_SAFE` (tipo da Phase 9). */
function domainEventType(eventType: AuditOutboxEventType): AuditEventType {
  return eventType.slice("AUDIT_".length) as AuditEventType;
}

export async function handleAuditEvent(
  ctx: OutboxHandlerContext,
  eventType: AuditOutboxEventType,
  payload: AuditPayload,
  requestId: string | null,
): Promise<HandlerResult> {
  const domainType = domainEventType(eventType);
  const outcome = payload.outcome ?? "SUCCEEDED";

  try {
    const inserted = await ctx.db
      .insert(auditEvents)
      .values({
        eventType: domainType,
        actorUserId: payload.actorUserId ?? null,
        targetType: payload.targetType ?? null,
        targetId: payload.targetId ?? null,
        groupId: payload.groupId ?? null,
        outcome,
        requestId: isValidRequestId(requestId) ? requestId : null,
        // Allow-list aplicada de novo aqui: defesa em profundidade caso um
        // evento antigo tenha entrado na fila antes de alguma regra nova.
        metadata: sanitizeMetadata(payload.metadata),
        sourceOutboxEventId: ctx.eventId,
      })
      .onConflictDoNothing({ target: auditEvents.sourceOutboxEventId })
      .returning({ id: auditEvents.id });

    // Sem linha devolvida = já existia (reprocessamento): sucesso, sem duplicar.
    if (inserted.length > 0) {
      auditEventsTotal.inc({ event_type: domainType, outcome });
    }
    return success;
  } catch (error) {
    auditFailuresTotal.inc({ event_type: domainType });
    ctx.log.error(
      { event: "audit_write_failed", err: error, auditEventType: domainType },
      "Falha ao materializar evento de auditoria",
    );
    return transient("AUDIT_INSERT_FAILED");
  }
}
