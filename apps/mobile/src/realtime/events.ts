/**
 * Envelope dos eventos realtime (Phase 5) — versão 1.
 *
 * O JSON recebido pelo socket nunca é confiado cegamente: validamos versão,
 * tipo, eventId, occurredAt e data. Eventos desconhecidos ou de versão não
 * suportada são ignorados com segurança (o app não quebra com eventos
 * futuros). Eventos carregam apenas IDs; o estado atual vem sempre da API.
 */

export const REALTIME_EVENT_VERSION = 1;

export const REALTIME_EVENT_TYPES = [
  "ALERT_CREATED",
  "ALERT_RESOLVED",
  "ALERT_CANCELLED",
  "ALERT_ACKNOWLEDGEMENT_CHANGED",
  "GROUP_MEMBERSHIP_CHANGED",
] as const;

export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

export interface RealtimeEventData {
  alertId?: string;
  groupId?: string;
  userId?: string;
}

export interface RealtimeEvent {
  version: typeof REALTIME_EVENT_VERSION;
  type: RealtimeEventType;
  eventId: string;
  occurredAt: string;
  data: RealtimeEventData;
}

const KNOWN_TYPES = new Set<string>(REALTIME_EVENT_TYPES);

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Valida e converte uma mensagem bruta do socket; `null` quando deve ser ignorada. */
export function parseRealtimeEvent(raw: unknown): RealtimeEvent | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;

  if (record.version !== REALTIME_EVENT_VERSION) return null;
  if (typeof record.type !== "string" || !KNOWN_TYPES.has(record.type)) return null;
  if (typeof record.eventId !== "string" || record.eventId.length === 0) return null;
  if (typeof record.occurredAt !== "string") return null;
  if (typeof record.data !== "object" || record.data === null) return null;

  const data = record.data as Record<string, unknown>;
  const parsed: RealtimeEvent = {
    version: REALTIME_EVENT_VERSION,
    type: record.type as RealtimeEventType,
    eventId: record.eventId,
    occurredAt: record.occurredAt,
    data: {},
  };
  const alertId = optionalString(data.alertId);
  const groupId = optionalString(data.groupId);
  const userId = optionalString(data.userId);
  if (alertId) parsed.data.alertId = alertId;
  if (groupId) parsed.data.groupId = groupId;
  if (userId) parsed.data.userId = userId;
  return parsed;
}

export function isAlertEvent(event: RealtimeEvent): boolean {
  return event.type.startsWith("ALERT_");
}
