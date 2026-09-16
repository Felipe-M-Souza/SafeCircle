import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import {
  authSessions,
  emergencyAlerts,
  groupInvitations,
  groupMemberships,
  pushDevices,
  safeJourneys,
  safetyCheckins,
  trustedGroups,
  users,
} from "../../infrastructure/database/schema.js";
import {
  enqueueAudit,
  enqueueMembershipChangedEffects,
  type DomainActionOptions,
} from "../../outbox/effects.js";
import type { Transaction } from "../../outbox/outbox.service.js";
import { errors } from "../../shared/errors.js";
import { verifyPassword } from "../auth/password.js";

/**
 * Exclusão de conta (Phase 12) — o RELEASE BLOCKER da Phase 11.
 *
 * Não é um `DELETE FROM users`. É uma transação que primeiro recusa o que não
 * pode ser resolvido sozinho e depois apaga o que é da pessoa, sem tocar no que
 * é de terceiros:
 *
 * **Bloqueios** (a exclusão não acontece; a resposta diz o quê resolver):
 * - grupo em que a pessoa é OWNER e há outros membros → transferir a
 *   propriedade (`POST /groups/:id/transfer-ownership`) ou remover os demais;
 * - alerta ACTIVE, check-in ou trajeto ACTIVE/OVERDUE → encerrar antes. Uma
 *   emergência nunca é cancelada em silêncio pela exclusão.
 *
 * **Decisão por entidade** (docs/privacy/retention-policy.md, ADR 0013):
 * - grupos em que a pessoa é o único membro: apagados (cascade);
 * - memberships em outros grupos: removidas; o grupo fica;
 * - alertas, check-ins e trajetos criados pela pessoa (já encerrados):
 *   apagados, com localização, sessões e confirmações de terceiros sobre eles
 *   — sem o alerta, a confirmação "vi" de outra pessoa não significa nada;
 * - confirmações da pessoa em alertas de outros: apagadas;
 * - convites enviados pela pessoa e convites para o e-mail dela: apagados;
 * - sessões, histórico de refresh e push devices: apagados (cascade);
 * - auditoria: fica pelo prazo de retenção, com `actor_user_id` nulo
 *   (SET NULL) e sem PII na metadata — não reidentificável;
 * - outbox: eventos PENDING que citam a pessoa são tolerados pelos handlers
 *   (ver `audit.handler.ts`); nada é apagado nem "fingido" como processado.
 */

export interface OwnershipBlocker {
  groupId: string;
  name: string;
  memberCount: number;
}

export interface DeletionBlockers {
  groupsWithOtherMembers: OwnershipBlocker[];
  activeAlerts: string[];
  activeCheckins: string[];
  activeJourneys: string[];
}

export interface DeletionImpact {
  /** Grupos apagados junto com a conta (a pessoa era o único membro). */
  soleMemberGroups: Array<{ groupId: string; name: string }>;
  membershipsLeft: number;
  alerts: number;
  checkins: number;
  journeys: number;
  pushDevices: number;
  sessions: number;
}

export interface AccountDeletionPreview {
  canDelete: boolean;
  blockers: DeletionBlockers;
  impact: DeletionImpact;
}

type Db = Database | Transaction;

async function ownedGroups(db: Db, userId: string) {
  const memberCount = db
    .select({ count: count() })
    .from(groupMemberships)
    .where(eq(groupMemberships.groupId, trustedGroups.id));
  return db
    .select({
      groupId: trustedGroups.id,
      name: trustedGroups.name,
      memberCount: sql<number>`(${memberCount})`.mapWith(Number),
    })
    .from(groupMemberships)
    .innerJoin(trustedGroups, eq(trustedGroups.id, groupMemberships.groupId))
    .where(and(eq(groupMemberships.userId, userId), eq(groupMemberships.role, "OWNER")));
}

async function collectBlockers(db: Db, userId: string): Promise<DeletionBlockers> {
  const owned = await ownedGroups(db, userId);
  const activeAlerts = await db
    .select({ id: emergencyAlerts.id })
    .from(emergencyAlerts)
    .where(and(eq(emergencyAlerts.createdByUserId, userId), eq(emergencyAlerts.status, "ACTIVE")));
  const activeCheckins = await db
    .select({ id: safetyCheckins.id })
    .from(safetyCheckins)
    .where(
      and(eq(safetyCheckins.userId, userId), inArray(safetyCheckins.status, ["ACTIVE", "OVERDUE"])),
    );
  const activeJourneys = await db
    .select({ id: safeJourneys.id })
    .from(safeJourneys)
    .where(
      and(eq(safeJourneys.userId, userId), inArray(safeJourneys.status, ["ACTIVE", "OVERDUE"])),
    );

  return {
    groupsWithOtherMembers: owned
      .filter((group) => group.memberCount > 1)
      .map((group) => ({
        groupId: group.groupId,
        name: group.name,
        memberCount: group.memberCount,
      })),
    activeAlerts: activeAlerts.map((row) => row.id),
    activeCheckins: activeCheckins.map((row) => row.id),
    activeJourneys: activeJourneys.map((row) => row.id),
  };
}

async function countWhere(
  db: Db,
  table: typeof emergencyAlerts | typeof safetyCheckins | typeof safeJourneys | typeof pushDevices,
  condition: ReturnType<typeof eq>,
): Promise<number> {
  const [row] = await db.select({ total: count() }).from(table).where(condition);
  return Number(row?.total ?? 0);
}

/** O que a exclusão faria agora — para a tela explicar antes de pedir a senha. */
export async function getAccountDeletionPreview(
  db: Database,
  userId: string,
): Promise<AccountDeletionPreview> {
  const blockers = await collectBlockers(db, userId);
  const owned = await ownedGroups(db, userId);
  const [memberships] = await db
    .select({ total: count() })
    .from(groupMemberships)
    .where(eq(groupMemberships.userId, userId));
  const [sessions] = await db
    .select({ total: count() })
    .from(authSessions)
    .where(eq(authSessions.userId, userId));

  const soleMemberGroups = owned
    .filter((group) => group.memberCount === 1)
    .map((group) => ({ groupId: group.groupId, name: group.name }));

  return {
    canDelete:
      blockers.groupsWithOtherMembers.length === 0 &&
      blockers.activeAlerts.length === 0 &&
      blockers.activeCheckins.length === 0 &&
      blockers.activeJourneys.length === 0,
    blockers,
    impact: {
      soleMemberGroups,
      membershipsLeft: Number(memberships?.total ?? 0) - soleMemberGroups.length,
      alerts: await countWhere(db, emergencyAlerts, eq(emergencyAlerts.createdByUserId, userId)),
      checkins: await countWhere(db, safetyCheckins, eq(safetyCheckins.userId, userId)),
      journeys: await countWhere(db, safeJourneys, eq(safeJourneys.userId, userId)),
      pushDevices: await countWhere(db, pushDevices, eq(pushDevices.userId, userId)),
      sessions: Number(sessions?.total ?? 0),
    },
  };
}

export interface DeleteAccountInput {
  password: string;
}

export interface DeleteAccountResult {
  /** Sessões que existiam: o chamador fecha os WebSockets delas. */
  sessionIds: string[];
  groupsDeleted: number;
}

/**
 * Exclui a conta. Reautenticação com a senha atual é obrigatória: um access
 * token roubado não pode apagar a vida digital de alguém.
 *
 * Tudo em UMA transação com a linha do usuário travada (`FOR UPDATE`): dois
 * pedidos simultâneos não competem, e um login concorrente não cria sessão no
 * meio do caminho. Ou a conta some inteira, ou nada muda.
 */
export async function deleteAccount(
  db: Database,
  userId: string,
  input: DeleteAccountInput,
  options: DomainActionOptions = {},
): Promise<DeleteAccountResult> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user) {
      throw errors.unauthorized();
    }

    const valid = await verifyPassword(user.passwordHash, input.password);
    if (!valid) {
      throw errors.invalidCredentials();
    }

    const blockers = await collectBlockers(tx, userId);
    if (blockers.groupsWithOtherMembers.length > 0) {
      throw errors.accountDeletionBlockedByGroupOwnership({
        groups: blockers.groupsWithOtherMembers,
      });
    }
    if (
      blockers.activeAlerts.length > 0 ||
      blockers.activeCheckins.length > 0 ||
      blockers.activeJourneys.length > 0
    ) {
      throw errors.accountDeletionBlockedByActiveResources({
        alerts: blockers.activeAlerts,
        checkins: blockers.activeCheckins,
        journeys: blockers.activeJourneys,
      });
    }

    const requestId = options.requestId ?? null;
    // Ator nulo desde o pedido: a trilha nunca aponta para alguém que não existe mais.
    await enqueueAudit(tx, "AUDIT_ACCOUNT_DELETION_REQUESTED", {
      aggregateType: "USER",
      aggregateId: userId,
      actorUserId: null,
      targetType: "USER",
      targetId: userId,
      requestId,
    });

    const sessions = await tx
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(eq(authSessions.userId, userId));

    // Grupos em que a pessoa era a única: vão junto (cascade leva memberships,
    // convites e recursos do grupo — todos dela, por definição).
    const owned = await ownedGroups(tx, userId);
    const soleGroupIds = owned.filter((group) => group.memberCount === 1).map((g) => g.groupId);
    if (soleGroupIds.length > 0) {
      await tx.delete(trustedGroups).where(inArray(trustedGroups.id, soleGroupIds));
    }

    // Nos grupos que ficam, os membros são avisados da saída (mesmo evento de
    // "saiu do grupo"), e a trilha registra a remoção sem ator.
    const remaining = await tx
      .select({ groupId: groupMemberships.groupId })
      .from(groupMemberships)
      .where(eq(groupMemberships.userId, userId));
    for (const membership of remaining) {
      await enqueueMembershipChangedEffects(tx, {
        groupId: membership.groupId,
        targetUserId: userId,
        actorUserId: null,
        auditEventType: "AUDIT_GROUP_MEMBER_REMOVED",
        metadata: { source: "account_deletion" },
        requestId,
      });
    }

    // Convites para o e-mail da pessoa: não há FK, e o e-mail é dado pessoal.
    await tx.delete(groupInvitations).where(eq(groupInvitations.invitedEmail, user.email));

    // O resto cai por cascade: memberships, sessões, histórico de refresh,
    // push devices, alertas (com localização, sessões ao vivo e confirmações),
    // confirmações, check-ins, trajetos, convites enviados. Auditoria: SET NULL.
    await tx.delete(users).where(eq(users.id, userId));

    await enqueueAudit(tx, "AUDIT_ACCOUNT_DELETION_COMPLETED", {
      aggregateType: "USER",
      aggregateId: userId,
      actorUserId: null,
      targetType: "USER",
      targetId: userId,
      metadata: { groupsDeleted: soleGroupIds.length },
      requestId,
    });

    return { sessionIds: sessions.map((row) => row.id), groupsDeleted: soleGroupIds.length };
  });
}
