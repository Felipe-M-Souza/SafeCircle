import { eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { emergencyAlerts, type AlertStatus } from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";
import { findMembershipRole } from "../groups/authorization.js";

/**
 * Acesso a um alerta pelo usuário autenticado (Phases 5/6).
 * Não-membro do grupo do alerta (ou alerta inexistente) → ALERT_NOT_FOUND:
 * resposta idêntica em ambos os casos (anti-IDOR).
 */
export interface AccessibleAlert {
  id: string;
  groupId: string;
  createdByUserId: string;
  status: AlertStatus;
}

export async function loadAccessibleAlert(
  db: Database,
  userId: string,
  alertId: string,
): Promise<AccessibleAlert> {
  const [alert] = await db
    .select({
      id: emergencyAlerts.id,
      groupId: emergencyAlerts.groupId,
      createdByUserId: emergencyAlerts.createdByUserId,
      status: emergencyAlerts.status,
    })
    .from(emergencyAlerts)
    .where(eq(emergencyAlerts.id, alertId))
    .limit(1);
  if (!alert) {
    throw errors.alertNotFound();
  }
  const role = await findMembershipRole(db, alert.groupId, userId);
  if (!role) {
    throw errors.alertNotFound();
  }
  return alert;
}

/** Membro que não é o criador: 403 (a existência do alerta já é conhecida por ele). */
export function requireCreator(alert: AccessibleAlert, userId: string): void {
  if (alert.createdByUserId !== userId) {
    throw errors.forbidden();
  }
}

export function requireActiveAlert(alert: AccessibleAlert): void {
  if (alert.status !== "ACTIVE") {
    throw errors.alertNotActive();
  }
}
