import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { invitationRateLimit } from "../../plugins/rate-limit.js";
import { errors, type AppError } from "../../shared/errors.js";
import {
  changeRoleSchema,
  createGroupSchema,
  createInvitationSchema,
  transferOwnershipSchema,
  updateGroupSchema,
} from "./groups.schemas.js";
import {
  changeMemberRole,
  createGroup,
  getGroupDetails,
  leaveGroup,
  listMembers,
  listMyGroups,
  removeMember,
  transferOwnership,
  updateGroupName,
} from "./groups.service.js";
import { createInvitation, listGroupInvitations, revokeInvitation } from "./invitations.service.js";

export interface GroupsRoutesOptions {
  appConfig: Config;
}

const uuid = z.string().uuid();

function parseUuid(value: unknown, notFound: () => AppError): string {
  const result = uuid.safeParse(value);
  if (!result.success) {
    throw notFound();
  }
  return result.data;
}

export async function groupsRoutes(
  app: FastifyInstance,
  options: GroupsRoutesOptions,
): Promise<void> {
  const { appConfig } = options;

  // Todas as rotas de grupos exigem autenticação.
  app.addHook("preHandler", app.authenticate);

  /** Correlaciona os efeitos enfileirados com a requisição que os originou. */
  const actionOptions = (request: FastifyRequest) => ({
    requestId: typeof request.id === "string" ? request.id : null,
  });

  app.post("/groups", async (request, reply) => {
    const input = createGroupSchema.parse(request.body);
    const group = await createGroup(
      app.db,
      request.auth.userId,
      input.name,
      actionOptions(request),
    );
    return reply.status(201).send(group);
  });

  app.get("/groups", async (request) => {
    return listMyGroups(app.db, request.auth.userId);
  });

  app.get("/groups/:groupId", async (request) => {
    const groupId = parseUuid(
      (request.params as { groupId: string }).groupId,
      errors.groupNotFound,
    );
    return getGroupDetails(app.db, request.auth.userId, groupId);
  });

  app.patch("/groups/:groupId", async (request) => {
    const groupId = parseUuid(
      (request.params as { groupId: string }).groupId,
      errors.groupNotFound,
    );
    const input = updateGroupSchema.parse(request.body);
    return updateGroupName(app.db, request.auth.userId, groupId, input.name);
  });

  app.get("/groups/:groupId/members", async (request) => {
    const groupId = parseUuid(
      (request.params as { groupId: string }).groupId,
      errors.groupNotFound,
    );
    return listMembers(app.db, request.auth.userId, groupId);
  });

  app.delete("/groups/:groupId/members/me", async (request, reply) => {
    const groupId = parseUuid(
      (request.params as { groupId: string }).groupId,
      errors.groupNotFound,
    );
    await leaveGroup(app.db, request.auth.userId, groupId, actionOptions(request));
    return reply.status(204).send();
  });

  app.delete("/groups/:groupId/members/:userId", async (request, reply) => {
    const params = request.params as { groupId: string; userId: string };
    const groupId = parseUuid(params.groupId, errors.groupNotFound);
    const targetUserId = parseUuid(params.userId, errors.memberNotFound);
    await removeMember(app.db, request.auth.userId, groupId, targetUserId, actionOptions(request));
    return reply.status(204).send();
  });

  app.patch("/groups/:groupId/members/:userId/role", async (request) => {
    const params = request.params as { groupId: string; userId: string };
    const groupId = parseUuid(params.groupId, errors.groupNotFound);
    const targetUserId = parseUuid(params.userId, errors.memberNotFound);
    const input = changeRoleSchema.parse(request.body);
    const member = await changeMemberRole(
      app.db,
      request.auth.userId,
      groupId,
      targetUserId,
      input.role,
      actionOptions(request),
    );
    return member;
  });

  // Phase 12: transferência de propriedade (pré-requisito para excluir a conta
  // sem desfazer o grupo). Só OWNER; alvo precisa ser membro e não o próprio.
  app.post("/groups/:groupId/transfer-ownership", async (request, reply) => {
    const params = request.params as { groupId: string };
    const groupId = parseUuid(params.groupId, errors.groupNotFound);
    const input = transferOwnershipSchema.parse(request.body);
    await transferOwnership(
      app.db,
      request.auth.userId,
      groupId,
      input.userId,
      actionOptions(request),
    );
    return reply.status(204).send();
  });

  // --- Convites do grupo ---

  app.post(
    "/groups/:groupId/invitations",
    { config: { rateLimit: invitationRateLimit(appConfig.rateLimitProfile) } },
    async (request, reply) => {
      const groupId = parseUuid(
        (request.params as { groupId: string }).groupId,
        errors.groupNotFound,
      );
      const input = createInvitationSchema.parse(request.body);
      const invitation = await createInvitation(app.db, request.auth.userId, groupId, input.email);
      return reply.status(201).send(invitation);
    },
  );

  app.get("/groups/:groupId/invitations", async (request) => {
    const groupId = parseUuid(
      (request.params as { groupId: string }).groupId,
      errors.groupNotFound,
    );
    return listGroupInvitations(app.db, request.auth.userId, groupId);
  });

  app.delete("/groups/:groupId/invitations/:invitationId", async (request, reply) => {
    const params = request.params as { groupId: string; invitationId: string };
    const groupId = parseUuid(params.groupId, errors.groupNotFound);
    const invitationId = parseUuid(params.invitationId, errors.invitationNotFound);
    await revokeInvitation(app.db, request.auth.userId, groupId, invitationId);
    return reply.status(204).send();
  });
}
