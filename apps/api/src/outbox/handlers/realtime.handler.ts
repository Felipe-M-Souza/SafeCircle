import {
  REALTIME_EVENT_VERSION,
  type RealtimeEvent,
  type RealtimeEventType as DomainRealtimeEventType,
} from "../../infrastructure/realtime/events.js";
import {
  permanent,
  success,
  transient,
  type HandlerResult,
  type RealtimeEventType,
  type RealtimePayload,
} from "../outbox.types.js";
import type { OutboxHandlerContext } from "./index.js";

/**
 * Publicação realtime a partir da outbox (Phase 10).
 *
 * Duas decisões importantes:
 *
 * 1. **`eventId` estável**: usamos o id do evento da outbox. Um retry publica o
 *    MESMO `eventId`, então o cliente consegue deduplicar. Gerar um id novo a
 *    cada tentativa tornaria a duplicata invisível para o app.
 * 2. **Expiração curta**: realtime é acelerador de UX, não fonte de verdade.
 *    Publicar um evento de 10 minutos atrás só faria a interface piscar com
 *    informação velha — o app já ressincronizou via REST. O worker descarta
 *    eventos expirados antes de chegar aqui.
 */

/** `REALTIME_CHECKIN_SAFE` → `CHECKIN_SAFE` (envelope da Phase 5). */
const DOMAIN_TYPES: Record<RealtimeEventType, DomainRealtimeEventType> = {
  REALTIME_ALERT_CREATED: "ALERT_CREATED",
  REALTIME_ALERT_RESOLVED: "ALERT_RESOLVED",
  REALTIME_ALERT_CANCELLED: "ALERT_CANCELLED",
  REALTIME_ALERT_ACKNOWLEDGEMENT_CHANGED: "ALERT_ACKNOWLEDGEMENT_CHANGED",
  REALTIME_ALERT_LIVE_LOCATION_STARTED: "ALERT_LIVE_LOCATION_STARTED",
  REALTIME_ALERT_LIVE_LOCATION_UPDATED: "ALERT_LIVE_LOCATION_UPDATED",
  REALTIME_ALERT_LIVE_LOCATION_STOPPED: "ALERT_LIVE_LOCATION_STOPPED",
  REALTIME_CHECKIN_CREATED: "CHECKIN_CREATED",
  REALTIME_CHECKIN_SAFE: "CHECKIN_SAFE",
  REALTIME_CHECKIN_CANCELLED: "CHECKIN_CANCELLED",
  REALTIME_CHECKIN_OVERDUE: "CHECKIN_OVERDUE",
  REALTIME_JOURNEY_CREATED: "JOURNEY_CREATED",
  REALTIME_JOURNEY_ARRIVED: "JOURNEY_ARRIVED",
  REALTIME_JOURNEY_CANCELLED: "JOURNEY_CANCELLED",
  REALTIME_JOURNEY_OVERDUE: "JOURNEY_OVERDUE",
  REALTIME_JOURNEY_LOCATION_UPDATED: "JOURNEY_LOCATION_UPDATED",
  REALTIME_GROUP_MEMBERSHIP_CHANGED: "GROUP_MEMBERSHIP_CHANGED",
};

export async function handleRealtimeEvent(
  ctx: OutboxHandlerContext,
  eventType: RealtimeEventType,
  payload: RealtimePayload,
  occurredAt: Date,
): Promise<HandlerResult> {
  const domainType = DOMAIN_TYPES[eventType];
  if (!domainType) return permanent("UNKNOWN_EVENT_TYPE");

  // Só os IDs do payload entram no envelope: nunca coordenadas.
  const data: Record<string, string> = {};
  for (const key of ["alertId", "checkinId", "journeyId", "sessionId", "userId"] as const) {
    const value = payload[key];
    if (value) data[key] = value;
  }
  if (payload.groupId) data.groupId = payload.groupId;

  const event = {
    version: REALTIME_EVENT_VERSION,
    type: domainType,
    // Estável entre retries: permite dedupe no cliente.
    eventId: ctx.eventId,
    occurredAt: occurredAt.toISOString(),
    data,
  } as RealtimeEvent;

  try {
    if (payload.targetUserId) {
      ctx.realtime.publishToUser(payload.targetUserId, event);
      return success;
    }
    if (!payload.groupId) {
      // Sem destinatário possível: o evento nunca vai funcionar.
      return permanent("PAYLOAD_INVALID");
    }
    await ctx.realtime.publishToGroup(payload.groupId, event);
    return success;
  } catch {
    // Hub indisponível: tenta de novo enquanto o evento não expirar.
    return transient("REALTIME_PUBLISH_FAILED");
  }
}
