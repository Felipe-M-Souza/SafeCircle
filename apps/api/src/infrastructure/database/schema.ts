import { relations, sql } from "drizzle-orm";
import { index, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Schema Drizzle do SafeCircle.
 *
 * Phase 1 — Autenticação: introduz `users` e `auth_sessions`.
 * Phase 2 — Grupos de Confiança: introduz `trusted_groups`, `group_memberships`
 * e `group_invitations`.
 * Identificadores internos permanecem em inglês por consistência técnica.
 */

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    // E-mail é normalizado (trim + lowercase) na camada de aplicação antes de persistir.
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Somente o hash (SHA-256) do refresh token é armazenado — nunca o token em texto puro.
    refreshTokenHash: text("refresh_token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("auth_sessions_refresh_token_hash_unique").on(table.refreshTokenHash),
    index("auth_sessions_user_id_idx").on(table.userId),
  ],
);

// ------------------------------------------------------------------
// Phase 2 — Grupos de Confiança
// ------------------------------------------------------------------

export const groupRole = pgEnum("group_role", ["OWNER", "ADMIN", "MEMBER"]);
export const invitationStatus = pgEnum("invitation_status", [
  "PENDING",
  "ACCEPTED",
  "REJECTED",
  "REVOKED",
  "EXPIRED",
]);

export const trustedGroups = pgTable("trusted_groups", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const groupMemberships = pgTable(
  "group_memberships",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    groupId: uuid("group_id")
      .notNull()
      .references(() => trustedGroups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: groupRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Um usuário não pode ter duas memberships no mesmo grupo.
    uniqueIndex("group_memberships_group_user_unique").on(table.groupId, table.userId),
    // Exatamente um OWNER por grupo (garantido no PostgreSQL).
    uniqueIndex("group_memberships_single_owner_unique")
      .on(table.groupId)
      .where(sql`${table.role} = 'OWNER'`),
    index("group_memberships_user_id_idx").on(table.userId),
    index("group_memberships_group_id_idx").on(table.groupId),
  ],
);

export const groupInvitations = pgTable(
  "group_invitations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    groupId: uuid("group_id")
      .notNull()
      .references(() => trustedGroups.id, { onDelete: "cascade" }),
    invitedByUserId: uuid("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // E-mail normalizado (trim + lowercase) do convidado.
    invitedEmail: text("invited_email").notNull(),
    status: invitationStatus("status").notNull().default("PENDING"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    // No máximo um convite PENDING por (grupo, e-mail).
    uniqueIndex("group_invitations_group_email_pending_unique")
      .on(table.groupId, table.invitedEmail)
      .where(sql`${table.status} = 'PENDING'`),
    index("group_invitations_group_id_idx").on(table.groupId),
    index("group_invitations_invited_email_idx").on(table.invitedEmail),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(authSessions),
  memberships: many(groupMemberships),
}));

export const authSessionsRelations = relations(authSessions, ({ one }) => ({
  user: one(users, {
    fields: [authSessions.userId],
    references: [users.id],
  }),
}));

export const trustedGroupsRelations = relations(trustedGroups, ({ many }) => ({
  memberships: many(groupMemberships),
  invitations: many(groupInvitations),
}));

export const groupMembershipsRelations = relations(groupMemberships, ({ one }) => ({
  group: one(trustedGroups, {
    fields: [groupMemberships.groupId],
    references: [trustedGroups.id],
  }),
  user: one(users, {
    fields: [groupMemberships.userId],
    references: [users.id],
  }),
}));

export const groupInvitationsRelations = relations(groupInvitations, ({ one }) => ({
  group: one(trustedGroups, {
    fields: [groupInvitations.groupId],
    references: [trustedGroups.id],
  }),
  invitedBy: one(users, {
    fields: [groupInvitations.invitedByUserId],
    references: [users.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;
export type TrustedGroup = typeof trustedGroups.$inferSelect;
export type GroupMembership = typeof groupMemberships.$inferSelect;
export type GroupInvitation = typeof groupInvitations.$inferSelect;
export type GroupRole = (typeof groupRole.enumValues)[number];
export type InvitationStatus = (typeof invitationStatus.enumValues)[number];
