import type { FastifyInstance } from "fastify";
import { parseDeviceId, parseRegisterPushDeviceInput } from "./push-devices.schemas.js";
import { deactivatePushDevice, registerPushDevice } from "./push-devices.service.js";

/**
 * Rotas de dispositivos de push do usuário autenticado (Phase 4).
 * O token nunca é devolvido nas respostas.
 */
export async function pushDevicesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.authenticate);

  app.post("/me/push-devices", async (request, reply) => {
    const input = parseRegisterPushDeviceInput(request.body);
    const { device, created } = await registerPushDevice(app.db, request.auth.userId, input);
    return reply.status(created ? 201 : 200).send(device);
  });

  app.delete("/me/push-devices/:deviceId", async (request, reply) => {
    const deviceId = parseDeviceId((request.params as { deviceId: string }).deviceId);
    await deactivatePushDevice(app.db, request.auth.userId, deviceId);
    return reply.status(204).send();
  });
}
