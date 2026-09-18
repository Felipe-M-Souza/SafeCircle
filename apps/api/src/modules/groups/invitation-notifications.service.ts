import type { EmailMessage } from "../../infrastructure/email/email-provider.js";
import {
  EMAIL_LOGO_BASE64,
  EMAIL_LOGO_CONTENT_ID,
  EMAIL_LOGO_FILENAME,
  EMAIL_LOGO_WIDTH,
} from "../../infrastructure/email/logo.generated.js";
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
 * E-mail de convite. Texto puro sempre; HTML como conveniência.
 *
 * Nenhuma requisição sai do cliente de e-mail ao abrir a mensagem. O logotipo
 * viaja embutido, por CID, e não como `<img src="https://...">`. A diferença
 * não é estética: imagem remota informa ao emissor o instante da abertura e o
 * endereço de rede de quem abriu. É um pixel de rastreamento, mesmo quando
 * ninguém pretendia rastrear, e contradiria o que a política de privacidade
 * promete.
 *
 * O único link clicável é o site do próprio SafeCircle. Já foi o deep link
 * `safecircle://`, e isso custou os primeiros convites: foram para a lixeira.
 * Filtros de spam desconfiam de esquema fora de http(s) dentro de um `<a>`, e
 * o destino era inútil para quem recebe convite, que quase por definição ainda
 * não instalou o aplicativo.
 */
export function buildInvitationEmail(
  to: string,
  invitation: InvitationNotificationTarget,
  options: { siteUrl: string; replyTo?: string },
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
    `Saiba mais sobre o SafeCircle: ${options.siteUrl}`,
    "",
    `O convite vale até ${until}. Depois disso, é preciso pedir um novo.`,
    "",
    "Se você não conhece quem convidou, ignore esta mensagem: nada acontece sem",
    "você aceitar, e nenhum dado seu é compartilhado até lá.",
  ].join("\n");

  const html = [
    // O contêiner declara fundo e cor: sem isso, um cliente em tema escuro
    // pinta o fundo de preto e o logotipo achatado sobre branco vira um
    // retângulo claro flutuando no meio da mensagem.
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.5;color:#0f172a;background:#ffffff;padding:8px">',
    // Largura e altura no atributo, não só no estilo: cliente que bloqueia
    // imagem reserva o espaço e mostra o `alt` em vez de quebrar o layout.
    `<p style="margin:8px 0 20px"><img src="cid:${EMAIL_LOGO_CONTENT_ID}" alt="SafeCircle" width="${EMAIL_LOGO_WIDTH / 2}" style="width:${EMAIL_LOGO_WIDTH / 2}px;max-width:100%;height:auto;border:0" /></p>`,
    `<p><strong>${escapeHtml(who)}</strong> convidou você para o grupo de confiança <strong>${escapeHtml(invitation.groupName)}</strong> no SafeCircle.</p>`,
    "<p>O SafeCircle é um aplicativo de segurança pessoal: em um grupo de confiança, você pode pedir ajuda rapidamente a quem escolheu e avisar que chegou bem.</p>",
    "<p><strong>Para aceitar:</strong></p>",
    "<ol><li>Instale o SafeCircle e crie sua conta com este mesmo e-mail.</li>",
    '<li>Na tela inicial, toque em "Convites recebidos".</li>',
    "<li>Toque em Aceitar.</li></ol>",
    // O único link é o site, em https. Nada de `safecircle://`, nem como link
    // nem como texto: filtros de spam desconfiam de esquema fora de http(s), o
    // destino é inútil para quem ainda não instalou — que é quem recebe
    // convite — e para quem já tem o app ele abre a tela inicial, exatamente o
    // que as instruções acima já mandam fazer. Era só ruído na tela.
    `<p><a href="${escapeHtml(options.siteUrl)}">Conheça o SafeCircle</a></p>`,
    `<p>O convite vale até <strong>${escapeHtml(until)}</strong>. Depois disso, é preciso pedir um novo.</p>`,
    '<p style="color:#475569;font-size:14px">Se você não conhece quem convidou, ignore esta mensagem: nada acontece sem você aceitar, e nenhum dado seu é compartilhado até lá.</p>',
    "</div>",
  ].join("");

  const inlineImages = [
    {
      filename: EMAIL_LOGO_FILENAME,
      base64: EMAIL_LOGO_BASE64,
      contentId: EMAIL_LOGO_CONTENT_ID,
    },
  ];

  return options.replyTo
    ? { to, subject, text, html, inlineImages, replyTo: options.replyTo }
    : { to, subject, text, html, inlineImages };
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
