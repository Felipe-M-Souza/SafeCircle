import Constants from "expo-constants";
import { Platform } from "react-native";

/**
 * O mapa nativo (react-native-maps) só pode ser montado no Android quando o
 * app foi construído com uma chave do Google Maps (`android.config.googleMaps.apiKey`
 * no `app.json`). Sem ela, o Maps SDK derruba o processo ao inflar o MapView —
 * achado em aparelho (2026-09-16): o app fechava ao ativar a localização ao vivo.
 * No iOS o MapKit não exige chave.
 */
export function isNativeMapAvailable(): boolean {
  if (Platform.OS === "ios") return true;
  if (Platform.OS !== "android") return false;
  const key = Constants.expoConfig?.android?.config?.googleMaps?.apiKey;
  return typeof key === "string" && key.trim().length > 0;
}

/** URL para abrir a posição no app de mapas do sistema (sem serviço externo nosso). */
export function externalMapUrl(latitude: number, longitude: number): string {
  const point = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  return Platform.OS === "ios" ? `maps:0,0?q=${point}` : `geo:${point}?q=${point}(SafeCircle)`;
}
