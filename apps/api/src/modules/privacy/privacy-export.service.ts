import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  alertAcknowledgements,
  alertLocationSessions,
  alertLocations,
  authSessions,
  emergencyAlerts,
  groupInvitations,
  groupMemberships,
  journeyLocationSessions,
  pushDevices,
  safeJourneys,
  safetyCheckins,
  trustedGroups,
  users,
} from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";

/**
 * Exportação dos próprios dados (Phase 11).
 *
 * Um único princípio decide o que entra: **é do usuário, ou é contexto mínimo
 * sem o qual o dado dele não faz sentido** (o nome do grupo ao lado da
 * membership, por exemplo). Tudo o mais fica fora, em especial:
 *
 * - qualquer segredo (hash de senha, hash de refresh, histórico de refresh,
 *   push token, tokens de acesso);
 * - qualquer dado de **terceiros** (e-mail de outros membros, localização de
 *   outras pessoas, quem convidou);
 * - internos operacionais (outbox, auditoria, métricas).
 *
 * A localização inicial dos alertas do próprio usuário entra porque é dele.
 * Os pontos de localização ao vivo NÃO entram individualmente: entram como
 * resumo de sessão (quando começou e terminou). Manter a exportação limitada
 * em tamanho e em precisão reduz o que um token roubado consegue extrair de
 * uma vez.
 */

export const PRIVACY_EXPORT_VERSION = 1;
const LIST_LIMIT = 500;

export interface PrivacyExport {
  version: number;
  generatedAt: string;
  profile: { id: string; name: string; email: string; createdAt: string };
  memberships: Array<{ groupId: string; groupName: string; role: string; since: string }>;
  invitations: Array<{
    groupId: string;
    groupName: string;
    status: string;
    createdAt: string;
    expiresAt: string;
  }>;
  alerts: Array<{
    id: string;
    groupId: string;
    status: string;
    activatedAt: string;
    resolvedAt: string | null;
    cancelledAt: string | null;
    initialLocation: { latitude: number; longitude: number; accuracy: number | null } | null;
    liveLocationSessions: Array<{ startedAt: string; stoppedAt: string | null }>;
  }>;
  acknowledgements: Array<{ alertId: string; type: string; updatedAt: string }>;
  checkins: Array<{
    id: string;
    groupId: string;
    status: string;
    dueAt: string;
    confirmedAt: string | null;
    cancelledAt: string | null;
    overdueAt: string | null;
    createdAt: string;
  }>;
  journeys: Array<{
    id: string;
    groupId: string;
    status: string;
    destinationLabel: string | null;
    expectedArrivalAt: string;
    liveLocationEnabled: boolean;
    startedAt: string;
    arrivedAt: string | null;
    cancelledAt: string | null;
    overdueAt: string | null;
    liveLocationSessions: Array<{ startedAt: string; stoppedAt: string | null }>;
  }>;
  sessions: Array<{
    sessionId: string;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
    current: boolean;
  }>;
  pushDevices: Array<{
    id: string;
    platform: string;
    deviceId: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

const iso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;
const isoRequired = (value: Date): string => value.toISOString();

export async function buildPrivacyExport(
  db: Database,
  userId: string,
  currentSessionId: string,
  now: Date = new Date(),
): Promise<PrivacyExport> {
  const [user] = await db
    .select({ id: users.id, name: users.name, email: users.email, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) throw errors.unauthorized();

  const memberships = await db
    .select({
      groupId: groupMemberships.groupId,
      groupName: trustedGroups.name,
      role: groupMemberships.role,
      since: groupMemberships.createdAt,
    })
    .from(groupMemberships)
    .innerJoin(trustedGroups, eq(trustedGroups.id, groupMemberships.groupId))
    .where(eq(groupMemberships.userId, userId))
    .orderBy(desc(groupMemberships.createdAt))
    .limit(LIST_LIMIT);

  // Convites destinados ao usuário: o grupo, não quem convidou.
  const invitations = await db
    .select({
      groupId: groupInvitations.groupId,
      groupName: trustedGroups.name,
      status: groupInvitations.status,
      createdAt: groupInvitations.createdAt,
      expiresAt: groupInvitations.expiresAt,
    })
    .from(groupInvitations)
    .innerJoin(trustedGroups, eq(trustedGroups.id, groupInvitations.groupId))
    .where(eq(groupInvitations.invitedEmail, user.email))
    .orderBy(desc(groupInvitations.createdAt))
    .limit(LIST_LIMIT);

  const alerts = await db
    .select({
      id: emergencyAlerts.id,
      groupId: emergencyAlerts.groupId,
      status: emergencyAlerts.status,
      activatedAt: emergencyAlerts.activatedAt,
      resolvedAt: emergencyAlerts.resolvedAt,
      cancelledAt: emergencyAlerts.cancelledAt,
      latitude: alertLocations.latitude,
      longitude: alertLocations.longitude,
      accuracy: alertLocations.accuracy,
    })
    .from(emergencyAlerts)
    .leftJoin(alertLocations, eq(alertLocations.alertId, emergencyAlerts.id))
    .where(eq(emergencyAlerts.createdByUserId, userId))
    .orderBy(desc(emergencyAlerts.activatedAt))
    .limit(LIST_LIMIT);

  const alertSessions = await db
    .select({
      alertId: alertLocationSessions.alertId,
      startedAt: alertLocationSessions.startedAt,
      stoppedAt: alertLocationSessions.stoppedAt,
    })
    .from(alertLocationSessions)
    .where(eq(alertLocationSessions.userId, userId))
    .orderBy(desc(alertLocationSessions.startedAt))
    .limit(LIST_LIMIT);

  const acknowledgements = await db
    .select({
      alertId: alertAcknowledgements.alertId,
      type: alertAcknowledgements.type,
      updatedAt: alertAcknowledgements.updatedAt,
    })
    .from(alertAcknowledgements)
    .where(eq(alertAcknowledgements.userId, userId))
    .orderBy(desc(alertAcknowledgements.updatedAt))
    .limit(LIST_LIMIT);

  const checkins = await db
    .select({
      id: safetyCheckins.id,
      groupId: safetyCheckins.groupId,
      status: safetyCheckins.status,
      dueAt: safetyCheckins.dueAt,
      confirmedAt: safetyCheckins.confirmedAt,
      cancelledAt: safetyCheckins.cancelledAt,
      overdueAt: safetyCheckins.overdueAt,
      createdAt: safetyCheckins.createdAt,
    })
    .from(safetyCheckins)
    .where(eq(safetyCheckins.userId, userId))
    .orderBy(desc(safetyCheckins.createdAt))
    .limit(LIST_LIMIT);

  const journeys = await db
    .select({
      id: safeJourneys.id,
      groupId: safeJourneys.groupId,
      status: safeJourneys.status,
      destinationLabel: safeJourneys.destinationLabel,
      expectedArrivalAt: safeJourneys.expectedArrivalAt,
      liveLocationEnabled: safeJourneys.liveLocationEnabled,
      startedAt: safeJourneys.startedAt,
      arrivedAt: safeJourneys.arrivedAt,
      cancelledAt: safeJourneys.cancelledAt,
      overdueAt: safeJourneys.overdueAt,
    })
    .from(safeJourneys)
    .where(eq(safeJourneys.userId, userId))
    .orderBy(desc(safeJourneys.startedAt))
    .limit(LIST_LIMIT);

  const journeySessions = await db
    .select({
      journeyId: journeyLocationSessions.journeyId,
      startedAt: journeyLocationSessions.startedAt,
      stoppedAt: journeyLocationSessions.stoppedAt,
    })
    .from(journeyLocationSessions)
    .where(eq(journeyLocationSessions.userId, userId))
    .orderBy(desc(journeyLocationSessions.startedAt))
    .limit(LIST_LIMIT);

  // Sessões ativas, no mesmo formato de GET /me/sessions: nada de hash.
  const sessions = await db
    .select({
      id: authSessions.id,
      createdAt: authSessions.createdAt,
      lastUsedAt: authSessions.lastUsedAt,
      expiresAt: authSessions.expiresAt,
    })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ),
    )
    .orderBy(desc(authSessions.createdAt))
    .limit(LIST_LIMIT);

  // Dispositivos: plataforma e id de instalação; o push token NUNCA.
  const devices = await db
    .select({
      id: pushDevices.id,
      platform: pushDevices.platform,
      deviceId: pushDevices.deviceId,
      isActive: pushDevices.isActive,
      createdAt: pushDevices.createdAt,
    })
    .from(pushDevices)
    .where(eq(pushDevices.userId, userId))
    .orderBy(desc(pushDevices.createdAt))
    .limit(LIST_LIMIT);

  const sessionsByAlert = groupBy(alertSessions, (row) => row.alertId);
  const sessionsByJourney = groupBy(journeySessions, (row) => row.journeyId);

  return {
    version: PRIVACY_EXPORT_VERSION,
    generatedAt: now.toISOString(),
    profile: {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: isoRequired(user.createdAt),
    },
    memberships: memberships.map((row) => ({
      groupId: row.groupId,
      groupName: row.groupName,
      role: row.role,
      since: isoRequired(row.since),
    })),
    invitations: invitations.map((row) => ({
      groupId: row.groupId,
      groupName: row.groupName,
      status: row.status,
      createdAt: isoRequired(row.createdAt),
      expiresAt: isoRequired(row.expiresAt),
    })),
    alerts: alerts.map((row) => ({
      id: row.id,
      groupId: row.groupId,
      status: row.status,
      activatedAt: isoRequired(row.activatedAt),
      resolvedAt: iso(row.resolvedAt),
      cancelledAt: iso(row.cancelledAt),
      initialLocation:
        row.latitude !== null && row.longitude !== null
          ? { latitude: row.latitude, longitude: row.longitude, accuracy: row.accuracy ?? null }
          : null,
      liveLocationSessions: (sessionsByAlert.get(row.id) ?? []).map((session) => ({
        startedAt: isoRequired(session.startedAt),
        stoppedAt: iso(session.stoppedAt),
      })),
    })),
    acknowledgements: acknowledgements.map((row) => ({
      alertId: row.alertId,
      type: row.type,
      updatedAt: isoRequired(row.updatedAt),
    })),
    checkins: checkins.map((row) => ({
      id: row.id,
      groupId: row.groupId,
      status: row.status,
      dueAt: isoRequired(row.dueAt),
      confirmedAt: iso(row.confirmedAt),
      cancelledAt: iso(row.cancelledAt),
      overdueAt: iso(row.overdueAt),
      createdAt: isoRequired(row.createdAt),
    })),
    journeys: journeys.map((row) => ({
      id: row.id,
      groupId: row.groupId,
      status: row.status,
      destinationLabel: row.destinationLabel,
      expectedArrivalAt: isoRequired(row.expectedArrivalAt),
      liveLocationEnabled: row.liveLocationEnabled,
      startedAt: isoRequired(row.startedAt),
      arrivedAt: iso(row.arrivedAt),
      cancelledAt: iso(row.cancelledAt),
      overdueAt: iso(row.overdueAt),
      liveLocationSessions: (sessionsByJourney.get(row.id) ?? []).map((session) => ({
        startedAt: isoRequired(session.startedAt),
        stoppedAt: iso(session.stoppedAt),
      })),
    })),
    sessions: sessions.map((row) => ({
      sessionId: row.id,
      createdAt: isoRequired(row.createdAt),
      lastUsedAt: iso(row.lastUsedAt),
      expiresAt: isoRequired(row.expiresAt),
      current: row.id === currentSessionId,
    })),
    pushDevices: devices.map((row) => ({
      id: row.id,
      platform: row.platform,
      deviceId: row.deviceId,
      isActive: row.isActive,
      createdAt: isoRequired(row.createdAt),
    })),
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** Quantos alertas o usuário criou (diagnóstico e testes). */
export async function countOwnAlerts(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(emergencyAlerts)
    .where(eq(emergencyAlerts.createdByUserId, userId));
  return Number(row?.total ?? 0);
}
