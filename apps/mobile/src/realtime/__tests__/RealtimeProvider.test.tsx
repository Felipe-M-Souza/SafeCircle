import { AppState, Text, type AppStateStatus } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { AuthContext, type AuthContextValue } from "../../auth/AuthContext";
import { createAuthValue, createMockApi } from "../../test-utils/renderWithAuth";
import { RealtimeProvider, useRealtime } from "../RealtimeProvider";
import type { RealtimeSocket } from "../RealtimeClient";

class FakeSocket implements RealtimeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly closes: number[] = [];
  constructor(readonly token: string) {}
  close(code?: number): void {
    this.closes.push(code ?? 1005);
  }
}

function Probe(): React.JSX.Element {
  const realtime = useRealtime();
  return (
    <>
      <Text testID="state">{realtime?.state ?? "sem-provider"}</Text>
      <Text testID="resync">{String(realtime?.resyncVersion ?? -1)}</Text>
    </>
  );
}

describe("RealtimeProvider", () => {
  const sockets: FakeSocket[] = [];
  const createSocket = jest.fn((_url: string, token: string) => {
    const socket = new FakeSocket(token);
    sockets.push(socket);
    return socket;
  });
  let appStateHandlers: Array<(state: AppStateStatus) => void> = [];

  beforeEach(() => {
    sockets.length = 0;
    createSocket.mockClear();
    appStateHandlers = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
      appStateHandlers.push(handler as (state: AppStateStatus) => void);
      return { remove: jest.fn() };
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function tree(auth: AuthContextValue) {
    return (
      <AuthContext.Provider value={auth}>
        <RealtimeProvider createSocket={createSocket} url="ws://api.test/realtime">
          <Probe />
        </RealtimeProvider>
      </AuthContext.Provider>
    );
  }

  async function emitAppState(state: AppStateStatus) {
    await act(async () => {
      for (const handler of appStateHandlers) handler(state);
    });
  }

  it("conecta após autenticação com o access token e ressincroniza ao abrir", async () => {
    const auth = createAuthValue(createMockApi(), { getAccessToken: () => "tok-A" });
    await render(tree(auth));

    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(sockets[0]?.token).toBe("tok-A");
    expect(screen.getByTestId("state")).toHaveTextContent("CONNECTING");
    expect(screen.getByTestId("resync")).toHaveTextContent("0");

    await act(async () => sockets[0]!.onopen?.());
    expect(screen.getByTestId("state")).toHaveTextContent("CONNECTED");
    expect(screen.getByTestId("resync")).toHaveTextContent("1");
  });

  it("não conecta quando não autenticado e fecha no logout sem reconectar", async () => {
    jest.useFakeTimers();
    const api = createMockApi();
    const view = await render(
      tree(createAuthValue(api, { status: "unauthenticated", user: null })),
    );
    expect(createSocket).not.toHaveBeenCalled();

    await view.rerender(tree(createAuthValue(api)));
    expect(createSocket).toHaveBeenCalledTimes(1);
    await act(async () => sockets[0]!.onopen?.());

    await view.rerender(
      tree(createAuthValue(api, { status: "unauthenticated", user: null, accessTokenVersion: 2 })),
    );
    expect(sockets[0]?.closes).toEqual([1000]);
    expect(screen.getByTestId("state")).toHaveTextContent("DISCONNECTED");
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(createSocket).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it("background fecha o socket; foreground reconecta e ressincroniza", async () => {
    await render(tree(createAuthValue(createMockApi())));
    await act(async () => sockets[0]!.onopen?.());
    expect(screen.getByTestId("resync")).toHaveTextContent("1");

    await emitAppState("background");
    expect(sockets[0]?.closes).toEqual([1000]);
    expect(screen.getByTestId("state")).toHaveTextContent("DISCONNECTED");

    await emitAppState("active");
    expect(createSocket).toHaveBeenCalledTimes(2);
    await act(async () => sockets[1]!.onopen?.());
    expect(screen.getByTestId("state")).toHaveTextContent("CONNECTED");
    expect(screen.getByTestId("resync")).toHaveTextContent("2");
  });

  it("access token renovado: reconecta com o token novo (sem duplicar sockets)", async () => {
    const api = createMockApi();
    let current = "tok-1";
    const view = await render(
      tree(createAuthValue(api, { getAccessToken: () => current, accessTokenVersion: 1 })),
    );
    await act(async () => sockets[0]!.onopen?.());

    current = "tok-2";
    await view.rerender(
      tree(createAuthValue(api, { getAccessToken: () => current, accessTokenVersion: 2 })),
    );
    expect(sockets[0]?.closes).toEqual([1000]);
    expect(createSocket).toHaveBeenCalledTimes(2);
    expect(sockets[1]?.token).toBe("tok-2");
  });

  it("desmontar fecha o socket; useRealtime é null fora do provider", async () => {
    const view = await render(tree(createAuthValue(createMockApi())));
    await view.unmount();
    expect(sockets[0]?.closes).toEqual([1000]);

    await render(<Probe />);
    expect(screen.getByTestId("state")).toHaveTextContent("sem-provider");
  });
});
