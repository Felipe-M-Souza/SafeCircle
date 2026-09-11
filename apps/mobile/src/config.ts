/**
 * Configuração pública do app mobile.
 * EXPO_PUBLIC_* é embutido no bundle e considerado público — nunca conter segredos.
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";
