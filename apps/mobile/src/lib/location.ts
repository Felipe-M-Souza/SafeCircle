import * as Location from "expo-location";

/**
 * Captura de localização em primeiro plano, apenas no momento da ativação do
 * alerta (Phase 3). Não há tracking contínuo, background location nem polling.
 *
 * Contrato central: esta função NUNCA lança e NUNCA bloqueia o pedido de ajuda.
 * Permissão negada, GPS desligado, erro da biblioteca ou tempo excedido
 * resultam em `null`, e o alerta é criado sem localização.
 *
 * Privacidade: as coordenadas são devolvidas ao chamador para envio à API e
 * não são registradas em logs nem persistidas no dispositivo.
 */
export interface LocationSnapshot {
  latitude: number;
  longitude: number;
  accuracy?: number;
  capturedAt: string;
}

/** Tempo máximo razoável para obter a posição sem atrasar o pedido de ajuda. */
export const LOCATION_TIMEOUT_MS = 6000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export async function captureInitialLocation(
  timeoutMs: number = LOCATION_TIMEOUT_MS,
): Promise<LocationSnapshot | null> {
  try {
    let { status } = await Location.getForegroundPermissionsAsync();
    if (status !== Location.PermissionStatus.GRANTED) {
      // O texto da solicitação (pt-BR) é configurado no app.json (plugin expo-location).
      ({ status } = await Location.requestForegroundPermissionsAsync());
    }
    if (status !== Location.PermissionStatus.GRANTED) {
      return null;
    }

    const position = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      timeoutMs,
    );
    if (!position) {
      return null;
    }

    const { latitude, longitude, accuracy } = position.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }

    const snapshot: LocationSnapshot = {
      latitude,
      longitude,
      capturedAt: new Date(position.timestamp || Date.now()).toISOString(),
    };
    if (typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0) {
      snapshot.accuracy = accuracy;
    }
    return snapshot;
  } catch {
    // Qualquer falha de GPS/permissão/biblioteca: seguir sem localização.
    return null;
  }
}
