import { createApiClient } from "../api";

/**
 * Achado em aparelho (2026-09-16): o cliente enviava `Content-Type:
 * application/json` em todo POST, inclusive sem corpo (resolver/cancelar
 * alerta, iniciar localização ao vivo). A API recusava o "JSON vazio" com 400
 * e o app mostrava "Dados inválidos". O header só pode ir quando há corpo.
 */
const originalFetch = globalThis.fetch;

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function headersOf(call: [string, RequestInit?]): Record<string, string> {
  const init = call[1] ?? {};
  return (init.headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Cliente HTTP — Content-Type", () => {
  it("POST sem corpo (resolver alerta) não envia Content-Type", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ id: "a1", status: "RESOLVED" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = createApiClient({
      getAccessToken: () => "token-de-teste",
      refreshAccessToken: async () => null,
    });

    await api.resolveAlert("a1");
    await api.cancelAlert("a1");
    await api.startLiveLocation("a1");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] ?? {};
      expect(init.method).toBe("POST");
      expect(init.body).toBeUndefined();
      expect(headersOf(call)["Content-Type"]).toBeUndefined();
      expect(headersOf(call).Authorization).toBe("Bearer token-de-teste");
    }
  });

  it("POST com corpo envia Content-Type: application/json e o JSON", async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) =>
      okResponse({ id: "g1" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const api = createApiClient({
      getAccessToken: () => "token-de-teste",
      refreshAccessToken: async () => null,
    });

    await api.createGroup("Família");

    const call = fetchMock.mock.calls[0]!;
    expect(headersOf(call)["Content-Type"]).toBe("application/json");
    expect(call[1]?.body).toBe(JSON.stringify({ name: "Família" }));
  });
});
