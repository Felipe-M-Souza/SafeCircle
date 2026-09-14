import { and, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  idempotencyKeys,
  safeJourneys,
  trustedGroups,
  users,
  type JourneyStatus,
} from "../../infrastructure/database/schema.js";
import {
  enqueueJourneyCreatedEffects,
  enqueueJourneyOverdueEffects,
  enqueueJourneyTransitionEffects,
  type DomainActionOptions,
} from "../../outbox/effects.js";
import { errors } from "../../shared/errors.js";
import { hashRequestPayload } from "../../shared/idempotency.js";
import { findMembershipRole, requireMembership } from "../groups/authorization.js";
import { stopActiveJourneySession } from "./journey-live-location.service.js";
import {
  JOURNEY_MAX_DURATION_MS,
  JOURNEY_MIN_DURATION_MS,
  type CreateJourneyInput,
} from "./journeys.schemas.js";

/**
 * Trajeto Seguro (Phase 8).
 *
 * - Somente membro atual cria (externo → GROUP_NOT_FOUND); um trajeto
 *   não-finalizado (ACTIVE ou OVERDUE) por usuário, garantido por índice único
 *   parcial → JOURNEY_ALREADY_ACTIVE.
 * - Criação idempotente pela infraestrutura de `Idempotency-Key`
 *   (escopo "journeys.create").
 * - Transições: ACTIVE→ARRIVED, ACTIVE→CANCELLED, ACTIVE→OVERDUE (scheduler),
 *   OVERDUE→ARRIVED, OVERDUE→CANCELLED. Sempre por update condicional.
 * - Visibilidade: dono e membros atuais do grupo; externo → JOURNEY_NOT_FOUND
 *   (anti-IDOR). Somente o dono confirma chegada/cancela (membro → FORBIDDEN).
 * - Um trajeto atrasado NÃO é emergência confirmada: nunca cria alerta.
 */

export const CREATE_JOURNEY_IDEMPOTENCY_SCOPE = "journeys.create";
export const JOURNEY_RETENTION_DAYS = 90;
export const GROUP_JOURNEYS_LIMIT = 50;
export const MY_JOURNEYS_LIMIT = 100;

const UNFINISHED_UNIQUE_INDEX = "safe_journeys_unfinished_per_user_unique";
const IDEMPOTENCY_KEY_UNIQUE_INDEX = "idempotency_keys_user_scope_key_unique";

type Db = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface JourneyView {
  id: string;
  groupId: string;
  groupName: string;
  user: { id: string; name: string };
  status: JourneyStatus;
  destinationLabel: string | null;
  expectedArrivalAt: string;
  liveLocationEnabled: boolean;
  startedAt: string;
  arrivedAt: string | null;
  cancelledAt: string | null;
  overdueAt: string | null;
  createdAt: string;
}

const selection = {
  id: safeJourneys.id,
  groupId: safeJourneys.groupId,
  groupName: trustedGroups.name,
  userId: users.id,
  userName: users.name,
  status: safeJourneys.status,
  destinationLabel: safeJourneys.destinationLabel,
  expectedArrivalAt: safeJourneys.expectedArrivalAt,
  liveLocationEnabled: safeJourneys.liveLocationEnabled,
  startedAt: safeJourneys.startedAt,
  arrivedAt: safeJourneys.arrivedAt,
  cancelledAt: safeJourneys.cancelledAt,
  overdueAt: safeJourneys.overdueAt,
  createdAt: safeJourneys.createdAt,
};

interface Row {
  id: string;
  groupId: string;
  groupName: string;
  userId: string;
  userName: string;
  status: JourneyStatus;
  destinationLabel: string | null;
  expectedArrivalAt: Date;
  liveLocationEnabled: boolean;
  startedAt: Date;
  arrivedAt: Date | null;
  cancelledAt: Date | null;
  overdueAt: Date | null;
  createdAt: Date;
}

function toView(row: Row): JourneyView {
  return {
    id: row.id,
    groupId: row.groupId,
    groupName: row.groupName,
    user: { id: row.userId, name: row.userName },
    status: row.status,
    destinationLabel: row.destinationLabel,
    expectedArrivalAt: row.expectedArrivalAt.toISOString(),
    liveLocationEnabled: row.liveLocationEnabled,
    startedAt: row.startedAt.toISOString(),
    arrivedAt: row.arrivedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    overdueAt: row.overdueAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function pgErrorField(error: unknown, field: string): unknown {
  const read = (value: unknown): unknown =>
    typeof value === "object" && value !== null && field in value
      ? (value as Record<string, unknown>)[field]
      : undefined;
  return read(error) ?? read((error as { cause?: unknown } | null)?.cause);
}

function uniqueViolationConstraint(error: unknown): string | null {
  if (pgErrorField(error, "code") !== "23505") return null;
  const name = pgErrorField(error, "constraint_name");
  return typeof name === "string" ? name : "";
}

function baseQuery(db: Db) {
  return db
    .select(selection)
    .from(safeJourneys)
    .innerJoin(trustedGroups, eq(trustedGroups.id, safeJourneys.groupId))
    .innerJoin(users, eq(users.id, safeJourneys.userId));
}

async function loadRow(db: Db, journeyId: string): Promise<Row | null> {
  const [row] = await baseQuery(db).where(eq(safeJourneys.id, journeyId)).limit(1);
  return row ?? null;
}

async function loadView(db: Db, journeyId: string): Promise<JourneyView> {
  const row = await loadRow(db, journeyId);
  if (!row) throw errors.journeyNotFound();
  return toView(row);
}

/** Dono ou membro atual do grupo; caso contrário JOURNEY_NOT_FOUND (anti-IDOR). */
async function loadAccessibleRow(db: Database, userId: string, journeyId: string): Promise<Row> {
  const row = await loadRow(db, journeyId);
  if (!row) throw errors.journeyNotFound();
  if (row.userId !== userId) {
    const role = await findMembershipRole(db, row.groupId, userId);
    if (!role) throw errors.journeyNotFound();
  }
  return row;
}

// ------------------------------------------------------------------
// Criação (idempotente)
// ------------------------------------------------------------------

/** Prazo: futuro, entre 10 minutos e 24 horas a partir do relógio do servidor. */
export function validateExpectedArrival(iso: string, now: Date): Date {
  const expected = new Date(iso);
  if (Number.isNaN(expected.getTime())) throw errors.invalidJourneyExpectedArrival();
  const delta = expected.getTime() - now.getTime();
  if (delta <= 0) {
    throw errors.invalidJourneyExpectedArrival("A chegada prevista precisa estar no futuro.");
  }
  if (delta < JOURNEY_MIN_DURATION_MS) {
    throw errors.invalidJourneyExpectedArrival("O prazo mínimo do trajeto é de 10 minutos.");
  }
  if (delta > JOURNEY_MAX_DURATION_MS) {
    throw errors.invalidJourneyExpectedArrival("O prazo máximo do trajeto é de 24 horas.");
  }
  return expected;
}

async function findIdempotencyKey(db: Db, userId: string, key: string) {
  const [row] = await db
    .select({ requestHash: idempotencyKeys.requestHash, resourceId: idempotencyKeys.resourceId })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.scope, CREATE_JOURNEY_IDEMPOTENCY_SCOPE),
        eq(idempotencyKeys.key, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function replay(
  db: Db,
  existing: { requestHash: string; resourceId: string | null },
  requestHash: string,
): Promise<{ journey: JourneyView; replayed: true }> {
  if (existing.requestHash !== requestHash) throw errors.idempotencyKeyReused();
  if (!existing.resourceId) throw new Error("Chave de idempotência sem recurso associado.");
  return { journey: await loadView(db, existing.resourceId), replayed: true };
}

export async function createJourney(
  db: Database,
  userId: string,
  input: CreateJourneyInput,
  idempotencyKey: string,
  now: Date = new Date(),
  options: DomainActionOptions = {},
): Promise<{ journey: JourneyView; replayed: boolean }> {
  await requireMembership(db, input.groupId, userId);
  const expectedArrivalAt = validateExpectedArrival(input.expectedArrivalAt, now);
  const destinationLabel = input.destinationLabel ?? null;
  const liveLocationEnabled = input.liveLocationEnabled;
  const requestHash = hashRequestPayload({
    groupId: input.groupId,
    destinationLabel,
    expectedArrivalAt: expectedArrivalAt.toISOString(),
    liveLocationEnabled,
  });

  const existing = await findIdempotencyKey(db, userId, idempotencyKey);
  if (existing) return replay(db, existing, requestHash);

  try {
    const journeyId = await db.transaction(async (tx) => {
      await tx.insert(idempotencyKeys).values({
        userId,
        scope: CREATE_JOURNEY_IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        requestHash,
      });
      const [created] = await tx
        .insert(safeJourneys)
        .values({
          userId,
          groupId: input.groupId,
          status: "ACTIVE",
          destinationLabel,
          expectedArrivalAt,
          liveLocationEnabled,
        })
        .returning({ id: safeJourneys.id });
      if (!created) throw new Error("Falha ao criar trajeto.");
      await tx
        .update(idempotencyKeys)
        .set({ resourceId: created.id })
        .where(
          and(
            eq(idempotencyKeys.userId, userId),
            eq(idempotencyKeys.scope, CREATE_JOURNEY_IDEMPOTENCY_SCOPE),
            eq(idempotencyKeys.key, idempotencyKey),
          ),
        );
      // Phase 10: efeitos na MESMA transação do trajeto.
      await enqueueJourneyCreatedEffects(tx, {
        journeyId: created.id,
        groupId: input.groupId,
        ownerUserId: userId,
        actorUserId: userId,
        hasDestination: destinationLabel !== null,
        liveLocationEnabled,
        requestId: options.requestId ?? null,
      });
      return created.id;
    });
    return { journey: await loadView(db, journeyId), replayed: false };
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === UNFINISHED_UNIQUE_INDEX) throw errors.journeyAlreadyActive();
    if (constraint === IDEMPOTENCY_KEY_UNIQUE_INDEX) {
      const winner = await findIdempotencyKey(db, userId, idempotencyKey);
      if (winner) return replay(db, winner, requestHash);
    }
    throw error;
  }
}

// ------------------------------------------------------------------
// Leitura
// ------------------------------------------------------------------

export async function listMyJourneys(
  db: Database,
  userId: string,
  status?: JourneyStatus,
): Promise<JourneyView[]> {
  const rows = await baseQuery(db)
    .where(
      status
        ? and(eq(safeJourneys.userId, userId), eq(safeJourneys.status, status))
        : eq(safeJourneys.userId, userId),
    )
    .orderBy(desc(safeJourneys.createdAt))
    .limit(MY_JOURNEYS_LIMIT);
  return rows.map(toView);
}

export async function getJourney(
  db: Database,
  userId: string,
  journeyId: string,
): Promise<JourneyView> {
  return toView(await loadAccessibleRow(db, userId, journeyId));
}

/** Trajetos do grupo (membros atuais), os mais recentes primeiro, com limite. */
export async function listGroupJourneys(
  db: Database,
  userId: string,
  groupId: string,
): Promise<JourneyView[]> {
  await requireMembership(db, groupId, userId);
  const rows = await baseQuery(db)
    .where(eq(safeJourneys.groupId, groupId))
    .orderBy(desc(safeJourneys.createdAt))
    .limit(GROUP_JOURNEYS_LIMIT);
  return rows.map(toView);
}

// ------------------------------------------------------------------
// Transições do dono
// ------------------------------------------------------------------

export interface JourneyTransitionResult {
  journey: JourneyView;
  /** Verdadeiro quando o estado persistido mudou (publica evento). */
  changed: boolean;
}

async function loadOwned(db: Database, userId: string, journeyId: string): Promise<Row> {
  const row = await loadAccessibleRow(db, userId, journeyId);
  if (row.userId !== userId) throw errors.forbidden();
  return row;
}

/**
 * ACTIVE|OVERDUE -> ARRIVED; já ARRIVED devolve o estado atual (idempotente).
 * Ao confirmar a chegada, encerra a sessão de localização ativa na mesma
 * transação (nunca continuar rastreando depois de chegar).
 */
export async function arriveJourney(
  db: Database,
  userId: string,
  journeyId: string,
  now: Date = new Date(),
  options: DomainActionOptions = {},
): Promise<JourneyTransitionResult> {
  const row = await loadOwned(db, userId, journeyId);
  if (row.status === "ARRIVED") return { journey: toView(row), changed: false };
  if (row.status === "CANCELLED") throw errors.invalidJourneyTransition();

  const changed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(safeJourneys)
      .set({ status: "ARRIVED", arrivedAt: now, updatedAt: now })
      .where(
        and(eq(safeJourneys.id, journeyId), inArray(safeJourneys.status, ["ACTIVE", "OVERDUE"])),
      )
      .returning({ id: safeJourneys.id });
    if (updated.length === 0) return false;
    await stopActiveJourneySession(tx, journeyId, now);
    // Phase 10: efeitos no MESMO COMMIT da transição.
    await enqueueJourneyTransitionEffects(tx, {
      journeyId,
      groupId: row.groupId,
      ownerUserId: row.userId,
      actorUserId: userId,
      transition: "ARRIVED",
      requestId: options.requestId ?? null,
    });
    return true;
  });

  if (!changed) {
    const current = await loadView(db, journeyId);
    if (current.status === "ARRIVED") return { journey: current, changed: false };
    throw errors.invalidJourneyTransition();
  }
  return { journey: await loadView(db, journeyId), changed: true };
}

/**
 * ACTIVE|OVERDUE -> CANCELLED; já CANCELLED devolve o estado atual
 * (idempotente). Encerra a sessão de localização ativa na mesma transação.
 */
export async function cancelJourney(
  db: Database,
  userId: string,
  journeyId: string,
  now: Date = new Date(),
  options: DomainActionOptions = {},
): Promise<JourneyTransitionResult> {
  const row = await loadOwned(db, userId, journeyId);
  if (row.status === "CANCELLED") return { journey: toView(row), changed: false };
  if (row.status === "ARRIVED") throw errors.invalidJourneyTransition();

  const changed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(safeJourneys)
      .set({ status: "CANCELLED", cancelledAt: now, updatedAt: now })
      .where(
        and(eq(safeJourneys.id, journeyId), inArray(safeJourneys.status, ["ACTIVE", "OVERDUE"])),
      )
      .returning({ id: safeJourneys.id });
    if (updated.length === 0) return false;
    await stopActiveJourneySession(tx, journeyId, now);
    // Phase 10: efeitos no MESMO COMMIT da transição.
    await enqueueJourneyTransitionEffects(tx, {
      journeyId,
      groupId: row.groupId,
      ownerUserId: row.userId,
      actorUserId: userId,
      transition: "CANCELLED",
      requestId: options.requestId ?? null,
    });
    return true;
  });

  if (!changed) {
    const current = await loadView(db, journeyId);
    if (current.status === "CANCELLED") return { journey: current, changed: false };
    throw errors.invalidJourneyTransition();
  }
  return { journey: await loadView(db, journeyId), changed: true };
}

// ------------------------------------------------------------------
// Vencimento (scheduler) e retenção
// ------------------------------------------------------------------

export interface OverdueJourney {
  id: string;
  userId: string;
  groupId: string;
}

/**
 * ACTIVE -> OVERDUE para prazos vencidos, em lote e de forma atômica: a
 * cláusula `status = 'ACTIVE' AND expected_arrival_at <= now` é reavaliada
 * após o lock de linha, então execuções concorrentes nunca vencem o mesmo
 * trajeto duas vezes. A localização ao vivo NÃO é encerrada aqui: enquanto o
 * trajeto não for finalizado o compartilhamento continua (se opt-in).
 */
export async function markOverdueBatch(
  db: Database,
  now: Date,
  batchSize: number,
): Promise<OverdueJourney[]> {
  // Phase 10: transição e efeitos no MESMO COMMIT (ver checkins.service).
  return db.transaction(async (tx) => {
    const due = tx
      .select({ id: safeJourneys.id })
      .from(safeJourneys)
      .where(and(eq(safeJourneys.status, "ACTIVE"), lte(safeJourneys.expectedArrivalAt, now)))
      .orderBy(safeJourneys.expectedArrivalAt)
      .limit(batchSize);

    const overdue = await tx
      .update(safeJourneys)
      .set({ status: "OVERDUE", overdueAt: now, updatedAt: now })
      .where(
        and(
          inArray(safeJourneys.id, due),
          eq(safeJourneys.status, "ACTIVE"),
          lte(safeJourneys.expectedArrivalAt, now),
        ),
      )
      .returning({
        id: safeJourneys.id,
        userId: safeJourneys.userId,
        groupId: safeJourneys.groupId,
      });

    for (const journey of overdue) {
      await enqueueJourneyOverdueEffects(tx, {
        journeyId: journey.id,
        groupId: journey.groupId,
        ownerUserId: journey.userId,
      });
    }
    return overdue;
  });
}

/**
 * Retenção: apaga trajetos finalizados (ARRIVED/CANCELLED/OVERDUE) cujo
 * encerramento ocorreu há mais de `retentionDays`. Nunca apaga ACTIVE nem
 * OVERDUE em aberto — apenas OVERDUE cujo `overdueAt` é antigo. As sessões e
 * pontos de localização caem por cascade (FK ON DELETE CASCADE).
 */
export async function deleteExpiredJourneys(
  db: Database,
  now: Date = new Date(),
  retentionDays: number = JOURNEY_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(safeJourneys)
    .where(
      and(
        ne(safeJourneys.status, "ACTIVE"),
        sql`coalesce(${safeJourneys.arrivedAt}, ${safeJourneys.cancelledAt}, ${safeJourneys.overdueAt}, ${safeJourneys.updatedAt}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: safeJourneys.id });
  return deleted.length;
}
