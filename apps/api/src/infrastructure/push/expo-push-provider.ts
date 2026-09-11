import type { PushDeliveryResult, PushMessage, PushProvider } from "./push-provider.js";

/**
 * Provedor de push via Expo Push API (HTTP direto, encapsulado).
 *
 * - Envia em lotes de até 100 mensagens (limite da Expo).
 * - Timeout por lote: a requisição nunca fica presa indefinidamente.
 * - Mapeia os "tickets" da Expo para um resultado simples e seguro:
 *   `ok` → sent; `DeviceNotRegistered` → invalidToken; demais → failed.
 * - Nunca inclui o token nem a mensagem bruta do provedor nos resultados.
 */

export const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_CHUNK_SIZE = 100;
export const DEFAULT_PUSH_TIMEOUT_MS = 8000;

/** Erros da Expo que indicam token definitivamente inválido → desativar. */
export const INVALID_TOKEN_ERRORS = new Set(["DeviceNotRegistered"]);

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

interface ExpoResponse {
  data?: ExpoTicket[];
  errors?: Array<{ code?: string; message?: string }>;
}

export interface ExpoPushProviderOptions {
  /** Token de acesso opcional da Expo (segredo; vem do ambiente). */
  accessToken?: string;
  timeoutMs?: number;
  url?: string;
  /** Injetável para testes; padrão: `fetch` global do Node. */
  fetchImpl?: typeof fetch;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function safeErrorCode(value: unknown, fallback: string): string {
  // Apenas códigos alfanuméricos curtos: nunca mensagens que possam conter o token.
  return typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : fallback;
}

export class ExpoPushProvider implements PushProvider {
  readonly name = "expo";
  private readonly accessToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ExpoPushProviderOptions = {}) {
    this.accessToken = options.accessToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
    this.url = options.url ?? EXPO_PUSH_API_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(messages: PushMessage[]): Promise<PushDeliveryResult[]> {
    const results: PushDeliveryResult[] = [];
    for (const batch of chunk(messages, EXPO_PUSH_CHUNK_SIZE)) {
      results.push(...(await this.sendBatch(batch)));
    }
    return results;
  }

  private async sendBatch(batch: PushMessage[]): Promise<PushDeliveryResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (this.accessToken) {
        headers.Authorization = `Bearer ${this.accessToken}`;
      }

      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(
          batch.map((message) => ({
            to: message.to,
            title: message.title,
            body: message.body,
            data: message.data,
            channelId: message.channelId,
            priority: message.priority,
            sound: message.sound ?? "default",
          })),
        ),
        signal: controller.signal,
      });

      if (!response.ok) {
        return batch.map((message) => ({
          to: message.to,
          status: "failed",
          error: `HTTP_${response.status}`,
        }));
      }

      const payload = (await response.json()) as ExpoResponse;
      if (!Array.isArray(payload.data) || payload.data.length !== batch.length) {
        const code = safeErrorCode(payload.errors?.[0]?.code, "InvalidResponse");
        return batch.map((message) => ({ to: message.to, status: "failed", error: code }));
      }

      return batch.map((message, index) => {
        const ticket = payload.data?.[index];
        if (ticket?.status === "ok") {
          return { to: message.to, status: "sent" };
        }
        const code = safeErrorCode(ticket?.details?.error, "UnknownError");
        return {
          to: message.to,
          status: INVALID_TOKEN_ERRORS.has(code) ? "invalidToken" : "failed",
          error: code,
        };
      });
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        (error as { name?: string }).name === "AbortError"
          ? "Timeout"
          : "NetworkError";
      return batch.map((message) => ({ to: message.to, status: "failed", error: code }));
    } finally {
      clearTimeout(timer);
    }
  }
}
