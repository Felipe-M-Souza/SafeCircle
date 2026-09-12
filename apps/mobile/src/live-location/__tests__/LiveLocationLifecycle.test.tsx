import { AppState, type AppStateStatus } from "react-native";
import { act, render } from "@testing-library/react-native";
import { AuthContext } from "../../auth/AuthContext";
import { createAuthValue, createMockApi } from "../../test-utils/renderWithAuth";
import { getLiveLocationController, resetLiveLocationRegistry } from "../LiveLocationController";
import { LiveLocationLifecycle } from "../LiveLocationLifecycle";

describe("LiveLocationLifecycle", () => {
  let handlers: Array<(state: AppStateStatus) => void> = [];

  beforeEach(() => {
    resetLiveLocationRegistry();
    handlers = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, handler) => {
      handlers.push(handler as (state: AppStateStatus) => void);
      return { remove: jest.fn() };
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function activeController(api: ReturnType<typeof createMockApi>) {
    const remove = jest.fn();
    const controller = getLiveLocationController("alert-1", api, {
      requestPermission: jest.fn(async () => "granted" as const),
      watch: jest.fn(async () => ({ remove })),
    });
    await controller.start();
    return { controller, remove };
  }

  function apiWithSession(status: "ACTIVE" | "STOPPED") {
    return createMockApi({
      startLiveLocation: jest.fn(async () => ({
        sessionId: "s",
        status: "ACTIVE" as const,
        startedAt: "2026-09-11T20:00:00.000Z",
        stoppedAt: null,
      })),
      getLiveLocation: jest.fn(async () => ({
        status,
        sessionId: "s",
        startedAt: "2026-09-11T20:00:00.000Z",
        stoppedAt: status === "STOPPED" ? "2026-09-11T20:05:00.000Z" : null,
        latest: null,
      })),
    });
  }

  it("ao voltar ao primeiro plano ressincroniza e para o que o backend já encerrou", async () => {
    const api = apiWithSession("STOPPED");
    const { controller, remove } = await activeController(api);
    await render(
      <AuthContext.Provider value={createAuthValue(api)}>
        <LiveLocationLifecycle />
      </AuthContext.Provider>,
    );

    await act(async () => {
      for (const handler of handlers) handler("active");
    });

    expect(api.getLiveLocation).toHaveBeenCalledWith("alert-1");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe("STOPPED");
  });

  it("sessão ainda ativa no backend: mantém o watcher", async () => {
    const api = apiWithSession("ACTIVE");
    const { controller, remove } = await activeController(api);
    await render(
      <AuthContext.Provider value={createAuthValue(api)}>
        <LiveLocationLifecycle />
      </AuthContext.Provider>,
    );
    await act(async () => {
      for (const handler of handlers) handler("active");
    });
    expect(remove).not.toHaveBeenCalled();
    expect(controller.getSnapshot().state).toBe("ACTIVE");
  });

  it("logout (não autenticado) para todos os compartilhamentos imediatamente", async () => {
    const api = apiWithSession("ACTIVE");
    const { controller, remove } = await activeController(api);
    const view = await render(
      <AuthContext.Provider value={createAuthValue(api)}>
        <LiveLocationLifecycle />
      </AuthContext.Provider>,
    );
    await view.rerender(
      <AuthContext.Provider value={createAuthValue(api, { status: "unauthenticated", user: null })}>
        <LiveLocationLifecycle />
      </AuthContext.Provider>,
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe("STOPPED");
    // Sem credencial não tentamos chamar o backend.
    expect(api.stopLiveLocation).not.toHaveBeenCalled();
  });
});
