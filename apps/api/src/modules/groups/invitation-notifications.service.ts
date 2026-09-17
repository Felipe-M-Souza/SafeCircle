import type { EmailMessage } from "../../infrastructure/email/email-provider.js";
import type { PushMessage } from "../../infrastructure/push/push-provider.js";

/**
 * Conteúdo das notificações de convite (Phase 13).
 *
 * Push e e-mail avisam a pessoa convidada, que antes só descobria o convite
 * abrindo o app por conta própria.
 *
 * Privacidade: o e-mail revela o nome do grupo e o primeiro nome de quem
 * convidou a quem controla aquele endereço. Isso é inerente a um convite — sem
 * esses dois dados a mensagem seria indistinguível de spam. Nada além disso vai
 * na mensagem: sem lista de membros, sem telefone, sem localização, sem
 * histórico. O push é ainda mais curto porque aparece na tela bloqueada.
 */

export const INVITATION_NOTIFICATION_TYPE = "GROUP_INVITATION";
export const INVITATION_NOTIFICATION_CHANNEL = "default";

export interface InvitationNotificationTarget {
  invitationId: string;
  groupId: string;
  groupName: string;
  /** Nome de quem convidou, como cadastrado. */
  invitedByName: string;
  expiresAt: Date;
}

/** Primeiro nome — o suficiente para reconhecer quem convidou. */
function firstName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Alguém";
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

export function buildInvitationPushMessage(
  token: string,
  invitation: InvitationNotificationTarget,
): PushMessage {
  return {
    to: token,
    title: "Convite para um grupo de confiança",
    body: `${firstName(invitation.invitedByName)} convidou você para "${invitation.groupName}" no SafeCircle.`,
    data: {
      type: INVITATION_NOTIFICATION_TYPE,
      invitationId: invitation.invitationId,
      groupId: invitation.groupId,
    },
    channelId: INVITATION_NOTIFICATION_CHANNEL,
    priority: "normal",
    sound: "default",
  };
}

/**
 * E-mail de convite. Texto puro sempre; HTML como conveniência. Sem imagens
 * remotas, sem rastreamento de abertura e sem link de terceiros — o único link
 * é o deep link do próprio app.
 */
export function buildInvitationEmail(
  to: string,
  invitation: InvitationNotificationTarget,
  options: { deepLink: string },
): EmailMessage {
  const who = firstName(invitation.invitedByName);
  const until = formatDate(invitation.expiresAt);
  const subject = `${who} convidou você para o grupo "${invitation.groupName}" no SafeCircle`;

  const text = [
    `${who} convidou você para o grupo de confiança "${invitation.groupName}" no SafeCircle.`,
    "",
    "O SafeCircle é um aplicativo de segurança pessoal: em um grupo de confiança,",
    "você pode pedir ajuda rapidamente a quem escolheu e avisar que chegou bem.",
    "",
    "Para aceitar:",
    "1. Instale o SafeCircle e crie sua conta com este mesmo e-mail.",
    '2. Na tela inicial, toque em "Convites recebidos".',
    "3. Toque em Aceitar.",
    "",
    `Se o app já estiver instalado, abra: ${options.deepLink}`,
    "",
    `O convite vale até ${until}. Depois disso, é preciso pedir um novo.`,
    "",
    "Se você não conhece quem convidou, ignore esta mensagem: nada acontece sem",
    "você aceitar, e nenhum dado seu é compartilhado até lá.",
  ].join("\n");

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.5;color:#0f172a">',
    `<p><strong>${escapeHtml(who)}</strong> convidou você para o grupo de confiança <strong>${escapeHtml(invitation.groupName)}</strong> no SafeCircle.</p>`,
    "<p>O SafeCircle é um aplicativo de segurança pessoal: em um grupo de confiança, você pode pedir ajuda rapidamente a quem escolheu e avisar que chegou bem.</p>",
    "<p><strong>Para aceitar:</strong></p>",
    "<ol><li>Instale o SafeCircle e crie sua conta com este mesmo e-mail.</li>",
    '<li>Na tela inicial, toque em "Convites recebidos".</li>',
    "<li>Toque em Aceitar.</li></ol>",
    `<p>Se o app já estiver instalado: <a href="${escapeHtml(options.deepLink)}">abrir o SafeCircle</a></p>`,
    `<p>O convite vale até <strong>${escapeHtml(until)}</strong>. Depois disso, é preciso pedir um novo.</p>`,
    '<p style="color:#475569;font-size:14px">Se você não conhece quem convidou, ignore esta mensagem: nada acontece sem você aceitar, e nenhum dado seu é compartilhado até lá.</p>',
    "</div>",
  ].join("");

  return { to, subject, text, html };
}

/** Escapa o que vem do banco (nome de grupo e de pessoa) antes de virar HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
