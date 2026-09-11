import * as Location from "expo-location";
import { LOCATION_TIMEOUT_MS, captureInitialLocation } from "../location";

const getPermissions = jest.mocked(Location.getForegroundPermissionsAsync);
const requestPermissions = jest.mocked(Location.requestForegroundPermissionsAsync);
const getPosition = jest.mocked(Location.getCurrentPositionAsync);

// Coordenadas SINTÉTICAS — nunca localização pessoal real.
const syntheticPosition = {
  coords: { latitude: -23, longitude: -46, accuracy: 15 },
  timestamp: Date.parse("2026-09-11T20:30:00.000Z"),
} as unknown as Location.LocationObject;

function granted() {
  return { status: "granted" } as Location.LocationPermissionResponse;
}
function denied() {
  return { status: "denied" } as Location.LocationPermissionResponse;
}

describe("captureInitialLocation — nunca bloqueia o pedido de ajuda", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it("retorna snapshot quando a permissão já foi concedida e há posição", async () => {
    getPermissions.mockResolvedValue(granted());
    getPosition.mockResolvedValue(syntheticPosition);

    await expect(captureInitialLocation()).resolves.toEqual({
      latitude: -23,
      longitude: -46,
      accuracy: 15,
      capturedAt: "2026-09-11T20:30:00.000Z",
    });
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it("solicita permissão quando indeterminada e prossegue se concedida", async () => {
    getPermissions.mockResolvedValue({
      status: "undetermined",
    } as Location.LocationPermissionResponse);
    requestPermissions.mockResolvedValue(granted());
    getPosition.mockResolvedValue(syntheticPosition);

    const snapshot = await captureInitialLocation();
    expect(requestPermissions).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toBeNull();
  });

  it("permissão negada → null, sem tentar obter posição", async () => {
    getPermissions.mockResolvedValue(denied());
    requestPermissions.mockResolvedValue(denied());

    await expect(captureInitialLocation()).resolves.toBeNull();
    expect(getPosition).not.toHaveBeenCalled();
  });

  it("erro da biblioteca/GPS desligado → null", async () => {
    getPermissions.mockResolvedValue(granted());
    getPosition.mockRejectedValue(new Error("Location services are disabled"));

    await expect(captureInitialLocation()).resolves.toBeNull();
  });

  it("erro ao consultar permissão → null", async () => {
    getPermissions.mockRejectedValue(new Error("falha"));
    await expect(captureInitialLocation()).resolves.toBeNull();
  });

  it("tempo excedido → null (sem esperar indefinidamente)", async () => {
    jest.useFakeTimers();
    getPermissions.mockResolvedValue(granted());
    getPosition.mockImplementation(() => new Promise(() => {}));

    const pending = captureInitialLocation();
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(LOCATION_TIMEOUT_MS + 1);

    await expect(pending).resolves.toBeNull();
  });

  it("coordenadas inválidas → null; accuracy inválida é omitida", async () => {
    getPermissions.mockResolvedValue(granted());
    getPosition.mockResolvedValue({
      coords: { latitude: Number.NaN, longitude: -46, accuracy: 15 },
      timestamp: Date.now(),
    } as unknown as Location.LocationObject);
    await expect(captureInitialLocation()).resolves.toBeNull();

    getPosition.mockResolvedValue({
      coords: { latitude: 10, longitude: 20, accuracy: -1 },
      timestamp: Date.now(),
    } as unknown as Location.LocationObject);
    const snapshot = await captureInitialLocation();
    expect(snapshot).toMatchObject({ latitude: 10, longitude: 20 });
    expect(snapshot?.accuracy).toBeUndefined();
  });
});
