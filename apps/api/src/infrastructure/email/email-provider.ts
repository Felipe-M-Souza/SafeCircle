import { createHash } from "node:crypto";

/**
 * Abstração do provedor de e-mail transacional (Phase 13).
 *
 * O domínio depende apenas desta interface — nunca de SMTP, Resend ou SES.
 * Implementações: `SmtpEmailProvider` (qualquer provedor que fale SMTP) e
 * `NoopEmailProvider` (sem credencial: registra e descarta).
 *
 * O endereço do destinatário é **PII**: aparece aqui porque é preciso para
 * entregar, mas nunca vai para log, métrica, outbox ou mensagem de erro. Para
 * correlacionar uma entrega em log use `fingerprintEmail`.
 */

export interface InlineImage {
  /** Nome do arquivo apresentado ao cliente de e-mail. */
  filename: string;
  /** Conteúdo em base64, sem prefixo de data URI. */
  base64: string;
  /** Referenciado no HTML como `cid:<contentId>`. */
  contentId: string;
}

export interface EmailMessage {
  /** Destinatário (PII: nunca logar). */
  to: string;
  subject: string;
  /** Corpo em texto puro — sempre presente, é o que clientes simples exibem. */
  text: string;
  /** Corpo HTML opcional. */
  html?: string;
  /**
   * Endereço de resposta.
   *
   * O remetente é `nao-responda@`, que não tem caixa. Sem um `Reply-To`, quem
   * responde escreve para o vazio, e filtros de spam tratam remetente sem
   * resposta possível como sinal de envio em massa. Apontar para o suporte
   * resolve os dois problemas.
   */
  replyTo?: string;
  /**
   * Imagens embutidas na própria mensagem, referenciadas no HTML por
   * `cid:<contentId>`.
   *
   * É embutido, e não buscado de um servidor, de propósito. Uma `<img>` remota
   * revela ao emissor quando a mensagem foi aberta e de qual endereço de rede:
   * é um pixel de rastreamento, mesmo quando ninguém pretendia rastrear. Ver o
   * ADR 0014.
   */
  inlineImages?: InlineImage[];
  /**
   * Chave de idempotência (id do evento da outbox). A entrega é at-least-once;
   * com ela o provedor descarta a repetição em vez de mandar o convite de novo.
   */
  idempotencyKey?: string;
}

export type EmailDeliveryStatus = "sent" | "failed" | "invalidAddress";

export interface EmailDeliveryResult {
  status: EmailDeliveryStatus;
  /** Código curto e seguro do erro (sem endereço, sem resposta bruta do servidor). */
  error?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailDeliveryResult>;
}

/** Fingerprint curta do endereço para correlação em log, sem expor o e-mail. */
export function fingerprintEmail(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 12);
}

/**
 * Erros de SMTP que NÃO adianta repetir: endereço inexistente ou recusado pelo
 * servidor de destino (5xx permanente). O resto — conexão, autenticação,
 * limite temporário — é transitório e vale retry pela outbox.
 */
export function isPermanentSmtpError(code: unknown): boolean {
  const responseCode = typeof code === "number" ? code : Number.NaN;
  return responseCode >= 500 && responseCode < 600;
}
