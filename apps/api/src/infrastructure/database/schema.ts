import { relations, sql } from "drizzle-orm";
import {
  boolean,
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
 * Phase 4 — Notificações Push: introduz `push_devices`.
 * Phase 5 — Tempo Real: introduz `alert_acknowledgements`.
 * Phase 6 — Localização ao Vivo: introduz `alert_location_sessions` e
 * `alert_location_updates` (a `alert_locations` da Phase 3 segue sendo a
 * localização pontual da ativação).
 * Phase 7 — Check-in de Segurança: introduz `safety_checkins`.
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

// ------------------------------------------------------------------
// Phase 4 — Notificações Push
// ------------------------------------------------------------------

export const pushPlatform = pgEnum("push_platform", ["IOS", "ANDROID"]);

/**
 * Registro de push por instalação do app (Phase 4).
 *
 * - `token`: Expo Push Token — dado sensível, único e pertencente a um único
 *   usuário por vez (nunca devolvido pela API nem registrado em logs).
 * - `deviceId`: UUID de instalação gerado pelo próprio app (sem IMEI, MAC ou
 *   advertising ID); um registro por (usuário, instalação).
 * - `isActive`: tokens inválidos são desativados sem apagar o registro.
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    platform: pushPlatform("platform").notNull(),
    deviceId: uuid("device_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("push_devices_token_unique").on(table.token),
    uniqueIndex("push_devices_user_device_unique").on(table.userId, table.deviceId),
    index("push_devices_user_id_idx").on(table.userId),
  ],
);

// ------------------------------------------------------------------
// Phase 5 — Atualizações em Tempo Real (acknowledgements)
// ------------------------------------------------------------------

export const acknowledgementType = pgEnum("acknowledgement_type", [
  "SEEN",
  "ACKNOWLEDGED",
  "GOING_TO_HELP",
  "EMERGENCY_SERVICES_CONTACTED",
]);

/**
 * Estado declarado por um membro sobre um alerta (Phase 5).
 * Um usuário possui exatamente um estado atual por alerta (upsert). Não é
 * garantia real de socorro: representa apenas o que o membro declarou.
 */
export const alertAcknowledgements = pgTable(
  "alert_acknowledgements",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => emergencyAlerts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: acknowledgementType("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("alert_acknowledgements_alert_user_unique").on(table.alertId, table.userId),
    index("alert_acknowledgements_alert_id_idx").on(table.alertId),
  ],
);

// ------------------------------------------------------------------
// Phase 6 — Localização ao Vivo
// ------------------------------------------------------------------

export const liveLocationSessionStatus = pgEnum("live_location_session_status", [
  "ACTIVE",
  "STOPPED",
]);

/**
 * Sessão de compartilhamento ao vivo (Phase 6): opt-in explícito do criador
 * do alerta, no máximo uma ACTIVE por alerta, encerrada manualmente ou
 * automaticamente quando o alerta deixa de estar ACTIVE.
 */
export const alertLocationSessions = pgTable(
  "alert_location_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => emergencyAlerts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: liveLocationSessionStatus("status").notNull().default("ACTIVE"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("alert_location_sessions_active_per_alert_unique")
      .on(table.alertId)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("alert_location_sessions_alert_id_idx").on(table.alertId),
  ],
);

/**
 * Pontos de localização ao vivo (Phase 6). Dado altamente sensível: só
 * membros atuais do grupo leem, nunca aparece em logs nem em eventos
 * realtime, e é apagado pela política de retenção (30 dias após o
 * encerramento do alerta).
 */
export const alertLocationUpdates = pgTable(
  "alert_location_updates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => alertLocationSessions.id, { onDelete: "cascade" }),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => emergencyAlerts.id, { onDelete: "cascade" }),
    // Idempotência do ponto: retry de rede com o mesmo id não duplica.
    clientUpdateId: uuid("client_update_id").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    accuracy: doublePrecision("accuracy"),
    altitude: doublePrecision("altitude"),
    heading: doublePrecision("heading"),
    speed: doublePrecision("speed"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("alert_location_updates_session_client_unique").on(
      table.sessionId,
      table.clientUpdateId,
    ),
    index("alert_location_updates_session_created_idx").on(table.sessionId, table.createdAt),
    index("alert_location_updates_alert_id_idx").on(table.alertId),
  ],
);

// ------------------------------------------------------------------
// Phase 7 — Check-in de Segurança
// ------------------------------------------------------------------

export const checkinStatus = pgEnum("checkin_status", ["ACTIVE", "SAFE", "CANCELLED", "OVERDUE"]);

/**
 * Check-in temporizado (Phase 7): o usuário se compromete a confirmar que
 * está bem até `dueAt`. O servidor é o relógio autoritativo: um scheduler
 * marca `ACTIVE -> OVERDUE` quando o prazo vence. Um check-in vencido NÃO é
 * uma emergência confirmada e nunca cria alerta automaticamente.
 */
export const safetyCheckins = pgTable(
  "safety_checkins",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => trustedGroups.id, { onDelete: "cascade" }),
    status: checkinStatus("status").notNull().default("ACTIVE"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    overdueAt: timestamp("overdue_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // No máximo um check-in ACTIVE por (usuário, grupo) — garantido no PostgreSQL.
    uniqueIndex("safety_checkins_active_per_user_group_unique")
      .on(table.userId, table.groupId)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("safety_checkins_user_id_idx").on(table.userId),
    index("safety_checkins_group_id_idx").on(table.groupId),
    // Scheduler: ACTIVE com due_at vencido.
    index("safety_checkins_status_due_at_idx").on(table.status, table.dueAt),
  ],
);

// ------------------------------------------------------------------
// Phase 8 — Trajeto Seguro
// ------------------------------------------------------------------

export const journeyStatus = pgEnum("journey_status", [
  "ACTIVE",
  "ARRIVED",
  "CANCELLED",
  "OVERDUE",
]);

/**
 * Trajeto seguro (Phase 8): o usuário avisa um grupo que está a caminho e se
 * compromete a confirmar a chegada até `expectedArrivalAt`. O servidor é o
 * relógio autoritativo: um scheduler marca `ACTIVE -> OVERDUE` quando o prazo
 * vence. Um trajeto atrasado NÃO é uma emergência confirmada e nunca cria
 * alerta automaticamente. O destino é textual e opcional; a localização ao
 * vivo é opt-in explícito (`liveLocationEnabled`).
 */
export const safeJourneys = pgTable(
  "safe_journeys",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => trustedGroups.id, { onDelete: "cascade" }),
    status: journeyStatus("status").notNull().default("ACTIVE"),
    // Descrição textual e opcional do destino (ex.: "Casa"). Nunca um endereço
    // exato obrigatório nem coordenada — sem geocoding.
    destinationLabel: text("destination_label"),
    expectedArrivalAt: timestamp("expected_arrival_at", { withTimezone: true }).notNull(),
    liveLocationEnabled: boolean("live_location_enabled").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    overdueAt: timestamp("overdue_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // No máximo um trajeto não-finalizado (ACTIVE ou OVERDUE) por usuário.
    uniqueIndex("safe_journeys_unfinished_per_user_unique")
      .on(table.userId)
      .where(sql`${table.status} in ('ACTIVE', 'OVERDUE')`),
    index("safe_journeys_user_id_idx").on(table.userId),
    index("safe_journeys_group_id_idx").on(table.groupId),
    // Scheduler: ACTIVE com expected_arrival_at vencido.
    index("safe_journeys_status_expected_idx").on(table.status, table.expectedArrivalAt),
  ],
);

/**
 * Sessão de compartilhamento ao vivo de um trajeto (Phase 8). Tabela própria
 * (não reutiliza as de alerta): opt-in explícito, no máximo uma ACTIVE por
 * trajeto, encerrada ao chegar/cancelar ou manualmente.
 */
export const journeyLocationSessions = pgTable(
  "journey_location_sessions",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => safeJourneys.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: liveLocationSessionStatus("status").notNull().default("ACTIVE"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("journey_location_sessions_active_per_journey_unique")
      .on(table.journeyId)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("journey_location_sessions_journey_id_idx").on(table.journeyId),
  ],
);

/**
 * Pontos de localização ao vivo do trajeto (Phase 8). Dado altamente
 * sensível: só membros atuais do grupo leem, nunca aparece em logs nem em
 * eventos realtime, e é apagado pela retenção (30 dias após o encerramento).
 */
export const journeyLocationUpdates = pgTable(
  "journey_location_updates",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => journeyLocationSessions.id, { onDelete: "cascade" }),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => safeJourneys.id, { onDelete: "cascade" }),
    // Idempotência do ponto: retry de rede com o mesmo id não duplica.
    clientUpdateId: uuid("client_update_id").notNull(),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    accuracy: doublePrecision("accuracy"),
    altitude: doublePrecision("altitude"),
    heading: doublePrecision("heading"),
    speed: doublePrecision("speed"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("journey_location_updates_session_client_unique").on(
      table.sessionId,
      table.clientUpdateId,
    ),
    index("journey_location_updates_session_created_idx").on(table.sessionId, table.createdAt),
    index("journey_location_updates_journey_id_idx").on(table.journeyId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(authSessions),
  memberships: many(groupMemberships),
  alerts: many(emergencyAlerts),
  pushDevices: many(pushDevices),
  acknowledgements: many(alertAcknowledgements),
  liveLocationSessions: many(alertLocationSessions),
  safetyCheckins: many(safetyCheckins),
  safeJourneys: many(safeJourneys),
}));

export const safeJourneysRelations = relations(safeJourneys, ({ one, many }) => ({
  user: one(users, {
    fields: [safeJourneys.userId],
    references: [users.id],
  }),
  group: one(trustedGroups, {
    fields: [safeJourneys.groupId],
    references: [trustedGroups.id],
  }),
  locationSessions: many(journeyLocationSessions),
}));

export const journeyLocationSessionsRelations = relations(
  journeyLocationSessions,
  ({ one, many }) => ({
    journey: one(safeJourneys, {
      fields: [journeyLocationSessions.journeyId],
      references: [safeJourneys.id],
    }),
    user: one(users, {
      fields: [journeyLocationSessions.userId],
      references: [users.id],
    }),
    updates: many(journeyLocationUpdates),
  }),
);

export const journeyLocationUpdatesRelations = relations(journeyLocationUpdates, ({ one }) => ({
  session: one(journeyLocationSessions, {
    fields: [journeyLocationUpdates.sessionId],
    references: [journeyLocationSessions.id],
  }),
}));

export const safetyCheckinsRelations = relations(safetyCheckins, ({ one }) => ({
  user: one(users, {
    fields: [safetyCheckins.userId],
    references: [users.id],
  }),
  group: one(trustedGroups, {
    fields: [safetyCheckins.groupId],
    references: [trustedGroups.id],
  }),
}));

export const alertLocationSessionsRelations = relations(alertLocationSessions, ({ one, many }) => ({
  alert: one(emergencyAlerts, {
    fields: [alertLocationSessions.alertId],
    references: [emergencyAlerts.id],
  }),
  user: one(users, {
    fields: [alertLocationSessions.userId],
    references: [users.id],
  }),
  updates: many(alertLocationUpdates),
}));

export const alertLocationUpdatesRelations = relations(alertLocationUpdates, ({ one }) => ({
  session: one(alertLocationSessions, {
    fields: [alertLocationUpdates.sessionId],
    references: [alertLocationSessions.id],
  }),
}));

export const alertAcknowledgementsRelations = relations(alertAcknowledgements, ({ one }) => ({
  alert: one(emergencyAlerts, {
    fields: [alertAcknowledgements.alertId],
    references: [emergencyAlerts.id],
  }),
  user: one(users, {
    fields: [alertAcknowledgements.userId],
    references: [users.id],
  }),
}));

export const pushDevicesRelations = relations(pushDevices, ({ one }) => ({
  user: one(users, {
    fields: [pushDevices.userId],
    references: [users.id],
  }),
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
export type PushDevice = typeof pushDevices.$inferSelect;
export type PushPlatform = (typeof pushPlatform.enumValues)[number];
export type AlertAcknowledgement = typeof alertAcknowledgements.$inferSelect;
export type AcknowledgementType = (typeof acknowledgementType.enumValues)[number];
export type AlertLocationSession = typeof alertLocationSessions.$inferSelect;
export type AlertLocationUpdate = typeof alertLocationUpdates.$inferSelect;
export type LiveLocationSessionStatus = (typeof liveLocationSessionStatus.enumValues)[number];
export type SafetyCheckin = typeof safetyCheckins.$inferSelect;
export type CheckinStatus = (typeof checkinStatus.enumValues)[number];
export type SafeJourney = typeof safeJourneys.$inferSelect;
export type JourneyStatus = (typeof journeyStatus.enumValues)[number];
export type JourneyLocationSession = typeof journeyLocationSessions.$inferSelect;
export type JourneyLocationUpdate = typeof journeyLocationUpdates.$inferSelect;
