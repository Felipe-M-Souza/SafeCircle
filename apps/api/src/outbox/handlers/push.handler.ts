import type { PushMessage } from "../../infrastructure/push/push-provider.js";
import { buildAlertPushMessage } from "../../modules/notifications/alert-notifications.service.js";
import { buildCheckinOverdueMessage } from "../../modules/checkins/checkin-notifications.service.js";
import { buildJourneyOverdueMessage } from "../../modules/journeys/journey-notifications.service.js";
import {
  dispatchPush,
  loadGroupRecipientTokens,
} from "../../modules/notifications/push-dispatch.js";
import {
  permanent,
  success,
  transient,
  type HandlerResult,
  type PushEventType,
  type PushPayload,
} from "../outbox.types.js";
import type { OutboxHandlerContext } from "./index.js";

/**
 * Entrega de push a partir da outbox (Phase 10).
 *
 * Os destinatários são carregados **no momento da entrega**, não no enfileira-
 * mento: quem saiu do grupo entre o commit e o envio não recebe, e quem entrou
 * recebe. É também por isso que o payload guarda apenas IDs — o push token
 * nunca é persistido na outbox.
 *
 * Semântica at-least-once: se o processo cair depois de o provedor aceitar a
 * mensagem e antes de marcar PROCESSED, o evento é reprocessado e a notificação
 * pode chegar duas vezes. Preferimos duplicar a perder um aviso de emergência.
 */

type MessageBuilder = (token: string, resource: { id: string; groupId: string }) => PushMessage;

const BUILDERS: Record<PushEventType, MessageBuilder> = {
  PUSH_ALERT_CREATED: (token, resource) =>
    buildAlertPushMessage(token, {
      id: resource.id,
      groupId: resource.groupId,
      // Destinatários já foram filtrados por loadGroupRecipientTokens.
      createdByUserId: "",
    }),
  PUSH_CHECKIN_OVERDUE: (token, resource) =>
    buildCheckinOverdueMessage(token, { id: resource.id, groupId: resource.groupId, userId: "" }),
  PUSH_JOURNEY_OVERDUE: (token, resource) =>
    buildJourneyOverdueMessage(token, { id: resource.id, groupId: resource.groupId, userId: "" }),
};

const DESCRIPTIONS: Record<PushEventType, string> = {
  PUSH_ALERT_CREATED: "alerta de emergência",
  PUSH_CHECKIN_OVERDUE: "check-in vencido",
  PUSH_JOURNEY_OVERDUE: "trajeto atrasado",
};

export async function handlePushEvent(
  ctx: OutboxHandlerContext,
  eventType: PushEventType,
  payload: PushPayload,
): Promise<HandlerResult> {
  const build = BUILDERS[eventType];
  if (!build) return permanent("UNKNOWN_EVENT_TYPE");

  // Excluir o autor é regra de produto: quem acionou não precisa do aviso.
  const tokens = await loadGroupRecipientTokens(ctx.db, payload.groupId, payload.actorUserId);
  if (tokens.length === 0) {
    // Ninguém com dispositivo ativo: nada a fazer, e não é erro.
    return success;
  }

  const messages = tokens.map((token) =>
    build(token, { id: payload.resourceId, groupId: payload.groupId }),
  );
  const summary = await dispatchPush(
    { db: ctx.db, pushProvider: ctx.pushProvider, log: ctx.log },
    messages,
    { outboxEventId: ctx.eventId, groupId: payload.groupId },
    DESCRIPTIONS[eventType],
  );

  // Provedor totalmente indisponível: transitório, vale a pena tentar de novo.
  if (summary.sent === 0 && summary.failed > 0) {
    return transient("PUSH_PROVIDER_FAILED");
  }
  // Sucesso total ou parcial: reenviar o lote inteiro duplicaria quem recebeu.
  return success;
}
