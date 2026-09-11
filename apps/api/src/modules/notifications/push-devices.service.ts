import { and, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { pushDevices, type PushPlatform } from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";
import type { RegisterPushDeviceInput } from "./push-devices.schemas.js";

/**
 * Representação devolvida pela API. O token NUNCA é devolvido.
 */
export interface PushDeviceView {
  id: string;
  platform: PushPlatform;
  deviceId: string;
  isActive: boolean;
  updatedAt: string;
}

const deviceSelection = {
  id: pushDevices.id,
  userId: pushDevices.userId,
  token: pushDevices.token,
  platform: pushDevices.platform,
  deviceId: pushDevices.deviceId,
  isActive: pushDevices.isActive,
  updatedAt: pushDevices.updatedAt,
};

function isUniqueViolation(error: unknown): boolean {
  const code = (value: unknown): unknown =>
    typeof value === "object" && value !== null && "code" in value
      ? (value as { code?: unknown }).code
      : undefined;
  return code(error) === "23505" || code((error as { cause?: unknown } | null)?.cause) === "23505";
}

function toView(row: {
  id: string;
  platform: PushPlatform;
  deviceId: string;
  isActive: boolean;
  updatedAt: Date;
}): PushDeviceView {
  return {
    id: row.id,
    platform: row.platform,
    deviceId: row.deviceId,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Upsert seguro do dispositivo de push do usuário autenticado.
 *
 * Política (ADR 0005):
 * - um registro por (usuário, deviceId); `UNIQUE(token)` global;
 * - mesmo deviceId com token novo → o token é substituído no registro (rotação);
 * - token já conhecido registrado por outro usuário (troca de conta no mesmo
 *   aparelho) → o registro passa a pertencer ao usuário autenticado atual e o
 *   registro antigo daquela instalação é removido — nunca há duas contas
 *   apontando para o mesmo token;
 * - registro inativo volta a ficar ativo; `lastSeenAt` é atualizado.
 *
 * Concorrência: as constraints do banco garantem consistência; em violação de
 * unicidade por corrida, a operação é repetida uma vez.
 */
export async function registerPushDevice(
  db: Database,
  userId: string,
  input: RegisterPushDeviceInput,
): Promise<{ device: PushDeviceView; created: boolean }> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await upsert(db, userId, input);
    } catch (error) {
      if (attempt === 0 && isUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }
}

async function upsert(
  db: Database,
  userId: string,
  input: RegisterPushDeviceInput,
): Promise<{ device: PushDeviceView; created: boolean }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [byToken] = await tx
      .select(deviceSelection)
      .from(pushDevices)
      .where(eq(pushDevices.token, input.token))
      .limit(1);
    const [byDevice] = await tx
      .select(deviceSelection)
      .from(pushDevices)
      .where(and(eq(pushDevices.userId, userId), eq(pushDevices.deviceId, input.deviceId)))
      .limit(1);

    if (byToken) {
      if (byDevice && byDevice.id !== byToken.id) {
        // Esta instalação tinha outro token (rotação): o antigo deixa de existir.
        await tx.delete(pushDevices).where(eq(pushDevices.id, byDevice.id));
      }
      const [updated] = await tx
        .update(pushDevices)
        .set({
          userId,
          deviceId: input.deviceId,
          platform: input.platform,
          isActive: true,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(pushDevices.id, byToken.id))
        .returning(deviceSelection);
      if (!updated) {
        throw new Error("Falha ao atualizar dispositivo de push.");
      }
      return { device: toView(updated), created: false };
    }

    if (byDevice) {
      const [updated] = await tx
        .update(pushDevices)
        .set({
          token: input.token,
          platform: input.platform,
          isActive: true,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(eq(pushDevices.id, byDevice.id))
        .returning(deviceSelection);
      if (!updated) {
        throw new Error("Falha ao atualizar dispositivo de push.");
      }
      return { device: toView(updated), created: false };
    }

    const [created] = await tx
      .insert(pushDevices)
      .values({
        userId,
        token: input.token,
        platform: input.platform,
        deviceId: input.deviceId,
        isActive: true,
        lastSeenAt: now,
      })
      .returning(deviceSelection);
    if (!created) {
      throw new Error("Falha ao registrar dispositivo de push.");
    }
    return { device: toView(created), created: true };
  });
}

/**
 * Desativa o dispositivo do usuário (logout/desassociação). O registro é
 * mantido inativo; um novo registro do mesmo dispositivo o reativa.
 */
export async function deactivatePushDevice(
  db: Database,
  userId: string,
  deviceId: string,
): Promise<void> {
  const updated = await db
    .update(pushDevices)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(pushDevices.userId, userId), eq(pushDevices.deviceId, deviceId)))
    .returning({ id: pushDevices.id });
  if (updated.length === 0) {
    throw errors.pushDeviceNotFound();
  }
}
