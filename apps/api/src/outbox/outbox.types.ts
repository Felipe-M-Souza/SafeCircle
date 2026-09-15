import { z } from "zod";

/**
 * Contratos da outbox transacional (Phase 10).
 *
 * Cada tipo de evento tem um **payload mínimo e versionado**, validado por Zod
 * no worker antes de qualquer efeito. Versão desconhecida ou payload inválido é
 * falha PERMANENTE (vai para DEAD), não retry infinito: reprocessar para sempre
 * um evento que nunca vai funcionar só entope a fila.
 *
 * Privacidade (ADR 0011): o payload carrega **apenas IDs e flags**. Nunca push
 * token, coordenada, credencial, e-mail, corpo de requisição ou resposta bruta
 * de provedor — a outbox é uma tabela durável, e o que entra nela fica.
 */

export const OUTBOX_PAYLOAD_VERSION = 1;

// ------------------------------------------------------------------
// Tipos de evento (conjunto fechado — nunca vindo de request)
// ------------------------------------------------------------------

export const PUSH_EVENT_TYPES = [
  "PUSH_ALERT_CREATED",
  "PUSH_CHECKIN_OVERDUE",
  "PUSH_JOURNEY_OVERDUE",
] as const;

export const REALTIME_EVENT_TYPES = [
  "REALTIME_ALERT_CREATED",
  "REALTIME_ALERT_RESOLVED",
  "REALTIME_ALERT_CANCELLED",
  "REALTIME_ALERT_ACKNOWLEDGEMENT_CHANGED",
  "REALTIME_ALERT_LIVE_LOCATION_STARTED",
  "REALTIME_ALERT_LIVE_LOCATION_UPDATED",
  "REALTIME_ALERT_LIVE_LOCATION_STOPPED",
  "REALTIME_CHECKIN_CREATED",
  "REALTIME_CHECKIN_SAFE",
  "REALTIME_CHECKIN_CANCELLED",
  "REALTIME_CHECKIN_OVERDUE",
  "REALTIME_JOURNEY_CREATED",
  "REALTIME_JOURNEY_ARRIVED",
  "REALTIME_JOURNEY_CANCELLED",
  "REALTIME_JOURNEY_OVERDUE",
  "REALTIME_JOURNEY_LOCATION_UPDATED",
  "REALTIME_GROUP_MEMBERSHIP_CHANGED",
] as const;

export const AUDIT_EVENT_TYPES = [
  "AUDIT_AUTH_LOGIN_SUCCEEDED",
  "AUDIT_AUTH_LOGIN_FAILED",
  "AUDIT_AUTH_LOGOUT",
  "AUDIT_AUTH_SESSION_REVOKED",
  "AUDIT_AUTH_OTHER_SESSIONS_REVOKED",
  "AUDIT_AUTH_REFRESH_REUSE_DETECTED",
  "AUDIT_PRIVACY_EXPORT_REQUESTED",
  "AUDIT_GROUP_CREATED",
  "AUDIT_GROUP_MEMBER_REMOVED",
  "AUDIT_GROUP_MEMBER_ROLE_CHANGED",
  "AUDIT_ALERT_CREATED",
  "AUDIT_ALERT_RESOLVED",
  "AUDIT_ALERT_CANCELLED",
  "AUDIT_LIVE_LOCATION_STARTED",
  "AUDIT_LIVE_LOCATION_STOPPED",
  "AUDIT_CHECKIN_CREATED",
  "AUDIT_CHECKIN_MARKED_SAFE",
  "AUDIT_CHECKIN_CANCELLED",
  "AUDIT_CHECKIN_OVERDUE",
  "AUDIT_JOURNEY_CREATED",
  "AUDIT_JOURNEY_ARRIVED",
  "AUDIT_JOURNEY_CANCELLED",
  "AUDIT_JOURNEY_OVERDUE",
] as const;

export const OUTBOX_EVENT_TYPES = [
  ...PUSH_EVENT_TYPES,
  ...REALTIME_EVENT_TYPES,
  ...AUDIT_EVENT_TYPES,
] as const;

export type PushEventType = (typeof PUSH_EVENT_TYPES)[number];
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];
export type AuditOutboxEventType = (typeof AUDIT_EVENT_TYPES)[number];
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

/** Família do evento — decide handler, retries e expiração. */
export type OutboxEventFamily = "push" | "realtime" | "audit";

const pushTypes = new Set<string>(PUSH_EVENT_TYPES);
const realtimeTypes = new Set<string>(REALTIME_EVENT_TYPES);
const auditTypes = new Set<string>(AUDIT_EVENT_TYPES);

export function familyOf(eventType: string): OutboxEventFamily | null {
  if (pushTypes.has(eventType)) return "push";
  if (realtimeTypes.has(eventType)) return "realtime";
  if (auditTypes.has(eventType)) return "audit";
  return null;
}

export function isOutboxEventType(value: string): value is OutboxEventType {
  return familyOf(value) !== null;
}

// ------------------------------------------------------------------
// Políticas por família
// ------------------------------------------------------------------

/**
 * Tentativas e expiração por família (ADR 0011).
 *
 * - **push**: 8 tentativas e TTL de 20 min. Uma notificação de SOS entregue
 *   uma hora depois é pior que nenhuma — confunde e assusta sem ajudar.
 * - **realtime**: poucas tentativas e TTL de 5 min. É acelerador de UX; o REST
 *   é a fonte de verdade e o app ressincroniza ao abrir/reconectar.
 * - **audit**: muitas tentativas e **sem expiração**. Perder trilha de
 *   auditoria é o pior desfecho possível aqui.
 */
export interface OutboxPolicy {
  maxAttempts: number;
  /** Nulo = nunca expira. */
  ttlMs: number | null;
}

export const OUTBOX_POLICIES: Record<OutboxEventFamily, OutboxPolicy> = {
  push: { maxAttempts: 8, ttlMs: 20 * 60 * 1000 },
  realtime: { maxAttempts: 3, ttlMs: 5 * 60 * 1000 },
  audit: { maxAttempts: 12, ttlMs: null },
};

// ------------------------------------------------------------------
// Payloads versionados
// ------------------------------------------------------------------

const versioned = z.object({ version: z.literal(OUTBOX_PAYLOAD_VERSION) });
const uuidField = z.string().uuid();

/** Push: só os IDs necessários para o handler recarregar destinatários. */
export const pushPayloadSchema = versioned.extend({
  /** Quem originou o efeito e NÃO deve receber a notificação. */
  actorUserId: uuidField,
  groupId: uuidField,
  resourceId: uuidField,
});

/** Realtime: IDs do envelope da Phase 5. Sem coordenadas, sempre. */
export const realtimePayloadSchema = versioned.extend({
  groupId: uuidField.optional(),
  /** Publicação direcionada a um único usuário (ex.: membership alterada). */
  targetUserId: uuidField.optional(),
  alertId: uuidField.optional(),
  checkinId: uuidField.optional(),
  journeyId: uuidField.optional(),
  sessionId: uuidField.optional(),
  userId: uuidField.optional(),
});

/** Auditoria: espelha o que a Phase 9 já gravava, com metadata allow-listed. */
export const auditPayloadSchema = versioned.extend({
  actorUserId: uuidField.nullable().optional(),
  targetType: z.string().max(40).optional(),
  targetId: uuidField.nullable().optional(),
  groupId: uuidField.nullable().optional(),
  outcome: z.enum(["SUCCEEDED", "FAILED"]).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type PushPayload = z.infer<typeof pushPayloadSchema>;
export type RealtimePayload = z.infer<typeof realtimePayloadSchema>;
export type AuditPayload = z.infer<typeof auditPayloadSchema>;

/** Schema do payload conforme a família do evento. */
export function payloadSchemaFor(family: OutboxEventFamily) {
  if (family === "push") return pushPayloadSchema;
  if (family === "realtime") return realtimePayloadSchema;
  return auditPayloadSchema;
}

// ------------------------------------------------------------------
// Resultado do processamento
// ------------------------------------------------------------------

export type HandlerOutcome = "SUCCESS" | "TRANSIENT_FAILURE" | "PERMANENT_FAILURE" | "EXPIRED";

export interface HandlerResult {
  outcome: HandlerOutcome;
  /** Código curto e controlado — nunca stack nem resposta de provedor. */
  errorCode?: OutboxErrorCode;
}

/** Códigos de erro persistidos em `last_error_code` (conjunto fechado). */
export const OUTBOX_ERROR_CODES = [
  "PAYLOAD_INVALID",
  "UNSUPPORTED_EVENT_VERSION",
  "UNKNOWN_EVENT_TYPE",
  "PUSH_PROVIDER_FAILED",
  "PUSH_NO_RECIPIENTS",
  "REALTIME_PUBLISH_FAILED",
  "AUDIT_INSERT_FAILED",
  "HANDLER_UNEXPECTED_ERROR",
  "LEASE_EXPIRED",
] as const;

export type OutboxErrorCode = (typeof OUTBOX_ERROR_CODES)[number];

export const success: HandlerResult = { outcome: "SUCCESS" };

export function transient(errorCode: OutboxErrorCode): HandlerResult {
  return { outcome: "TRANSIENT_FAILURE", errorCode };
}

export function permanent(errorCode: OutboxErrorCode): HandlerResult {
  return { outcome: "PERMANENT_FAILURE", errorCode };
}
