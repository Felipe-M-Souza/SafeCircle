import * as Location from "expo-location";
import { Platform } from "react-native";
import { subscribeLocationUpdates } from "./background-location";
import type { LocationSample, WatchHandle } from "./location-sample";

export {
  toLocationSample,
  WATCH_DISTANCE_INTERVAL_M,
  WATCH_TIME_INTERVAL_MS,
  type LocationSample,
  type WatchHandle,
} from "./location-sample";

/**
 * Acesso ao GPS para a localização ao vivo (Phase 6; estendido na Phase 13).
 *
 * A permissão pedida continua sendo **apenas a de primeiro plano**: o
 * compartilhamento só começa com o app aberto e com a pessoa ativando o
 * recurso. A partir daí ele continua com a tela bloqueada, através de um
 * serviço em primeiro plano com notificação fixa no Android e do indicador
 * azul no iOS (ADR 0015) — nunca de rastreamento silencioso, e sem a permissão
 * `ACCESS_BACKGROUND_LOCATION`.
 *
 * Coordenadas nunca são registradas em logs.
 */

export type LiveLocationPermission =
  "granted" | "denied" | "blocked" | "services-disabled" | "unavailable";

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

/**
 * Inicia o recebimento de posições; o chamador é responsável por `remove()`.
 *
 * Desde a Phase 13 isso assina o stream do sistema operacional em vez de um
 * watcher preso ao primeiro plano, então a posição continua chegando com a
 * tela bloqueada.
 */
export async function watchLiveLocation(
  onSample: (sample: LocationSample) => void,
): Promise<WatchHandle> {
  return subscribeLocationUpdates(onSample);
}
