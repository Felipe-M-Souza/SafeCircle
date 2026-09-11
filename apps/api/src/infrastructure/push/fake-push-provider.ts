import type {
  PushDeliveryResult,
  PushDeliveryStatus,
  PushMessage,
  PushProvider,
} from "./push-provider.js";

/**
 * Provedor de push em memória para testes: nunca chama a API da Expo.
 *
 * Permite inspecionar mensagens/destinatários/payload e simular erros
 * (falha total do provedor, token inválido, erro transitório).
 */
export class FakePushProvider implements PushProvider {
  readonly name = "fake";
  /** Lotes enviados, na ordem. */
  readonly batches: PushMessage[][] = [];
  private failNextWith: Error | null = null;
  private readonly resultsByToken = new Map<
    string,
    { status: PushDeliveryStatus; error?: string }
  >();

  /** Todas as mensagens enviadas, em ordem. */
  get messages(): PushMessage[] {
    return this.batches.flat();
  }

  /** Tokens destinatários de todas as mensagens enviadas. */
  get recipients(): string[] {
    return this.messages.map((message) => message.to);
  }

  /** A próxima chamada a `send` lança este erro (simula provedor indisponível). */
  failNext(error: Error = new Error("Provedor de push indisponível.")): void {
    this.failNextWith = error;
  }

  /** Define o resultado devolvido para um token específico. */
  setResult(token: string, status: PushDeliveryStatus, error?: string): void {
    this.resultsByToken.set(token, { status, error });
  }

  reset(): void {
    this.batches.length = 0;
    this.failNextWith = null;
    this.resultsByToken.clear();
  }

  async send(messages: PushMessage[]): Promise<PushDeliveryResult[]> {
    if (this.failNextWith) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
    this.batches.push(messages.map((message) => ({ ...message })));
    return messages.map((message) => {
      const configured = this.resultsByToken.get(message.to);
      return configured
        ? { to: message.to, status: configured.status, error: configured.error }
        : { to: message.to, status: "sent" };
    });
  }
}
