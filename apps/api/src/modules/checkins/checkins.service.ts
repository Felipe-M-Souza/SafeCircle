import { and, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  idempotencyKeys,
  safetyCheckins,
  trustedGroups,
  users,
  type CheckinStatus,
} from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";
import { hashRequestPayload } from "../../shared/idempotency.js";
import { findMembershipRole, requireMembership } from "../groups/authorization.js";
import {
  CHECKIN_MAX_DURATION_MS,
  CHECKIN_MIN_DURATION_MS,
  type CreateCheckinInput,
} from "./checkins.schemas.js";

/**
 * Check-in de Segurança (Phase 7).
 *
 * - Somente membro atual cria (externo → GROUP_NOT_FOUND); um ACTIVE por
 *   (usuário, grupo), garantido por índice único parcial → CHECKIN_ALREADY_ACTIVE.
 * - Criação idempotente pela infraestrutura de `Idempotency-Key`
 *   (escopo "checkins.create").
 * - Transições: ACTIVE→SAFE, ACTIVE→CANCELLED, ACTIVE→OVERDUE (scheduler),
 *   OVERDUE→SAFE. Sempre por update condicional (compare-and-swap).
 * - Visibilidade: dono e membros atuais do grupo; externo → CHECKIN_NOT_FOUND
 *   (anti-IDOR). Somente o dono confirma/cancela (membro → FORBIDDEN).
 * - Um check-in vencido NÃO é emergência confirmada: nunca cria alerta.
 */

export const CREATE_CHECKIN_IDEMPOTENCY_SCOPE = "checkins.create";
export const CHECKIN_RETENTION_DAYS = 90;
export const GROUP_CHECKINS_LIMIT = 50;
export const MY_CHECKINS_LIMIT = 100;

const ACTIVE_UNIQUE_INDEX = "safety_checkins_active_per_user_group_unique";
const IDEMPOTENCY_KEY_UNIQUE_INDEX = "idempotency_keys_user_scope_key_unique";

type Db = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Clock = () => Date;

export interface CheckinView {
  id: string;
  groupId: string;
  groupName: string;
  user: { id: string; name: string };
  status: CheckinStatus;
  dueAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  overdueAt: string | null;
  createdAt: string;
}

const selection = {
  id: safetyCheckins.id,
  groupId: safetyCheckins.groupId,
  groupName: trustedGroups.name,
  userId: users.id,
  userName: users.name,
  status: safetyCheckins.status,
  dueAt: safetyCheckins.dueAt,
  confirmedAt: safetyCheckins.confirmedAt,
  cancelledAt: safetyCheckins.cancelledAt,
  overdueAt: safetyCheckins.overdueAt,
  createdAt: safetyCheckins.createdAt,
};

interface Row {
  id: string;
  groupId: string;
  groupName: string;
  userId: string;
  userName: string;
  status: CheckinStatus;
  dueAt: Date;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  overdueAt: Date | null;
  createdAt: Date;
}

function toView(row: Row): CheckinView {
  return {
    id: row.id,
    groupId: row.groupId,
    groupName: row.groupName,
    user: { id: row.userId, name: row.userName },
    status: row.status,
    dueAt: row.dueAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
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
    .from(safetyCheckins)
    .innerJoin(trustedGroups, eq(trustedGroups.id, safetyCheckins.groupId))
    .innerJoin(users, eq(users.id, safetyCheckins.userId));
}

async function loadRow(db: Db, checkinId: string): Promise<Row | null> {
  const [row] = await baseQuery(db).where(eq(safetyCheckins.id, checkinId)).limit(1);
  return row ?? null;
}

async function loadView(db: Db, checkinId: string): Promise<CheckinView> {
  const row = await loadRow(db, checkinId);
  if (!row) throw errors.checkinNotFound();
  return toView(row);
}

/** Dono ou membro atual do grupo; caso contrário CHECKIN_NOT_FOUND (anti-IDOR). */
async function loadAccessibleRow(db: Database, userId: string, checkinId: string): Promise<Row> {
  const row = await loadRow(db, checkinId);
  if (!row) throw errors.checkinNotFound();
  if (row.userId !== userId) {
    const role = await findMembershipRole(db, row.groupId, userId);
    if (!role) throw errors.checkinNotFound();
  }
  return row;
}

// ------------------------------------------------------------------
// Criação (idempotente)
// ------------------------------------------------------------------

/** Prazo: futuro, entre 5 minutos e 24 horas a partir do relógio do servidor. */
export function validateDueAt(dueAtIso: string, now: Date): Date {
  const dueAt = new Date(dueAtIso);
  if (Number.isNaN(dueAt.getTime())) throw errors.invalidCheckinDueAt();
  const delta = dueAt.getTime() - now.getTime();
  if (delta <= 0) throw errors.invalidCheckinDueAt("O prazo do check-in precisa estar no futuro.");
  if (delta < CHECKIN_MIN_DURATION_MS) {
    throw errors.invalidCheckinDueAt("O prazo mínimo do check-in é de 5 minutos.");
  }
  if (delta > CHECKIN_MAX_DURATION_MS) {
    throw errors.invalidCheckinDueAt("O prazo máximo do check-in é de 24 horas.");
  }
  return dueAt;
}

async function findIdempotencyKey(db: Db, userId: string, key: string) {
  const [row] = await db
    .select({ requestHash: idempotencyKeys.requestHash, resourceId: idempotencyKeys.resourceId })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.scope, CREATE_CHECKIN_IDEMPOTENCY_SCOPE),
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
): Promise<{ checkin: CheckinView; replayed: true }> {
  if (existing.requestHash !== requestHash) throw errors.idempotencyKeyReused();
  if (!existing.resourceId) throw new Error("Chave de idempotência sem recurso associado.");
  return { checkin: await loadView(db, existing.resourceId), replayed: true };
}

export async function createCheckin(
  db: Database,
  userId: string,
  input: CreateCheckinInput,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<{ checkin: CheckinView; replayed: boolean }> {
  await requireMembership(db, input.groupId, userId);
  const dueAt = validateDueAt(input.dueAt, now);
  const requestHash = hashRequestPayload({ groupId: input.groupId, dueAt: dueAt.toISOString() });

  const existing = await findIdempotencyKey(db, userId, idempotencyKey);
  if (existing) return replay(db, existing, requestHash);

  try {
    const checkinId = await db.transaction(async (tx) => {
      await tx.insert(idempotencyKeys).values({
        userId,
        scope: CREATE_CHECKIN_IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        requestHash,
      });
      const [created] = await tx
        .insert(safetyCheckins)
        .values({ userId, groupId: input.groupId, status: "ACTIVE", dueAt })
        .returning({ id: safetyCheckins.id });
      if (!created) throw new Error("Falha ao criar check-in.");
      await tx
        .update(idempotencyKeys)
        .set({ resourceId: created.id })
        .where(
          and(
            eq(idempotencyKeys.userId, userId),
            eq(idempotencyKeys.scope, CREATE_CHECKIN_IDEMPOTENCY_SCOPE),
            eq(idempotencyKeys.key, idempotencyKey),
          ),
        );
      return created.id;
    });
    return { checkin: await loadView(db, checkinId), replayed: false };
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === ACTIVE_UNIQUE_INDEX) throw errors.checkinAlreadyActive();
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

export async function listMyCheckins(
  db: Database,
  userId: string,
  status?: CheckinStatus,
): Promise<CheckinView[]> {
  const rows = await baseQuery(db)
    .where(
      status
        ? and(eq(safetyCheckins.userId, userId), eq(safetyCheckins.status, status))
        : eq(safetyCheckins.userId, userId),
    )
    .orderBy(desc(safetyCheckins.createdAt))
    .limit(MY_CHECKINS_LIMIT);
  return rows.map(toView);
}

export async function getCheckin(
  db: Database,
  userId: string,
  checkinId: string,
): Promise<CheckinView> {
  return toView(await loadAccessibleRow(db, userId, checkinId));
}

/** Check-ins do grupo (membros atuais), os mais recentes primeiro, com limite. */
export async function listGroupCheckins(
  db: Database,
  userId: string,
  groupId: string,
): Promise<CheckinView[]> {
  await requireMembership(db, groupId, userId);
  const rows = await baseQuery(db)
    .where(eq(safetyCheckins.groupId, groupId))
    .orderBy(desc(safetyCheckins.createdAt))
    .limit(GROUP_CHECKINS_LIMIT);
  return rows.map(toView);
}

// ------------------------------------------------------------------
// Transições do dono
// ------------------------------------------------------------------

export interface CheckinTransitionResult {
  checkin: CheckinView;
  /** Verdadeiro quando o estado persistido mudou (publica evento). */
  changed: boolean;
}

async function loadOwned(db: Database, userId: string, checkinId: string): Promise<Row> {
  const row = await loadAccessibleRow(db, userId, checkinId);
  if (row.userId !== userId) throw errors.forbidden();
  return row;
}

/** ACTIVE|OVERDUE -> SAFE; já SAFE devolve o estado atual (idempotente). */
export async function confirmCheckinSafe(
  db: Database,
  userId: string,
  checkinId: string,
  now: Date = new Date(),
): Promise<CheckinTransitionResult> {
  const row = await loadOwned(db, userId, checkinId);
  if (row.status === "SAFE") return { checkin: toView(row), changed: false };
  if (row.status === "CANCELLED") throw errors.invalidCheckinTransition();

  const updated = await db
    .update(safetyCheckins)
    .set({ status: "SAFE", confirmedAt: now, updatedAt: now })
    .where(
      and(eq(safetyCheckins.id, checkinId), inArray(safetyCheckins.status, ["ACTIVE", "OVERDUE"])),
    )
    .returning({ id: safetyCheckins.id });

  if (updated.length === 0) {
    // Corrida: alguém já mudou o estado. Se virou SAFE, é idempotente; senão inválido.
    const current = await loadView(db, checkinId);
    if (current.status === "SAFE") return { checkin: current, changed: false };
    throw errors.invalidCheckinTransition();
  }
  return { checkin: await loadView(db, checkinId), changed: true };
}

/** ACTIVE -> CANCELLED; já CANCELLED devolve o estado atual (idempotente). */
export async function cancelCheckin(
  db: Database,
  userId: string,
  checkinId: string,
  now: Date = new Date(),
): Promise<CheckinTransitionResult> {
  const row = await loadOwned(db, userId, checkinId);
  if (row.status === "CANCELLED") return { checkin: toView(row), changed: false };
  if (row.status !== "ACTIVE") throw errors.invalidCheckinTransition();

  const updated = await db
    .update(safetyCheckins)
    .set({ status: "CANCELLED", cancelledAt: now, updatedAt: now })
    .where(and(eq(safetyCheckins.id, checkinId), eq(safetyCheckins.status, "ACTIVE")))
    .returning({ id: safetyCheckins.id });

  if (updated.length === 0) {
    const current = await loadView(db, checkinId);
    if (current.status === "CANCELLED") return { checkin: current, changed: false };
    throw errors.invalidCheckinTransition();
  }
  return { checkin: await loadView(db, checkinId), changed: true };
}

// ------------------------------------------------------------------
// Vencimento (scheduler) e retenção
// ------------------------------------------------------------------

export interface OverdueCheckin {
  id: string;
  userId: string;
  groupId: string;
}

/**
 * ACTIVE -> OVERDUE para prazos vencidos, em lote e de forma atômica: a
 * cláusula `status = 'ACTIVE' AND due_at <= now` é reavaliada após o lock de
 * linha, então execuções concorrentes nunca vencem o mesmo check-in duas
 * vezes — só quem alterou a linha recebe o registro (e publica efeitos).
 */
export async function markOverdueBatch(
  db: Database,
  now: Date,
  batchSize: number,
): Promise<OverdueCheckin[]> {
  const due = db
    .select({ id: safetyCheckins.id })
    .from(safetyCheckins)
    .where(and(eq(safetyCheckins.status, "ACTIVE"), lte(safetyCheckins.dueAt, now)))
    .orderBy(safetyCheckins.dueAt)
    .limit(batchSize);

  return db
    .update(safetyCheckins)
    .set({ status: "OVERDUE", overdueAt: now, updatedAt: now })
    .where(
      and(
        inArray(safetyCheckins.id, due),
        eq(safetyCheckins.status, "ACTIVE"),
        lte(safetyCheckins.dueAt, now),
      ),
    )
    .returning({
      id: safetyCheckins.id,
      userId: safetyCheckins.userId,
      groupId: safetyCheckins.groupId,
    });
}

/**
 * Retenção: apaga check-ins finalizados (SAFE/CANCELLED/OVERDUE) cujo
 * encerramento ocorreu há mais de `retentionDays`. Nunca apaga ACTIVE.
 */
export async function deleteExpiredCheckins(
  db: Database,
  now: Date = new Date(),
  retentionDays: number = CHECKIN_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(safetyCheckins)
    .where(
      and(
        ne(safetyCheckins.status, "ACTIVE"),
        sql`coalesce(${safetyCheckins.confirmedAt}, ${safetyCheckins.cancelledAt}, ${safetyCheckins.overdueAt}, ${safetyCheckins.updatedAt}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: safetyCheckins.id });
  return deleted.length;
}
