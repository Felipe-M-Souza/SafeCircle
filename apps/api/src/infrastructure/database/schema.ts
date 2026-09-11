import { relations, sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Schema Drizzle do SafeCircle.
 *
 * Phase 1 — Autenticação: introduz `users` e `auth_sessions`.
 * Phase 2 — Grupos de Confiança: introduz `trusted_groups`, `group_memberships`
 * e `group_invitations`.
 * Phase 3 — Alerta de Emergência: introduz `emergency_alerts`, `alert_locations`
 * e `idempotency_keys`.
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

// ------------------------------------------------------------------
// Phase 3 — Alerta de Emergência
// ------------------------------------------------------------------

export const alertStatus = pgEnum("alert_status", ["ACTIVE", "RESOLVED", "CANCELLED"]);

export const emergencyAlerts = pgTable(
  "emergency_alerts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    groupId: uuid("group_id")
      .notNull()
      .references(() => trustedGroups.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: alertStatus("status").notNull().default("ACTIVE"),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // No máximo um alerta ACTIVE por (usuário, grupo) — garantido no PostgreSQL.
    uniqueIndex("emergency_alerts_active_per_user_group_unique")
      .on(table.createdByUserId, table.groupId)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("emergency_alerts_group_id_status_idx").on(table.groupId, table.status),
    index("emergency_alerts_created_by_user_id_idx").on(table.createdByUserId),
  ],
);

/**
 * Snapshot de localização capturado no início do alerta (Phase 3).
 * Dado sensível: só é exposto a membros do grupo e nunca aparece em logs.
 * Nesta fase existe no máximo um snapshot por alerta (sem tracking contínuo).
 */
export const alertLocations = pgTable(
  "alert_locations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => emergencyAlerts.id, { onDelete: "cascade" }),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    accuracy: doublePrecision("accuracy"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("alert_locations_alert_id_idx").on(table.alertId)],
);

/**
 * Idempotência persistente para operações críticas sujeitas a retry
 * (README §17). A chave é escopada por usuário + operação: a mesma chave
 * enviada por usuários diferentes não interfere entre si.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Operação a que a chave se refere (ex.: "alerts.create").
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    // Hash do payload canônico: detecta reuso da mesma chave com dados diferentes.
    requestHash: text("request_hash").notNull(),
    // Recurso criado pela requisição original (ex.: id do alerta).
    resourceId: uuid("resource_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_user_scope_key_unique").on(table.userId, table.scope, table.key),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(authSessions),
  memberships: many(groupMemberships),
  alerts: many(emergencyAlerts),
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

export const emergencyAlertsRelations = relations(emergencyAlerts, ({ one, many }) => ({
  group: one(trustedGroups, {
    fields: [emergencyAlerts.groupId],
    references: [trustedGroups.id],
  }),
  createdBy: one(users, {
    fields: [emergencyAlerts.createdByUserId],
    references: [users.id],
  }),
  locations: many(alertLocations),
}));

export const alertLocationsRelations = relations(alertLocations, ({ one }) => ({
  alert: one(emergencyAlerts, {
    fields: [alertLocations.alertId],
    references: [emergencyAlerts.id],
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
export type EmergencyAlert = typeof emergencyAlerts.$inferSelect;
export type AlertLocation = typeof alertLocations.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type AlertStatus = (typeof alertStatus.enumValues)[number];
