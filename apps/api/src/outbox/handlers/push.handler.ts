import { and, eq } from "drizzle-orm";
import type { PushMessage } from "../../infrastructure/push/push-provider.js";
import {
  groupInvitations,
  pushDevices,
  trustedGroups,
  users,
} from "../../infrastructure/database/schema.js";
import { buildAlertPushMessage } from "../../modules/notifications/alert-notifications.service.js";
import { buildInvitationPushMessage } from "../../modules/groups/invitation-notifications.service.js";
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
 *
 * Convite (Phase 13) é a exceção ao "destinatários = membros do grupo": quem foi
 * convidado ainda NÃO é membro. O handler resolve o destinatário pelo e-mail do
 * convite, e só existe push se essa pessoa já tiver conta e aparelho ativo.
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
  // Convite usa um caminho próprio (buildInvitationRecipients); nunca chega aqui.
  PUSH_GROUP_INVITATION_CREATED: (token, resource) =>
    buildInvitationPushMessage(token, {
      invitationId: resource.id,
      groupId: resource.groupId,
      groupName: "",
      invitedByName: "",
      expiresAt: new Date(),
    }),
};

const DESCRIPTIONS: Record<PushEventType, string> = {
  PUSH_ALERT_CREATED: "alerta de emergência",
  PUSH_CHECKIN_OVERDUE: "check-in vencido",
  PUSH_JOURNEY_OVERDUE: "trajeto atrasado",
  PUSH_GROUP_INVITATION_CREATED: "convite para grupo",
};

/**
 * Push de convite: destinatário é a pessoa convidada, identificada pelo e-mail
 * do convite. Sem conta ou sem aparelho ativo, não há nada a enviar — o convite
 * segue visível no app e (se configurado) sai por e-mail.
 */
async function buildInvitationMessages(
  ctx: OutboxHandlerContext,
  payload: PushPayload,
): Promise<PushMessage[]> {
  const [row] = await ctx.db
    .select({
      invitedEmail: groupInvitations.invitedEmail,
      status: groupInvitations.status,
      expiresAt: groupInvitations.expiresAt,
      groupId: groupInvitations.groupId,
      groupName: trustedGroups.name,
      invitedByName: users.name,
    })
    .from(groupInvitations)
    .innerJoin(trustedGroups, eq(trustedGroups.id, groupInvitations.groupId))
    .innerJoin(users, eq(users.id, groupInvitations.invitedByUserId))
    .where(eq(groupInvitations.id, payload.resourceId))
    .limit(1);
  if (!row || row.status !== "PENDING" || row.expiresAt.getTime() <= Date.now()) return [];

  const tokens = await ctx.db
    .select({ token: pushDevices.token })
    .from(pushDevices)
    .innerJoin(users, eq(users.id, pushDevices.userId))
    .where(and(eq(users.email, row.invitedEmail), eq(pushDevices.isActive, true)));

  const invitation = {
    invitationId: payload.resourceId,
    groupId: row.groupId,
    groupName: row.groupName,
    invitedByName: row.invitedByName,
    expiresAt: row.expiresAt,
  };
  return [...new Set(tokens.map((t) => t.token))].map((token) =>
    buildInvitationPushMessage(token, invitation),
  );
}

export async function handlePushEvent(
  ctx: OutboxHandlerContext,
  eventType: PushEventType,
  payload: PushPayload,
): Promise<HandlerResult> {
  const build = BUILDERS[eventType];
  if (!build) return permanent("UNKNOWN_EVENT_TYPE");

  if (eventType === "PUSH_GROUP_INVITATION_CREATED") {
    const messages = await buildInvitationMessages(ctx, payload);
    if (messages.length === 0) return success;
    const summary = await dispatchPush(
      { db: ctx.db, pushProvider: ctx.pushProvider, log: ctx.log },
      messages,
      { outboxEventId: ctx.eventId, groupId: payload.groupId },
      DESCRIPTIONS[eventType],
    );
    if (summary.sent === 0 && summary.failed > 0) return transient("PUSH_PROVIDER_FAILED");
    return success;
  }

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
