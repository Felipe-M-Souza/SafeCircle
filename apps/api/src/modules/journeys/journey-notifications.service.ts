import type { PushMessage } from "../../infrastructure/push/push-provider.js";
import {
  dispatchPush,
  loadGroupRecipientTokens,
  type PushDispatchContext,
  type PushDispatchSummary,
} from "../notifications/push-dispatch.js";
import type { OverdueJourney } from "./journeys.service.js";

/**
 * Push de trajeto atrasado (Phase 8): enviado UMA vez por transição
 * ACTIVE -> OVERDUE, aos membros atuais do grupo exceto o dono. Conteúdo sem
 * nome (tela bloqueada) e sem qualquer afirmação de emergência: um prazo
 * vencido não confirma perigo.
 */
export const JOURNEY_OVERDUE_TITLE = "Trajeto não confirmado";
export const JOURNEY_OVERDUE_BODY =
  "Um membro do seu grupo não confirmou a chegada no prazo esperado.";
export const JOURNEY_OVERDUE_TYPE = "SAFE_JOURNEY_OVERDUE";
export const JOURNEY_NOTIFICATION_CHANNEL = "emergency";

export function buildJourneyOverdueMessage(token: string, journey: OverdueJourney): PushMessage {
  return {
    to: token,
    title: JOURNEY_OVERDUE_TITLE,
    body: JOURNEY_OVERDUE_BODY,
    data: { type: JOURNEY_OVERDUE_TYPE, journeyId: journey.id, groupId: journey.groupId },
    channelId: JOURNEY_NOTIFICATION_CHANNEL,
    priority: "high",
    sound: "default",
  };
}

export async function notifyJourneyOverdue(
  ctx: PushDispatchContext,
  journey: OverdueJourney,
): Promise<PushDispatchSummary & { journeyId: string }> {
  const tokens = await loadGroupRecipientTokens(ctx.db, journey.groupId, journey.userId);
  const messages = tokens.map((token) => buildJourneyOverdueMessage(token, journey));
  const summary = await dispatchPush(
    ctx,
    messages,
    { journeyId: journey.id, groupId: journey.groupId },
    "trajeto atrasado",
  );
  return { journeyId: journey.id, ...summary };
}
