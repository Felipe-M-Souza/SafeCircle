import { describe, expect, it } from "vitest";
import {
  EXPO_PUSH_API_URL,
  EXPO_PUSH_CHUNK_SIZE,
  ExpoPushProvider,
} from "../src/infrastructure/push/expo-push-provider.js";
import { fingerprintToken, type PushMessage } from "../src/infrastructure/push/push-provider.js";

/**
 * Testa o cliente da Expo Push API com `fetch` injetado — nenhuma chamada real.
 * Tokens sintéticos.
 */

function message(to: string): PushMessage {
  return { to, title: "t", body: "b", data: { type: "EMERGENCY_ALERT", alertId: "a" } };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ExpoPushProvider", () => {
  it("envia para a Expo Push API e mapeia tickets ok / DeviceNotRegistered / outros", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse(200, {
        data: [
          { status: "ok", id: "ticket-1" },
          {
            status: "error",
            message: "ExponentPushToken[t2] is not a registered push notification recipient",
            details: { error: "DeviceNotRegistered" },
          },
          { status: "error", message: "rate", details: { error: "MessageRateExceeded" } },
          { status: "error" },
        ],
      });
    };
    const provider = new ExpoPushProvider({ fetchImpl, accessToken: "segredo-de-teste" });

    const results = await provider.send([
      message("ExponentPushToken[t1]"),
      message("ExponentPushToken[t2]"),
      message("ExponentPushToken[t3]"),
      message("ExponentPushToken[t4]"),
    ]);

    expect(results).toEqual([
      { to: "ExponentPushToken[t1]", status: "sent" },
      { to: "ExponentPushToken[t2]", status: "invalidToken", error: "DeviceNotRegistered" },
      { to: "ExponentPushToken[t3]", status: "failed", error: "MessageRateExceeded" },
      { to: "ExponentPushToken[t4]", status: "failed", error: "UnknownError" },
    ]);
    // Erros nunca carregam a mensagem bruta (que pode conter o token).
    expect(JSON.stringify(results.map((r) => r.error))).not.toContain("registered push");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(EXPO_PUSH_API_URL);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer segredo-de-teste");
    const body = JSON.parse(String(calls[0]?.init.body)) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(4);
    expect(body[0]).toMatchObject({ to: "ExponentPushToken[t1]", sound: "default" });
  });

  it("divide em lotes de 100", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      const batch = JSON.parse(String(init?.body)) as unknown[];
      return jsonResponse(200, { data: batch.map(() => ({ status: "ok" })) });
    };
    const provider = new ExpoPushProvider({ fetchImpl });
    const results = await provider.send(
      Array.from({ length: EXPO_PUSH_CHUNK_SIZE + 5 }, (_, i) =>
        message(`ExponentPushToken[t${i}]`),
      ),
    );
    expect(calls).toBe(2);
    expect(results).toHaveLength(EXPO_PUSH_CHUNK_SIZE + 5);
    expect(results.every((r) => r.status === "sent")).toBe(true);
  });

  it("HTTP não-2xx e resposta inválida → failed (nunca invalidToken)", async () => {
    const provider500 = new ExpoPushProvider({ fetchImpl: async () => jsonResponse(500, {}) });
    expect(await provider500.send([message("ExponentPushToken[t1]")])).toEqual([
      { to: "ExponentPushToken[t1]", status: "failed", error: "HTTP_500" },
    ]);

    const providerBad = new ExpoPushProvider({
      fetchImpl: async () =>
        jsonResponse(200, { errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS" }] }),
    });
    expect(await providerBad.send([message("ExponentPushToken[t1]")])).toEqual([
      { to: "ExponentPushToken[t1]", status: "failed", error: "PUSH_TOO_MANY_EXPERIENCE_IDS" },
    ]);
  });

  it("timeout e erro de rede → failed, sem ficar preso", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    const slow = new ExpoPushProvider({ fetchImpl: hanging, timeoutMs: 20 });
    expect(await slow.send([message("ExponentPushToken[t1]")])).toEqual([
      { to: "ExponentPushToken[t1]", status: "failed", error: "Timeout" },
    ]);

    const broken = new ExpoPushProvider({
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await broken.send([message("ExponentPushToken[t1]")])).toEqual([
      { to: "ExponentPushToken[t1]", status: "failed", error: "NetworkError" },
    ]);
  });

  it("fingerprintToken não revela o token", () => {
    const token = "ExponentPushToken[abcdefgh12345678]";
    const fp = fingerprintToken(token);
    expect(fp).toHaveLength(12);
    expect(token).not.toContain(fp);
  });
});
