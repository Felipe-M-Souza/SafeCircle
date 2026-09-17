import type { FastifyBaseLogger } from "fastify";
import {
  fingerprintEmail,
  type EmailDeliveryResult,
  type EmailMessage,
  type EmailProvider,
} from "./email-provider.js";

/**
 * Provedor que não envia nada (Phase 13) — padrão quando não há SMTP
 * configurado. Registra a intenção de envio e devolve sucesso, para que a
 * outbox não acumule retries eternos por uma configuração que simplesmente
 * não existe naquele ambiente.
 *
 * O convite continua funcionando dentro do app: quem foi convidado vê em
 * "Convites recebidos". O e-mail é um aviso adicional, não o mecanismo.
 *
 * Nunca registra o endereço, só a fingerprint — o log é o mesmo em qualquer
 * ambiente e não vira um vazamento de PII em desenvolvimento.
 */
export class NoopEmailProvider implements EmailProvider {
  readonly name = "noop";

  constructor(private readonly log: FastifyBaseLogger) {}

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    this.log.info(
      {
        event: "email_skipped_noop",
        provider: this.name,
        recipient: fingerprintEmail(message.to),
        subject: message.subject,
      },
      "E-mail não enviado: nenhum provedor SMTP configurado",
    );
    return { status: "sent" };
  }
}
