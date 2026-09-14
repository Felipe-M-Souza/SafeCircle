import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { createRealtimeEvent } from "../../infrastructure/realtime/events.js";
import { authRateLimit } from "../../plugins/rate-limit.js";
import { errors, type AppError } from "../../shared/errors.js";
import {
  changeRoleSchema,
  createGroupSchema,
  createInvitationSchema,
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

  app.post("/groups", async (request, reply) => {
    const input = createGroupSchema.parse(request.body);
    const group = await createGroup(app.db, request.auth.userId, input.name);
    app.auditRequest(request, {
      eventType: "GROUP_CREATED",
      targetType: "GROUP",
      targetId: group.id,
      groupId: group.id,
    });
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

  // Phase 5: avisa o usuário afetado para ressincronizar grupos/permissões.
  const notifyMembershipChanged = (userId: string, groupId: string) => {
    app.background.run("realtime:GROUP_MEMBERSHIP_CHANGED", async () => {
      app.realtime.publishToUser(
        userId,
        createRealtimeEvent("GROUP_MEMBERSHIP_CHANGED", { groupId, userId }),
      );
    });
  };

  app.delete("/groups/:groupId/members/me", async (request, reply) => {
    const groupId = parseUuid(
      (request.params as { groupId: string }).groupId,
      errors.groupNotFound,
    );
    await leaveGroup(app.db, request.auth.userId, groupId);
    app.auditRequest(request, {
      eventType: "GROUP_MEMBER_REMOVED",
      targetType: "GROUP_MEMBERSHIP",
      targetId: request.auth.userId,
      groupId,
      metadata: { source: "self" },
    });
    notifyMembershipChanged(request.auth.userId, groupId);
    return reply.status(204).send();
  });

  app.delete("/groups/:groupId/members/:userId", async (request, reply) => {
    const params = request.params as { groupId: string; userId: string };
    const groupId = parseUuid(params.groupId, errors.groupNotFound);
    const targetUserId = parseUuid(params.userId, errors.memberNotFound);
    await removeMember(app.db, request.auth.userId, groupId, targetUserId);
    app.auditRequest(request, {
      eventType: "GROUP_MEMBER_REMOVED",
      targetType: "GROUP_MEMBERSHIP",
      targetId: targetUserId,
      groupId,
      metadata: { source: "admin" },
    });
    notifyMembershipChanged(targetUserId, groupId);
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
    );
    app.auditRequest(request, {
      eventType: "GROUP_MEMBER_ROLE_CHANGED",
      targetType: "GROUP_MEMBERSHIP",
      targetId: targetUserId,
      groupId,
      metadata: { role: input.role },
    });
    return member;
  });

  // --- Convites do grupo ---

  app.post(
    "/groups/:groupId/invitations",
    { config: { rateLimit: authRateLimit(appConfig.nodeEnv) } },
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
