/**
 * Intenção de navegação vinda de uma notificação (Phase 4).
 *
 * Quando o usuário toca em uma notificação de alerta, guardamos apenas o
 * `alertId` (referência, não autorização). A área autenticada consome a
 * intenção ao montar (cold start ou login posterior) ou reage imediatamente
 * via assinatura quando já está aberta. O backend revalida a autorização ao
 * buscar o alerta.
 */

type Listener = (alertId: string) => void;

let pendingAlertId: string | null = null;
const listeners = new Set<Listener>();

export function openAlertFromNotification(alertId: string): void {
  pendingAlertId = alertId;
  for (const listener of listeners) {
    listener(alertId);
  }
}

/** Devolve e limpa a intenção pendente. */
export function consumePendingAlertId(): string | null {
  const value = pendingAlertId;
  pendingAlertId = null;
  return value;
}

export function subscribeAlertOpen(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Apenas para testes. */
export function resetPendingAlert(): void {
  pendingAlertId = null;
  listeners.clear();
}
