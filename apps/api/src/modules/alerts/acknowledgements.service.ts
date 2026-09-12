import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  alertAcknowledgements,
  users,
  type AcknowledgementType,
} from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";
import { loadAccessibleAlert } from "./alert-access.js";

/**
 * Acknowledgements (Phase 5): estado declarado por um membro sobre um alerta.
 *
 * Política (ADR 0006):
 * - somente membros atuais do grupo (externo → ALERT_NOT_FOUND, anti-IDOR);
 * - o criador não registra acknowledgement (FORBIDDEN);
 * - só alertas ACTIVE aceitam alteração (ALERT_NOT_ACTIVE); leitura é livre
 *   para membros mesmo após o encerramento;
 * - um estado atual por (alerta, usuário) — upsert; qualquer estado explícito
 *   pode substituir outro, exceto que `SEEN` nunca rebaixa um estado existente
 *   (é o "auto-SEEN" ao abrir a tela);
 * - a autoria vem sempre de `request.auth.userId`, nunca do body.
 */

export interface AcknowledgementView {
  user: { id: string; name: string };
  type: AcknowledgementType;
  updatedAt: string;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (value: unknown): unknown =>
    typeof value === "object" && value !== null && "code" in value
      ? (value as { code?: unknown }).code
      : undefined;
  return code(error) === "23505" || code((error as { cause?: unknown } | null)?.cause) === "23505";
}

async function loadView(
  db: Database,
  alertId: string,
  userId: string,
): Promise<AcknowledgementView> {
  const [row] = await db
    .select({
      userId: users.id,
      userName: users.name,
      type: alertAcknowledgements.type,
      updatedAt: alertAcknowledgements.updatedAt,
    })
    .from(alertAcknowledgements)
    .innerJoin(users, eq(users.id, alertAcknowledgements.userId))
    .where(
      and(eq(alertAcknowledgements.alertId, alertId), eq(alertAcknowledgements.userId, userId)),
    )
    .limit(1);
  if (!row) {
    throw new Error("Acknowledgement não encontrado após gravação.");
  }
  return {
    user: { id: row.userId, name: row.userName },
    type: row.type,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAcknowledgements(
  db: Database,
  userId: string,
  alertId: string,
): Promise<AcknowledgementView[]> {
  await loadAccessibleAlert(db, userId, alertId);
  const rows = await db
    .select({
      userId: users.id,
      userName: users.name,
      type: alertAcknowledgements.type,
      updatedAt: alertAcknowledgements.updatedAt,
    })
    .from(alertAcknowledgements)
    .innerJoin(users, eq(users.id, alertAcknowledgements.userId))
    .where(eq(alertAcknowledgements.alertId, alertId))
    .orderBy(desc(alertAcknowledgements.updatedAt));
  return rows.map((row) => ({
    user: { id: row.userId, name: row.userName },
    type: row.type,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export interface SetAcknowledgementResult {
  acknowledgement: AcknowledgementView;
  /** Verdadeiro quando o estado persistido mudou (publica evento realtime). */
  changed: boolean;
  groupId: string;
}

export async function setAcknowledgement(
  db: Database,
  userId: string,
  alertId: string,
  type: AcknowledgementType,
): Promise<SetAcknowledgementResult> {
  const alert = await loadAccessibleAlert(db, userId, alertId);
  if (alert.createdByUserId === userId) {
    throw errors.forbidden();
  }
  if (alert.status !== "ACTIVE") {
    throw errors.alertNotActive();
  }

  for (let attempt = 0; ; attempt += 1) {
    try {
      const changed = await upsert(db, userId, alertId, type);
      return {
        acknowledgement: await loadView(db, alertId, userId),
        changed,
        groupId: alert.groupId,
      };
    } catch (error) {
      // Dois inserts concorrentes: o segundo repete e encontra a linha existente.
      if (attempt === 0 && isUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }
}

async function upsert(
  db: Database,
  userId: string,
  alertId: string,
  type: AcknowledgementType,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: alertAcknowledgements.id, type: alertAcknowledgements.type })
      .from(alertAcknowledgements)
      .where(
        and(eq(alertAcknowledgements.alertId, alertId), eq(alertAcknowledgements.userId, userId)),
      )
      .limit(1)
      .for("update");

    if (!existing) {
      await tx.insert(alertAcknowledgements).values({ alertId, userId, type });
      return true;
    }
    // Auto-SEEN nunca rebaixa um estado já declarado.
    if (type === "SEEN" && existing.type !== "SEEN") {
      return false;
    }
    if (existing.type === type) {
      return false;
    }
    await tx
      .update(alertAcknowledgements)
      .set({ type, updatedAt: new Date() })
      .where(eq(alertAcknowledgements.id, existing.id));
    return true;
  });
}
