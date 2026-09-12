import { eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { safeJourneys, type JourneyStatus } from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";
import { findMembershipRole } from "../groups/authorization.js";

/**
 * Acesso a um trajeto pelo usuário autenticado (Phase 8).
 * Não-membro do grupo do trajeto (ou trajeto inexistente) → JOURNEY_NOT_FOUND:
 * resposta idêntica em ambos os casos (anti-IDOR).
 */
export interface AccessibleJourney {
  id: string;
  groupId: string;
  userId: string;
  status: JourneyStatus;
  liveLocationEnabled: boolean;
}

export async function loadAccessibleJourney(
  db: Database,
  userId: string,
  journeyId: string,
): Promise<AccessibleJourney> {
  const [journey] = await db
    .select({
      id: safeJourneys.id,
      groupId: safeJourneys.groupId,
      userId: safeJourneys.userId,
      status: safeJourneys.status,
      liveLocationEnabled: safeJourneys.liveLocationEnabled,
    })
    .from(safeJourneys)
    .where(eq(safeJourneys.id, journeyId))
    .limit(1);
  if (!journey) {
    throw errors.journeyNotFound();
  }
  const role = await findMembershipRole(db, journey.groupId, userId);
  if (!role) {
    throw errors.journeyNotFound();
  }
  return journey;
}

/** Membro que não é o dono: 403 (a existência do trajeto já é conhecida por ele). */
export function requireJourneyOwner(journey: AccessibleJourney, userId: string): void {
  if (journey.userId !== userId) {
    throw errors.forbidden();
  }
}

/** Trajeto ainda em andamento (ACTIVE ou OVERDUE) — compartilhamento permitido. */
export function requireTrackableJourney(journey: AccessibleJourney): void {
  if (journey.status !== "ACTIVE" && journey.status !== "OVERDUE") {
    throw errors.journeyNotActive();
  }
}

/** O trajeto precisa ter habilitado o compartilhamento de localização (opt-in). */
export function requireLiveLocationEnabled(journey: AccessibleJourney): void {
  if (!journey.liveLocationEnabled) {
    throw errors.journeyLiveLocationDisabled();
  }
}
