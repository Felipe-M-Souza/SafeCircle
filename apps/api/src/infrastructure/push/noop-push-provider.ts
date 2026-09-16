import type { FastifyBaseLogger } from "fastify";
import type { PushDeliveryResult, PushMessage, PushProvider } from "./push-provider.js";

/**
 * Provedor de push que não envia nada (Phase 12).
 *
 * Existe para o ambiente E2E e para staging sem credenciais: a API sobe com o
 * worker da outbox ligado, processa os eventos de push e marca cada mensagem
 * como enviada — sem jamais chamar a Expo. Recusado em produção pela
 * validação de configuração (`PUSH_PROVIDER=noop` só fora de `production`).
 *
 * Loga apenas a quantidade: nunca token, título ou corpo.
 */
export class NoopPushProvider implements PushProvider {
  readonly name = "noop";
  private sentCount = 0;

  constructor(private readonly log?: FastifyBaseLogger) {}

  async send(messages: PushMessage[]): Promise<PushDeliveryResult[]> {
    this.sentCount += messages.length;
    this.log?.info(
      { event: "push_noop_delivery", recipients: messages.length },
      "Push descartado pelo provedor noop (ambiente sem Expo)",
    );
    return messages.map((message) => ({ to: message.to, status: "sent" }));
  }

  /** Total "entregue" desde o início do processo (diagnóstico). */
  total(): number {
    return this.sentCount;
  }
}
