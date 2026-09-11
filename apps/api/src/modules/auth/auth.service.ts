import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../../infrastructure/database/client.js";
import { authSessions, users } from "../../infrastructure/database/schema.js";
import { errors } from "../../shared/errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import { generateRefreshToken, hashRefreshToken, type AccessTokenClaims } from "./tokens.js";
import type { LoginInput, RegisterInput } from "./auth.schemas.js";

export interface AuthContext {
  db: Database;
  refreshTokenTtlDays: number;
  signAccessToken: (claims: AccessTokenClaims) => string;
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

function refreshExpiry(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function createSession(
  ctx: AuthContext,
  userId: string,
): Promise<{ sessionId: string; refreshToken: string }> {
  const refreshToken = generateRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const [session] = await ctx.db
    .insert(authSessions)
    .values({
      userId,
      refreshTokenHash,
      expiresAt: refreshExpiry(ctx.refreshTokenTtlDays),
    })
    .returning({ id: authSessions.id });

  if (!session) {
    throw new Error("Falha ao criar sessão de autenticação.");
  }

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

  const { sessionId, refreshToken } = await createSession(ctx, user.id);
  const accessToken = ctx.signAccessToken({ sub: user.id, sid: sessionId });

  return { user, accessToken, refreshToken };
}

export async function loginUser(ctx: AuthContext, input: LoginInput): Promise<AuthResult> {
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

  const { sessionId, refreshToken } = await createSession(ctx, user.id);
  const accessToken = ctx.signAccessToken({ sub: user.id, sid: sessionId });

  return {
    user: { id: user.id, name: user.name, email: user.email },
    accessToken,
    refreshToken,
  };
}

export async function refreshSession(
  ctx: AuthContext,
  rawRefreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const currentHash = hashRefreshToken(rawRefreshToken);

  const [session] = await ctx.db
    .select()
    .from(authSessions)
    .where(eq(authSessions.refreshTokenHash, currentHash))
    .limit(1);

  if (!session) {
    throw errors.invalidRefreshToken();
  }
  if (session.revokedAt) {
    throw errors.sessionRevoked();
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw errors.sessionExpired();
  }

  const newRefreshToken = generateRefreshToken();
  const newHash = hashRefreshToken(newRefreshToken);

  // Compare-and-swap: a rotação só ocorre se o hash atual ainda for válido.
  // Garante uso único do refresh token, mesmo sob concorrência.
  const rotated = await ctx.db
    .update(authSessions)
    .set({
      refreshTokenHash: newHash,
      expiresAt: refreshExpiry(ctx.refreshTokenTtlDays),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(authSessions.id, session.id),
        eq(authSessions.refreshTokenHash, currentHash),
        isNull(authSessions.revokedAt),
      ),
    )
    .returning({ id: authSessions.id });

  if (rotated.length === 0) {
    throw errors.invalidRefreshToken();
  }

  const accessToken = ctx.signAccessToken({ sub: session.userId, sid: session.id });
  return { accessToken, refreshToken: newRefreshToken };
}

export async function logout(ctx: AuthContext, rawRefreshToken: string): Promise<void> {
  const currentHash = hashRefreshToken(rawRefreshToken);
  // Idempotente: revoga a sessão correspondente se ainda estiver ativa.
  await ctx.db
    .update(authSessions)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(authSessions.refreshTokenHash, currentHash), isNull(authSessions.revokedAt)));
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
