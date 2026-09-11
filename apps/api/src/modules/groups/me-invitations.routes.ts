import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
    return acceptInvitation(app.db, request.auth.userId, invitationId);
  });

  app.post("/me/group-invitations/:invitationId/reject", async (request, reply) => {
    const invitationId = parseInvitationId(
      (request.params as { invitationId: string }).invitationId,
    );
    await rejectInvitation(app.db, request.auth.userId, invitationId);
    return reply.status(204).send();
  });
}
