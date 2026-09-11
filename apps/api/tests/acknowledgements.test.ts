import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { SYNTHETIC_LOCATION, createAlert } from "./helpers/alerts.js";
import { connectRealtime, startRealtimeServer } from "./helpers/realtime.js";

const cleaner = createCleaner();
let app: FastifyInstance;
let wsUrl: string;

beforeAll(async () => {
  app = await createTestApp();
  wsUrl = await startRealtimeServer(app);
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
});

function put(user: TestUser, alertId: string, type: unknown) {
  return app.inject({
    method: "PUT",
    url: `/alerts/${alertId}/acknowledgement`,
    headers: authHeaders(user),
    payload: { type },
  });
}

function list(user: TestUser, alertId: string) {
  return app.inject({
    method: "GET",
    url: `/alerts/${alertId}/acknowledgements`,
    headers: authHeaders(user),
  });
}

async function countRows(alertId: string): Promise<number> {
  const [row] = await cleaner.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM alert_acknowledgements WHERE alert_id = ${alertId}
  `;
  return row?.count ?? 0;
}

describe("Acknowledgements de alerta", () => {
  let creator: TestUser;
  let maria: TestUser;
  let joao: TestUser;
  let outsider: TestUser;
  let groupId: string;
  let alertId: string;

  beforeEach(async () => {
    creator = await registerUser(app, { name: "Felipe" });
    maria = await registerUser(app, { name: "Maria" });
    joao = await registerUser(app, { name: "João" });
    outsider = await registerUser(app);
    groupId = await createGroup(app, creator, "Família");
    await addMember(app, creator, groupId, maria);
    await addMember(app, creator, groupId, joao);
    await createGroup(app, outsider, "Outro");
    alertId = (await createAlert(app, creator, groupId, SYNTHETIC_LOCATION)).id;
  });

  it("membro cria e atualiza o próprio acknowledgement (uma linha por usuário)", async () => {
    const created = await put(maria, alertId, "SEEN");
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      user: { id: maria.userId, name: "Maria" },
      type: "SEEN",
    });
    expect(typeof created.json().updatedAt).toBe("string");

    const updated = await put(maria, alertId, "GOING_TO_HELP");
    expect(updated.statusCode).toBe(200);
    expect(updated.json().type).toBe("GOING_TO_HELP");
    expect(await countRows(alertId)).toBe(1);
  });

  it("qualquer estado explícito substitui outro; SEEN nunca rebaixa um estado existente", async () => {
    await put(maria, alertId, "GOING_TO_HELP");
    const seen = await put(maria, alertId, "SEEN");
    expect(seen.statusCode).toBe(200);
    expect(seen.json().type).toBe("GOING_TO_HELP");

    const contacted = await put(maria, alertId, "EMERGENCY_SERVICES_CONTACTED");
    expect(contacted.json().type).toBe("EMERGENCY_SERVICES_CONTACTED");
    const back = await put(maria, alertId, "ACKNOWLEDGED");
    expect(back.json().type).toBe("ACKNOWLEDGED");
    expect(await countRows(alertId)).toBe(1);
  });

  it("autoria vem do token, nunca do body", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/alerts/${alertId}/acknowledgement`,
      headers: authHeaders(maria),
      payload: { type: "SEEN", userId: joao.userId, user: { id: joao.userId } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(maria.userId);
    const rows = await cleaner.sql<{ user_id: string }[]>`
      SELECT user_id FROM alert_acknowledgements WHERE alert_id = ${alertId}
    `;
    expect(rows.map((r) => r.user_id)).toEqual([maria.userId]);
  });

  it("tipo inválido → 400 VALIDATION_ERROR", async () => {
    const res = await put(maria, alertId, "VI");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(await countRows(alertId)).toBe(0);
  });

  it("criador não registra acknowledgement (403 FORBIDDEN)", async () => {
    const res = await put(creator, alertId, "ACKNOWLEDGED");
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
    expect(await countRows(alertId)).toBe(0);
  });

  it("externo não registra nem lê (404 ALERT_NOT_FOUND, anti-IDOR)", async () => {
    const write = await put(outsider, alertId, "SEEN");
    expect(write.statusCode).toBe(404);
    expect(write.json().code).toBe("ALERT_NOT_FOUND");

    const read = await list(outsider, alertId);
    expect(read.statusCode).toBe(404);
    expect(read.json().code).toBe("ALERT_NOT_FOUND");

    const missing = await list(outsider, "00000000-0000-4000-8000-000000000000");
    expect(missing.json()).toEqual(read.json());
  });

  it("alerta encerrado não aceita alteração (409 ALERT_NOT_ACTIVE), mas continua legível", async () => {
    await put(maria, alertId, "GOING_TO_HELP");
    await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/resolve`,
      headers: authHeaders(creator),
    });

    const res = await put(joao, alertId, "SEEN");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("ALERT_NOT_ACTIVE");

    const read = await list(joao, alertId);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toHaveLength(1);
    expect(read.json()[0]).toMatchObject({ user: { name: "Maria" }, type: "GOING_TO_HELP" });
  });

  it("GET lista apenas dados seguros (id, nome, tipo, updatedAt)", async () => {
    await put(maria, alertId, "GOING_TO_HELP");
    await put(joao, alertId, "SEEN");

    const res = await list(creator, alertId);
    expect(res.statusCode).toBe(200);
    const body = res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    for (const item of body) {
      expect(Object.keys(item).sort()).toEqual(["type", "updatedAt", "user"]);
      expect(Object.keys(item.user as object).sort()).toEqual(["id", "name"]);
    }
    for (const forbidden of ["email", "password", "refreshToken", "PushToken", maria.email]) {
      expect(res.payload).not.toContain(forbidden);
    }
  });

  it("id inválido e não autenticado", async () => {
    const bad = await list(maria, "nao-uuid");
    expect(bad.statusCode).toBe(404);
    expect(bad.json().code).toBe("ALERT_NOT_FOUND");

    const unauth = await app.inject({
      method: "PUT",
      url: `/alerts/${alertId}/acknowledgement`,
      payload: { type: "SEEN" },
    });
    expect(unauth.statusCode).toBe(401);
  });

  it("updates concorrentes mantêm uma única linha", async () => {
    const responses = await Promise.all(
      ["SEEN", "ACKNOWLEDGED", "GOING_TO_HELP", "SEEN", "EMERGENCY_SERVICES_CONTACTED"].map(
        (type) => put(maria, alertId, type),
      ),
    );
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }
    expect(await countRows(alertId)).toBe(1);
    await expect(
      cleaner.sql`
        INSERT INTO alert_acknowledgements (alert_id, user_id, type)
        VALUES (${alertId}, ${maria.userId}, 'SEEN')
      `,
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("mudança publica ALERT_ACKNOWLEDGEMENT_CHANGED; auto-SEEN sem mudança não publica", async () => {
    const client = await connectRealtime(wsUrl, creator.accessToken);
    try {
      await put(maria, alertId, "GOING_TO_HELP");
      const event = await client.waitForEvent((e) => e.type === "ALERT_ACKNOWLEDGEMENT_CHANGED");
      expect(event.data).toEqual({ alertId, groupId, userId: maria.userId });

      // SEEN não rebaixa e, sem mudança, não publica; repetir o mesmo tipo tampouco.
      await put(maria, alertId, "SEEN");
      await put(maria, alertId, "GOING_TO_HELP");
      await app.background.flush();
      await client.expectNoEvent(
        (e) => e.type === "ALERT_ACKNOWLEDGEMENT_CHANGED" && e.eventId !== event.eventId,
      );
    } finally {
      await client.close();
    }
  });
});
