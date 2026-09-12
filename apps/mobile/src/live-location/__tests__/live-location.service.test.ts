import * as Location from "expo-location";
import { Platform } from "react-native";
import {
  WATCH_DISTANCE_INTERVAL_M,
  WATCH_TIME_INTERVAL_MS,
  requestLiveLocationPermission,
  toLocationSample,
  watchLiveLocation,
} from "../live-location.service";

const getPermissions = jest.mocked(Location.getForegroundPermissionsAsync);
const requestPermissions = jest.mocked(Location.requestForegroundPermissionsAsync);
const servicesEnabled = jest.mocked(Location.hasServicesEnabledAsync);
const watchPosition = jest.mocked(Location.watchPositionAsync);

type PermissionResponse = Awaited<ReturnType<typeof Location.getForegroundPermissionsAsync>>;
const granted = { status: "granted", canAskAgain: true } as PermissionResponse;
const denied = (canAskAgain: boolean) => ({ status: "denied", canAskAgain }) as PermissionResponse;

describe("live-location.service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    servicesEnabled.mockResolvedValue(true);
  });

  it("pede a permissão de primeiro plano só quando ainda não concedida", async () => {
    getPermissions.mockResolvedValueOnce(granted);
    expect(await requestLiveLocationPermission()).toBe("granted");
    expect(requestPermissions).not.toHaveBeenCalled();

    getPermissions.mockResolvedValueOnce(denied(true));
    requestPermissions.mockResolvedValueOnce(granted);
    expect(await requestLiveLocationPermission()).toBe("granted");
    expect(requestPermissions).toHaveBeenCalledTimes(1);
  });

  it("mapeia negada, bloqueada, serviço desligado e web", async () => {
    getPermissions.mockResolvedValueOnce(denied(true));
    requestPermissions.mockResolvedValueOnce(denied(true));
    expect(await requestLiveLocationPermission()).toBe("denied");

    getPermissions.mockResolvedValueOnce(denied(false));
    requestPermissions.mockResolvedValueOnce(denied(false));
    expect(await requestLiveLocationPermission()).toBe("blocked");

    getPermissions.mockResolvedValueOnce(granted);
    servicesEnabled.mockResolvedValueOnce(false);
    expect(await requestLiveLocationPermission()).toBe("services-disabled");

    const restore = jest.replaceProperty(Platform, "OS", "web");
    try {
      expect(await requestLiveLocationPermission()).toBe("unavailable");
    } finally {
      restore.restore();
    }
  });

  it("converte a posição do expo-location em amostra segura (coordenadas sintéticas)", () => {
    const base = {
      coords: {
        latitude: -23,
        longitude: -46,
        accuracy: 8,
        altitude: 750,
        heading: -1,
        speed: -1,
        altitudeAccuracy: null,
      },
      timestamp: Date.parse("2026-09-11T20:00:00.000Z"),
    } as Location.LocationObject;
    expect(toLocationSample(base)).toEqual({
      latitude: -23,
      longitude: -46,
      accuracy: 8,
      altitude: 750,
      heading: null,
      speed: null,
      capturedAt: "2026-09-11T20:00:00.000Z",
    });
    expect(
      toLocationSample({
        ...base,
        coords: { ...base.coords, latitude: Number.NaN },
      } as Location.LocationObject),
    ).toBeNull();
  });

  it("watcher usa intervalo de tempo/distância moderados e repassa amostras válidas", async () => {
    let callback: ((p: Location.LocationObject) => void) | null = null;
    const remove = jest.fn();
    watchPosition.mockImplementationOnce(async (_options, cb) => {
      callback = cb;
      return { remove } as Location.LocationSubscription;
    });
    const onSample = jest.fn();
    const handle = await watchLiveLocation(onSample);

    expect(watchPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        timeInterval: WATCH_TIME_INTERVAL_MS,
        distanceInterval: WATCH_DISTANCE_INTERVAL_M,
      }),
      expect.any(Function),
    );
    expect(WATCH_TIME_INTERVAL_MS).toBeGreaterThanOrEqual(5000);
    expect(WATCH_DISTANCE_INTERVAL_M).toBeGreaterThanOrEqual(10);

    callback!({
      coords: {
        latitude: 1,
        longitude: 2,
        accuracy: 5,
        altitude: null,
        heading: null,
        speed: null,
        altitudeAccuracy: null,
      },
      timestamp: Date.now(),
    } as Location.LocationObject);
    callback!({
      coords: {
        latitude: Number.POSITIVE_INFINITY,
        longitude: 2,
        accuracy: 5,
        altitude: null,
        heading: null,
        speed: null,
        altitudeAccuracy: null,
      },
      timestamp: Date.now(),
    } as Location.LocationObject);
    expect(onSample).toHaveBeenCalledTimes(1);

    handle.remove();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
