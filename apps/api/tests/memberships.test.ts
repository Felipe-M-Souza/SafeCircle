import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { createTestApp } from "./helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "./helpers/test-db.js";
import { authHeaders, registerUser } from "./helpers/auth.js";
import { addMember, createGroup, setRole } from "./helpers/groups.js";

const cleaner = createCleaner();
const sql = postgres(getTestDatabaseUrl(), { max: 1 });
let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
  await sql.end({ timeout: 5 });
});
beforeEach(async () => {
  await cleaner.truncate();
});

describe("GET /groups/:groupId/members", () => {
  it("lista membros sem expor e-mail nem dados de autenticação", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}/members`,
      headers: authHeaders(owner),
    });
    expect(res.statusCode).toBe(200);
    const members = res.json();
    expect(members).toHaveLength(2);
    expect(members[0]).toHaveProperty("role");
    expect(members[0]).toHaveProperty("joinedAt");
    expect(res.payload).not.toContain("@example.com");
    expect(res.payload).not.toContain("passwordHash");
    expect(res.payload).not.toContain("refreshToken");
  });
});

describe("constraints de membership", () => {
  it("garante unicidade (group, user)", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await expect(
      sql`INSERT INTO group_memberships (group_id, user_id, role) VALUES (${groupId}, ${owner.userId}, 'MEMBER')`,
    ).rejects.toThrow();
  });

  it("garante apenas um OWNER por grupo", async () => {
    const owner = await registerUser(app);
    const other = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await expect(
      sql`INSERT INTO group_memberships (group_id, user_id, role) VALUES (${groupId}, ${other.userId}, 'OWNER')`,
    ).rejects.toThrow();
  });
});

describe("DELETE /groups/:groupId/members/me (sair)", () => {
  it("MEMBER pode sair", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);
    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/members/me`,
      headers: authHeaders(member),
    });
    expect(res.statusCode).toBe(204);
  });

  it("ADMIN pode sair", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, admin);
    await setRole(app, owner, groupId, admin, "ADMIN");
    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/members/me`,
      headers: authHeaders(admin),
    });
    expect(res.statusCode).toBe(204);
  });

  it("OWNER não pode sair", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/members/me`,
      headers: authHeaders(owner),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("OWNER_CANNOT_LEAVE_GROUP");
  });
});

describe("DELETE /groups/:groupId/members/:userId (remover)", () => {
  it("OWNER remove MEMBER e ADMIN", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, admin);
    await addMember(app, owner, groupId, member);
    await setRole(app, owner, groupId, admin, "ADMIN");

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/groups/${groupId}/members/${member.userId}`,
          headers: authHeaders(owner),
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/groups/${groupId}/members/${admin.userId}`,
          headers: authHeaders(owner),
        })
      ).statusCode,
    ).toBe(204);
  });

  it("ADMIN remove MEMBER mas não outro ADMIN nem OWNER", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const admin2 = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    for (const u of [admin, admin2, member]) await addMember(app, owner, groupId, u);
    await setRole(app, owner, groupId, admin, "ADMIN");
    await setRole(app, owner, groupId, admin2, "ADMIN");

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/groups/${groupId}/members/${member.userId}`,
          headers: authHeaders(admin),
        })
      ).statusCode,
    ).toBe(204);

    const removeAdmin = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/members/${admin2.userId}`,
      headers: authHeaders(admin),
    });
    expect(removeAdmin.statusCode).toBe(403);

    const removeOwner = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/members/${owner.userId}`,
      headers: authHeaders(admin),
    });
    expect(removeOwner.statusCode).toBe(403);
    expect(removeOwner.json().code).toBe("CANNOT_REMOVE_OWNER");
  });

  it("MEMBER não remove ninguém", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const other = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);
    await addMember(app, owner, groupId, other);
    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/members/${other.userId}`,
      headers: authHeaders(member),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PATCH /groups/:groupId/members/:userId/role", () => {
  it("OWNER promove MEMBER e rebaixa ADMIN", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);

    const promote = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}/members/${member.userId}/role`,
      headers: authHeaders(owner),
      payload: { role: "ADMIN" },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().role).toBe("ADMIN");

    const demote = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}/members/${member.userId}/role`,
      headers: authHeaders(owner),
      payload: { role: "MEMBER" },
    });
    expect(demote.statusCode).toBe(200);
    expect(demote.json().role).toBe("MEMBER");
  });

  it("ADMIN não altera roles", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, admin);
    await addMember(app, owner, groupId, member);
    await setRole(app, owner, groupId, admin, "ADMIN");

    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}/members/${member.userId}/role`,
      headers: authHeaders(admin),
      payload: { role: "ADMIN" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("não permite alterar o papel do OWNER", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);
    // tentar rebaixar o OWNER
    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${groupId}/members/${owner.userId}/role`,
      headers: authHeaders(owner),
      payload: { role: "MEMBER" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_GROUP_ROLE");
  });
});
