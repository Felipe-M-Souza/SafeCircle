import { describe, expect, inject, it } from "vitest";
import { E2E_PASSWORD, E2eClient, connectWs, uniqueEmail, waitUntil } from "./harness.js";

/**
 * E2E — Autenticação (Phase 12 §25):
 * registro → login → restauração de sessão (refresh) → logout → login de novo;
 * revogar sessão → a sessão perde acesso (REST e WebSocket).
 */
const api = new E2eClient(inject("apiUrl"));

describe("E2E auth", () => {
  it("registro, login, restauração de sessão, logout e login novamente", async () => {
    const email = uniqueEmail("auth");
    const registered = await api.register("Ana E2E", email);
    expect(registered.accessToken).toBeTruthy();

    const login = await api.login(email, E2E_PASSWORD);
    expect(login.status).toBe(200);
    const access1 = login.json.accessToken;
    const refresh1 = login.json.refreshToken;

    const me = await api.call<{ email: string }>("GET", "/me", { token: access1 });
    expect(me.status).toBe(200);
    expect(me.json.email).toBe(email);

    // "Restaurar sessão" ao reabrir o app = refresh do token persistido.
    const restored = await api.call<{ accessToken: string; refreshToken: string }>(
      "POST",
      "/auth/refresh",
      { body: { refreshToken: refresh1 } },
    );
    expect(restored.status).toBe(200);
    expect(restored.json.refreshToken).not.toBe(refresh1);
    expect((await api.call("GET", "/me", { token: restored.json.accessToken })).status).toBe(200);

    // Logout revoga a sessão: o access token morre na hora.
    const logout = await api.call("POST", "/auth/logout", {
      body: { refreshToken: restored.json.refreshToken },
    });
    expect(logout.status).toBe(204);
    expect((await api.call("GET", "/me", { token: restored.json.accessToken })).status).toBe(401);

    const again = await api.login(email, E2E_PASSWORD);
    expect(again.status).toBe(200);
    expect((await api.call("GET", "/me", { token: again.json.accessToken })).status).toBe(200);

    // Senha errada e conta inexistente: mesma resposta, sem enumeração.
    const wrong = await api.login(email, "senha-errada-errada");
    const missing = await api.login(uniqueEmail("nao-existe"), E2E_PASSWORD);
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect((wrong.json as unknown as { code: string }).code).toBe("INVALID_CREDENTIALS");
    expect((missing.json as unknown as { code: string }).code).toBe("INVALID_CREDENTIALS");
  });

  it("revogar uma sessão: ela perde a API e o WebSocket na hora; a outra continua", async () => {
    const user = await api.register("Ana Sessões", uniqueEmail("sessions"));
    const deviceB = await api.login(user.email, E2E_PASSWORD);
    expect(deviceB.status).toBe(200);
    const socketB = await connectWs(api.baseUrl, deviceB.json.accessToken);

    const sessions = await api.call<Array<{ sessionId: string; current: boolean }>>(
      "GET",
      "/me/sessions",
      { token: user.accessToken },
    );
    expect(sessions.status).toBe(200);
    expect(sessions.json).toHaveLength(2);
    const other = sessions.json.find((session) => !session.current)!;

    const revoke = await api.call("DELETE", `/me/sessions/${other.sessionId}`, {
      token: user.accessToken,
    });
    expect(revoke.status).toBe(204);

    const closed = await socketB.waitForClose();
    expect(closed.code).toBe(4403);
    expect((await api.call("GET", "/me", { token: deviceB.json.accessToken })).status).toBe(401);
    const refreshB = await api.call<{ code: string }>("POST", "/auth/refresh", {
      body: { refreshToken: deviceB.json.refreshToken },
    });
    expect(refreshB.status).toBe(401);
    expect(refreshB.json.code).toBe("SESSION_REVOKED");

    // A sessão que revogou segue viva.
    expect((await api.call("GET", "/me", { token: user.accessToken })).status).toBe(200);
    await waitUntil(async () => {
      const list = await api.call<unknown[]>("GET", "/me/sessions", { token: user.accessToken });
      return list.json.length === 1;
    });
  });

  it("reuso de refresh token fora da janela de graça revoga a sessão e fecha o socket", async () => {
    const user = await api.register("Ana Reuso", uniqueEmail("reuse"));
    const socket = await connectWs(api.baseUrl, user.accessToken);
    const rotated = await api.call<{ accessToken: string; refreshToken: string }>(
      "POST",
      "/auth/refresh",
      { body: { refreshToken: user.refreshToken } },
    );
    expect(rotated.status).toBe(200);

    // Envelhece a rotação além da janela de graça (10 s) direto no banco.
    const { default: postgres } = await import("postgres");
    const sql = postgres(inject("databaseUrl"), { max: 1 });
    try {
      await sql`UPDATE auth_refresh_token_history SET rotated_at = now() - interval '1 minute'`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const reuse = await api.call<{ code: string }>("POST", "/auth/refresh", {
      body: { refreshToken: user.refreshToken },
    });
    expect(reuse.status).toBe(401);
    expect(reuse.json.code).toBe("INVALID_REFRESH_TOKEN");

    const closed = await socket.waitForClose();
    expect(closed.code).toBe(4403);
    expect((await api.call("GET", "/me", { token: rotated.json.accessToken })).status).toBe(401);
    const dead = await api.call<{ code: string }>("POST", "/auth/refresh", {
      body: { refreshToken: rotated.json.refreshToken },
    });
    expect(dead.json.code).toBe("SESSION_REVOKED");
  });
});
