import type * as Location from "expo-location";

/**
 * Amostra de posição e sua conversão a partir do `expo-location`.
 *
 * Fica em módulo próprio porque é usada tanto pelo serviço de permissão quanto
 * pela task de localização em segundo plano (Phase 13) — separar evita import
 * circular entre os dois.
 *
 * Coordenadas nunca são registradas em log.
 */

/**
 * Frequência do stream: no máximo uma amostra a cada 5 s ou a cada 10 m —
 * equilíbrio entre utilidade, bateria, rede e privacidade.
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
