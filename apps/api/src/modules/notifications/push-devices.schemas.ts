import { z } from "zod";
import { errors } from "../../shared/errors.js";

/**
 * Validação do registro de dispositivos de push (Phase 4).
 * Cada campo gera um código estável próprio para facilitar o diagnóstico no app.
 */

export const pushPlatformValues = ["IOS", "ANDROID"] as const;

/**
 * Expo Push Token: `ExponentPushToken[...]` ou `ExpoPushToken[...]`, com
 * conteúdo alfanumérico de tamanho plausível — validado além do prefixo.
 */
export const EXPO_PUSH_TOKEN_REGEX = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

export const pushTokenSchema = z.string().trim().min(1).max(255).regex(EXPO_PUSH_TOKEN_REGEX);
export const pushPlatformSchema = z.enum(pushPlatformValues);
/** `deviceId` é um UUID de instalação gerado pelo app. */
export const deviceIdSchema = z.string().uuid();

export interface RegisterPushDeviceInput {
  token: string;
  platform: (typeof pushPlatformValues)[number];
  deviceId: string;
}

/** Valida o body do registro campo a campo com códigos estáveis. */
export function parseRegisterPushDeviceInput(body: unknown): RegisterPushDeviceInput {
  if (typeof body !== "object" || body === null) {
    throw errors.validation();
  }
  const record = body as Record<string, unknown>;

  const token = pushTokenSchema.safeParse(record.token);
  if (!token.success) {
    throw errors.invalidPushToken();
  }
  const platform = pushPlatformSchema.safeParse(record.platform);
  if (!platform.success) {
    throw errors.invalidPushPlatform();
  }
  const deviceId = deviceIdSchema.safeParse(record.deviceId);
  if (!deviceId.success) {
    throw errors.invalidDeviceId();
  }

  return { token: token.data, platform: platform.data, deviceId: deviceId.data };
}

export function parseDeviceId(value: unknown): string {
  const result = deviceIdSchema.safeParse(value);
  if (!result.success) {
    throw errors.invalidDeviceId();
  }
  return result.data;
}
