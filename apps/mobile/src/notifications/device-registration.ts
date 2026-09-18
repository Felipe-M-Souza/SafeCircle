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
 *
 * O resultado carrega o **motivo** da não-conclusão. Antes existia um
 * `"skipped"` genérico que cobria cinco situações diferentes, e por causa dele
 * um app sem credenciais do Firebase se comportava exatamente como um app com
 * tudo certo: nenhum aviso, nenhum registro, nada para investigar.
 */

export type RegistrationResult =
  /** Cadastrado no backend; o push funciona. */
  | { readonly status: "registered" }
  /** Já cadastrado com este mesmo token neste processo. */
  | { readonly status: "current" }
  /** Plataforma sem push (web, simulador). */
  | { readonly status: "unsupported" }
  /** Falta a permissão do sistema operacional. */
  | { readonly status: "permission" }
  /** O serviço da Expo não devolveu token — no Android, normalmente Firebase. */
  | { readonly status: "token"; readonly detail?: string }
  /** O token existe, mas a API recusou ou estava fora do ar. */
  | { readonly status: "api"; readonly detail?: string };

let lastRegisteredToken: string | null = null;

export async function registerCurrentDevice(api: ApiClient): Promise<RegistrationResult> {
  if (!isPushSupported()) return { status: "unsupported" };
  if ((await getPermissionStatus()) !== "granted") return { status: "permission" };

  const result = await getExpoPushToken();
  if (!result.ok) {
    if (result.reason === "unsupported") return { status: "unsupported" };
    return result.detail ? { status: "token", detail: result.detail } : { status: "token" };
  }

  const platform = getPushPlatform();
  if (!platform) return { status: "unsupported" };
  if (lastRegisteredToken === result.token) return { status: "current" };

  try {
    const deviceId = await getOrCreateInstallationId();
    await api.registerPushDevice({ token: result.token, platform, deviceId });
    lastRegisteredToken = result.token;
    return { status: "registered" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : undefined;
    return detail ? { status: "api", detail } : { status: "api" };
  }
}

/** `true` quando o aparelho está apto a receber push agora. */
export function isRegistered(result: RegistrationResult | null): boolean {
  return result?.status === "registered" || result?.status === "current";
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
