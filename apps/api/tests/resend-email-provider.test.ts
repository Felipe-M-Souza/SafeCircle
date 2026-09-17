import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { ResendApiEmailProvider } from "../src/infrastructure/email/resend-api-email-provider.js";

/**
 * Envio pela API HTTP do Resend (Phase 13).
 *
 * Existe porque o Railway bloqueia SMTP de saída fora do plano Pro. Os testes
 * cobrem o que decide a vida do evento na outbox: sucesso, recusa definitiva e
 * falha que vale retry — além de garantir que a chave nunca vai para o log.
 */
function fakeLog() {
  const entries: Array<{ level: string; payload: Record<string, unknown>; message: string }> = [];
  const record =
    (level: string) =>
    (payload: Record<string, unknown>, message: string): void => {
      entries.push({ level, payload, message });
    };
  const log = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as FastifyBaseLogger;
  return { log, entries };
}

const API_KEY = "re_chave_sintetica_de_teste_0001";

function provider(fetchImpl: typeof fetch) {
  const { log, entries } = fakeLog();
  return {
    entries,
    instance: new ResendApiEmailProvider({
      apiKey: API_KEY,
      from: "SafeCircle <nao-responda@exemplo.invalid>",
      log,
      fetchImpl,
    }),
  };
}

const message = {
  to: "convidado@exemplo.invalid",
  subject: "Convite",
  text: "corpo",
  html: "<p>corpo</p>",
  idempotencyKey: "evento-1",
};

describe("ResendApiEmailProvider", () => {
  it("envia por HTTPS com Bearer e chave de idempotência do evento da outbox", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { instance } = provider(fetchImpl as unknown as typeof fetch);

    const result = await instance.send(message);

    expect(result.status).toBe("sent");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`);
    // Reprocessar o evento não pode virar convite duplicado.
    expect(headers["Idempotency-Key"]).toBe("evento-1");
    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(["convidado@exemplo.invalid"]);
    expect(body.from).toContain("nao-responda@exemplo.invalid");
  });

  it("422 é recusa definitiva: vira DEAD em vez de gastar tentativas", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 422 }));
    const { instance } = provider(fetchImpl as unknown as typeof fetch);

    const result = await instance.send(message);

    expect(result.status).toBe("invalidAddress");
    expect(result.error).toBe("RESEND_REJECTED");
  });

  it("limite de taxa e erro do servidor continuam transitórios", async () => {
    for (const status of [429, 500, 503]) {
      const fetchImpl = vi.fn(async () => new Response("{}", { status }));
      const { instance } = provider(fetchImpl as unknown as typeof fetch);
      const result = await instance.send(message);
      expect(result.status, `status ${status}`).toBe("failed");
      expect(result.error).toBe("RESEND_HTTP_ERROR");
    }
  });

  it("falha de rede é transitória e não derruba o worker", async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    });
    const { instance } = provider(fetchImpl as unknown as typeof fetch);

    const result = await instance.send(message);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("RESEND_NETWORK");
  });

  it("nunca registra a chave da API nem o endereço do destinatário", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => new Response("{}", { status: 200 }),
      async () => new Response("{}", { status: 422 }),
      async () => {
        throw new Error("boom");
      },
    ];
    for (const impl of cases) {
      const { instance, entries } = provider(vi.fn(impl) as unknown as typeof fetch);
      await instance.send(message);
      const raw = JSON.stringify(entries);
      expect(raw).not.toContain(API_KEY);
      expect(raw).not.toContain("convidado@exemplo.invalid");
      // Correlação continua possível pela fingerprint.
      expect(raw).toContain("recipient");
    }
  });
});
