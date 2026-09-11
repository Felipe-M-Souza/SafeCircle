import { and, eq, inArray, ne } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../infrastructure/database/client.js";
import { groupMemberships, pushDevices } from "../../infrastructure/database/schema.js";
import type { PushMessage, PushProvider } from "../../infrastructure/push/push-provider.js";

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

export interface AlertNotificationContext {
  db: Database;
  pushProvider: PushProvider;
  log: FastifyBaseLogger;
}

export interface AlertNotificationTarget {
  id: string;
  groupId: string;
  createdByUserId: string;
}

export interface AlertNotificationSummary {
  alertId: string;
  recipients: number;
  sent: number;
  failed: number;
  invalidToken: number;
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

/**
 * Tokens ativos dos membros do grupo, excluindo o criador — em uma única
 * consulta (sem N+1). Deduplicados por token (um usuário com dois aparelhos
 * recebe em ambos).
 */
async function loadRecipientTokens(
  db: Database,
  alert: AlertNotificationTarget,
): Promise<string[]> {
  const rows = await db
    .select({ token: pushDevices.token })
    .from(pushDevices)
    .innerJoin(
      groupMemberships,
      and(
        eq(groupMemberships.groupId, alert.groupId),
        eq(groupMemberships.userId, pushDevices.userId),
      ),
    )
    .where(and(eq(pushDevices.isActive, true), ne(pushDevices.userId, alert.createdByUserId)));
  return [...new Set(rows.map((row) => row.token))];
}

export async function notifyAlertCreated(
  ctx: AlertNotificationContext,
  alert: AlertNotificationTarget,
): Promise<AlertNotificationSummary> {
  const summary: AlertNotificationSummary = {
    alertId: alert.id,
    recipients: 0,
    sent: 0,
    failed: 0,
    invalidToken: 0,
  };

  const tokens = await loadRecipientTokens(ctx.db, alert);
  summary.recipients = tokens.length;
  if (tokens.length === 0) {
    return summary;
  }

  const messages = tokens.map((token) => buildAlertPushMessage(token, alert));

  let results;
  try {
    results = await ctx.pushProvider.send(messages);
  } catch (error) {
    // Provedor indisponível: registrar operacionalmente, sem tokens.
    summary.failed = tokens.length;
    ctx.log.error(
      { err: error, alertId: alert.id, recipients: tokens.length, provider: ctx.pushProvider.name },
      "Falha ao enviar push de alerta",
    );
    return summary;
  }

  const invalidTokens: string[] = [];
  for (const result of results) {
    if (result.status === "sent") {
      summary.sent += 1;
    } else if (result.status === "invalidToken") {
      summary.invalidToken += 1;
      invalidTokens.push(result.to);
    } else {
      summary.failed += 1;
    }
  }

  if (invalidTokens.length > 0) {
    // Token definitivamente inválido (ex.: DeviceNotRegistered): desativar sem
    // apagar o registro, o usuário ou a membership.
    await ctx.db
      .update(pushDevices)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(pushDevices.token, invalidTokens));
  }

  ctx.log.info(
    {
      alertId: alert.id,
      recipients: summary.recipients,
      sent: summary.sent,
      failed: summary.failed,
      invalidToken: summary.invalidToken,
    },
    "Push de alerta processado",
  );
  return summary;
}
