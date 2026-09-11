import { createHash } from "node:crypto";

/**
 * Abstração do provedor de push (Phase 4).
 *
 * O domínio (alertas, dispositivos) depende apenas desta interface — nunca do
 * SDK/API da Expo. Implementações: `ExpoPushProvider` (produção) e
 * `FakePushProvider` (testes).
 */

export interface PushMessage {
  /** Push token do destinatário (dado sensível: nunca logar completo). */
  to: string;
  title: string;
  body: string;
  /** Apenas IDs de navegação — nunca dados sensíveis. */
  data?: Record<string, string>;
  /** Canal Android (ex.: "emergency"). */
  channelId?: string;
  priority?: "default" | "normal" | "high";
  sound?: "default" | null;
}

export type PushDeliveryStatus = "sent" | "failed" | "invalidToken";

export interface PushDeliveryResult {
  to: string;
  status: PushDeliveryStatus;
  /** Código curto e seguro do erro (sem token, sem mensagem bruta do provedor). */
  error?: string;
}

export interface PushProvider {
  readonly name: string;
  send(messages: PushMessage[]): Promise<PushDeliveryResult[]>;
}

/**
 * Fingerprint curta de um token para correlação em logs, sem expor o token.
 */
export function fingerprintToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
