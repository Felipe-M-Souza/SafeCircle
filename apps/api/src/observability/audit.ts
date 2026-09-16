import { lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../infrastructure/database/client.js";
import { auditEvents } from "../infrastructure/database/schema.js";
import { auditEventsTotal, auditFailuresTotal, safeLabel } from "./metrics.js";
import { isValidRequestId } from "./request-context.js";

/**
 * Auditoria de ações críticas (Phase 9).
 *
 * Não é event sourcing: é a trilha mínima para segurança, investigação e
 * suporte. Três invariantes:
 *
 * 1. **Conjunto explícito de eventos** — só o que está em `AUDIT_EVENT_TYPES`
 *    é auditado. GETs de rotina não geram trilha.
 * 2. **Metadata allow-listed** — apenas as chaves de `ALLOWED_METADATA_KEYS`,
 *    com valores escalares curtos. Nunca body completo, senha, token, push
 *    token, coordenada, endereço ou resposta bruta de provedor.
 * 3. **Auditoria nunca derruba a operação** — falha ao gravar é logada e
 *    contabilizada (`safecircle_audit_failures_total`), mas o fluxo de
 *    negócio segue. Limitação aceita e documentada no ADR 0010; a durabilidade
 *    forte (outbox) fica para a Phase 10.
 *
 * IP e User-Agent NÃO são persistidos nesta fase (anti-fingerprinting).
 */

export const AUDIT_EVENT_TYPES = [
  // Autenticação
  "AUTH_LOGIN_SUCCEEDED",
  "AUTH_LOGIN_FAILED",
  "AUTH_LOGOUT",
  // Sessões e privacidade (Phase 11)
  "AUTH_SESSION_REVOKED",
  "AUTH_OTHER_SESSIONS_REVOKED",
  "AUTH_REFRESH_REUSE_DETECTED",
  "PRIVACY_EXPORT_REQUESTED",
  // Exclusão de conta e propriedade de grupo (Phase 12)
  "ACCOUNT_DELETION_REQUESTED",
  "ACCOUNT_DELETION_COMPLETED",
  "GROUP_OWNERSHIP_TRANSFERRED",
  // Grupos
  "GROUP_CREATED",
  "GROUP_MEMBER_REMOVED",
  "GROUP_MEMBER_ROLE_CHANGED",
  // Alerta de emergência
  "ALERT_CREATED",
  "ALERT_RESOLVED",
  "ALERT_CANCELLED",
  // Localização ao vivo
  "LIVE_LOCATION_STARTED",
  "LIVE_LOCATION_STOPPED",
  // Check-in de segurança
  "CHECKIN_CREATED",
  "CHECKIN_MARKED_SAFE",
  "CHECKIN_CANCELLED",
  "CHECKIN_OVERDUE",
  // Trajeto seguro
  "JOURNEY_CREATED",
  "JOURNEY_ARRIVED",
  "JOURNEY_CANCELLED",
  "JOURNEY_OVERDUE",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export type AuditOutcome = "SUCCEEDED" | "FAILED";

export type AuditTargetType =
  | "USER"
  | "SESSION"
  | "GROUP"
  | "GROUP_MEMBERSHIP"
  | "ALERT"
  | "CHECKIN"
  | "JOURNEY"
  | "LIVE_LOCATION_SESSION";

/**
 * Chaves permitidas em `metadata`. Tudo fora desta lista é descartado —
 * allow-list, nunca deny-list (uma deny-list esquece o próximo campo sensível).
 */
export const ALLOWED_METADATA_KEYS = [
  "resource",
  "role",
  "previousRole",
  "status",
  "previousStatus",
  "reason",
  "source",
  "replayed",
  "changed",
  "recipientCount",
  "memberCount",
  "durationMinutes",
  "hasDestination",
  "liveLocationEnabled",
  // Phase 11: quantas sessões uma revogação em lote atingiu (número, nunca ids).
  "revokedCount",
  // Phase 12: quantos grupos (sem outros membros) foram apagados com a conta.
  "groupsDeleted",
] as const;

export type AuditMetadataKey = (typeof ALLOWED_METADATA_KEYS)[number];
export type AuditMetadata = Partial<Record<AuditMetadataKey, string | number | boolean>>;

const METADATA_STRING_MAX = 60;
const allowedKeys = new Set<string>(ALLOWED_METADATA_KEYS);

/**
 * Filtra a metadata: mantém só chaves permitidas com valores escalares curtos.
 * Strings passam por `safeLabel` (sem UUID, alfabeto restrito) — mesmo aqui
 * evitamos gravar identificadores soltos fora dos campos próprios.
 */
export function sanitizeMetadata(
  metadata: AuditMetadata | undefined,
): Record<string, string | number | boolean> | null {
  if (!metadata) return null;
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!allowedKeys.has(key) || value === undefined || value === null) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) clean[key] = value;
      continue;
    }
    if (typeof value === "boolean") {
      clean[key] = value;
      continue;
    }
    if (typeof value === "string") {
      const safe = safeLabel(value.slice(0, METADATA_STRING_MAX), "");
      if (safe) clean[key] = safe;
    }
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

export interface AuditContext {
  db: Database;
  log: FastifyBaseLogger;
}

export interface AuditEventInput {
  eventType: AuditEventType;
  /** Nulo/ausente em eventos do sistema (scheduler). */
  actorUserId?: string | null;
  targetType?: AuditTargetType;
  targetId?: string | null;
  groupId?: string | null;
  outcome?: AuditOutcome;
  requestId?: string | null;
  metadata?: AuditMetadata;
}

/**
 * Persiste um evento de auditoria. Nunca lança: a operação de negócio que a
 * originou não pode falhar por causa da trilha.
 */
export async function recordAuditEvent(
  ctx: AuditContext,
  input: AuditEventInput,
): Promise<boolean> {
  const outcome: AuditOutcome = input.outcome ?? "SUCCEEDED";
  try {
    await ctx.db.insert(auditEvents).values({
      eventType: input.eventType,
      actorUserId: input.actorUserId ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      groupId: input.groupId ?? null,
      outcome,
      requestId: isValidRequestId(input.requestId) ? input.requestId : null,
      metadata: sanitizeMetadata(input.metadata),
    });
    auditEventsTotal.inc({ event_type: input.eventType, outcome });
    return true;
  } catch (error) {
    auditFailuresTotal.inc({ event_type: input.eventType });
    ctx.log.error(
      {
        event: "audit_write_failed",
        err: error,
        auditEventType: input.eventType,
        requestId: input.requestId ?? undefined,
      },
      "Falha ao registrar evento de auditoria",
    );
    return false;
  }
}

// ------------------------------------------------------------------
// Retenção
// ------------------------------------------------------------------

export const AUDIT_RETENTION_DAYS = 180;

/**
 * Apaga eventos de auditoria mais antigos que `retentionDays`.
 * NUNCA toca em entidades de domínio — só na própria trilha.
 */
export async function deleteExpiredAuditEvents(
  db: Database,
  now: Date = new Date(),
  retentionDays: number = AUDIT_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(auditEvents)
    .where(lt(auditEvents.createdAt, cutoff))
    .returning({ id: auditEvents.id });
  return deleted.length;
}
