import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import {
  LIVE_LOCATION_TASK,
  activeListenerCount,
  stopAllLocationUpdates,
  subscribeLocationUpdates,
} from "../background-location";

/**
 * Localização com a tela bloqueada (Phase 13).
 *
 * O compartilhamento passa a usar o stream do sistema operacional, com serviço
 * em primeiro plano no Android. Um único stream alimenta todos os
 * compartilhamentos ativos: liga no primeiro e desliga no último.
 */
const startUpdates = jest.mocked(Location.startLocationUpdatesAsync);
const stopUpdates = jest.mocked(Location.stopLocationUpdatesAsync);
const hasStarted = jest.mocked(Location.hasStartedLocationUpdatesAsync);

type TaskHandler = (body: {
  data?: { locations?: Location.LocationObject[] };
  error?: unknown;
}) => Promise<void> | void;

function taskHandler(): TaskHandler {
  const mock = TaskManager as unknown as { __getTask: (name: string) => TaskHandler };
  return mock.__getTask(LIVE_LOCATION_TASK);
}

function position(latitude: number, longitude: number): Location.LocationObject {
  return {
    coords: {
      latitude,
      longitude,
      accuracy: 8,
      altitude: null,
      heading: null,
      speed: null,
      altitudeAccuracy: null,
    },
    timestamp: Date.UTC(2026, 8, 17, 12, 0, 0),
  } as Location.LocationObject;
}

beforeEach(async () => {
  await stopAllLocationUpdates();
  startUpdates.mockClear();
  stopUpdates.mockClear();
  hasStarted.mockReset();
  hasStarted.mockResolvedValue(false);
});

describe("Stream de localização do sistema operacional", () => {
  it("a task é registrada no import: o SO pode reativar o processo esperando por ela", () => {
    expect(TaskManager.isTaskDefined(LIVE_LOCATION_TASK)).toBe(true);
    expect(typeof taskHandler()).toBe("function");
  });

  it("configura serviço em primeiro plano com notificação, sem pedir background location", async () => {
    const handle = await subscribeLocationUpdates(jest.fn());

    expect(startUpdates).toHaveBeenCalledTimes(1);
    const options = startUpdates.mock.calls[0]![1]!;
    expect(options.foregroundService?.notificationTitle).toContain("SafeCircle");
    expect(options.foregroundService?.notificationBody.length).toBeGreaterThan(10);
    // App fechado encerra o compartilhamento: nada sobrevive fora da vista.
    expect(options.foregroundService?.killServiceOnDestroy).toBe(true);
    // iOS: indicador azul sempre visível, sem pausa automática.
    expect(options.showsBackgroundLocationIndicator).toBe(true);
    expect(options.pausesUpdatesAutomatically).toBe(false);

    handle.remove();
  });

  it("liga no primeiro assinante e desliga só no último", async () => {
    const first = await subscribeLocationUpdates(jest.fn());
    hasStarted.mockResolvedValue(true);
    const second = await subscribeLocationUpdates(jest.fn());

    // Já iniciado: não chama o SO de novo.
    expect(startUpdates).toHaveBeenCalledTimes(1);
    expect(activeListenerCount()).toBe(2);

    first.remove();
    await Promise.resolve();
    expect(stopUpdates).not.toHaveBeenCalled();

    second.remove();
    await stopAllLocationUpdates();
    expect(stopUpdates).toHaveBeenCalled();
    expect(activeListenerCount()).toBe(0);
  });

  it("remover duas vezes não desliga o stream de outro compartilhamento", async () => {
    const handle = await subscribeLocationUpdates(jest.fn());
    hasStarted.mockResolvedValue(true);
    const other = await subscribeLocationUpdates(jest.fn());

    handle.remove();
    handle.remove();
    await Promise.resolve();

    expect(activeListenerCount()).toBe(1);
    expect(stopUpdates).not.toHaveBeenCalled();
    other.remove();
  });

  it("entrega amostras válidas a todos os assinantes e descarta coordenada inválida", async () => {
    const one = jest.fn();
    const two = jest.fn();
    const a = await subscribeLocationUpdates(one);
    hasStarted.mockResolvedValue(true);
    const b = await subscribeLocationUpdates(two);

    await taskHandler()({ data: { locations: [position(-30.5, -40.5)] } });
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
    expect(one.mock.calls[0]![0]).toMatchObject({ latitude: -30.5, longitude: -40.5 });

    await taskHandler()({ data: { locations: [position(Number.POSITIVE_INFINITY, -40.5)] } });
    expect(one).toHaveBeenCalledTimes(1);

    a.remove();
    b.remove();
  });

  it("erro do sistema operacional não quebra a task nem entrega amostra", async () => {
    const listener = jest.fn();
    const handle = await subscribeLocationUpdates(listener);

    await expect(
      taskHandler()({ error: { message: "location services disabled" } }),
    ).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    handle.remove();
  });

  it("processo reativado sem compartilhamento ativo desliga o serviço órfão", async () => {
    hasStarted.mockResolvedValue(true);
    expect(activeListenerCount()).toBe(0);

    await taskHandler()({ data: { locations: [position(-30.5, -40.5)] } });

    expect(stopUpdates).toHaveBeenCalledWith(LIVE_LOCATION_TASK);
  });

  it("falha ao iniciar não deixa assinante pendurado", async () => {
    startUpdates.mockRejectedValueOnce(new Error("sem permissão"));
    await expect(subscribeLocationUpdates(jest.fn())).rejects.toThrow("sem permissão");
    expect(activeListenerCount()).toBe(0);
  });
});
