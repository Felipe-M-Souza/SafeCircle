import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "./uuid";

/**
 * Abstração de armazenamento do refresh token (README §15).
 *
 * - Nativo (iOS/Android): expo-secure-store (Keychain/Keystore).
 * - Web (apenas demonstração/desenvolvimento): armazenamento SOMENTE em memória.
 *   A sessão não persiste após reload — isso é intencional. Nunca usar
 *   localStorage/AsyncStorage para refresh token sem decisão arquitetural.
 */
export interface SecureStorage {
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clearRefreshToken(): Promise<void>;
  /** Indica se o token persiste entre reinicializações do app. */
  readonly persistent: boolean;
}

const REFRESH_TOKEN_KEY = "safecircle.refreshToken";
const INSTALLATION_ID_KEY = "safecircle.installationId";

const nativeStorage: SecureStorage = {
  persistent: true,
  async getRefreshToken() {
    return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  },
  async setRefreshToken(token: string) {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
  },
  async clearRefreshToken() {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  },
};

function createMemoryStorage(): SecureStorage {
  let value: string | null = null;
  return {
    persistent: false,
    async getRefreshToken() {
      return value;
    },
    async setRefreshToken(token: string) {
      value = token;
    },
    async clearRefreshToken() {
      value = null;
    },
  };
}

export const secureStorage: SecureStorage =
  Platform.OS === "web" ? createMemoryStorage() : nativeStorage;

// ------------------------------------------------------------------
// Identificador de instalação (Phase 4 — push devices)
// ------------------------------------------------------------------

let memoryInstallationId: string | null = null;

/**
 * UUID gerado pelo próprio app na primeira execução e mantido entre sessões.
 * Identifica a instalação para registrar/rotacionar o push token — sem IMEI,
 * MAC address, advertising ID ou qualquer identificador de hardware.
 * Não é apagado no logout: representa a instalação, não o usuário.
 */
export async function getOrCreateInstallationId(): Promise<string> {
  if (Platform.OS === "web") {
    memoryInstallationId ??= randomUUID();
    return memoryInstallationId;
  }
  const existing = await SecureStore.getItemAsync(INSTALLATION_ID_KEY);
  if (existing) {
    return existing;
  }
  const created = randomUUID();
  await SecureStore.setItemAsync(INSTALLATION_ID_KEY, created);
  return created;
}
