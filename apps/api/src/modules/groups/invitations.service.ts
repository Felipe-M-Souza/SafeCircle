import { and, desc, eq, gt } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  groupInvitations,
  groupMemberships,
  trustedGroups,
  users,
} from "../../infrastructure/database/schema.js";
import { enqueueRealtime, type DomainActionOptions } from "../../outbox/effects.js";
import { errors } from "../../shared/errors.js";
import { requireGroupRole } from "./authorization.js";

/** Validade padrão do convite (README/spec §7). */
export const INVITATION_TTL_DAYS = 7;

function invitationExpiry(): Date {
  return new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export interface GroupInvitationView {
  id: string;
  invitedEmail: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface MyInvitationView {
  id: string;
  group: { id: string; name: string };
  invitedBy: { name: string };
  expiresAt: string;
}

async function getUserEmail(db: Database, userId: string): Promise<string> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw errors.unauthorized();
  }
  return user.email;
}

function isUniqueViolation(error: unknown): boolean {
  const check = (value: unknown): boolean =>
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code?: unknown }).code === "23505";
  return check(error) || check((error as { cause?: unknown } | null)?.cause);
}

export async function createInvitation(
  db: Database,
  actorUserId: string,
  groupId: string,
  email: string,
): Promise<GroupInvitationView> {
  await requireGroupRole(db, groupId, actorUserId, ["OWNER", "ADMIN"]);

  const actorEmail = await getUserEmail(db, actorUserId);
  if (actorEmail === email) {
    throw errors.cannotInviteSelf();
  }

  // Já é membro? (busca o usuário pelo e-mail e verifica membership)
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existingUser) {
    const [membership] = await db
      .select({ id: groupMemberships.id })
      .from(groupMemberships)
      .where(
        and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, existingUser.id)),
      )
      .limit(1);
    if (membership) {
      throw errors.alreadyGroupMember();
    }
  }

  // Trata convite PENDING existente: se expirado, marca EXPIRED e permite novo.
  const [pending] = await db
    .select({ id: groupInvitations.id, expiresAt: groupInvitations.expiresAt })
    .from(groupInvitations)
    .where(
      and(
        eq(groupInvitations.groupId, groupId),
        eq(groupInvitations.invitedEmail, email),
        eq(groupInvitations.status, "PENDING"),
      ),
    )
    .limit(1);

  if (pending) {
    if (pending.expiresAt.getTime() > Date.now()) {
      throw errors.invitationAlreadyPending();
    }
    await db
      .update(groupInvitations)
      .set({ status: "EXPIRED", updatedAt: new Date() })
      .where(eq(groupInvitations.id, pending.id));
  }

  try {
    const [created] = await db
      .insert(groupInvitations)
      .values({
        groupId,
        invitedByUserId: actorUserId,
        invitedEmail: email,
        status: "PENDING",
        expiresAt: invitationExpiry(),
      })
      .returning({
        id: groupInvitations.id,
        invitedEmail: groupInvitations.invitedEmail,
        status: groupInvitations.status,
        expiresAt: groupInvitations.expiresAt,
        createdAt: groupInvitations.createdAt,
      });
    if (!created) {
      throw new Error("Falha ao criar convite.");
    }
    return {
      id: created.id,
      invitedEmail: created.invitedEmail,
      status: created.status,
      expiresAt: created.expiresAt.toISOString(),
      createdAt: created.createdAt.toISOString(),
    };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw errors.invitationAlreadyPending();
    }
    throw error;
  }
}

export async function listGroupInvitations(
  db: Database,
  actorUserId: string,
  groupId: string,
): Promise<GroupInvitationView[]> {
  await requireGroupRole(db, groupId, actorUserId, ["OWNER", "ADMIN"]);

  const rows = await db
    .select({
      id: groupInvitations.id,
      invitedEmail: groupInvitations.invitedEmail,
      status: groupInvitations.status,
      expiresAt: groupInvitations.expiresAt,
      createdAt: groupInvitations.createdAt,
    })
    .from(groupInvitations)
    .where(and(eq(groupInvitations.groupId, groupId), eq(groupInvitations.status, "PENDING")))
    .orderBy(desc(groupInvitations.createdAt));

  return rows.map((row) => ({
    id: row.id,
    invitedEmail: row.invitedEmail,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function revokeInvitation(
  db: Database,
  actorUserId: string,
  groupId: string,
  invitationId: string,
): Promise<void> {
  await requireGroupRole(db, groupId, actorUserId, ["OWNER", "ADMIN"]);

  const [invitation] = await db
    .select({ id: groupInvitations.id, status: groupInvitations.status })
    .from(groupInvitations)
    .where(and(eq(groupInvitations.id, invitationId), eq(groupInvitations.groupId, groupId)))
    .limit(1);

  if (!invitation) {
    throw errors.invitationNotFound();
  }
  if (invitation.status !== "PENDING") {
    throw errors.invitationAlreadyProcessed();
  }

  await db
    .update(groupInvitations)
    .set({ status: "REVOKED", revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(groupInvitations.id, invitationId), eq(groupInvitations.status, "PENDING")));
}

export async function listMyInvitations(db: Database, userId: string): Promise<MyInvitationView[]> {
  const email = await getUserEmail(db, userId);

  const rows = await db
    .select({
      id: groupInvitations.id,
      groupId: trustedGroups.id,
      groupName: trustedGroups.name,
      invitedByName: users.name,
      expiresAt: groupInvitations.expiresAt,
    })
    .from(groupInvitations)
    .innerJoin(trustedGroups, eq(trustedGroups.id, groupInvitations.groupId))
    .innerJoin(users, eq(users.id, groupInvitations.invitedByUserId))
    .where(
      and(
        eq(groupInvitations.invitedEmail, email),
        eq(groupInvitations.status, "PENDING"),
        gt(groupInvitations.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(groupInvitations.createdAt));

  return rows.map((row) => ({
    id: row.id,
    group: { id: row.groupId, name: row.groupName },
    invitedBy: { name: row.invitedByName },
    expiresAt: row.expiresAt.toISOString(),
  }));
}

export async function acceptInvitation(
  db: Database,
  userId: string,
  invitationId: string,
  options: DomainActionOptions = {},
): Promise<{ groupId: string }> {
  const email = await getUserEmail(db, userId);

  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select({
        id: groupInvitations.id,
        groupId: groupInvitations.groupId,
        invitedEmail: groupInvitations.invitedEmail,
        status: groupInvitations.status,
        expiresAt: groupInvitations.expiresAt,
      })
      .from(groupInvitations)
      .where(eq(groupInvitations.id, invitationId))
      .limit(1);

    if (!invitation) {
      throw errors.invitationNotFound();
    }
    if (invitation.invitedEmail !== email) {
      throw errors.invitationNotForUser();
    }
    if (invitation.status !== "PENDING") {
      throw errors.invitationAlreadyProcessed();
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      await tx
        .update(groupInvitations)
        .set({ status: "EXPIRED", updatedAt: new Date() })
        .where(eq(groupInvitations.id, invitationId));
      throw errors.invitationExpired();
    }

    // Compare-and-swap: só uma aceitação vence sob concorrência.
    const accepted = await tx
      .update(groupInvitations)
      .set({ status: "ACCEPTED", acceptedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(groupInvitations.id, invitationId), eq(groupInvitations.status, "PENDING")))
      .returning({ id: groupInvitations.id });

    if (accepted.length === 0) {
      throw errors.invitationAlreadyProcessed();
    }

    // Cria a membership; se já existir (retry/concorrência), não duplica.
    await tx
      .insert(groupMemberships)
      .values({ groupId: invitation.groupId, userId, role: "MEMBER" })
      .onConflictDoNothing({
        target: [groupMemberships.groupId, groupMemberships.userId],
      });

    // Phase 10: o aviso de ressincronização entra no MESMO COMMIT.
    await enqueueRealtime(tx, "REALTIME_GROUP_MEMBERSHIP_CHANGED", {
      aggregateType: "GROUP",
      aggregateId: invitation.groupId,
      groupId: invitation.groupId,
      requestId: options.requestId ?? null,
      //  roteia;  compõe o envelope da Phase 5.
      payload: { groupId: invitation.groupId, targetUserId: userId, userId },
    });

    return { groupId: invitation.groupId };
  });
}

export async function rejectInvitation(
  db: Database,
  userId: string,
  invitationId: string,
): Promise<void> {
  const email = await getUserEmail(db, userId);

  const [invitation] = await db
    .select({
      id: groupInvitations.id,
      invitedEmail: groupInvitations.invitedEmail,
      status: groupInvitations.status,
    })
    .from(groupInvitations)
    .where(eq(groupInvitations.id, invitationId))
    .limit(1);

  if (!invitation) {
    throw errors.invitationNotFound();
  }
  if (invitation.invitedEmail !== email) {
    throw errors.invitationNotForUser();
  }
  if (invitation.status !== "PENDING") {
    throw errors.invitationAlreadyProcessed();
  }

  await db
    .update(groupInvitations)
    .set({ status: "REJECTED", rejectedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(groupInvitations.id, invitationId), eq(groupInvitations.status, "PENDING")));
}
