import { and, eq, isNull } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../infrastructure/database/client.js";
import {
  authRefreshTokenHistory,
  authSessions,
  users,
} from "../../infrastructure/database/schema.js";
import { authRefreshTotal, refreshReuseDetectedTotal } from "../../observability/metrics.js";
import { enqueueAudit, type DomainActionOptions } from "../../outbox/effects.js";
import { errors } from "../../shared/errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import { enforceSessionLimit } from "./sessions.service.js";
import { generateRefreshToken, hashRefreshToken, type AccessTokenClaims } from "./tokens.js";
import type { LoginInput, RegisterInput } from "./auth.schemas.js";

export interface AuthContext {
  db: Database;
  refreshTokenTtlDays: number;
  signAccessToken: (claims: AccessTokenClaims) => string;
  /** Chamado depois do commit quando uma sessão é revogada por segurança. */
  onSessionRevoked?: (sessionId: string) => void;
  log?: FastifyBaseLogger;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface AuthResult {
  user: { id: string; name: string; email: string };
  accessToken: string;
  refreshToken: string;
}

/**
 * Janela em que um refresh token recém-rotacionado pode reaparecer sem ser
 * tratado como roubo (Phase 11). Dois refreshes simultâneos do mesmo aparelho
 * (rede instável, duas abas) são corrida benigna: o perdedor recebe 401 e usa
 * o token novo. Fora da janela, o reaparecimento é reuso — a sessão inteira
 * é revogada.
 */
export const REFRESH_REUSE_GRACE_MS = 10_000;

// Hash "dummy" para equalizar o tempo de resposta quando o usuário não existe,
// dificultando enumeração por timing. Calculado uma única vez sob demanda.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("safecircle-timing-equalizer");
  }
  return dummyHashPromise;
}

// Código de violação de unique constraint no PostgreSQL (23505).
// O Drizzle encapsula o erro do driver em DrizzleQueryError, com o erro real
// disponível em `cause`; por isso inspecionamos o próprio erro e sua causa.
function hasPgCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code?: unknown }).code === code
  );
}

function isUniqueViolation(error: unknown): boolean {
  if (hasPgCode(error, "23505")) {
    return true;
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  return hasPgCode(cause, "23505");
}

function refreshExpiry(days: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

async function createSession(
  ctx: AuthContext,
  userId: string,
  audit?: { eventType: "AUDIT_AUTH_LOGIN_SUCCEEDED"; requestId?: string | null },
): Promise<{ sessionId: string; refreshToken: string }> {
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const now = new Date();

  // Phase 10: sessão e auditoria no MESMO COMMIT — nem o refresh token nem o
  // hash entram na outbox; o payload leva apenas IDs.
  // Phase 11: o limite de sessões é aplicado na mesma transação, antes do
  // INSERT, para que nunca exista um instante com mais sessões que o teto.
  const session = await ctx.db.transaction(async (tx) => {
    await enforceSessionLimit(tx, userId, now);

    const [row] = await tx
      .insert(authSessions)
      .values({
        userId,
        refreshTokenHash,
        expiresAt: refreshExpiry(ctx.refreshTokenTtlDays, now),
        lastUsedAt: now,
      })
      .returning({ id: authSessions.id });

    if (!row) {
      throw new Error("Falha ao criar sessão de autenticação.");
    }
    if (audit) {
      await enqueueAudit(tx, audit.eventType, {
        aggregateType: "USER",
        aggregateId: userId,
        actorUserId: userId,
        targetType: "USER",
        targetId: userId,
        requestId: audit.requestId ?? null,
      });
    }
    return row;
  });

  return { sessionId: session.id, refreshToken };
}

export async function registerUser(ctx: AuthContext, input: RegisterInput): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);

  let user: { id: string; name: string; email: string };
  try {
    const [created] = await ctx.db
      .insert(users)
      .values({ name: input.name, email: input.email, passwordHash })
      .returning({ id: users.id, name: users.name, email: users.email });
    if (!created) {
      throw new Error("Falha ao criar usuário.");
    }
    user = created;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw errors.emailAlreadyInUse();
    }
    throw error;
  }

  // Registro não emite AUDIT_AUTH_LOGIN_SUCCEEDED: o conjunto de eventos
  // auditáveis da Phase 9 não inclui criação de conta.
  const { sessionId, refreshToken } = await createSession(ctx, user.id);
  const accessToken = ctx.signAccessToken({ sub: user.id, sid: sessionId });

  return { user, accessToken, refreshToken };
}

export async function loginUser(
  ctx: AuthContext,
  input: LoginInput,
  options: DomainActionOptions = {},
): Promise<AuthResult> {
  const [user] = await ctx.db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  if (!user) {
    // Equaliza timing e retorna o MESMO erro de credenciais inválidas.
    await verifyPassword(await getDummyHash(), input.password);
    throw errors.invalidCredentials();
  }

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) {
    throw errors.invalidCredentials();
  }

  const { sessionId, refreshToken } = await createSession(ctx, user.id, {
    eventType: "AUDIT_AUTH_LOGIN_SUCCEEDED",
    requestId: options.requestId ?? null,
  });
  const accessToken = ctx.signAccessToken({ sub: user.id, sid: sessionId });

  return {
    user: { id: user.id, name: user.name, email: user.email },
    accessToken,
    refreshToken,
  };
}

/**
 * Um token que não é o atual de nenhuma sessão pode ser um token **antigo**
 * desta mesma sessão. Se for, alguém está apresentando uma credencial que já
 * foi trocada — o dono legítimo tem o token novo. Fora da janela de corrida
 * benigna, isso é reuso: a sessão é revogada e o fato auditado. A resposta ao
 * chamador é a mesma genérica de token inválido — não confirmamos nada.
 */
async function handlePossibleReuse(
  ctx: AuthContext,
  presentedHash: string,
  now: Date,
  options: DomainActionOptions,
): Promise<never> {
  const [history] = await ctx.db
    .select({
      sessionId: authRefreshTokenHistory.sessionId,
      rotatedAt: authRefreshTokenHistory.rotatedAt,
      userId: authSessions.userId,
      revokedAt: authSessions.revokedAt,
    })
    .from(authRefreshTokenHistory)
    .innerJoin(authSessions, eq(authSessions.id, authRefreshTokenHistory.sessionId))
    .where(eq(authRefreshTokenHistory.tokenHash, presentedHash))
    .limit(1);

  if (!history) {
    authRefreshTotal.inc({ result: "invalid" });
    throw errors.invalidRefreshToken();
  }

  const withinGrace = now.getTime() - history.rotatedAt.getTime() < REFRESH_REUSE_GRACE_MS;
  if (withinGrace) {
    // Corrida benigna: não punimos, só recusamos este token.
    authRefreshTotal.inc({ result: "invalid" });
    throw errors.invalidRefreshToken();
  }

  refreshReuseDetectedTotal.inc();
  authRefreshTotal.inc({ result: "reuse_detected" });

  if (!history.revokedAt) {
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(authSessions)
        .set({ revokedAt: now, revokedReason: "REFRESH_REUSE", updatedAt: now })
        .where(and(eq(authSessions.id, history.sessionId), isNull(authSessions.revokedAt)));
      // O ator NÃO é confirmado: quem apresentou o token pode ser o atacante.
      await enqueueAudit(tx, "AUDIT_AUTH_REFRESH_REUSE_DETECTED", {
        aggregateType: "SESSION",
        aggregateId: history.sessionId,
        actorUserId: null,
        targetType: "SESSION",
        targetId: history.sessionId,
        outcome: "FAILED",
        requestId: options.requestId ?? null,
      });
    });
    ctx.onSessionRevoked?.(history.sessionId);
  }

  ctx.log?.warn(
    {
      event: "auth_refresh_reuse_detected",
      sessionId: history.sessionId,
      userId: history.userId,
    },
    "Refresh token já rotacionado foi reapresentado; sessão revogada",
  );
  throw errors.invalidRefreshToken();
}

export async function refreshSession(
  ctx: AuthContext,
  rawRefreshToken: string,
  options: DomainActionOptions = {},
): Promise<{ accessToken: string; refreshToken: string }> {
  const currentHash = hashRefreshToken(rawRefreshToken);
  const now = new Date();

  const [session] = await ctx.db
    .select()
    .from(authSessions)
    .where(eq(authSessions.refreshTokenHash, currentHash))
    .limit(1);

  if (!session) {
    return handlePossibleReuse(ctx, currentHash, now, options);
  }
  if (session.revokedAt) {
    authRefreshTotal.inc({ result: "revoked" });
    throw errors.sessionRevoked();
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    authRefreshTotal.inc({ result: "expired" });
    throw errors.sessionExpired();
  }

  const newRefreshToken = generateRefreshToken();
  const newHash = hashRefreshToken(newRefreshToken);
  const expiresAt = refreshExpiry(ctx.refreshTokenTtlDays, now);

  // Compare-and-swap: a rotação só ocorre se o hash atual ainda for válido.
  // Garante uso único do refresh token, mesmo sob concorrência. O hash antigo
  // vai para o histórico NA MESMA transação — ou a rotação e o rastro existem,
  // ou nenhum dos dois.
  const rotated = await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(authSessions)
      .set({
        refreshTokenHash: newHash,
        expiresAt,
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(authSessions.id, session.id),
          eq(authSessions.refreshTokenHash, currentHash),
          isNull(authSessions.revokedAt),
        ),
      )
      .returning({ id: authSessions.id });
    if (updated.length === 0) return false;

    await tx
      .insert(authRefreshTokenHistory)
      .values({ sessionId: session.id, tokenHash: currentHash, rotatedAt: now, expiresAt })
      .onConflictDoNothing({ target: authRefreshTokenHistory.tokenHash });
    return true;
  });

  if (!rotated) {
    // Perdeu a corrida para outro refresh do mesmo token: benigno, sem punição.
    authRefreshTotal.inc({ result: "invalid" });
    throw errors.invalidRefreshToken();
  }

  authRefreshTotal.inc({ result: "success" });
  const accessToken = ctx.signAccessToken({ sub: session.userId, sid: session.id });
  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(
  ctx: AuthContext,
  rawRefreshToken: string,
  options: DomainActionOptions = {},
): Promise<void> {
  const currentHash = hashRefreshToken(rawRefreshToken);
  const now = new Date();
  // Idempotente: revoga a sessão correspondente se ainda estiver ativa.
  const revokedSessionId = await ctx.db.transaction(async (tx) => {
    const revoked = await tx
      .update(authSessions)
      .set({ revokedAt: now, revokedReason: "LOGOUT", updatedAt: now })
      .where(and(eq(authSessions.refreshTokenHash, currentHash), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id, userId: authSessions.userId });

    // Só audita quando havia sessão ativa: logout repetido não polui a trilha.
    const session = revoked[0];
    if (session) {
      await enqueueAudit(tx, "AUDIT_AUTH_LOGOUT", {
        aggregateType: "SESSION",
        aggregateId: session.userId,
        actorUserId: session.userId,
        targetType: "SESSION",
        targetId: session.id,
        requestId: options.requestId ?? null,
      });
    }
    return session?.id ?? null;
  });
  if (revokedSessionId) {
    ctx.onSessionRevoked?.(revokedSessionId);
  }
}

export async function getMe(ctx: AuthContext, userId: string): Promise<PublicUser> {
  const [user] = await ctx.db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw errors.unauthorized();
  }

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}
