import { randomUUID } from "node:crypto";

/**
 * Envelope versionado dos eventos realtime (Phase 5).
 *
 * Eventos transportam o mínimo: IDs e metadados seguros. O cliente busca o
 * estado atual via REST — o WebSocket é notificação de mudança, não fonte de
 * verdade. Nenhum evento carrega coordenadas, e-mail, tokens ou sessões.
 */

export const REALTIME_EVENT_VERSION = 1 as const;

export interface RealtimeEventDataMap {
  ALERT_CREATED: { alertId: string; groupId: string };
  ALERT_RESOLVED: { alertId: string; groupId: string };
  ALERT_CANCELLED: { alertId: string; groupId: string };
  ALERT_ACKNOWLEDGEMENT_CHANGED: { alertId: string; groupId: string; userId: string };
  /** Enviado apenas ao usuário afetado, para ressincronizar grupos/permissões. */
  GROUP_MEMBERSHIP_CHANGED: { groupId: string; userId: string };
  // Phase 6 — Localização ao Vivo: NUNCA carregam coordenadas; o cliente busca via REST.
  ALERT_LIVE_LOCATION_STARTED: { alertId: string; groupId: string; sessionId: string };
  ALERT_LIVE_LOCATION_UPDATED: { alertId: string; groupId: string; sessionId: string };
  ALERT_LIVE_LOCATION_STOPPED: { alertId: string; groupId: string; sessionId: string };
}

export type RealtimeEventType = keyof RealtimeEventDataMap;

export interface RealtimeEvent<T extends RealtimeEventType = RealtimeEventType> {
  version: typeof REALTIME_EVENT_VERSION;
  type: T;
  /** UUID gerado na publicação (observabilidade e deduplicação no cliente). */
  eventId: string;
  occurredAt: string;
  data: RealtimeEventDataMap[T];
}

export function createRealtimeEvent<T extends RealtimeEventType>(
  type: T,
  data: RealtimeEventDataMap[T],
  now: Date = new Date(),
): RealtimeEvent<T> {
  return {
    version: REALTIME_EVENT_VERSION,
    type,
    eventId: randomUUID(),
    occurredAt: now.toISOString(),
    data,
  };
}
