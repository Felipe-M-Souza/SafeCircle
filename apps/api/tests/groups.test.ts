import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";

const cleaner = createCleaner();
let app: FastifyInstance;

async function createGroup(user: TestUser, name = "Família") {
  return app.inject({
    method: "POST",
    url: "/groups",
    headers: authHeaders(user),
    payload: { name },
  });
}

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

describe("POST /groups", () => {
  it("cria grupo e torna o criador OWNER (201)", async () => {
    const owner = await registerUser(app);
    const res = await createGroup(owner);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ name: "Família", role: "OWNER", memberCount: 1 });
    expect(typeof body.id).toBe("string");
  });

  it("exige autenticação (401)", async () => {
    const res = await app.inject({ method: "POST", url: "/groups", payload: { name: "X" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejeita nome inválido (400)", async () => {
    const owner = await registerUser(app);
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeaders(owner),
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("permite grupos com o mesmo nome para usuários diferentes", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    expect((await createGroup(a, "Família")).statusCode).toBe(201);
    expect((await createGroup(b, "Família")).statusCode).toBe(201);
  });
});

describe("GET /groups", () => {
  it("retorna apenas grupos onde o usuário é membro", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await createGroup(a, "Família");
    await createGroup(b, "Vizinhos");

    const res = await app.inject({ method: "GET", url: "/groups", headers: authHeaders(a) });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Família", role: "OWNER", memberCount: 1 });
  });
});

describe("GET /groups/:groupId", () => {
  it("membro visualiza o grupo", async () => {
    const owner = await registerUser(app);
    const groupId = (await createGroup(owner)).json().id;
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}`,
      headers: authHeaders(owner),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: groupId, role: "OWNER" });
  });

  it("usuário externo recebe 404 GROUP_NOT_FOUND (anti-IDOR)", async () => {
    const owner = await registerUser(app);
    const outsider = await registerUser(app);
    const groupId = (await createGroup(owner)).json().id;
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}`,
      headers: authHeaders(outsider),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("GROUP_NOT_FOUND");
  });
});

describe("PATCH /groups/:groupId", () => {
  it("OWNER renomeia; ADMIN renomeia; MEMBER não pode", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const member = await registerUser(app);
    const groupId = (await createGroup(owner).then((r) => r.json())).id;

    // adiciona admin e member via convite+aceite
    const invite = async (u: TestUser) => {
      const inv = await app.inject({
        method: "POST",
        url: `/groups/${groupId}/invitations`,
        headers: authHeaders(owner),
        payload: { email: u.email },
      });
      const id = inv.json().id;
      await app.inject({
        method: "POST",
        url: `/me/group-invitations/${id}/accept`,
        headers: authHeaders(u),
      });
    };
    await invite(admin);
    await invite(member);
    // promove admin
    await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}/members/${admin.userId}/role`,
      headers: authHeaders(owner),
      payload: { role: "ADMIN" },
    });

    const ownerRename = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}`,
      headers: authHeaders(owner),
      payload: { name: "Família e vizinhos" },
    });
    expect(ownerRename.statusCode).toBe(200);
    expect(ownerRename.json().name).toBe("Família e vizinhos");

    const adminRename = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}`,
      headers: authHeaders(admin),
      payload: { name: "Renomeado pelo admin" },
    });
    expect(adminRename.statusCode).toBe(200);

    const memberRename = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}`,
      headers: authHeaders(member),
      payload: { name: "Não permitido" },
    });
    expect(memberRename.statusCode).toBe(403);
    expect(memberRename.json().code).toBe("INSUFFICIENT_GROUP_ROLE");
  });
});
