import { ApiError, type LiveLocationPoint } from "../../lib/api";
import { createMockApi } from "../../test-utils/renderWithAuth";
import {
  LiveLocationController,
  getLiveLocationController,
  resetLiveLocationRegistry,
  resyncAllLiveLocation,
  stopAllLiveLocation,
  type SharingSnapshot,
} from "../LiveLocationController";
import type { LiveLocationPermission, LocationSample } from "../live-location.service";

// Coordenadas SINTÉTICAS.
const sample: LocationSample = {
  latitude: -23,
  longitude: -46,
  accuracy: 10,
  capturedAt: "2026-09-11T20:00:00.000Z",
};

function setup(permission: LiveLocationPermission = "granted") {
  const api = createMockApi({
    startLiveLocation: jest.fn(async () => ({
      sessionId: "session-1",
      status: "ACTIVE" as const,
      startedAt: "2026-09-11T20:00:00.000Z",
      stoppedAt: null,
    })),
    sendLiveLocation: jest.fn(async () => ({
      sessionId: "session-1",
      point: {} as LiveLocationPoint,
    })),
    stopLiveLocation: jest.fn(async () => ({
      status: "STOPPED" as const,
      sessionId: "session-1",
      startedAt: "2026-09-11T20:00:00.000Z",
      stoppedAt: "2026-09-11T20:05:00.000Z",
      latest: null,
    })),
    getLiveLocation: jest.fn(async () => ({
      status: "ACTIVE" as const,
      sessionId: "session-1",
      startedAt: "2026-09-11T20:00:00.000Z",
      stoppedAt: null,
      latest: null,
    })),
  });
  const remove = jest.fn();
  let onSample: ((s: LocationSample) => void) | null = null;
  const watch = jest.fn(async (cb: (s: LocationSample) => void) => {
    onSample = cb;
    return { remove };
  });
  const requestPermission = jest.fn(async () => permission);
  const controller = new LiveLocationController("alert-1", api, { requestPermission, watch });
  const snapshots: SharingSnapshot[] = [];
  controller.subscribe((s) => snapshots.push(s));
  return {
    api,
    controller,
    watch,
    remove,
    requestPermission,
    snapshots,
    emit: (s: LocationSample) => onSample?.(s),
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("LiveLocationController", () => {
  beforeEach(() => {
    resetLiveLocationRegistry();
  });

  it("permissão negada: não inicia sessão nem watcher e informa em pt-BR", async () => {
    const { api, controller, watch } = setup("denied");
    expect(await controller.start()).toBe(false);
    expect(api.startLiveLocation).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      state: "INACTIVE",
      permission: "denied",
      error:
        "Não foi possível ativar a localização ao vivo.\n\nVocê pode continuar usando o alerta normalmente.",
    });
  });

  it("localização do aparelho desligada: mensagem específica e nada inicia", async () => {
    const { api, controller } = setup("services-disabled");
    expect(await controller.start()).toBe(false);
    expect(api.startLiveLocation).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toContain("localização do aparelho está desligada");
  });

  it("permissão concedida: inicia sessão no backend, watcher e envia pontos com clientUpdateId", async () => {
    const { api, controller, watch, emit } = setup();
    expect(await controller.start()).toBe(true);
    expect(await controller.start()).toBe(true); // idempotente
    expect(api.startLiveLocation).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe("ACTIVE");

    emit(sample);
    await flushPromises();
    expect(api.sendLiveLocation).toHaveBeenCalledTimes(1);
    const [alertId, point] = api.sendLiveLocation.mock.calls[0]!;
    expect(alertId).toBe("alert-1");
    expect(point).toMatchObject({ latitude: -23, longitude: -46, accuracy: 10 });
    expect(typeof point.clientUpdateId).toBe("string");
    expect(controller.getSnapshot().lastSentAt).not.toBeNull();
  });

  it("erro do backend ao iniciar é traduzido e nada fica ligado", async () => {
    const { api, controller, watch } = setup();
    api.startLiveLocation.mockRejectedValueOnce(new ApiError("ALERT_NOT_ACTIVE", "x", 409));
    expect(await controller.start()).toBe(false);
    expect(watch).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      state: "INACTIVE",
      error: "Este alerta não está mais ativo.",
    });
  });

  it("stop() remove o watcher, avisa o backend e muda para STOPPED; sem notifyBackend não chama a API", async () => {
    const { api, controller, remove } = setup();
    await controller.start();
    await controller.stop();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(api.stopLiveLocation).toHaveBeenCalledWith("alert-1");
    expect(controller.getSnapshot().state).toBe("STOPPED");

    await controller.start();
    await controller.stop({ notifyBackend: false });
    expect(api.stopLiveLocation).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("falha ao avisar o backend no stop não é propagada", async () => {
    const { api, controller } = setup();
    api.stopLiveLocation.mockRejectedValueOnce(new ApiError("NETWORK", "offline", 0));
    await controller.start();
    await expect(controller.stop()).resolves.toBeUndefined();
    expect(controller.getSnapshot().state).toBe("STOPPED");
  });

  it("backend recusa o ponto definitivamente (sessão encerrada): para o watcher imediatamente", async () => {
    const { api, controller, remove, emit } = setup();
    api.sendLiveLocation.mockRejectedValueOnce(
      new ApiError("LIVE_LOCATION_NOT_ACTIVE", "conflict", 409),
    );
    await controller.start();
    emit(sample);
    await flushPromises();
    await flushPromises();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      state: "STOPPED",
      error: "O compartilhamento de localização ao vivo não está ativo.",
    });
    // Não tenta parar de novo no backend (ele já encerrou).
    expect(api.stopLiveLocation).not.toHaveBeenCalled();
  });

  it("resync ao voltar ao primeiro plano: sessão não ativa no backend → para localmente", async () => {
    const { api, controller, remove } = setup();
    await controller.start();
    api.getLiveLocation.mockResolvedValueOnce({
      status: "STOPPED",
      sessionId: "session-1",
      startedAt: "2026-09-11T20:00:00.000Z",
      stoppedAt: "2026-09-11T20:05:00.000Z",
      latest: null,
    });
    await controller.resync();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().state).toBe("STOPPED");
    expect(api.stopLiveLocation).not.toHaveBeenCalled();
  });

  it("resync com sessão ainda ativa mantém o compartilhamento; erro de rede também", async () => {
    const { api, controller, remove } = setup();
    await controller.start();
    await controller.resync();
    api.getLiveLocation.mockRejectedValueOnce(new ApiError("NETWORK", "offline", 0));
    await controller.resync();
    expect(remove).not.toHaveBeenCalled();
    expect(controller.getSnapshot().state).toBe("ACTIVE");
  });

  it("registro: uma instância por alerta; stopAll e resyncAll atuam em todas", async () => {
    const api = createMockApi({
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
    });
    const remove = jest.fn();
    const deps = {
      requestPermission: jest.fn(async () => "granted" as const),
      watch: jest.fn(async () => ({ remove })),
    };
    const a = getLiveLocationController("alert-a", api, deps);
    expect(getLiveLocationController("alert-a", api, deps)).toBe(a);
    const b = getLiveLocationController("alert-b", api, deps);
    await a.start();
    await b.start();

    await resyncAllLiveLocation();
    expect(api.getLiveLocation).toHaveBeenCalledTimes(2);

    await stopAllLiveLocation({ notifyBackend: false });
    expect(remove).toHaveBeenCalledTimes(2);
    expect(a.getSnapshot().state).toBe("STOPPED");
    expect(b.getSnapshot().state).toBe("STOPPED");
    expect(api.stopLiveLocation).not.toHaveBeenCalled();
  });
});
