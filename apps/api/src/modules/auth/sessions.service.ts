import { and, asc, desc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { authRefreshTokenHistory, authSessions } from "../../infrastructure/database/schema.js";
import { enqueueAudit } from "../../outbox/effects.js";
import { errors } from "../../shared/errors.js";
import type { Transaction } from "../../outbox/outbox.service.js";

/**
 * Sessões de autenticação (Phase 11).
 *
 * Uma sessão nasce no login/registro, vive pelo refresh token e morre por
 * logout, expiração, revogação pelo próprio usuário, limite de sessões ou
 * detecção de reuso de refresh token. O motivo fica gravado: quando alguém
 * relata "fui desconectado", a resposta está no banco, não na memória.
 *
 * O usuário só enxerga e revoga as **próprias** sessões. Sessão alheia ou
 * inexistente recebe a mesma resposta (404): não confirmamos que o id existe.
 */

/** Motivos de revogação — conjunto fechado, gravado em `revoked_reason`. */
export const REVOKED_REASONS = [
  "LOGOUT",
  "USER_REVOKED",
  "USER_REVOKED_OTHERS",
  "SESSION_LIMIT",
  "REFRESH_REUSE",
] as const;
export type RevokedReason = (typeof REVOKED_REASONS)[number];

/** Sessões ativas por usuário. Vários aparelhos, não um só; mas não infinitos. */
export const MAX_ACTIVE_SESSIONS_PER_USER = 10;

/** `last_used_at` é atualizado com esta folga, não a cada requisição. */
export const LAST_USED_REFRESH_MS = 60_000;

/** Sessões encerradas (expiradas ou revogadas) ficam este tempo para investigação. */
export const AUTH_SESSION_RETENTION_DAYS = 30;

type Db = Database | Transaction;

export interface SessionView {
  sessionId: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  /** Verdadeiro para a sessão que fez a requisição. */
  current: boolean;
}

/** Sessão ativa: não revogada e dentro da validade. */
function activeSession(now: Date) {
  return and(isNull(authSessions.revokedAt), gt(authSessions.expiresAt, now));
}

// ------------------------------------------------------------------
// Autenticação por requisição
// ------------------------------------------------------------------

export interface SessionForAuth {
  id: string;
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
  lastUsedAt: Date | null;
}

export async function findSessionForAuth(
  db: Db,
  sessionId: string,
): Promise<SessionForAuth | null> {
  const [row] = await db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      revokedAt: authSessions.revokedAt,
      expiresAt: authSessions.expiresAt,
      lastUsedAt: authSessions.lastUsedAt,
    })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/** Verdadeiro quando a sessão pode sustentar um access token agora. */
export function isSessionUsable(session: SessionForAuth | null, now: Date): boolean {
  return (
    session !== null && session.revokedAt === null && session.expiresAt.getTime() > now.getTime()
  );
}

/**
 * Marca o último uso, no máximo uma vez por janela: transformar cada GET em um
 * UPDATE seria pagar escrita para ganhar precisão que ninguém precisa.
 */
export async function touchSession(
  db: Db,
  session: SessionForAuth,
  now: Date = new Date(),
): Promise<void> {
  const stale =
    session.lastUsedAt === null ||
    now.getTime() - session.lastUsedAt.getTime() >= LAST_USED_REFRESH_MS;
  if (!stale) return;
  await db.update(authSessions).set({ lastUsedAt: now }).where(eq(authSessions.id, session.id));
}

// ------------------------------------------------------------------
// Limite de sessões
// ------------------------------------------------------------------

/**
 * Antes de criar uma sessão nova: se o usuário já está no limite, as mais
 * antigas (por último uso) são revogadas. Preferimos isso a recusar o login —
 * quem está tentando entrar agora é quem tem o aparelho na mão.
 */
export async function enforceSessionLimit(
  tx: Db,
  userId: string,
  now: Date = new Date(),
  limit: number = MAX_ACTIVE_SESSIONS_PER_USER,
): Promise<number> {
  const active = await tx
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), activeSession(now)))
    .orderBy(asc(sql`coalesce(${authSessions.lastUsedAt}, ${authSessions.createdAt})`));

  const excess = active.length - (limit - 1);
  if (excess <= 0) return 0;

  const victims = active.slice(0, excess).map((row) => row.id);
  for (const id of victims) {
    await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: "SESSION_LIMIT", updatedAt: now })
      .where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt)));
  }
  return victims.length;
}

// ------------------------------------------------------------------
// Listagem e revogação pelo usuário
// ------------------------------------------------------------------

export async function listSessions(
  db: Database,
  userId: string,
  currentSessionId: string,
  now: Date = new Date(),
): Promise<SessionView[]> {
  const rows = await db
    .select({
      id: authSessions.id,
      createdAt: authSessions.createdAt,
      lastUsedAt: authSessions.lastUsedAt,
      expiresAt: authSessions.expiresAt,
    })
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), activeSession(now)))
    .orderBy(desc(sql`coalesce(${authSessions.lastUsedAt}, ${authSessions.createdAt})`))
    .limit(MAX_ACTIVE_SESSIONS_PER_USER);

  // Nunca: hash do refresh token, IP, User-Agent. Só o que o usuário precisa
  // para reconhecer "essa sessão não sou eu".
  return rows.map((row) => ({
    sessionId: row.id,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    current: row.id === currentSessionId,
  }));
}

export interface RevokeOptions {
  requestId?: string | null;
}

/**
 * Revoga uma sessão do próprio usuário. Revogar a sessão **atual** é permitido
 * e tem efeito imediato: o access token deixa de valer na próxima requisição.
 *
 * Sessão de outro usuário ou inexistente → 404, indistinguíveis. Sessão do
 * próprio usuário já encerrada → 204 (idempotente).
 */
export async function revokeSession(
  db: Database,
  userId: string,
  sessionId: string,
  options: RevokeOptions = {},
  now: Date = new Date(),
): Promise<{ revoked: boolean }> {
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: authSessions.id, revokedAt: authSessions.revokedAt })
      .from(authSessions)
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
      .limit(1);
    if (!owned) {
      throw errors.sessionNotFound();
    }
    if (owned.revokedAt) {
      return { revoked: false };
    }

    await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: "USER_REVOKED", updatedAt: now })
      .where(eq(authSessions.id, sessionId));

    await enqueueAudit(tx, "AUDIT_AUTH_SESSION_REVOKED", {
      aggregateType: "SESSION",
      aggregateId: sessionId,
      actorUserId: userId,
      targetType: "SESSION",
      targetId: sessionId,
      requestId: options.requestId ?? null,
    });
    return { revoked: true };
  });
}

/** Revoga todas as sessões ativas do usuário, exceto a atual. */
export async function revokeOtherSessions(
  db: Database,
  userId: string,
  currentSessionId: string,
  options: RevokeOptions = {},
  now: Date = new Date(),
): Promise<{ revokedCount: number; revokedSessionIds: string[] }> {
  return db.transaction(async (tx) => {
    const revoked = await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: "USER_REVOKED_OTHERS", updatedAt: now })
      .where(
        and(
          eq(authSessions.userId, userId),
          ne(authSessions.id, currentSessionId),
          activeSession(now),
        ),
      )
      .returning({ id: authSessions.id });

    // Auditado mesmo com zero revogadas: a intenção de "sair de todo lugar" é
    // relevante numa investigação de takeover.
    await enqueueAudit(tx, "AUDIT_AUTH_OTHER_SESSIONS_REVOKED", {
      aggregateType: "USER",
      aggregateId: userId,
      actorUserId: userId,
      targetType: "USER",
      targetId: userId,
      metadata: { revokedCount: revoked.length },
      requestId: options.requestId ?? null,
    });
    return { revokedCount: revoked.length, revokedSessionIds: revoked.map((row) => row.id) };
  });
}

// ------------------------------------------------------------------
// Retenção
// ------------------------------------------------------------------

export interface AuthCleanupSummary {
  sessions: number;
  refreshHistory: number;
}

/**
 * Retenção de dados de autenticação. Sessão ativa NUNCA é tocada.
 *
 * - Histórico de refresh tokens: apagado ao expirar (hash morto não fica).
 * - Sessões expiradas ou revogadas: mantidas por `AUTH_SESSION_RETENTION_DAYS`
 *   para investigação de incidente e então apagadas (o histórico da sessão
 *   cai junto pela FK).
 */
export async function deleteExpiredAuthData(
  db: Database,
  now: Date = new Date(),
  retentionDays: number = AUTH_SESSION_RETENTION_DAYS,
): Promise<AuthCleanupSummary> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const history = await db
    .delete(authRefreshTokenHistory)
    .where(lt(authRefreshTokenHistory.expiresAt, now))
    .returning({ id: authRefreshTokenHistory.id });

  const sessions = await db
    .delete(authSessions)
    .where(or(lt(authSessions.revokedAt, cutoff), lt(authSessions.expiresAt, cutoff)))
    .returning({ id: authSessions.id });

  return { sessions: sessions.length, refreshHistory: history.length };
}
