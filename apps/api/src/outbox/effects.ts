import type { AuditMetadata } from "../observability/audit.js";
import { outboxEnqueuedTotal, safeLabel } from "../observability/metrics.js";
import { enqueueOutboxEvent, type Transaction } from "./outbox.service.js";
import type { AuditOutboxEventType, OutboxEventType, RealtimeEventType } from "./outbox.types.js";

/**
 * Efeitos por ação de domínio (Phase 10).
 *
 * Cada função descreve **o conjunto de efeitos** de uma transição e os
 * enfileira na transação recebida. Manter isso em um lugar só evita o erro
 * clássico de adicionar uma transição nova e esquecer o push, o realtime ou a
 * auditoria — e deixa explícito, em um arquivo, tudo que o sistema promete
 * entregar depois de cada commit.
 */

export interface EffectContext {
  /** Quem causou a ação; nulo em transições do sistema (schedulers). */
  actorUserId: string | null;
  requestId?: string | null;
}

/**
 * Opções que as rotas repassam aos serviços de domínio para correlacionar os
 * efeitos enfileirados com a requisição que os originou.
 */
export interface DomainActionOptions {
  requestId?: string | null;
}

async function enqueue(
  tx: Transaction,
  eventType: OutboxEventType,
  input: {
    aggregateType: string;
    aggregateId?: string | null;
    groupId?: string | null;
    payload: Record<string, unknown>;
    requestId?: string | null;
  },
): Promise<string> {
  const id = await enqueueOutboxEvent(tx, { eventType, ...input });
  outboxEnqueuedTotal.inc({ event_type: safeLabel(eventType) });
  return id;
}

/** Evento realtime (só IDs; jamais coordenadas). */
export function enqueueRealtime(
  tx: Transaction,
  eventType: RealtimeEventType,
  input: {
    aggregateType: string;
    aggregateId?: string | null;
    groupId?: string | null;
    payload: Record<string, unknown>;
    requestId?: string | null;
  },
): Promise<string> {
  return enqueue(tx, eventType, input);
}

/** Evento de auditoria (metadata allow-listed pelo handler ao materializar). */
export function enqueueAudit(
  tx: Transaction,
  eventType: AuditOutboxEventType,
  input: {
    aggregateType: string;
    aggregateId?: string | null;
    groupId?: string | null;
    actorUserId: string | null;
    targetType?: string;
    targetId?: string | null;
    outcome?: "SUCCEEDED" | "FAILED";
    metadata?: AuditMetadata;
    requestId?: string | null;
  },
): Promise<string> {
  const { aggregateType, aggregateId, groupId, requestId, ...payload } = input;
  return enqueue(tx, eventType, {
    aggregateType,
    aggregateId,
    groupId,
    requestId,
    payload: {
      actorUserId: payload.actorUserId,
      targetType: payload.targetType,
      targetId: payload.targetId,
      groupId: groupId ?? null,
      outcome: payload.outcome ?? "SUCCEEDED",
      metadata: payload.metadata,
    },
  });
}

// ------------------------------------------------------------------
// Alertas
// ------------------------------------------------------------------

export interface AlertEffectInput extends EffectContext {
  alertId: string;
  groupId: string;
}

/** Criação de alerta: push aos membros, realtime e auditoria. */
export async function enqueueAlertCreatedEffects(
  tx: Transaction,
  input: AlertEffectInput & { actorUserId: string },
): Promise<void> {
  const base = { aggregateType: "ALERT", aggregateId: input.alertId, groupId: input.groupId };
  await enqueue(tx, "PUSH_ALERT_CREATED", {
    ...base,
    requestId: input.requestId,
    payload: {
      actorUserId: input.actorUserId,
      groupId: input.groupId,
      resourceId: input.alertId,
    },
  });
  await enqueueRealtime(tx, "REALTIME_ALERT_CREATED", {
    ...base,
    requestId: input.requestId,
    payload: { alertId: input.alertId, groupId: input.groupId },
  });
  await enqueueAudit(tx, "AUDIT_ALERT_CREATED", {
    ...base,
    actorUserId: input.actorUserId,
    targetType: "ALERT",
    targetId: input.alertId,
    requestId: input.requestId,
  });
}

/** Encerramento do alerta (resolve/cancel): realtime + auditoria. */
export async function enqueueAlertTransitionEffects(
  tx: Transaction,
  input: AlertEffectInput & {
    transition: "RESOLVED" | "CANCELLED";
    stoppedLiveSessionId?: string | null;
  },
): Promise<void> {
  const base = { aggregateType: "ALERT", aggregateId: input.alertId, groupId: input.groupId };
  await enqueueRealtime(
    tx,
    input.transition === "RESOLVED" ? "REALTIME_ALERT_RESOLVED" : "REALTIME_ALERT_CANCELLED",
    {
      ...base,
      requestId: input.requestId,
      payload: { alertId: input.alertId, groupId: input.groupId },
    },
  );
  // A sessão ao vivo encerrada junto também precisa avisar o grupo.
  if (input.stoppedLiveSessionId) {
    await enqueueRealtime(tx, "REALTIME_ALERT_LIVE_LOCATION_STOPPED", {
      ...base,
      requestId: input.requestId,
      payload: {
        alertId: input.alertId,
        groupId: input.groupId,
        sessionId: input.stoppedLiveSessionId,
      },
    });
  }
  await enqueueAudit(
    tx,
    input.transition === "RESOLVED" ? "AUDIT_ALERT_RESOLVED" : "AUDIT_ALERT_CANCELLED",
    {
      ...base,
      actorUserId: input.actorUserId,
      targetType: "ALERT",
      targetId: input.alertId,
      requestId: input.requestId,
    },
  );
}

// ------------------------------------------------------------------
// Localização ao vivo (alerta — Phase 6; trajeto — Phase 8)
// ------------------------------------------------------------------

export interface LiveLocationEffectInput extends EffectContext {
  resource: "alert" | "journey";
  resourceId: string;
  groupId: string;
  sessionId: string;
}

function liveLocationBase(input: LiveLocationEffectInput) {
  return {
    aggregateType: input.resource === "alert" ? "ALERT" : "JOURNEY",
    aggregateId: input.resourceId,
    groupId: input.groupId,
    requestId: input.requestId,
  };
}

function liveLocationPayload(input: LiveLocationEffectInput): Record<string, unknown> {
  // Apenas IDs — o evento realtime NUNCA carrega coordenadas.
  // O envelope é exatamente o das Phases 7 e 8: o alerta identifica a sessão,
  // o trajeto identifica quem está se movendo. A Phase 10 troca o transporte,
  // não o contrato que o app já consome.
  return input.resource === "alert"
    ? { alertId: input.resourceId, groupId: input.groupId, sessionId: input.sessionId }
    : {
        journeyId: input.resourceId,
        groupId: input.groupId,
        userId: input.actorUserId ?? undefined,
      };
}

export async function enqueueLiveLocationStartedEffects(
  tx: Transaction,
  input: LiveLocationEffectInput,
): Promise<void> {
  await enqueueRealtime(
    tx,
    input.resource === "alert"
      ? "REALTIME_ALERT_LIVE_LOCATION_STARTED"
      : "REALTIME_JOURNEY_LOCATION_UPDATED",
    { ...liveLocationBase(input), payload: liveLocationPayload(input) },
  );
  await enqueueAudit(tx, "AUDIT_LIVE_LOCATION_STARTED", {
    ...liveLocationBase(input),
    actorUserId: input.actorUserId,
    targetType: "LIVE_LOCATION_SESSION",
    targetId: input.sessionId,
    metadata: { resource: input.resource },
  });
}

/** Ponto novo: só realtime. Auditar cada ponto inundaria a trilha. */
export function enqueueLiveLocationUpdatedEffects(
  tx: Transaction,
  input: LiveLocationEffectInput,
): Promise<string> {
  return enqueueRealtime(
    tx,
    input.resource === "alert"
      ? "REALTIME_ALERT_LIVE_LOCATION_UPDATED"
      : "REALTIME_JOURNEY_LOCATION_UPDATED",
    { ...liveLocationBase(input), payload: liveLocationPayload(input) },
  );
}

export async function enqueueLiveLocationStoppedEffects(
  tx: Transaction,
  input: LiveLocationEffectInput & { source?: "manual" | "automatic" },
): Promise<void> {
  await enqueueRealtime(
    tx,
    input.resource === "alert"
      ? "REALTIME_ALERT_LIVE_LOCATION_STOPPED"
      : "REALTIME_JOURNEY_LOCATION_UPDATED",
    { ...liveLocationBase(input), payload: liveLocationPayload(input) },
  );
  await enqueueAudit(tx, "AUDIT_LIVE_LOCATION_STOPPED", {
    ...liveLocationBase(input),
    actorUserId: input.actorUserId,
    targetType: "LIVE_LOCATION_SESSION",
    targetId: input.sessionId,
    metadata: { resource: input.resource, source: input.source ?? "manual" },
  });
}

// ------------------------------------------------------------------
// Grupos
// ------------------------------------------------------------------

/** Mudança de membership: realtime direcionado ao usuário afetado + auditoria. */
export async function enqueueMembershipChangedEffects(
  tx: Transaction,
  input: EffectContext & {
    groupId: string;
    targetUserId: string;
    auditEventType: AuditOutboxEventType;
    metadata?: AuditMetadata;
  },
): Promise<void> {
  const base = { aggregateType: "GROUP", aggregateId: input.groupId, groupId: input.groupId };
  await enqueueRealtime(tx, "REALTIME_GROUP_MEMBERSHIP_CHANGED", {
    ...base,
    requestId: input.requestId,
    // `targetUserId` roteia a publicação; `userId` compõe o envelope da Phase 5.
    payload: {
      groupId: input.groupId,
      targetUserId: input.targetUserId,
      userId: input.targetUserId,
    },
  });
  await enqueueAudit(tx, input.auditEventType, {
    ...base,
    actorUserId: input.actorUserId,
    targetType: "GROUP_MEMBERSHIP",
    targetId: input.targetUserId,
    requestId: input.requestId,
    metadata: input.metadata,
  });
}

// ------------------------------------------------------------------
// Check-ins
// ------------------------------------------------------------------

export interface CheckinEffectInput extends EffectContext {
  checkinId: string;
  groupId: string;
  ownerUserId: string;
}

export async function enqueueCheckinCreatedEffects(
  tx: Transaction,
  input: CheckinEffectInput,
): Promise<void> {
  const base = { aggregateType: "CHECKIN", aggregateId: input.checkinId, groupId: input.groupId };
  await enqueueRealtime(tx, "REALTIME_CHECKIN_CREATED", {
    ...base,
    requestId: input.requestId,
    payload: { checkinId: input.checkinId, groupId: input.groupId, userId: input.ownerUserId },
  });
  await enqueueAudit(tx, "AUDIT_CHECKIN_CREATED", {
    ...base,
    actorUserId: input.actorUserId,
    targetType: "CHECKIN",
    targetId: input.checkinId,
    requestId: input.requestId,
  });
}

export async function enqueueCheckinTransitionEffects(
  tx: Transaction,
  input: CheckinEffectInput & { transition: "SAFE" | "CANCELLED" },
): Promise<void> {
  const base = { aggregateType: "CHECKIN", aggregateId: input.checkinId, groupId: input.groupId };
  await enqueueRealtime(
    tx,
    input.transition === "SAFE" ? "REALTIME_CHECKIN_SAFE" : "REALTIME_CHECKIN_CANCELLED",
    {
      ...base,
      requestId: input.requestId,
      payload: { checkinId: input.checkinId, groupId: input.groupId, userId: input.ownerUserId },
    },
  );
  await enqueueAudit(
    tx,
    input.transition === "SAFE" ? "AUDIT_CHECKIN_MARKED_SAFE" : "AUDIT_CHECKIN_CANCELLED",
    {
      ...base,
      actorUserId: input.actorUserId,
      targetType: "CHECKIN",
      targetId: input.checkinId,
      requestId: input.requestId,
    },
  );
}

/** Vencimento pelo scheduler: push, realtime e auditoria, sem ator humano. */
export async function enqueueCheckinOverdueEffects(
  tx: Transaction,
  input: { checkinId: string; groupId: string; ownerUserId: string },
): Promise<void> {
  const base = { aggregateType: "CHECKIN", aggregateId: input.checkinId, groupId: input.groupId };
  await enqueue(tx, "PUSH_CHECKIN_OVERDUE", {
    ...base,
    payload: {
      actorUserId: input.ownerUserId,
      groupId: input.groupId,
      resourceId: input.checkinId,
    },
  });
  await enqueueRealtime(tx, "REALTIME_CHECKIN_OVERDUE", {
    ...base,
    payload: { checkinId: input.checkinId, groupId: input.groupId, userId: input.ownerUserId },
  });
  await enqueueAudit(tx, "AUDIT_CHECKIN_OVERDUE", {
    ...base,
    actorUserId: null,
    targetType: "CHECKIN",
    targetId: input.checkinId,
    metadata: { source: "scheduler" },
  });
}

// ------------------------------------------------------------------
// Trajetos
// ------------------------------------------------------------------

export interface JourneyEffectInput extends EffectContext {
  journeyId: string;
  groupId: string;
  ownerUserId: string;
}

export async function enqueueJourneyCreatedEffects(
  tx: Transaction,
  input: JourneyEffectInput & { hasDestination: boolean; liveLocationEnabled: boolean },
): Promise<void> {
  const base = { aggregateType: "JOURNEY", aggregateId: input.journeyId, groupId: input.groupId };
  await enqueueRealtime(tx, "REALTIME_JOURNEY_CREATED", {
    ...base,
    requestId: input.requestId,
    payload: { journeyId: input.journeyId, groupId: input.groupId, userId: input.ownerUserId },
  });
  await enqueueAudit(tx, "AUDIT_JOURNEY_CREATED", {
    ...base,
    actorUserId: input.actorUserId,
    targetType: "JOURNEY",
    targetId: input.journeyId,
    requestId: input.requestId,
    // Allow-listed: flags, nunca o rótulo do destino.
    metadata: {
      hasDestination: input.hasDestination,
      liveLocationEnabled: input.liveLocationEnabled,
    },
  });
}

export async function enqueueJourneyTransitionEffects(
  tx: Transaction,
  input: JourneyEffectInput & { transition: "ARRIVED" | "CANCELLED" },
): Promise<void> {
  const base = { aggregateType: "JOURNEY", aggregateId: input.journeyId, groupId: input.groupId };
  await enqueueRealtime(
    tx,
    input.transition === "ARRIVED" ? "REALTIME_JOURNEY_ARRIVED" : "REALTIME_JOURNEY_CANCELLED",
    {
      ...base,
      requestId: input.requestId,
      payload: { journeyId: input.journeyId, groupId: input.groupId, userId: input.ownerUserId },
    },
  );
  await enqueueAudit(
    tx,
    input.transition === "ARRIVED" ? "AUDIT_JOURNEY_ARRIVED" : "AUDIT_JOURNEY_CANCELLED",
    {
      ...base,
      actorUserId: input.actorUserId,
      targetType: "JOURNEY",
      targetId: input.journeyId,
      requestId: input.requestId,
    },
  );
}

export async function enqueueJourneyOverdueEffects(
  tx: Transaction,
  input: { journeyId: string; groupId: string; ownerUserId: string },
): Promise<void> {
  const base = { aggregateType: "JOURNEY", aggregateId: input.journeyId, groupId: input.groupId };
  await enqueue(tx, "PUSH_JOURNEY_OVERDUE", {
    ...base,
    payload: {
      actorUserId: input.ownerUserId,
      groupId: input.groupId,
      resourceId: input.journeyId,
    },
  });
  await enqueueRealtime(tx, "REALTIME_JOURNEY_OVERDUE", {
    ...base,
    payload: { journeyId: input.journeyId, groupId: input.groupId, userId: input.ownerUserId },
  });
  await enqueueAudit(tx, "AUDIT_JOURNEY_OVERDUE", {
    ...base,
    actorUserId: null,
    targetType: "JOURNEY",
    targetId: input.journeyId,
    metadata: { source: "scheduler" },
  });
}
