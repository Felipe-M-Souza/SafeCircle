import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  alertLocations,
  emergencyAlerts,
  groupMemberships,
  idempotencyKeys,
  trustedGroups,
  users,
  type AlertStatus,
} from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";
import { hashRequestPayload } from "../../shared/idempotency.js";
import { findMembershipRole, requireMembership } from "../groups/authorization.js";
import type { CreateAlertInput } from "./alerts.schemas.js";
import { stopActiveSessionForAlert } from "./live-location.service.js";

/** Escopo da chave de idempotência da criação de alerta. */
export const CREATE_ALERT_IDEMPOTENCY_SCOPE = "alerts.create";

const ACTIVE_ALERT_UNIQUE_INDEX = "emergency_alerts_active_per_user_group_unique";
const IDEMPOTENCY_KEY_UNIQUE_INDEX = "idempotency_keys_user_scope_key_unique";

export interface AlertLocationView {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: string;
}

/**
 * Representação do alerta devolvida pela API. Contém apenas o necessário:
 * nunca e-mail, hashes, sessões ou dados técnicos de autenticação.
 */
export interface AlertView {
  id: string;
  groupId: string;
  groupName: string;
  status: AlertStatus;
  createdBy: { id: string; name: string };
  activatedAt: string;
  resolvedAt: string | null;
  cancelledAt: string | null;
  location: AlertLocationView | null;
}

type Db = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

// ------------------------------------------------------------------
// Erros do PostgreSQL
// ------------------------------------------------------------------

function pgErrorField(error: unknown, field: string): unknown {
  const read = (value: unknown): unknown =>
    typeof value === "object" && value !== null && field in value
      ? (value as Record<string, unknown>)[field]
      : undefined;
  // O Drizzle encapsula o erro do driver em DrizzleQueryError (erro real em `cause`).
  return read(error) ?? read((error as { cause?: unknown } | null)?.cause);
}

/** Nome do índice violado em um erro 23505, ou null se não for unique violation. */
function uniqueViolationConstraint(error: unknown): string | null {
  if (pgErrorField(error, "code") !== "23505") {
    return null;
  }
  const name = pgErrorField(error, "constraint_name");
  return typeof name === "string" ? name : "";
}

// ------------------------------------------------------------------
// Leitura
// ------------------------------------------------------------------

const alertSelection = {
  id: emergencyAlerts.id,
  groupId: emergencyAlerts.groupId,
  groupName: trustedGroups.name,
  status: emergencyAlerts.status,
  createdById: users.id,
  createdByName: users.name,
  activatedAt: emergencyAlerts.activatedAt,
  resolvedAt: emergencyAlerts.resolvedAt,
  cancelledAt: emergencyAlerts.cancelledAt,
};

interface AlertRow {
  id: string;
  groupId: string;
  groupName: string;
  status: AlertStatus;
  createdById: string;
  createdByName: string;
  activatedAt: Date;
  resolvedAt: Date | null;
  cancelledAt: Date | null;
}

/** Busca o snapshot de localização mais recente de cada alerta informado. */
async function loadLatestLocations(
  db: Db,
  alertIds: string[],
): Promise<Map<string, AlertLocationView>> {
  const result = new Map<string, AlertLocationView>();
  if (alertIds.length === 0) {
    return result;
  }
  const rows = await db
    .select({
      alertId: alertLocations.alertId,
      latitude: alertLocations.latitude,
      longitude: alertLocations.longitude,
      accuracy: alertLocations.accuracy,
      capturedAt: alertLocations.capturedAt,
    })
    .from(alertLocations)
    .where(inArray(alertLocations.alertId, alertIds))
    .orderBy(desc(alertLocations.capturedAt), desc(alertLocations.createdAt));

  for (const row of rows) {
    if (!result.has(row.alertId)) {
      result.set(row.alertId, {
        latitude: row.latitude,
        longitude: row.longitude,
        accuracy: row.accuracy,
        capturedAt: row.capturedAt.toISOString(),
      });
    }
  }
  return result;
}

async function toViews(db: Db, rows: AlertRow[]): Promise<AlertView[]> {
  const locations = await loadLatestLocations(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    groupId: row.groupId,
    groupName: row.groupName,
    status: row.status,
    createdBy: { id: row.createdById, name: row.createdByName },
    activatedAt: row.activatedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    location: locations.get(row.id) ?? null,
  }));
}

async function loadAlertRow(db: Db, alertId: string): Promise<AlertRow | null> {
  const [row] = await db
    .select(alertSelection)
    .from(emergencyAlerts)
    .innerJoin(trustedGroups, eq(trustedGroups.id, emergencyAlerts.groupId))
    .innerJoin(users, eq(users.id, emergencyAlerts.createdByUserId))
    .where(eq(emergencyAlerts.id, alertId))
    .limit(1);
  return row ?? null;
}

async function loadAlertView(db: Db, alertId: string): Promise<AlertView> {
  const row = await loadAlertRow(db, alertId);
  if (!row) {
    throw errors.alertNotFound();
  }
  const [view] = await toViews(db, [row]);
  if (!view) {
    throw errors.alertNotFound();
  }
  return view;
}

// ------------------------------------------------------------------
// Criação (idempotente e atômica)
// ------------------------------------------------------------------

async function findIdempotencyKey(db: Db, userId: string, key: string) {
  const [row] = await db
    .select({
      id: idempotencyKeys.id,
      requestHash: idempotencyKeys.requestHash,
      resourceId: idempotencyKeys.resourceId,
    })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.scope, CREATE_ALERT_IDEMPOTENCY_SCOPE),
        eq(idempotencyKeys.key, key),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function replayAlert(
  db: Db,
  existing: { requestHash: string; resourceId: string | null },
  requestHash: string,
): Promise<{ alert: AlertView; replayed: true }> {
  if (existing.requestHash !== requestHash) {
    throw errors.idempotencyKeyReused();
  }
  if (!existing.resourceId) {
    // A chave e o alerta são gravados na mesma transação; isto não deve ocorrer.
    throw new Error("Chave de idempotência sem recurso associado.");
  }
  return { alert: await loadAlertView(db, existing.resourceId), replayed: true };
}

/**
 * Cria um alerta ACTIVE para o usuário no grupo informado.
 *
 * Garantias:
 * - membership verificada no backend (não-membro → GROUP_NOT_FOUND, anti-IDOR);
 * - idempotência persistente por (usuário, operação, chave): retry devolve o
 *   mesmo alerta sem criar um novo incidente, mesmo após reinício da API;
 * - um único alerta ACTIVE por (usuário, grupo), garantido por índice parcial;
 * - alerta, localização (opcional) e chave são gravados em uma única transação.
 *
 * Localização é opcional: a ausência de GPS nunca impede o pedido de ajuda.
 */
export async function createAlert(
  db: Database,
  userId: string,
  input: CreateAlertInput,
  idempotencyKey: string,
): Promise<{ alert: AlertView; replayed: boolean }> {
  const location = input.location ?? null;
  const requestHash = hashRequestPayload({ groupId: input.groupId, location });

  // 1. Autorização: o groupId do cliente só vale se houver membership.
  await requireMembership(db, input.groupId, userId);

  // 2. Retry da mesma intenção → devolve o alerta já criado.
  const existing = await findIdempotencyKey(db, userId, idempotencyKey);
  if (existing) {
    return replayAlert(db, existing, requestHash);
  }

  // 3. Criação atômica. A chave é reservada primeiro: sob concorrência com a
  //    mesma chave, a segunda transação aguarda a primeira e falha por unicidade,
  //    caindo no replay abaixo. Se a criação falhar, a chave é desfeita junto.
  try {
    const alertId = await db.transaction(async (tx) => {
      await tx.insert(idempotencyKeys).values({
        userId,
        scope: CREATE_ALERT_IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        requestHash,
      });

      const [alert] = await tx
        .insert(emergencyAlerts)
        .values({ groupId: input.groupId, createdByUserId: userId, status: "ACTIVE" })
        .returning({ id: emergencyAlerts.id });
      if (!alert) {
        throw new Error("Falha ao criar alerta.");
      }

      if (location) {
        await tx.insert(alertLocations).values({
          alertId: alert.id,
          latitude: location.latitude,
          longitude: location.longitude,
          accuracy: location.accuracy ?? null,
          capturedAt: location.capturedAt ? new Date(location.capturedAt) : new Date(),
        });
      }

      await tx
        .update(idempotencyKeys)
        .set({ resourceId: alert.id })
        .where(
          and(
            eq(idempotencyKeys.userId, userId),
            eq(idempotencyKeys.scope, CREATE_ALERT_IDEMPOTENCY_SCOPE),
            eq(idempotencyKeys.key, idempotencyKey),
          ),
        );

      return alert.id;
    });

    return { alert: await loadAlertView(db, alertId), replayed: false };
  } catch (error) {
    const constraint = uniqueViolationConstraint(error);
    if (constraint === ACTIVE_ALERT_UNIQUE_INDEX) {
      throw errors.alertAlreadyActive();
    }
    if (constraint === IDEMPOTENCY_KEY_UNIQUE_INDEX) {
      const winner = await findIdempotencyKey(db, userId, idempotencyKey);
      if (winner) {
        return replayAlert(db, winner, requestHash);
      }
    }
    throw error;
  }
}

// ------------------------------------------------------------------
// Consulta
// ------------------------------------------------------------------

/** Lista alertas apenas dos grupos em que o usuário é membro. */
export async function listAlerts(
  db: Database,
  userId: string,
  status: AlertStatus,
): Promise<AlertView[]> {
  const rows = await db
    .select(alertSelection)
    .from(emergencyAlerts)
    .innerJoin(
      groupMemberships,
      and(
        eq(groupMemberships.groupId, emergencyAlerts.groupId),
        eq(groupMemberships.userId, userId),
      ),
    )
    .innerJoin(trustedGroups, eq(trustedGroups.id, emergencyAlerts.groupId))
    .innerJoin(users, eq(users.id, emergencyAlerts.createdByUserId))
    .where(eq(emergencyAlerts.status, status))
    .orderBy(desc(emergencyAlerts.activatedAt));

  return toViews(db, rows);
}

/**
 * Detalhes do alerta para membros do grupo. Não-membros recebem
 * ALERT_NOT_FOUND (não revelamos a existência do recurso).
 */
export async function getAlert(db: Database, userId: string, alertId: string): Promise<AlertView> {
  const row = await loadAlertRow(db, alertId);
  if (!row) {
    throw errors.alertNotFound();
  }
  const role = await findMembershipRole(db, row.groupId, userId);
  if (!role) {
    throw errors.alertNotFound();
  }
  const [view] = await toViews(db, [row]);
  if (!view) {
    throw errors.alertNotFound();
  }
  return view;
}

// ------------------------------------------------------------------
// Ciclo de vida: ACTIVE -> RESOLVED | CANCELLED
// ------------------------------------------------------------------

export interface AlertTransitionResult {
  alert: AlertView;
  /** Sessão de localização ao vivo encerrada junto com o alerta (Phase 6), se havia. */
  stoppedLiveSessionId: string | null;
}

async function closeAlert(
  db: Database,
  userId: string,
  alertId: string,
  target: "RESOLVED" | "CANCELLED",
): Promise<AlertTransitionResult> {
  const [alert] = await db
    .select({
      id: emergencyAlerts.id,
      groupId: emergencyAlerts.groupId,
      createdByUserId: emergencyAlerts.createdByUserId,
    })
    .from(emergencyAlerts)
    .where(eq(emergencyAlerts.id, alertId))
    .limit(1);

  if (!alert) {
    throw errors.alertNotFound();
  }
  // Externo ao grupo: 404 (anti-IDOR). Membro que não é o criador: 403.
  const role = await findMembershipRole(db, alert.groupId, userId);
  if (!role) {
    throw errors.alertNotFound();
  }
  if (alert.createdByUserId !== userId) {
    throw errors.forbidden();
  }

  // Compare-and-swap: só transita se ainda estiver ACTIVE. Em transição
  // inválida (já encerrado/cancelado) nada é alterado. A sessão de
  // localização ao vivo (Phase 6) é encerrada na MESMA transação: sem alerta
  // ativo não há compartilhamento, independentemente do app.
  const now = new Date();
  const stoppedLiveSessionId = await db.transaction(async (tx) => {
    const updated = await tx
      .update(emergencyAlerts)
      .set(
        target === "RESOLVED"
          ? { status: "RESOLVED", resolvedAt: now, updatedAt: now }
          : { status: "CANCELLED", cancelledAt: now, updatedAt: now },
      )
      .where(and(eq(emergencyAlerts.id, alertId), eq(emergencyAlerts.status, "ACTIVE")))
      .returning({ id: emergencyAlerts.id });

    if (updated.length === 0) {
      throw errors.invalidAlertTransition();
    }
    return stopActiveSessionForAlert(tx, alertId, now);
  });

  return { alert: await loadAlertView(db, alertId), stoppedLiveSessionId };
}

/** Somente o criador: ACTIVE -> RESOLVED (preenche `resolvedAt`). */
export function resolveAlert(
  db: Database,
  userId: string,
  alertId: string,
): Promise<AlertTransitionResult> {
  return closeAlert(db, userId, alertId, "RESOLVED");
}

/** Somente o criador: ACTIVE -> CANCELLED (preenche `cancelledAt`). */
export function cancelAlert(
  db: Database,
  userId: string,
  alertId: string,
): Promise<AlertTransitionResult> {
  return closeAlert(db, userId, alertId, "CANCELLED");
}
