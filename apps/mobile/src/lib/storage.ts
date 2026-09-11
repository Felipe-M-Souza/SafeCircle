import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

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
