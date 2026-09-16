import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, inject, it } from "vitest";
import {
  E2E_PASSWORD,
  E2eClient,
  SYNTHETIC_POINT,
  connectWs,
  uniqueEmail,
  waitUntil,
} from "./harness.js";

/**
 * E2E — Privacidade (Phase 12 §32–33): exportação dos próprios dados e
 * exclusão de conta ponta a ponta (sem bloqueios → reauth → delete → sessão
 * encerrada → login falha → dados removidos), mais o cenário bloqueado por
 * propriedade de grupo e o desbloqueio via transferência.
 */
const api = new E2eClient(inject("apiUrl"));
const sql = postgres(inject("databaseUrl"), { max: 1 });

const count = async (table: string, column: string, value: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM ${sql(table)} WHERE ${sql(column)} = ${value}
  `;
  return row?.count ?? 0;
};

describe("E2E privacidade", () => {
  it("exportação contém A, não contém segredos nem dados privados de B", async () => {
    const ana = await api.register("Ana Export", uniqueEmail("ana"));
    const bruno = await api.register("Bruno Privado", uniqueEmail("bruno"));
    const groupId = await api.createGroupWith(ana, "Família", [bruno]);
    const alertAna = await api.call<{ id: string }>("POST", "/alerts", {
      token: ana.accessToken,
      body: { groupId, location: SYNTHETIC_POINT },
      idempotencyKey: randomUUID(),
    });
    await api.call("POST", `/alerts/${alertAna.json.id}/resolve`, { token: ana.accessToken });
    const alertBruno = await api.call<{ id: string }>("POST", "/alerts", {
      token: bruno.accessToken,
      body: { groupId, location: { latitude: -11.75, longitude: -31.5, accuracy: 9 } },
      idempotencyKey: randomUUID(),
    });
    await api.call("POST", `/alerts/${alertBruno.json.id}/resolve`, { token: bruno.accessToken });

    const exported = await api.call<Record<string, unknown>>("GET", "/me/privacy/export", {
      token: ana.accessToken,
    });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("cache-control")).toBe("no-store");
    const raw = JSON.stringify(exported.json);
    expect((exported.json.profile as { email: string }).email).toBe(ana.email);
    expect(raw).toContain(alertAna.json.id);
    expect(raw).toContain(String(SYNTHETIC_POINT.latitude));
    for (const forbidden of [
      alertBruno.json.id,
      bruno.email,
      "Bruno Privado",
      "-11.75",
      "passwordHash",
      "refreshToken",
      "tokenHash",
      ana.refreshToken,
      ana.accessToken,
      "outbox",
      "audit",
    ]) {
      expect(raw, forbidden).not.toContain(forbidden);
    }
  });

  it("exclusão bloqueada por propriedade; transferir a propriedade desbloqueia", async () => {
    const ana = await api.register("Ana Dona", uniqueEmail("ana"));
    const bruno = await api.register("Bruno Herdeiro", uniqueEmail("bruno"));
    const groupId = await api.createGroupWith(ana, "Família", [bruno]);

    const preview = await api.call<{
      canDelete: boolean;
      blockers: { groupsWithOtherMembers: unknown[] };
    }>("GET", "/me/account-deletion", { token: ana.accessToken });
    expect(preview.json.canDelete).toBe(false);
    expect(preview.json.blockers.groupsWithOtherMembers).toHaveLength(1);

    const blocked = await api.call<{ code: string }>("POST", "/me/delete-account", {
      token: ana.accessToken,
      body: { password: E2E_PASSWORD },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("ACCOUNT_DELETION_BLOCKED_BY_GROUP_OWNERSHIP");
    expect(await count("users", "id", ana.id)).toBe(1);

    const transfer = await api.call("POST", `/groups/${groupId}/transfer-ownership`, {
      token: ana.accessToken,
      body: { userId: bruno.id },
    });
    expect(transfer.status).toBe(204);

    const deleted = await api.call("POST", "/me/delete-account", {
      token: ana.accessToken,
      body: { password: E2E_PASSWORD },
    });
    expect(deleted.status).toBe(204);
    const group = await api.call<{ role: string; memberCount: number }>(
      "GET",
      `/groups/${groupId}`,
      {
        token: bruno.accessToken,
      },
    );
    expect(group.json.role).toBe("OWNER");
    expect(group.json.memberCount).toBe(1);
  });

  it("exclusão completa: reauth, sessão encerrada, socket fechado, login falha, dados removidos", async () => {
    const ana = await api.register("Ana Sai", uniqueEmail("ana"));
    const groupId = await api.createGroupWith(ana, "Só eu");
    const alert = await api.call<{ id: string }>("POST", "/alerts", {
      token: ana.accessToken,
      body: { groupId, location: SYNTHETIC_POINT },
      idempotencyKey: randomUUID(),
    });
    await api.call("POST", `/alerts/${alert.json.id}/resolve`, { token: ana.accessToken });
    await api.call("POST", "/me/push-devices", {
      token: ana.accessToken,
      body: {
        token: `ExponentPushToken[e2e${randomUUID().replace(/-/g, "")}]`,
        platform: "ANDROID",
        deviceId: randomUUID(),
      },
    });
    const socket = await connectWs(api.baseUrl, ana.accessToken);

    // Senha errada primeiro: nada acontece.
    const wrong = await api.call<{ code: string }>("POST", "/me/delete-account", {
      token: ana.accessToken,
      body: { password: "senha-errada-errada" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.json.code).toBe("INVALID_CREDENTIALS");
    expect(await count("users", "id", ana.id)).toBe(1);

    const deleted = await api.call("POST", "/me/delete-account", {
      token: ana.accessToken,
      body: { password: E2E_PASSWORD },
    });
    expect(deleted.status).toBe(204);

    const closed = await socket.waitForClose();
    expect(closed.code).toBe(4403);
    expect((await api.call("GET", "/me", { token: ana.accessToken })).status).toBe(401);
    const login = await api.login(ana.email, E2E_PASSWORD);
    expect(login.status).toBe(401);

    expect(await count("users", "id", ana.id)).toBe(0);
    expect(await count("auth_sessions", "user_id", ana.id)).toBe(0);
    expect(await count("push_devices", "user_id", ana.id)).toBe(0);
    expect(await count("trusted_groups", "id", groupId)).toBe(0);
    expect(await count("emergency_alerts", "id", alert.json.id)).toBe(0);
    expect(await count("alert_locations", "alert_id", alert.json.id)).toBe(0);

    // A trilha registra o pedido e a conclusão, sem apontar para a pessoa.
    await waitUntil(async () => {
      const rows = await sql<{ actor_user_id: string | null }[]>`
        SELECT actor_user_id FROM audit_events
         WHERE target_id = ${ana.id} AND event_type IN ('ACCOUNT_DELETION_REQUESTED', 'ACCOUNT_DELETION_COMPLETED')
      `;
      return rows.length === 2 && rows.every((row) => row.actor_user_id === null);
    });
    // Nada ficou pendente nem morreu na outbox por causa da exclusão.
    await waitUntil(async () => {
      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM outbox_events
         WHERE status IN ('PENDING', 'PROCESSING') AND aggregate_id = ${ana.id}
      `;
      return (row?.count ?? 0) === 0;
    });
    const [dead] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM outbox_events WHERE status = 'DEAD'
    `;
    expect(dead?.count).toBe(0);
  });
});
