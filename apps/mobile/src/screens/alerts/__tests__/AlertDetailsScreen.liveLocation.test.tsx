import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import {
  getLiveLocationController,
  resetLiveLocationRegistry,
} from "../../../live-location/LiveLocationController";
import {
  createMockApi,
  createMockNav,
  makeAlert,
  renderWithAuth,
} from "../../../test-utils/renderWithAuth";
import { AlertDetailsScreen } from "../AlertDetailsScreen";

describe("AlertDetailsScreen — localização ao vivo ao encerrar o alerta", () => {
  beforeEach(() => {
    resetLiveLocationRegistry();
  });

  it("resolver o alerta para o watcher local imediatamente (backend já encerrou a sessão)", async () => {
    const api = createMockApi({
      getAlert: jest.fn(async () => makeAlert()),
      resolveAlert: jest.fn(async () =>
        makeAlert({ status: "RESOLVED", resolvedAt: "2026-09-11T20:45:00.000Z" }),
      ),
      startLiveLocation: jest.fn(async () => ({
        sessionId: "s",
        status: "ACTIVE" as const,
        startedAt: "2026-09-11T20:00:00.000Z",
        stoppedAt: null,
      })),
      getLiveLocation: jest.fn(async () => ({
        status: "ACTIVE" as const,
        sessionId: "s",
        startedAt: "2026-09-11T20:00:00.000Z",
        stoppedAt: null,
        latest: null,
      })),
      getLiveLocationHistory: jest.fn(async () => ({ sessionId: "s", points: [] })),
    });
    const remove = jest.fn();
    const controller = getLiveLocationController("alert-1", api, {
      requestPermission: jest.fn(async () => "granted" as const),
      watch: jest.fn(async () => ({ remove })),
    });
    await controller.start();
    expect(controller.getSnapshot().state).toBe("ACTIVE");

    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });
    expect(await screen.findByText("Ativa")).toBeOnTheScreen();

    await fireEvent.press(await screen.findByText("ESTOU EM SEGURANÇA"));

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(controller.getSnapshot().state).toBe("STOPPED");
    // O backend encerrou a sessão na mesma transação do resolve: não há stop extra.
    expect(api.stopLiveLocation).not.toHaveBeenCalled();
    expect(await screen.findByText("Alerta resolvido")).toBeOnTheScreen();
  });
});
