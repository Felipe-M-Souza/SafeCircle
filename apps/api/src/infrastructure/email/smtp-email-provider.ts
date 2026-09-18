import nodemailer, { type Transporter } from "nodemailer";
import type { FastifyBaseLogger } from "fastify";
import {
  fingerprintEmail,
  isPermanentSmtpError,
  type EmailDeliveryResult,
  type EmailMessage,
  type EmailProvider,
} from "./email-provider.js";

/**
 * Envio por SMTP (Phase 13) — funciona com Resend, SendGrid, Amazon SES,
 * Postmark, Gmail ou qualquer servidor que fale o protocolo. A escolha do
 * provedor é uma configuração de ambiente, não uma dependência de código.
 *
 * A senha vive apenas na variável de ambiente e nunca é logada. O log de
 * entrega carrega a fingerprint do destinatário, não o endereço.
 */

export interface SmtpEmailProviderOptions {
  host: string;
  port: number;
  /** TLS implícito (porta 465). Em 587 o transporte faz STARTTLS. */
  secure: boolean;
  user?: string;
  password?: string;
  /** Remetente no formato `Nome <endereco>` ou apenas o endereço. */
  from: string;
  log: FastifyBaseLogger;
  /** Injetável nos testes; em produção o transporte real é criado aqui. */
  transporter?: Transporter;
}

export class SmtpEmailProvider implements EmailProvider {
  readonly name = "smtp";
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly log: FastifyBaseLogger;

  constructor(options: SmtpEmailProviderOptions) {
    this.from = options.from;
    this.log = options.log;
    this.transporter =
      options.transporter ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: options.user ? { user: options.user, pass: options.password ?? "" } : undefined,
        // Um e-mail de convite não justifica segurar o worker da outbox.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
  }

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    const recipient = fingerprintEmail(message.to);
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.idempotencyKey
          ? { "Resend-Idempotency-Key": message.idempotencyKey }
          : undefined,
      });
      this.log.info({ event: "email_sent", provider: this.name, recipient }, "E-mail enviado");
      return { status: "sent" };
    } catch (error) {
      const failure = error as { responseCode?: number; code?: string; command?: string };
      const code = failure.responseCode;
      const permanent = isPermanentSmtpError(code);
      this.log.warn(
        {
          event: "email_send_failed",
          provider: this.name,
          recipient,
          responseCode: typeof code === "number" ? code : undefined,
          // Código técnico do erro (ECONNREFUSED, ETIMEDOUT, EAUTH, ESOCKET...)
          // e comando SMTP em que parou. Nenhum dos dois carrega endereço,
          // credencial ou conteúdo — existem para diagnosticar entrega.
          errorCode: typeof failure.code === "string" ? failure.code : undefined,
          smtpCommand: typeof failure.command === "string" ? failure.command : undefined,
          permanent,
        },
        "Falha ao enviar e-mail",
      );
      return {
        status: permanent ? "invalidAddress" : "failed",
        error: permanent ? "SMTP_PERMANENT" : "SMTP_TRANSIENT",
      };
    }
  }
}
