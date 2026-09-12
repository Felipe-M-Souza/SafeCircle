import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  alertLocationSessions,
  alertLocationUpdates,
  alertLocations,
  emergencyAlerts,
  type LiveLocationSessionStatus,
} from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";
import { loadAccessibleAlert, requireActiveAlert, requireCreator } from "./alert-access.js";
import type { LiveLocationUpdateInput } from "./alerts.schemas.js";

/**
 * Localização ao vivo (Phase 6).
 *
 * - Somente o criador do alerta inicia, envia e para; autoria vem do token.
 * - Somente membros atuais do grupo leem (externo → ALERT_NOT_FOUND).
 * - Uma sessão ACTIVE por alerta (índice único parcial); start é idempotente.
 * - Pontos idempotentes por (sessionId, clientUpdateId); throttling de ~1
 *   ponto a cada 2 s por sessão (429 LOCATION_UPDATE_TOO_FREQUENT).
 * - Sessão para automaticamente quando o alerta deixa de estar ACTIVE
 *   (na mesma transação da transição — ver alerts.service).
 * - Retenção: dados de localização apagados 30 dias após o encerramento.
 */

export const LIVE_LOCATION_MIN_INTERVAL_MS = 2000;
export const LIVE_LOCATION_HISTORY_LIMIT = 100;
export const LIVE_LOCATION_HISTORY_WINDOW_MS = 15 * 60 * 1000;
/** Tolerância para `capturedAt` no futuro (relógio do aparelho) e no passado. */
export const CAPTURED_AT_MAX_FUTURE_MS = 2 * 60 * 1000;
export const CAPTURED_AT_MAX_PAST_MS = 24 * 60 * 60 * 1000;
export const LOCATION_RETENTION_DAYS = 30;

type Db = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface LiveLocationPointView {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  capturedAt: string;
  /** Instante em que o servidor recebeu o ponto (referência operacional). */
  receivedAt: string;
}

export interface LiveLocationSessionView {
  sessionId: string;
  status: LiveLocationSessionStatus;
  startedAt: string;
  stoppedAt: string | null;
}

export interface LiveLocationStateView {
  status: LiveLocationSessionStatus | "INACTIVE";
  sessionId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  latest: LiveLocationPointView | null;
}

const sessionSelection = {
  id: alertLocationSessions.id,
  status: alertLocationSessions.status,
  startedAt: alertLocationSessions.startedAt,
  stoppedAt: alertLocationSessions.stoppedAt,
};

const pointSelection = {
  latitude: alertLocationUpdates.latitude,
  longitude: alertLocationUpdates.longitude,
  accuracy: alertLocationUpdates.accuracy,
  altitude: alertLocationUpdates.altitude,
  heading: alertLocationUpdates.heading,
  speed: alertLocationUpdates.speed,
  capturedAt: alertLocationUpdates.capturedAt,
  createdAt: alertLocationUpdates.createdAt,
};

type SessionRow = {
  id: string;
  status: LiveLocationSessionStatus;
  startedAt: Date;
  stoppedAt: Date | null;
};
type PointRow = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  capturedAt: Date;
  createdAt: Date;
};

function isUniqueViolation(error: unknown): boolean {
  const code = (value: unknown): unknown =>
    typeof value === "object" && value !== null && "code" in value
      ? (value as { code?: unknown }).code
      : undefined;
  return code(error) === "23505" || code((error as { cause?: unknown } | null)?.cause) === "23505";
}

function toSessionView(row: SessionRow): LiveLocationSessionView {
  return {
    sessionId: row.id,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
  };
}

function toPointView(row: PointRow): LiveLocationPointView {
  return {
    latitude: row.latitude,
    longitude: row.longitude,
    accuracy: row.accuracy,
    altitude: row.altitude,
    heading: row.heading,
    speed: row.speed,
    capturedAt: row.capturedAt.toISOString(),
    receivedAt: row.createdAt.toISOString(),
  };
}

async function findActiveSession(db: Db, alertId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select(sessionSelection)
    .from(alertLocationSessions)
    .where(
      and(eq(alertLocationSessions.alertId, alertId), eq(alertLocationSessions.status, "ACTIVE")),
    )
    .limit(1);
  return row ?? null;
}

async function findLatestSession(db: Db, alertId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select(sessionSelection)
    .from(alertLocationSessions)
    .where(eq(alertLocationSessions.alertId, alertId))
    .orderBy(desc(alertLocationSessions.startedAt), desc(alertLocationSessions.createdAt))
    .limit(1);
  return row ?? null;
}

async function findLatestPoint(db: Db, sessionId: string): Promise<PointRow | null> {
  const [row] = await db
    .select(pointSelection)
    .from(alertLocationUpdates)
    .where(eq(alertLocationUpdates.sessionId, sessionId))
    .orderBy(desc(alertLocationUpdates.createdAt), desc(alertLocationUpdates.id))
    .limit(1);
  return row ?? null;
}

// ------------------------------------------------------------------
// Criador: iniciar / enviar / parar
// ------------------------------------------------------------------

export async function startLiveLocation(
  db: Database,
  userId: string,
  alertId: string,
): Promise<{ session: LiveLocationSessionView; created: boolean }> {
  const alert = await loadAccessibleAlert(db, userId, alertId);
  requireCreator(alert, userId);
  requireActiveAlert(alert);

  const existing = await findActiveSession(db, alertId);
  if (existing) {
    return { session: toSessionView(existing), created: false };
  }
  try {
    const [created] = await db
      .insert(alertLocationSessions)
      .values({ alertId, userId, status: "ACTIVE" })
      .returning(sessionSelection);
    if (!created) {
      throw new Error("Falha ao iniciar localização ao vivo.");
    }
    return { session: toSessionView(created), created: true };
  } catch (error) {
    // Dois starts concorrentes: o índice único parcial garante uma sessão ACTIVE.
    if (isUniqueViolation(error)) {
      const winner = await findActiveSession(db, alertId);
      if (winner) {
        return { session: toSessionView(winner), created: false };
      }
    }
    throw error;
  }
}

export interface SendLiveLocationResult {
  sessionId: string;
  point: LiveLocationPointView;
  replayed: boolean;
}

export async function sendLiveLocationUpdate(
  db: Database,
  userId: string,
  alertId: string,
  input: LiveLocationUpdateInput,
  now: Date = new Date(),
): Promise<SendLiveLocationResult> {
  const alert = await loadAccessibleAlert(db, userId, alertId);
  requireCreator(alert, userId);
  requireActiveAlert(alert);

  const capturedAt = new Date(input.capturedAt);
  const delta = capturedAt.getTime() - now.getTime();
  if (delta > CAPTURED_AT_MAX_FUTURE_MS || delta < -CAPTURED_AT_MAX_PAST_MS) {
    throw errors.validation([{ path: "capturedAt", message: "Data de captura inválida." }]);
  }

  const session = await findActiveSession(db, alertId);
  if (!session) {
    throw errors.liveLocationNotActive();
  }

  const findExisting = async (): Promise<PointRow | null> => {
    const [row] = await db
      .select(pointSelection)
      .from(alertLocationUpdates)
      .where(
        and(
          eq(alertLocationUpdates.sessionId, session.id),
          eq(alertLocationUpdates.clientUpdateId, input.clientUpdateId),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  // Retry de rede com o mesmo clientUpdateId: devolve o ponto já gravado.
  const existing = await findExisting();
  if (existing) {
    return { sessionId: session.id, point: toPointView(existing), replayed: true };
  }

  // Throttling server-side por sessão (~1 ponto a cada 2 s).
  const latest = await findLatestPoint(db, session.id);
  if (latest && now.getTime() - latest.createdAt.getTime() < LIVE_LOCATION_MIN_INTERVAL_MS) {
    throw errors.locationUpdateTooFrequent();
  }

  const [inserted] = await db
    .insert(alertLocationUpdates)
    .values({
      sessionId: session.id,
      alertId,
      clientUpdateId: input.clientUpdateId,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: input.accuracy ?? null,
      altitude: input.altitude ?? null,
      heading: input.heading ?? null,
      speed: input.speed ?? null,
      capturedAt,
    })
    .onConflictDoNothing({
      target: [alertLocationUpdates.sessionId, alertLocationUpdates.clientUpdateId],
    })
    .returning(pointSelection);

  if (inserted) {
    return { sessionId: session.id, point: toPointView(inserted), replayed: false };
  }
  // Corrida com o próprio retry: a linha já existe.
  const winner = await findExisting();
  if (!winner) {
    throw new Error("Falha ao gravar ponto de localização.");
  }
  return { sessionId: session.id, point: toPointView(winner), replayed: true };
}

export async function stopLiveLocation(
  db: Database,
  userId: string,
  alertId: string,
): Promise<{ state: LiveLocationStateView; changed: boolean }> {
  const alert = await loadAccessibleAlert(db, userId, alertId);
  requireCreator(alert, userId);

  const now = new Date();
  const stopped = await db
    .update(alertLocationSessions)
    .set({ status: "STOPPED", stoppedAt: now, updatedAt: now })
    .where(
      and(eq(alertLocationSessions.alertId, alertId), eq(alertLocationSessions.status, "ACTIVE")),
    )
    .returning({ id: alertLocationSessions.id });

  return { state: await buildState(db, alertId), changed: stopped.length > 0 };
}

/**
 * Encerramento automático: para a sessão ACTIVE do alerta (chamado dentro da
 * transação que resolve/cancela o alerta). Devolve o id da sessão parada.
 */
export async function stopActiveSessionForAlert(
  db: Db,
  alertId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const [stopped] = await db
    .update(alertLocationSessions)
    .set({ status: "STOPPED", stoppedAt: now, updatedAt: now })
    .where(
      and(eq(alertLocationSessions.alertId, alertId), eq(alertLocationSessions.status, "ACTIVE")),
    )
    .returning({ id: alertLocationSessions.id });
  return stopped?.id ?? null;
}

// ------------------------------------------------------------------
// Membros: estado atual e histórico recente
// ------------------------------------------------------------------

async function buildState(db: Database, alertId: string): Promise<LiveLocationStateView> {
  const session = await findLatestSession(db, alertId);
  if (!session) {
    return { status: "INACTIVE", sessionId: null, startedAt: null, stoppedAt: null, latest: null };
  }
  const latest = await findLatestPoint(db, session.id);
  return {
    status: session.status,
    sessionId: session.id,
    startedAt: session.startedAt.toISOString(),
    stoppedAt: session.stoppedAt?.toISOString() ?? null,
    latest: latest ? toPointView(latest) : null,
  };
}

export async function getLiveLocationState(
  db: Database,
  userId: string,
  alertId: string,
): Promise<LiveLocationStateView> {
  await loadAccessibleAlert(db, userId, alertId);
  return buildState(db, alertId);
}

export interface LiveLocationHistoryView {
  sessionId: string | null;
  /** Pontos dos últimos 15 minutos (máx. 100), em ordem cronológica. */
  points: LiveLocationPointView[];
}

export async function getLiveLocationHistory(
  db: Database,
  userId: string,
  alertId: string,
  now: Date = new Date(),
): Promise<LiveLocationHistoryView> {
  await loadAccessibleAlert(db, userId, alertId);
  const session = await findLatestSession(db, alertId);
  if (!session) {
    return { sessionId: null, points: [] };
  }
  const cutoff = new Date(now.getTime() - LIVE_LOCATION_HISTORY_WINDOW_MS);
  const rows = await db
    .select(pointSelection)
    .from(alertLocationUpdates)
    .where(
      and(
        eq(alertLocationUpdates.sessionId, session.id),
        gte(alertLocationUpdates.createdAt, cutoff),
      ),
    )
    .orderBy(desc(alertLocationUpdates.createdAt), desc(alertLocationUpdates.id))
    .limit(LIVE_LOCATION_HISTORY_LIMIT);
  return { sessionId: session.id, points: rows.reverse().map(toPointView) };
}

// ------------------------------------------------------------------
// Retenção
// ------------------------------------------------------------------

export interface LocationCleanupSummary {
  alerts: number;
  updates: number;
  sessions: number;
  initialLocations: number;
}

/**
 * Apaga SOMENTE dados de localização (pontos ao vivo, sessões e a localização
 * inicial da Phase 3) de alertas encerrados há mais de `retentionDays`.
 * Nunca toca em alertas, grupos, usuários ou acknowledgements.
 */
export async function deleteExpiredLocationData(
  db: Database,
  now: Date = new Date(),
  retentionDays: number = LOCATION_RETENTION_DAYS,
): Promise<LocationCleanupSummary> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const expired = await db
    .select({ id: emergencyAlerts.id })
    .from(emergencyAlerts)
    .where(
      and(
        inArray(emergencyAlerts.status, ["RESOLVED", "CANCELLED"]),
        or(lt(emergencyAlerts.resolvedAt, cutoff), lt(emergencyAlerts.cancelledAt, cutoff)),
      ),
    );
  const alertIds = expired.map((row) => row.id);
  if (alertIds.length === 0) {
    return { alerts: 0, updates: 0, sessions: 0, initialLocations: 0 };
  }

  return db.transaction(async (tx) => {
    const updates = await tx
      .delete(alertLocationUpdates)
      .where(inArray(alertLocationUpdates.alertId, alertIds))
      .returning({ id: alertLocationUpdates.id });
    const sessions = await tx
      .delete(alertLocationSessions)
      .where(inArray(alertLocationSessions.alertId, alertIds))
      .returning({ id: alertLocationSessions.id });
    const initial = await tx
      .delete(alertLocations)
      .where(inArray(alertLocations.alertId, alertIds))
      .returning({ id: alertLocations.id });
    return {
      alerts: alertIds.length,
      updates: updates.length,
      sessions: sessions.length,
      initialLocations: initial.length,
    };
  });
}

/** Contagem de pontos de uma sessão (testes/observabilidade; sem coordenadas). */
export async function countSessionPoints(db: Database, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(alertLocationUpdates)
    .where(eq(alertLocationUpdates.sessionId, sessionId));
  return row?.count ?? 0;
}
