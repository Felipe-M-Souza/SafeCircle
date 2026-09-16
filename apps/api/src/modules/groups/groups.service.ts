import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  groupMemberships,
  trustedGroups,
  users,
  type GroupRole,
} from "../../infrastructure/database/schema.js";
import {
  enqueueAudit,
  enqueueMembershipChangedEffects,
  enqueueRealtime,
  type DomainActionOptions,
} from "../../outbox/effects.js";
import { errors } from "../../shared/errors.js";
import { findMembershipRole, requireGroupRole, requireMembership } from "./authorization.js";

export interface GroupSummary {
  id: string;
  name: string;
  role: GroupRole;
  memberCount: number;
  createdAt: string;
}

export interface GroupMemberView {
  id: string; // userId
  name: string;
  role: GroupRole;
  joinedAt: string;
}

async function countMembers(db: Database, groupId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(groupMemberships)
    .where(eq(groupMemberships.groupId, groupId));
  return row?.count ?? 0;
}

export async function createGroup(
  db: Database,
  userId: string,
  name: string,
  options: DomainActionOptions = {},
): Promise<GroupSummary> {
  return db.transaction(async (tx) => {
    const [group] = await tx.insert(trustedGroups).values({ name }).returning({
      id: trustedGroups.id,
      name: trustedGroups.name,
      createdAt: trustedGroups.createdAt,
    });
    if (!group) {
      throw new Error("Falha ao criar grupo.");
    }
    await tx.insert(groupMemberships).values({ groupId: group.id, userId, role: "OWNER" });
    // Phase 10: auditoria no MESMO COMMIT da criação.
    await enqueueAudit(tx, "AUDIT_GROUP_CREATED", {
      aggregateType: "GROUP",
      aggregateId: group.id,
      groupId: group.id,
      actorUserId: userId,
      targetType: "GROUP",
      targetId: group.id,
      requestId: options.requestId ?? null,
    });
    return {
      id: group.id,
      name: group.name,
      role: "OWNER" as const,
      memberCount: 1,
      createdAt: group.createdAt.toISOString(),
    };
  });
}

export async function listMyGroups(db: Database, userId: string): Promise<GroupSummary[]> {
  const rows = await db
    .select({
      id: trustedGroups.id,
      name: trustedGroups.name,
      role: groupMemberships.role,
      createdAt: trustedGroups.createdAt,
    })
    .from(groupMemberships)
    .innerJoin(trustedGroups, eq(trustedGroups.id, groupMemberships.groupId))
    .where(eq(groupMemberships.userId, userId));

  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((row) => row.id);
  const counts = await db
    .select({ groupId: groupMemberships.groupId, count: sql<number>`count(*)::int` })
    .from(groupMemberships)
    .where(inArray(groupMemberships.groupId, ids))
    .groupBy(groupMemberships.groupId);

  const countByGroup = new Map(counts.map((c) => [c.groupId, c.count]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    memberCount: countByGroup.get(row.id) ?? 0,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getGroupDetails(
  db: Database,
  userId: string,
  groupId: string,
): Promise<GroupSummary> {
  const role = await requireMembership(db, groupId, userId);

  const [group] = await db
    .select({ id: trustedGroups.id, name: trustedGroups.name, createdAt: trustedGroups.createdAt })
    .from(trustedGroups)
    .where(eq(trustedGroups.id, groupId))
    .limit(1);

  if (!group) {
    throw errors.groupNotFound();
  }

  return {
    id: group.id,
    name: group.name,
    role,
    memberCount: await countMembers(db, groupId),
    createdAt: group.createdAt.toISOString(),
  };
}

export async function updateGroupName(
  db: Database,
  userId: string,
  groupId: string,
  name: string,
): Promise<GroupSummary> {
  await requireGroupRole(db, groupId, userId, ["OWNER", "ADMIN"]);
  await db
    .update(trustedGroups)
    .set({ name, updatedAt: new Date() })
    .where(eq(trustedGroups.id, groupId));
  return getGroupDetails(db, userId, groupId);
}

export async function listMembers(
  db: Database,
  userId: string,
  groupId: string,
): Promise<GroupMemberView[]> {
  await requireMembership(db, groupId, userId);

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      role: groupMemberships.role,
      joinedAt: groupMemberships.createdAt,
    })
    .from(groupMemberships)
    .innerJoin(users, eq(users.id, groupMemberships.userId))
    .where(eq(groupMemberships.groupId, groupId));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
  }));
}

export async function leaveGroup(
  db: Database,
  userId: string,
  groupId: string,
  options: DomainActionOptions = {},
): Promise<void> {
  const role = await requireMembership(db, groupId, userId);
  if (role === "OWNER") {
    throw errors.ownerCannotLeaveGroup();
  }
  // Phase 10: saída e efeitos no MESMO COMMIT.
  await db.transaction(async (tx) => {
    await tx
      .delete(groupMemberships)
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
    await enqueueMembershipChangedEffects(tx, {
      groupId,
      targetUserId: userId,
      actorUserId: userId,
      auditEventType: "AUDIT_GROUP_MEMBER_REMOVED",
      metadata: { source: "self" },
      requestId: options.requestId ?? null,
    });
  });
}

export async function removeMember(
  db: Database,
  actorUserId: string,
  groupId: string,
  targetUserId: string,
  options: DomainActionOptions = {},
): Promise<void> {
  const actorRole = await requireGroupRole(db, groupId, actorUserId, ["OWNER", "ADMIN"]);
  const targetRole = await findMembershipRole(db, groupId, targetUserId);
  if (!targetRole) {
    throw errors.memberNotFound();
  }
  if (targetRole === "OWNER") {
    throw errors.cannotRemoveOwner();
  }
  // ADMIN só pode remover MEMBER (não outro ADMIN nem OWNER).
  if (actorRole === "ADMIN" && targetRole !== "MEMBER") {
    throw errors.insufficientGroupRole();
  }
  // Phase 10: remoção e efeitos no MESMO COMMIT.
  await db.transaction(async (tx) => {
    await tx
      .delete(groupMemberships)
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, targetUserId)));
    await enqueueMembershipChangedEffects(tx, {
      groupId,
      targetUserId,
      actorUserId,
      auditEventType: "AUDIT_GROUP_MEMBER_REMOVED",
      metadata: { source: "admin" },
      requestId: options.requestId ?? null,
    });
  });
}

/**
 * Transfere a propriedade do grupo para outro membro (Phase 12).
 *
 * Existe para que uma pessoa possa sair de vez (excluir a conta) sem precisar
 * expulsar a própria família do grupo. Só o OWNER transfere; o alvo precisa
 * ser membro e não pode ser o próprio OWNER. O antigo dono vira ADMIN — o
 * grupo continua sendo dele para todos os efeitos práticos, exceto a
 * propriedade. Tudo em uma transação: o índice parcial "um OWNER por grupo"
 * exige rebaixar antes de promover.
 */
export async function transferOwnership(
  db: Database,
  actorUserId: string,
  groupId: string,
  targetUserId: string,
  options: DomainActionOptions = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await requireGroupRole(tx, groupId, actorUserId, ["OWNER"]);
    if (targetUserId === actorUserId) {
      throw errors.ownershipTransferTargetInvalid();
    }
    const targetRole = await findMembershipRole(tx, groupId, targetUserId);
    if (!targetRole) {
      throw errors.memberNotFound();
    }

    const now = new Date();
    await tx
      .update(groupMemberships)
      .set({ role: "ADMIN", updatedAt: now })
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, actorUserId)));
    await tx
      .update(groupMemberships)
      .set({ role: "OWNER", updatedAt: now })
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, targetUserId)));

    await enqueueAudit(tx, "AUDIT_GROUP_OWNERSHIP_TRANSFERRED", {
      aggregateType: "GROUP",
      aggregateId: groupId,
      groupId,
      actorUserId,
      targetType: "GROUP_MEMBERSHIP",
      targetId: targetUserId,
      metadata: { role: "OWNER", previousRole: targetRole },
      requestId: options.requestId ?? null,
    });
    // Os dois envolvidos veem o papel mudar sem precisar recarregar.
    for (const userId of [actorUserId, targetUserId]) {
      await enqueueRealtime(tx, "REALTIME_GROUP_MEMBERSHIP_CHANGED", {
        aggregateType: "GROUP",
        aggregateId: groupId,
        groupId,
        requestId: options.requestId ?? null,
        payload: { groupId, targetUserId: userId, userId },
      });
    }
  });
}

export async function changeMemberRole(
  db: Database,
  actorUserId: string,
  groupId: string,
  targetUserId: string,
  newRole: "ADMIN" | "MEMBER",
  options: DomainActionOptions = {},
): Promise<GroupMemberView> {
  return db.transaction(async (tx) => {
    await requireGroupRole(tx, groupId, actorUserId, ["OWNER"]);
    const targetRole = await findMembershipRole(tx, groupId, targetUserId);
    if (!targetRole) {
      throw errors.memberNotFound();
    }
    if (targetRole === "OWNER") {
      // OWNER não pode ser rebaixado nem ter o papel alterado por aqui.
      throw errors.invalidGroupRole();
    }

    await tx
      .update(groupMemberships)
      .set({ role: newRole, updatedAt: new Date() })
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, targetUserId)));

    const [row] = await tx
      .select({
        id: users.id,
        name: users.name,
        role: groupMemberships.role,
        joinedAt: groupMemberships.createdAt,
      })
      .from(groupMemberships)
      .innerJoin(users, eq(users.id, groupMemberships.userId))
      .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, targetUserId)))
      .limit(1);

    if (!row) {
      throw errors.memberNotFound();
    }
    // Phase 10: auditoria no MESMO COMMIT da mudança de papel.
    await enqueueAudit(tx, "AUDIT_GROUP_MEMBER_ROLE_CHANGED", {
      aggregateType: "GROUP",
      aggregateId: groupId,
      groupId,
      actorUserId,
      targetType: "GROUP_MEMBERSHIP",
      targetId: targetUserId,
      metadata: { role: newRole },
      requestId: options.requestId ?? null,
    });
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
    };
  });
}
