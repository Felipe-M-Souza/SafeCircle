import { and, eq } from "drizzle-orm";
import { groupInvitations, trustedGroups, users } from "../../infrastructure/database/schema.js";
import { fingerprintEmail } from "../../infrastructure/email/email-provider.js";
import { buildInvitationEmail } from "../../modules/groups/invitation-notifications.service.js";
import {
  permanent,
  success,
  transient,
  type EmailEventType,
  type EmailPayload,
  type HandlerResult,
} from "../outbox.types.js";
import type { OutboxHandlerContext } from "./index.js";

/**
 * Entrega de e-mail transacional a partir da outbox (Phase 13).
 *
 * O endereço é carregado **na entrega**, nunca do payload: um convite revogado,
 * aceito ou expirado entre o commit e o envio simplesmente não gera e-mail, e a
 * outbox nunca guarda PII.
 *
 * Semântica at-least-once, como o push: se o processo cair depois de o servidor
 * SMTP aceitar e antes de marcar PROCESSED, o convite pode chegar duas vezes.
 * Um convite duplicado é inofensivo; um convite perdido deixa a pessoa de fora.
 */

export async function handleEmailEvent(
  ctx: OutboxHandlerContext,
  eventType: EmailEventType,
  payload: EmailPayload,
): Promise<HandlerResult> {
  if (eventType !== "EMAIL_GROUP_INVITATION_CREATED") return permanent("UNKNOWN_EVENT_TYPE");

  const [row] = await ctx.db
    .select({
      invitedEmail: groupInvitations.invitedEmail,
      status: groupInvitations.status,
      expiresAt: groupInvitations.expiresAt,
      groupName: trustedGroups.name,
      invitedByName: users.name,
    })
    .from(groupInvitations)
    .innerJoin(trustedGroups, eq(trustedGroups.id, groupInvitations.groupId))
    .innerJoin(users, eq(users.id, groupInvitations.invitedByUserId))
    .where(
      and(
        eq(groupInvitations.id, payload.invitationId),
        eq(groupInvitations.groupId, payload.groupId),
      ),
    )
    .limit(1);

  // Convite apagado (grupo ou conta removidos): nada a entregar, e não é erro.
  if (!row) return success;

  // Já aceito, recusado, revogado ou expirado: o aviso perdeu o sentido.
  if (row.status !== "PENDING" || row.expiresAt.getTime() <= Date.now()) {
    ctx.log.info(
      { event: "email_invitation_skipped", outboxEventId: ctx.eventId, status: row.status },
      "Convite não está mais pendente; e-mail não enviado",
    );
    return success;
  }

  const message = buildInvitationEmail(
    row.invitedEmail,
    {
      invitationId: payload.invitationId,
      groupId: payload.groupId,
      groupName: row.groupName,
      invitedByName: row.invitedByName,
      expiresAt: row.expiresAt,
    },
    {
      deepLink: ctx.appDeepLink,
      siteUrl: ctx.appSiteUrl,
      ...(ctx.emailReplyTo ? { replyTo: ctx.emailReplyTo } : {}),
    },
  );
  // Reprocessamento da outbox não pode virar convite duplicado.
  message.idempotencyKey = ctx.eventId;

  const result = await ctx.emailProvider.send(message);
  const recipient = fingerprintEmail(row.invitedEmail);

  if (result.status === "sent") {
    ctx.log.info(
      {
        event: "email_invitation_delivered",
        outboxEventId: ctx.eventId,
        provider: ctx.emailProvider.name,
        recipient,
      },
      "Convite enviado por e-mail",
    );
    return success;
  }

  // Endereço recusado em definitivo: retry nunca vai funcionar.
  if (result.status === "invalidAddress") {
    ctx.log.warn(
      { event: "email_invitation_rejected", outboxEventId: ctx.eventId, recipient },
      "Endereço recusado pelo servidor de destino",
    );
    return permanent("EMAIL_REJECTED");
  }

  return transient("EMAIL_PROVIDER_FAILED");
}
