import type { PushMessage } from "../../infrastructure/push/push-provider.js";
import {
  dispatchPush,
  loadGroupRecipientTokens,
  type PushDispatchContext,
  type PushDispatchSummary,
} from "./push-dispatch.js";

/**
 * Notificação push de alerta criado (Phase 4).
 *
 * Executada em segundo plano DEPOIS do commit do alerta: qualquer falha aqui
 * é capturada e logada e jamais afeta o alerta já persistido.
 *
 * Conteúdo mínimo e seguro (pode aparecer na tela bloqueada): sem nome,
 * coordenadas, e-mail ou detalhes do incidente. O payload leva apenas os IDs
 * necessários para navegação; o app busca o alerta na API, que revalida a
 * autorização.
 */

export const ALERT_NOTIFICATION_TITLE = "🚨 Alerta SafeCircle";
export const ALERT_NOTIFICATION_BODY =
  "Um novo alerta de emergência foi acionado em um dos seus grupos.";
export const ALERT_NOTIFICATION_CHANNEL = "emergency";
export const ALERT_NOTIFICATION_TYPE = "EMERGENCY_ALERT";

export type AlertNotificationContext = PushDispatchContext;

export interface AlertNotificationTarget {
  id: string;
  groupId: string;
  createdByUserId: string;
}

export interface AlertNotificationSummary extends PushDispatchSummary {
  alertId: string;
}

export function buildAlertPushMessage(token: string, alert: AlertNotificationTarget): PushMessage {
  return {
    to: token,
    title: ALERT_NOTIFICATION_TITLE,
    body: ALERT_NOTIFICATION_BODY,
    data: { type: ALERT_NOTIFICATION_TYPE, alertId: alert.id, groupId: alert.groupId },
    channelId: ALERT_NOTIFICATION_CHANNEL,
    priority: "high",
    sound: "default",
  };
}

export async function notifyAlertCreated(
  ctx: AlertNotificationContext,
  alert: AlertNotificationTarget,
): Promise<AlertNotificationSummary> {
  // Membros do grupo exceto o criador (uma consulta; deduplicado por token).
  const tokens = await loadGroupRecipientTokens(ctx.db, alert.groupId, alert.createdByUserId);
  const messages = tokens.map((token) => buildAlertPushMessage(token, alert));
  const summary = await dispatchPush(ctx, messages, { alertId: alert.id }, "alerta criado");
  return { alertId: alert.id, ...summary };
}
