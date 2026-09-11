import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";

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

describe("Isolamento entre grupos (anti-IDOR)", () => {
  let userA: TestUser;
  let userB: TestUser;
  let groupA: string;
  let memberA: TestUser;

  beforeEach(async () => {
    userA = await registerUser(app);
    userB = await registerUser(app);
    memberA = await registerUser(app);
    groupA = await createGroup(app, userA, "Grupo A");
    await addMember(app, userA, groupA, memberA);
    await createGroup(app, userB, "Grupo B");
  });

  it("User B não consegue ler o Grupo A", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupA}`,
      headers: authHeaders(userB),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("GROUP_NOT_FOUND");
  });

  it("User B não lista membros do Grupo A", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupA}/members`,
      headers: authHeaders(userB),
    });
    expect(res.statusCode).toBe(404);
  });

  it("User B não altera o Grupo A", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${groupA}`,
      headers: authHeaders(userB),
      payload: { name: "Invadido" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("User B não cria convite no Grupo A", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${groupA}/invitations`,
      headers: authHeaders(userB),
      payload: { email: "x@example.com" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("User B não lista convites do Grupo A", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupA}/invitations`,
      headers: authHeaders(userB),
    });
    expect(res.statusCode).toBe(404);
  });

  it("User B não remove membro do Grupo A", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${groupA}/members/${memberA.userId}`,
      headers: authHeaders(userB),
    });
    expect(res.statusCode).toBe(404);
  });

  it("User B não altera role no Grupo A", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${groupA}/members/${memberA.userId}/role`,
      headers: authHeaders(userB),
      payload: { role: "ADMIN" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Não vazamento de dados sensíveis", () => {
  it("respostas de grupos/membros não contêm campos de autenticação", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);

    for (const url of [`/groups`, `/groups/${groupId}`, `/groups/${groupId}/members`]) {
      const res = await app.inject({ method: "GET", url, headers: authHeaders(owner) });
      expect(res.statusCode).toBe(200);
      for (const forbidden of [
        "password",
        "passwordHash",
        "refreshToken",
        "refreshTokenHash",
        "authSessions",
      ]) {
        expect(res.payload).not.toContain(forbidden);
      }
    }
  });
});
