import * as Location from "expo-location";
import { Platform } from "react-native";

/**
 * Acesso ao GPS para a localização ao vivo (Phase 6) — SOMENTE em primeiro plano.
 *
 * Nunca inicia background location nem rastreia fora de um alerta ativo com
 * compartilhamento ligado. A permissão é pedida apenas quando o criador ativa
 * o recurso explicitamente. Coordenadas nunca são registradas em logs.
 */

export type LiveLocationPermission =
  "granted" | "denied" | "blocked" | "services-disabled" | "unavailable";

/**
 * Frequência do watcher (expo-location): no máximo um callback a cada 5 s ou
 * a cada 10 m — equilíbrio entre utilidade, bateria, rede e privacidade.
 */
export const WATCH_TIME_INTERVAL_MS = 5000;
export const WATCH_DISTANCE_INTERVAL_M = 10;

export interface LocationSample {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  altitude?: number | null;
  heading?: number | null;
  speed?: number | null;
  capturedAt: string;
}

export interface WatchHandle {
  remove: () => void;
}

export function isLiveLocationSupported(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

/** Pede a permissão de primeiro plano (após o consentimento na UI) e verifica o serviço. */
export async function requestLiveLocationPermission(): Promise<LiveLocationPermission> {
  if (!isLiveLocationSupported()) return "unavailable";
  try {
    let permission = await Location.getForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) {
      permission = await Location.requestForegroundPermissionsAsync();
    }
    if (permission.status !== Location.PermissionStatus.GRANTED) {
      return permission.canAskAgain === false ? "blocked" : "denied";
    }
    const enabled = await Location.hasServicesEnabledAsync();
    return enabled ? "granted" : "services-disabled";
  } catch {
    return "unavailable";
  }
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function toLocationSample(position: Location.LocationObject): LocationSample | null {
  const { latitude, longitude, accuracy, altitude, heading, speed } = position.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    accuracy: finiteOrNull(accuracy),
    altitude: typeof altitude === "number" && Number.isFinite(altitude) ? altitude : null,
    // expo-location devolve -1 quando direção/velocidade não estão disponíveis.
    heading: finiteOrNull(heading),
    speed: finiteOrNull(speed),
    capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
  };
}

/** Inicia o watcher de primeiro plano; o chamador é responsável por `remove()`. */
export async function watchLiveLocation(
  onSample: (sample: LocationSample) => void,
): Promise<WatchHandle> {
  const subscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      timeInterval: WATCH_TIME_INTERVAL_MS,
      distanceInterval: WATCH_DISTANCE_INTERVAL_M,
    },
    (position) => {
      const sample = toLocationSample(position);
      if (sample) onSample(sample);
    },
  );
  return { remove: () => subscription.remove() };
}
