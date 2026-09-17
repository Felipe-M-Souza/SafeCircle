/**
 * Intenção de navegação vinda de uma notificação (Phases 4/7).
 *
 * Guardamos apenas o ID do recurso (referência, não autorização): alerta ou
 * check-in. A área autenticada consome a intenção ao montar (cold start ou
 * login posterior) ou reage imediatamente via assinatura quando já está
 * aberta. O backend revalida a autorização ao buscar o recurso.
 */

export type PendingTarget =
  | { kind: "alert"; alertId: string }
  | { kind: "checkin"; checkinId: string }
  | { kind: "journey"; journeyId: string }
  /** Convite: a lista é a tela útil; o id serve para destacar/validar depois. */
  | { kind: "invitations"; invitationId: string };

type TargetListener = (target: PendingTarget) => void;

let pending: PendingTarget | null = null;
const listeners = new Set<TargetListener>();

function publish(target: PendingTarget): void {
  pending = target;
  for (const listener of listeners) {
    listener(target);
  }
}

export function openAlertFromNotification(alertId: string): void {
  publish({ kind: "alert", alertId });
}

export function openCheckinFromNotification(checkinId: string): void {
  publish({ kind: "checkin", checkinId });
}

export function openJourneyFromNotification(journeyId: string): void {
  publish({ kind: "journey", journeyId });
}

export function openInvitationsFromNotification(invitationId: string): void {
  publish({ kind: "invitations", invitationId });
}

/** Devolve e limpa a intenção pendente (qualquer tipo). */
export function consumePendingTarget(): PendingTarget | null {
  const value = pending;
  pending = null;
  return value;
}

/** Compatibilidade: devolve e limpa a intenção pendente se for um alerta. */
export function consumePendingAlertId(): string | null {
  if (pending?.kind !== "alert") return null;
  const value = pending.alertId;
  pending = null;
  return value;
}

export function subscribeNotificationOpen(listener: TargetListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Compatibilidade: assina apenas aberturas de alerta. */
export function subscribeAlertOpen(listener: (alertId: string) => void): () => void {
  return subscribeNotificationOpen((target) => {
    if (target.kind === "alert") listener(target.alertId);
  });
}

/** Apenas para testes. */
export function resetPendingAlert(): void {
  pending = null;
  listeners.clear();
}
