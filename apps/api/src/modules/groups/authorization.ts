import { and, eq } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { groupMemberships, type GroupRole } from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";

type Db = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Retorna o papel do usuário no grupo, ou null se não for membro.
 */
export async function findMembershipRole(
  db: Db,
  groupId: string,
  userId: string,
): Promise<GroupRole | null> {
  const [row] = await db
    .select({ role: groupMemberships.role })
    .from(groupMemberships)
    .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)))
    .limit(1);
  return row?.role ?? null;
}

/**
 * Exige que o usuário seja membro do grupo. Caso contrário responde
 * 404 GROUP_NOT_FOUND para NÃO revelar a existência do recurso (anti-IDOR).
 */
export async function requireMembership(
  db: Db,
  groupId: string,
  userId: string,
): Promise<GroupRole> {
  const role = await findMembershipRole(db, groupId, userId);
  if (!role) {
    throw errors.groupNotFound();
  }
  return role;
}

/**
 * Exige que o usuário seja membro e possua um dos papéis informados.
 * Não-membros recebem 404 (anti-IDOR); membros sem papel suficiente recebem 403.
 */
export async function requireGroupRole(
  db: Db,
  groupId: string,
  userId: string,
  allowed: GroupRole[],
): Promise<GroupRole> {
  const role = await requireMembership(db, groupId, userId);
  if (!allowed.includes(role)) {
    throw errors.insufficientGroupRole();
  }
  return role;
}
