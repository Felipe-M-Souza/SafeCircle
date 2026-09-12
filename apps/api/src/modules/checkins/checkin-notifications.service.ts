import type { PushMessage } from "../../infrastructure/push/push-provider.js";
import {
  dispatchPush,
  loadGroupRecipientTokens,
  type PushDispatchContext,
  type PushDispatchSummary,
} from "../notifications/push-dispatch.js";
import type { OverdueCheckin } from "./checkins.service.js";

/**
 * Push de check-in vencido (Phase 7): enviado UMA vez por transição
 * ACTIVE -> OVERDUE (quem executa a transição dispara), aos membros atuais do
 * grupo exceto o dono. Conteúdo sem nome (tela bloqueada) e sem qualquer
 * afirmação de emergência: um prazo vencido não confirma perigo.
 */
export const CHECKIN_OVERDUE_TITLE = "Check-in não confirmado";
export const CHECKIN_OVERDUE_BODY = "Um membro do seu grupo não confirmou o check-in no prazo.";
export const CHECKIN_OVERDUE_TYPE = "SAFETY_CHECKIN_OVERDUE";
export const CHECKIN_NOTIFICATION_CHANNEL = "emergency";

export function buildCheckinOverdueMessage(token: string, checkin: OverdueCheckin): PushMessage {
  return {
    to: token,
    title: CHECKIN_OVERDUE_TITLE,
    body: CHECKIN_OVERDUE_BODY,
    data: { type: CHECKIN_OVERDUE_TYPE, checkinId: checkin.id, groupId: checkin.groupId },
    channelId: CHECKIN_NOTIFICATION_CHANNEL,
    priority: "high",
    sound: "default",
  };
}

export async function notifyCheckinOverdue(
  ctx: PushDispatchContext,
  checkin: OverdueCheckin,
): Promise<PushDispatchSummary & { checkinId: string }> {
  const tokens = await loadGroupRecipientTokens(ctx.db, checkin.groupId, checkin.userId);
  const messages = tokens.map((token) => buildCheckinOverdueMessage(token, checkin));
  const summary = await dispatchPush(
    ctx,
    messages,
    { checkinId: checkin.id, groupId: checkin.groupId },
    "check-in vencido",
  );
  return { checkinId: checkin.id, ...summary };
}
