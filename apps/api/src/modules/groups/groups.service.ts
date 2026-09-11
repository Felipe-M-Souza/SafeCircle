import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  groupMemberships,
  trustedGroups,
  users,
  type GroupRole,
} from "../../infrastructure/database/schema.js";
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

export async function leaveGroup(db: Database, userId: string, groupId: string): Promise<void> {
  const role = await requireMembership(db, groupId, userId);
  if (role === "OWNER") {
    throw errors.ownerCannotLeaveGroup();
  }
  await db
    .delete(groupMemberships)
    .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
}

export async function removeMember(
  db: Database,
  actorUserId: string,
  groupId: string,
  targetUserId: string,
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
  await db
    .delete(groupMemberships)
    .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, targetUserId)));
}

export async function changeMemberRole(
  db: Database,
  actorUserId: string,
  groupId: string,
  targetUserId: string,
  newRole: "ADMIN" | "MEMBER",
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
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
    };
  });
}
