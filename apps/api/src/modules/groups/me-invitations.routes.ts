import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createRealtimeEvent } from "../../infrastructure/realtime/events.js";
import { errors } from "../../shared/errors.js";
import { acceptInvitation, listMyInvitations, rejectInvitation } from "./invitations.service.js";

const uuid = z.string().uuid();

function parseInvitationId(value: unknown): string {
  const result = uuid.safeParse(value);
  if (!result.success) {
    throw errors.invitationNotFound();
  }
  return result.data;
}

export async function meInvitationsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.authenticate);

  app.get("/me/group-invitations", async (request) => {
    return listMyInvitations(app.db, request.auth.userId);
  });

  app.post("/me/group-invitations/:invitationId/accept", async (request) => {
    const invitationId = parseInvitationId(
      (request.params as { invitationId: string }).invitationId,
    );
    const result = await acceptInvitation(app.db, request.auth.userId, invitationId);
    // Phase 5: o próprio usuário ressincroniza a lista de grupos nos outros aparelhos.
    const userId = request.auth.userId;
    app.background.run("realtime:GROUP_MEMBERSHIP_CHANGED", async () => {
      app.realtime.publishToUser(
        userId,
        createRealtimeEvent("GROUP_MEMBERSHIP_CHANGED", { groupId: result.groupId, userId }),
      );
    });
    return result;
  });

  app.post("/me/group-invitations/:invitationId/reject", async (request, reply) => {
    const invitationId = parseInvitationId(
      (request.params as { invitationId: string }).invitationId,
    );
    await rejectInvitation(app.db, request.auth.userId, invitationId);
    return reply.status(204).send();
  });
}
