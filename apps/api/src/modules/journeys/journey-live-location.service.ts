import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  journeyLocationSessions,
  journeyLocationUpdates,
  safeJourneys,
  type LiveLocationSessionStatus,
} from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";
import type { LiveLocationUpdateInput } from "../alerts/alerts.schemas.js";
import {
  CAPTURED_AT_MAX_FUTURE_MS,
  CAPTURED_AT_MAX_PAST_MS,
  LIVE_LOCATION_HISTORY_LIMIT,
  LIVE_LOCATION_HISTORY_WINDOW_MS,
  LIVE_LOCATION_MIN_INTERVAL_MS,
  LOCATION_RETENTION_DAYS,
  type LiveLocationHistoryView,
  type LiveLocationPointView,
  type LiveLocationSessionView,
  type LiveLocationStateView,
} from "../alerts/live-location.service.js";
import {
  loadAccessibleJourney,
  requireJourneyOwner,
  requireLiveLocationEnabled,
  requireTrackableJourney,
} from "./journey-access.js";

/**
 * Localização ao vivo do trajeto (Phase 8) — tabelas próprias
 * (`journey_location_*`), nunca as de alerta.
 *
 * - Opt-in explícito: só trajetos com `liveLocationEnabled` aceitam sessão.
 * - Somente o dono inicia, envia e para; membros atuais leem.
 * - Uma sessão ACTIVE por trajeto (índice único parcial); start idempotente.
 * - Pontos idempotentes por (sessionId, clientUpdateId); throttling reutiliza
 *   os mesmos limites da Phase 6.
 * - Enquanto o trajeto está em andamento (ACTIVE ou OVERDUE) o
 *   compartilhamento continua; ARRIVED/CANCELLED encerram a sessão (na mesma
 *   transação da transição — ver journeys.service).
 * - Retenção: dados de localização apagados 30 dias após o encerramento.
 */

type Db = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

const sessionSelection = {
  id: journeyLocationSessions.id,
  status: journeyLocationSessions.status,
  startedAt: journeyLocationSessions.startedAt,
  stoppedAt: journeyLocationSessions.stoppedAt,
};

const pointSelection = {
  latitude: journeyLocationUpdates.latitude,
  longitude: journeyLocationUpdates.longitude,
  accuracy: journeyLocationUpdates.accuracy,
  altitude: journeyLocationUpdates.altitude,
  heading: journeyLocationUpdates.heading,
  speed: journeyLocationUpdates.speed,
  capturedAt: journeyLocationUpdates.capturedAt,
  createdAt: journeyLocationUpdates.createdAt,
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

async function findActiveSession(db: Db, journeyId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select(sessionSelection)
    .from(journeyLocationSessions)
    .where(
      and(
        eq(journeyLocationSessions.journeyId, journeyId),
        eq(journeyLocationSessions.status, "ACTIVE"),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function findLatestSession(db: Db, journeyId: string): Promise<SessionRow | null> {
  const [row] = await db
    .select(sessionSelection)
    .from(journeyLocationSessions)
    .where(eq(journeyLocationSessions.journeyId, journeyId))
    .orderBy(desc(journeyLocationSessions.startedAt), desc(journeyLocationSessions.createdAt))
    .limit(1);
  return row ?? null;
}

async function findLatestPoint(db: Db, sessionId: string): Promise<PointRow | null> {
  const [row] = await db
    .select(pointSelection)
    .from(journeyLocationUpdates)
    .where(eq(journeyLocationUpdates.sessionId, sessionId))
    .orderBy(desc(journeyLocationUpdates.createdAt), desc(journeyLocationUpdates.id))
    .limit(1);
  return row ?? null;
}

// ------------------------------------------------------------------
// Dono: iniciar / enviar / parar
// ------------------------------------------------------------------

export async function startJourneyLiveLocation(
  db: Database,
  userId: string,
  journeyId: string,
): Promise<{ session: LiveLocationSessionView; created: boolean }> {
  const journey = await loadAccessibleJourney(db, userId, journeyId);
  requireJourneyOwner(journey, userId);
  requireTrackableJourney(journey);
  requireLiveLocationEnabled(journey);

  const existing = await findActiveSession(db, journeyId);
  if (existing) {
    return { session: toSessionView(existing), created: false };
  }
  try {
    const [created] = await db
      .insert(journeyLocationSessions)
      .values({ journeyId, userId, status: "ACTIVE" })
      .returning(sessionSelection);
    if (!created) {
      throw new Error("Falha ao iniciar localização do trajeto.");
    }
    return { session: toSessionView(created), created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await findActiveSession(db, journeyId);
      if (winner) {
        return { session: toSessionView(winner), created: false };
      }
    }
    throw error;
  }
}

export interface SendJourneyLocationResult {
  sessionId: string;
  point: LiveLocationPointView;
  replayed: boolean;
}

export async function sendJourneyLiveLocationUpdate(
  db: Database,
  userId: string,
  journeyId: string,
  input: LiveLocationUpdateInput,
  now: Date = new Date(),
): Promise<SendJourneyLocationResult> {
  const journey = await loadAccessibleJourney(db, userId, journeyId);
  requireJourneyOwner(journey, userId);
  requireTrackableJourney(journey);
  requireLiveLocationEnabled(journey);

  const capturedAt = new Date(input.capturedAt);
  const delta = capturedAt.getTime() - now.getTime();
  if (delta > CAPTURED_AT_MAX_FUTURE_MS || delta < -CAPTURED_AT_MAX_PAST_MS) {
    throw errors.validation([{ path: "capturedAt", message: "Data de captura inválida." }]);
  }

  const session = await findActiveSession(db, journeyId);
  if (!session) {
    throw errors.journeyLiveLocationNotActive();
  }

  const findExisting = async (): Promise<PointRow | null> => {
    const [row] = await db
      .select(pointSelection)
      .from(journeyLocationUpdates)
      .where(
        and(
          eq(journeyLocationUpdates.sessionId, session.id),
          eq(journeyLocationUpdates.clientUpdateId, input.clientUpdateId),
        ),
      )
      .limit(1);
    return row ?? null;
  };

  const existing = await findExisting();
  if (existing) {
    return { sessionId: session.id, point: toPointView(existing), replayed: true };
  }

  const latest = await findLatestPoint(db, session.id);
  if (latest && now.getTime() - latest.createdAt.getTime() < LIVE_LOCATION_MIN_INTERVAL_MS) {
    // Corrida com um retry concorrente do mesmo ponto: replay (200), nunca 429.
    const raced = await findExisting();
    if (raced) {
      return { sessionId: session.id, point: toPointView(raced), replayed: true };
    }
    throw errors.locationUpdateTooFrequent();
  }

  const [inserted] = await db
    .insert(journeyLocationUpdates)
    .values({
      sessionId: session.id,
      journeyId,
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
      target: [journeyLocationUpdates.sessionId, journeyLocationUpdates.clientUpdateId],
    })
    .returning(pointSelection);

  if (inserted) {
    return { sessionId: session.id, point: toPointView(inserted), replayed: false };
  }
  const winner = await findExisting();
  if (!winner) {
    throw new Error("Falha ao gravar ponto de localização do trajeto.");
  }
  return { sessionId: session.id, point: toPointView(winner), replayed: true };
}

export async function stopJourneyLiveLocation(
  db: Database,
  userId: string,
  journeyId: string,
): Promise<{ state: LiveLocationStateView; changed: boolean }> {
  const journey = await loadAccessibleJourney(db, userId, journeyId);
  requireJourneyOwner(journey, userId);

  const now = new Date();
  const stopped = await db
    .update(journeyLocationSessions)
    .set({ status: "STOPPED", stoppedAt: now, updatedAt: now })
    .where(
      and(
        eq(journeyLocationSessions.journeyId, journeyId),
        eq(journeyLocationSessions.status, "ACTIVE"),
      ),
    )
    .returning({ id: journeyLocationSessions.id });

  return { state: await buildState(db, journeyId), changed: stopped.length > 0 };
}

/**
 * Encerramento automático: para a sessão ACTIVE do trajeto (chamado dentro da
 * transação que confirma a chegada ou cancela). Devolve o id da sessão parada.
 */
export async function stopActiveJourneySession(
  db: Db,
  journeyId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const [stopped] = await db
    .update(journeyLocationSessions)
    .set({ status: "STOPPED", stoppedAt: now, updatedAt: now })
    .where(
      and(
        eq(journeyLocationSessions.journeyId, journeyId),
        eq(journeyLocationSessions.status, "ACTIVE"),
      ),
    )
    .returning({ id: journeyLocationSessions.id });
  return stopped?.id ?? null;
}

// ------------------------------------------------------------------
// Membros: estado atual e histórico recente
// ------------------------------------------------------------------

async function buildState(db: Database, journeyId: string): Promise<LiveLocationStateView> {
  const session = await findLatestSession(db, journeyId);
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

export async function getJourneyLiveLocationState(
  db: Database,
  userId: string,
  journeyId: string,
): Promise<LiveLocationStateView> {
  await loadAccessibleJourney(db, userId, journeyId);
  return buildState(db, journeyId);
}

export async function getJourneyLiveLocationHistory(
  db: Database,
  userId: string,
  journeyId: string,
  now: Date = new Date(),
): Promise<LiveLocationHistoryView> {
  await loadAccessibleJourney(db, userId, journeyId);
  const session = await findLatestSession(db, journeyId);
  if (!session) {
    return { sessionId: null, points: [] };
  }
  const cutoff = new Date(now.getTime() - LIVE_LOCATION_HISTORY_WINDOW_MS);
  const rows = await db
    .select(pointSelection)
    .from(journeyLocationUpdates)
    .where(
      and(
        eq(journeyLocationUpdates.sessionId, session.id),
        gte(journeyLocationUpdates.createdAt, cutoff),
      ),
    )
    .orderBy(desc(journeyLocationUpdates.createdAt), desc(journeyLocationUpdates.id))
    .limit(LIVE_LOCATION_HISTORY_LIMIT);
  return { sessionId: session.id, points: rows.reverse().map(toPointView) };
}

// ------------------------------------------------------------------
// Retenção
// ------------------------------------------------------------------

export interface JourneyLocationCleanupSummary {
  journeys: number;
  updates: number;
  sessions: number;
}

/**
 * Apaga SOMENTE dados de localização (pontos e sessões) de trajetos
 * encerrados (ARRIVED/CANCELLED) há mais de `retentionDays`. Trajetos ACTIVE
 * ou OVERDUE em aberto nunca são tocados. Não apaga o trajeto em si (isso é da
 * retenção de 90 dias em journeys.service).
 */
export async function deleteExpiredJourneyLocationData(
  db: Database,
  now: Date = new Date(),
  retentionDays: number = LOCATION_RETENTION_DAYS,
): Promise<JourneyLocationCleanupSummary> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const expired = await db
    .select({ id: safeJourneys.id })
    .from(safeJourneys)
    .where(
      and(
        inArray(safeJourneys.status, ["ARRIVED", "CANCELLED"]),
        or(lt(safeJourneys.arrivedAt, cutoff), lt(safeJourneys.cancelledAt, cutoff)),
      ),
    );
  const journeyIds = expired.map((row) => row.id);
  if (journeyIds.length === 0) {
    return { journeys: 0, updates: 0, sessions: 0 };
  }

  return db.transaction(async (tx) => {
    const updates = await tx
      .delete(journeyLocationUpdates)
      .where(inArray(journeyLocationUpdates.journeyId, journeyIds))
      .returning({ id: journeyLocationUpdates.id });
    const sessions = await tx
      .delete(journeyLocationSessions)
      .where(inArray(journeyLocationSessions.journeyId, journeyIds))
      .returning({ id: journeyLocationSessions.id });
    return {
      journeys: journeyIds.length,
      updates: updates.length,
      sessions: sessions.length,
    };
  });
}

/** Contagem de pontos de uma sessão (testes/observabilidade; sem coordenadas). */
export async function countJourneySessionPoints(db: Database, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(journeyLocationUpdates)
    .where(eq(journeyLocationUpdates.sessionId, sessionId));
  return row?.count ?? 0;
}
