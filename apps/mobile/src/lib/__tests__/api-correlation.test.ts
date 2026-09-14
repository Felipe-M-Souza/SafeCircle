import { ApiError, createApiClient } from "../api";

/**
 * Correlação no cliente (Phase 9): o app precisa conseguir dizer ao suporte
 * QUAL requisição falhou. O `requestId`/`errorId` vem do corpo (ou do header)
 * e nunca é inventado pelo app.
 */
const originalFetch = globalThis.fetch;

function mockResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ApiError — correlação", () => {
  it("lê requestId e errorId do corpo em uma falha interna", async () => {
    globalThis.fetch = jest.fn(async () =>
      mockResponse(500, {
        code: "INTERNAL_ERROR",
        message: "Erro interno.",
        requestId: "11111111-1111-4111-8111-111111111111",
        errorId: "22222222-2222-4222-8222-222222222222",
      }),
    ) as unknown as typeof fetch;

    const api = createApiClient();
    const error = await api.listGroups().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(500);
    expect(apiError.requestId).toBe("11111111-1111-4111-8111-111111111111");
    expect(apiError.errorId).toBe("22222222-2222-4222-8222-222222222222");
    // O código de suporte prefere o errorId (identifica a falha exata).
    expect(apiError.supportCode).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("sem requestId no corpo, usa o header X-Request-Id", async () => {
    globalThis.fetch = jest.fn(async () =>
      mockResponse(
        404,
        { code: "GROUP_NOT_FOUND", message: "Grupo não encontrado." },
        { "x-request-id": "33333333-3333-4333-8333-333333333333" },
      ),
    ) as unknown as typeof fetch;

    const api = createApiClient();
    const error = (await api.listGroups().catch((e: unknown) => e)) as ApiError;
    expect(error.requestId).toBe("33333333-3333-4333-8333-333333333333");
    expect(error.errorId).toBeUndefined();
    expect(error.supportCode).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("ignora valores absurdos vindos do servidor", async () => {
    globalThis.fetch = jest.fn(async () =>
      mockResponse(500, {
        code: "INTERNAL_ERROR",
        message: "Erro interno.",
        requestId: "x".repeat(500),
        errorId: 12345,
      }),
    ) as unknown as typeof fetch;

    const api = createApiClient();
    const error = (await api.listGroups().catch((e: unknown) => e)) as ApiError;
    expect(error.requestId).toBeUndefined();
    expect(error.errorId).toBeUndefined();
    expect(error.supportCode).toBeUndefined();
  });

  it("falha de rede não inventa correlação", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new TypeError("Network request failed");
    }) as unknown as typeof fetch;

    const api = createApiClient();
    const error = (await api.listGroups().catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("NETWORK");
    expect(error.supportCode).toBeUndefined();
  });
});
