import type { FastifyBaseLogger } from "fastify";
import {
  fingerprintEmail,
  type EmailDeliveryResult,
  type EmailMessage,
  type EmailProvider,
} from "./email-provider.js";

/**
 * Envio pela API HTTP do Resend (Phase 13).
 *
 * Existe porque **o Railway bloqueia portas SMTP de saída** (465/587) nos
 * planos abaixo do Pro: a conexão simplesmente expira. A API do Resend fala
 * HTTPS na 443, que nenhuma hospedagem bloqueia. O `SmtpEmailProvider` continua
 * disponível para quem hospedar em outro lugar — a escolha é de ambiente.
 *
 * Ganho colateral: a API aceita `Idempotency-Key`. Como a outbox é
 * at-least-once, reprocessar um evento deixaria o convite chegar duas vezes;
 * com a chave (o id do evento) o Resend descarta a repetição.
 *
 * A chave de API nunca é logada; o destinatário aparece só como fingerprint.
 */

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;

export interface ResendApiEmailProviderOptions {
  apiKey: string;
  /** Remetente no formato `Nome <endereco>` ou apenas o endereço. */
  from: string;
  log: FastifyBaseLogger;
  /** Injetável nos testes; em produção usa o fetch global. */
  fetchImpl?: typeof fetch;
}

export class ResendApiEmailProvider implements EmailProvider {
  readonly name = "resend";
  private readonly apiKey: string;
  private readonly from: string;
  private readonly log: FastifyBaseLogger;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendApiEmailProviderOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.log = options.log;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    const recipient = fingerprintEmail(message.to);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
    };
    if (message.idempotencyKey) {
      headers["Idempotency-Key"] = message.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          reply_to: message.replyTo,
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Rede indisponível ou timeout: vale tentar de novo pela outbox.
      this.log.warn(
        {
          event: "email_send_failed",
          provider: this.name,
          recipient,
          errorCode: (error as { name?: string }).name ?? "FETCH_FAILED",
          permanent: false,
        },
        "Falha de rede ao enviar e-mail",
      );
      return { status: "failed", error: "RESEND_NETWORK" };
    }

    if (response.ok) {
      this.log.info({ event: "email_sent", provider: this.name, recipient }, "E-mail enviado");
      return { status: "sent" };
    }

    // 422: payload recusado (endereço inválido, domínio não verificado). Retry
    // não resolve. 401/403/429/5xx podem mudar sozinhos ou com uma correção de
    // configuração, então seguem transitórios até esgotar as tentativas.
    const permanent = response.status === 422;
    this.log.warn(
      {
        event: "email_send_failed",
        provider: this.name,
        recipient,
        httpStatus: response.status,
        permanent,
      },
      "Resend recusou o e-mail",
    );
    return {
      status: permanent ? "invalidAddress" : "failed",
      error: permanent ? "RESEND_REJECTED" : "RESEND_HTTP_ERROR",
    };
  }
}
