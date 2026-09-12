import { type LiveLocationPoint } from "../../lib/api";
import { createMockApi } from "../../test-utils/renderWithAuth";
import {
  getJourneyLiveLocationController,
  resetLiveLocationRegistry,
  resyncAllLiveLocation,
  stopAllLiveLocation,
} from "../LiveLocationController";
import type { LocationSample } from "../live-location.service";

/**
 * O controller de trajeto reutiliza o MESMO motor de GPS/uploader da Phase 6
 * (via transporte de trajeto). Aqui garantimos que ele fala com os endpoints
 * de trajeto e participa do lifecycle (logout para; foreground ressincroniza).
 */
const sample: LocationSample = {
  latitude: -23,
  longitude: -46,
  accuracy: 10,
  capturedAt: "2026-09-12T21:00:00.000Z",
};

function setup() {
  const api = createMockApi({
    startJourneyLiveLocation: jest.fn(async () => ({
      sessionId: "session-1",
      status: "ACTIVE" as const,
      startedAt: "2026-09-12T21:00:00.000Z",
      stoppedAt: null,
    })),
    sendJourneyLiveLocation: jest.fn(async () => ({
      sessionId: "session-1",
      point: {} as LiveLocationPoint,
    })),
    stopJourneyLiveLocation: jest.fn(async () => ({
      status: "STOPPED" as const,
      sessionId: "session-1",
      startedAt: "2026-09-12T21:00:00.000Z",
      stoppedAt: "2026-09-12T21:05:00.000Z",
      latest: null,
    })),
    getJourneyLiveLocation: jest.fn(async () => ({
      status: "STOPPED" as const,
      sessionId: "session-1",
      startedAt: "2026-09-12T21:00:00.000Z",
      stoppedAt: "2026-09-12T21:05:00.000Z",
      latest: null,
    })),
  });
  const remove = jest.fn();
  const watch = jest.fn(async () => ({ remove }));
  const requestPermission = jest.fn(async () => "granted" as const);
  const controller = getJourneyLiveLocationController("journey-1", api, {
    requestPermission,
    watch,
  });
  return { api, controller, remove };
}

describe("Controller de localização do trajeto", () => {
  afterEach(() => {
    void stopAllLiveLocation({ notifyBackend: false });
    resetLiveLocationRegistry();
    jest.clearAllMocks();
  });

  it("inicia usando os endpoints de trajeto", async () => {
    const { api, controller } = setup();
    expect(await controller.start()).toBe(true);
    expect(api.startJourneyLiveLocation).toHaveBeenCalledWith("journey-1");
    expect(controller.isActive()).toBe(true);
    void sample; // ponto sintético disponível para watch, se necessário
  });

  it("logout para o watcher localmente (sem avisar o backend)", async () => {
    const { api, controller, remove } = setup();
    await controller.start();
    await stopAllLiveLocation({ notifyBackend: false });
    expect(remove).toHaveBeenCalled();
    expect(api.stopJourneyLiveLocation).not.toHaveBeenCalled();
    expect(controller.isActive()).toBe(false);
  });

  it("foreground ressincroniza e para se o backend já encerrou a sessão", async () => {
    const { api, controller } = setup();
    await controller.start();
    await resyncAllLiveLocation();
    expect(api.getJourneyLiveLocation).toHaveBeenCalledWith("journey-1");
    // Backend devolveu STOPPED → o controller encerra localmente.
    expect(controller.isActive()).toBe(false);
  });
});
