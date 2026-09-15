import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "../helpers/app.js";
import { createCleaner } from "../helpers/test-db.js";
import { authHeaders, registerUser, sessionIdOf, type TestUser } from "../helpers/auth.js";
import { drainOutbox } from "../helpers/outbox.js";
import { MAX_ACTIVE_SESSIONS_PER_USER } from "../../src/modules/auth/sessions.service.js";

/**
 * Sessões (Phase 11): listar só as próprias, revogar a própria (inclusive a
 * atual), nunca a alheia, "sair dos outros aparelhos" e limite por usuário.
 */
const cleaner = createCleaner();
let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
});

interface Session {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

/** Faz login de novo: outra sessão ("outro aparelho") do mesmo usuário. */
async function loginAgain(user: TestUser): Promise<Session> {
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: user.email, password: user.password },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  const sid = JSON.parse(Buffer.from(body.accessToken.split(".")[1], "base64url").toString("utf8"))
    .sid as string;
  return { accessToken: body.accessToken, refreshToken: body.refreshToken, sessionId: sid };
}

const bearer = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });
const listSessions = (accessToken: string) =>
  app.inject({ method: "GET", url: "/me/sessions", headers: bearer(accessToken) });
const revoke = (accessToken: string, sessionId: string) =>
  app.inject({ method: "DELETE", url: `/me/sessions/${sessionId}`, headers: bearer(accessToken) });
const me = (accessToken: string) =>
  app.inject({ method: "GET", url: "/me", headers: bearer(accessToken) });

describe("GET /me/sessions", () => {
  it("lista só as sessões do próprio usuário, marcando a atual, sem nada sensível", async () => {
    const a = await registerUser(app);
    const second = await loginAgain(a);
    const b = await registerUser(app);
    await loginAgain(b);

    const res = await listSessions(a.accessToken);
    expect(res.statusCode).toBe(200);
    const sessions = res.json() as Array<Record<string, unknown>>;
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(
      [sessionIdOf(a), second.sessionId].sort(),
    );
    expect(sessions.find((s) => s.sessionId === sessionIdOf(a))?.current).toBe(true);
    expect(sessions.find((s) => s.sessionId === second.sessionId)?.current).toBe(false);

    for (const session of sessions) {
      expect(Object.keys(session).sort()).toEqual(
        ["createdAt", "current", "expiresAt", "lastUsedAt", "sessionId"].sort(),
      );
    }
    const raw = JSON.stringify(sessions);
    for (const forbidden of ["hash", "token", "ip", "userAgent", "user_agent", b.userId]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("exige autenticação", async () => {
    expect((await app.inject({ method: "GET", url: "/me/sessions" })).statusCode).toBe(401);
  });
});

describe("DELETE /me/sessions/:sessionId", () => {
  it("revoga uma sessão própria: o access token dela morre na hora e ela sai da lista", async () => {
    const a = await registerUser(app);
    const other = await loginAgain(a);
    expect((await me(other.accessToken)).statusCode).toBe(200);

    const res = await revoke(a.accessToken, other.sessionId);
    expect(res.statusCode).toBe(204);

    expect((await me(other.accessToken)).statusCode).toBe(401);
    const list = (await listSessions(a.accessToken)).json() as Array<{ sessionId: string }>;
    expect(list.map((s) => s.sessionId)).toEqual([sessionIdOf(a)]);

    const [row] = await cleaner.sql<{ revoked_reason: string }[]>`
      SELECT revoked_reason FROM auth_sessions WHERE id = ${other.sessionId}
    `;
    expect(row?.revoked_reason).toBe("USER_REVOKED");

    // O refresh token da sessão revogada também não renova mais.
    const refresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      payload: { refreshToken: other.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json().code).toBe("SESSION_REVOKED");

    await drainOutbox(app);
    const [audit] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_events
       WHERE event_type = 'AUTH_SESSION_REVOKED' AND target_id = ${other.sessionId}
    `;
    expect(audit?.count).toBe(1);
  });

  it("revogar a sessão atual é permitido e derruba o próprio token", async () => {
    const a = await registerUser(app);
    const res = await revoke(a.accessToken, sessionIdOf(a));
    expect(res.statusCode).toBe(204);
    expect((await me(a.accessToken)).statusCode).toBe(401);
  });

  it("sessão alheia, inexistente ou id malformado → 404 SESSION_NOT_FOUND, sem efeito", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);

    for (const target of [sessionIdOf(b), randomUUID(), "nao-e-uuid"]) {
      const res = await revoke(a.accessToken, target);
      expect(res.statusCode, target).toBe(404);
      expect(res.json().code, target).toBe("SESSION_NOT_FOUND");
    }
    expect((await me(b.accessToken)).statusCode).toBe(200);
  });

  it("revogar de novo uma sessão própria já encerrada é idempotente (204)", async () => {
    const a = await registerUser(app);
    const other = await loginAgain(a);
    expect((await revoke(a.accessToken, other.sessionId)).statusCode).toBe(204);
    expect((await revoke(a.accessToken, other.sessionId)).statusCode).toBe(204);
  });
});

describe("POST /me/sessions/revoke-others", () => {
  it("encerra todas as outras sessões e mantém a atual", async () => {
    const a = await registerUser(app);
    const s2 = await loginAgain(a);
    const s3 = await loginAgain(a);

    const res = await app.inject({
      method: "POST",
      url: "/me/sessions/revoke-others",
      headers: authHeaders(a),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revokedCount: 2 });

    expect((await me(a.accessToken)).statusCode).toBe(200);
    expect((await me(s2.accessToken)).statusCode).toBe(401);
    expect((await me(s3.accessToken)).statusCode).toBe(401);

    const rows = await cleaner.sql<{ revoked_reason: string | null }[]>`
      SELECT revoked_reason FROM auth_sessions WHERE user_id = ${a.userId} ORDER BY created_at
    `;
    expect(rows.map((r) => r.revoked_reason)).toEqual([
      null,
      "USER_REVOKED_OTHERS",
      "USER_REVOKED_OTHERS",
    ]);

    await drainOutbox(app);
    const [audit] = await cleaner.sql<{ metadata: { revokedCount?: number } }[]>`
      SELECT metadata FROM audit_events WHERE event_type = 'AUTH_OTHER_SESSIONS_REVOKED'
    `;
    expect(audit?.metadata).toEqual({ revokedCount: 2 });
  });

  it("não toca nas sessões de outros usuários", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await loginAgain(a);
    const res = await app.inject({
      method: "POST",
      url: "/me/sessions/revoke-others",
      headers: authHeaders(a),
    });
    expect(res.json()).toEqual({ revokedCount: 1 });
    expect((await me(b.accessToken)).statusCode).toBe(200);
  });
});

describe("Limite de sessões ativas", () => {
  it(`nunca há mais de ${MAX_ACTIVE_SESSIONS_PER_USER} sessões ativas; a mais antiga é revogada`, async () => {
    const a = await registerUser(app);
    const first = sessionIdOf(a);
    const created: Session[] = [];
    for (let i = 0; i < MAX_ACTIVE_SESSIONS_PER_USER + 1; i += 1) {
      created.push(await loginAgain(a));
    }

    const [active] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM auth_sessions
       WHERE user_id = ${a.userId} AND revoked_at IS NULL AND expires_at > now()
    `;
    expect(active?.count).toBe(MAX_ACTIVE_SESSIONS_PER_USER);

    // As duas mais antigas (a do registro e o primeiro login) caíram.
    const [oldest] = await cleaner.sql<{ revoked_reason: string | null }[]>`
      SELECT revoked_reason FROM auth_sessions WHERE id = ${first}
    `;
    expect(oldest?.revoked_reason).toBe("SESSION_LIMIT");
    expect((await me(a.accessToken)).statusCode).toBe(401);
    expect((await me(created[0]!.accessToken)).statusCode).toBe(401);

    // Quem acabou de entrar está com o aparelho na mão: funciona.
    expect((await me(created.at(-1)!.accessToken)).statusCode).toBe(200);
  });
});
