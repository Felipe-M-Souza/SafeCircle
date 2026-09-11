import type { ApiClient } from "../lib/api";
import { getOrCreateInstallationId } from "../lib/storage";
import {
  getExpoPushToken,
  getPermissionStatus,
  getPushPlatform,
  isPushSupported,
} from "./notifications.service";

/**
 * Registro do dispositivo de push no backend (Phase 4).
 *
 * - Só registra com permissão concedida e token disponível.
 * - Evita chamadas repetidas para o mesmo token dentro do processo; um token
 *   novo (rotação) é registrado de novo com o mesmo `deviceId`.
 * - O desregistro no logout é best-effort: falha nunca impede sair da conta.
 */

export type RegistrationOutcome = "registered" | "skipped" | "failed";

let lastRegisteredToken: string | null = null;

export async function registerCurrentDevice(api: ApiClient): Promise<RegistrationOutcome> {
  if (!isPushSupported()) return "skipped";
  if ((await getPermissionStatus()) !== "granted") return "skipped";

  const token = await getExpoPushToken();
  const platform = getPushPlatform();
  if (!token || !platform) return "skipped";
  if (lastRegisteredToken === token) return "skipped";

  try {
    const deviceId = await getOrCreateInstallationId();
    await api.registerPushDevice({ token, platform, deviceId });
    lastRegisteredToken = token;
    return "registered";
  } catch {
    return "failed";
  }
}

/** Desativa o dispositivo no backend. Nunca lança; o logout segue mesmo em falha. */
export async function unregisterCurrentDevice(api: ApiClient): Promise<void> {
  lastRegisteredToken = null;
  if (!isPushSupported()) return;
  try {
    const deviceId = await getOrCreateInstallationId();
    await api.unregisterPushDevice(deviceId);
  } catch {
    // Best-effort: o backend deixará de usar o token quando ele expirar/invalidar.
  }
}

/** Apenas para testes. */
export function resetRegistrationCache(): void {
  lastRegisteredToken = null;
}
