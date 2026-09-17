import type {
  EmailDeliveryResult,
  EmailDeliveryStatus,
  EmailMessage,
  EmailProvider,
} from "./email-provider.js";

/**
 * Provedor de e-mail em memória para testes: nunca abre conexão SMTP.
 *
 * Permite inspecionar destinatário, assunto e corpo, e simular endereço
 * recusado (permanente) ou servidor fora do ar (transitório).
 */
export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake";
  /** Mensagens enviadas, na ordem. */
  readonly messages: EmailMessage[] = [];
  private nextResults: EmailDeliveryResult[] = [];

  get recipients(): string[] {
    return this.messages.map((message) => message.to);
  }

  /** Define o resultado da próxima chamada a `send` (fila). */
  queueResult(status: EmailDeliveryStatus, error?: string): void {
    this.nextResults.push({ status, error });
  }

  reset(): void {
    this.messages.length = 0;
    this.nextResults = [];
  }

  async send(message: EmailMessage): Promise<EmailDeliveryResult> {
    this.messages.push({ ...message });
    return this.nextResults.shift() ?? { status: "sent" };
  }
}
