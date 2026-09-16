import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup, setRole } from "./helpers/groups.js";
import { drainOutbox } from "./helpers/outbox.js";

/**
 * Transferência de propriedade (Phase 12): pré-requisito para excluir a conta
 * sem desfazer o grupo. Só OWNER transfere; o antigo dono vira ADMIN; o índice
 * de "um OWNER por grupo" continua valendo.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let outsider: TestUser;
let groupId: string;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
  owner = await registerUser(app, { name: "Dona" });
  admin = await registerUser(app, { name: "Admin" });
  member = await registerUser(app, { name: "Membro" });
  outsider = await registerUser(app, { name: "Externo" });
  groupId = await createGroup(app, owner, "Família");
  await addMember(app, owner, groupId, admin);
  await addMember(app, owner, groupId, member);
  await setRole(app, owner, groupId, admin, "ADMIN");
  await drainOutbox(app);
});

const transfer = (actor: TestUser, target: string, group = groupId) =>
  app.inject({
    method: "POST",
    url: `/groups/${group}/transfer-ownership`,
    headers: authHeaders(actor),
    payload: { userId: target },
  });
const roles = async (): Promise<Record<string, string>> => {
  const rows = await cleaner.sql<{ user_id: string; role: string }[]>`
    SELECT user_id, role FROM group_memberships WHERE group_id = ${groupId}
  `;
  return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
};

describe("POST /groups/:groupId/transfer-ownership", () => {
  it("OWNER transfere para MEMBER: alvo vira OWNER, antigo dono vira ADMIN, um só OWNER", async () => {
    const res = await transfer(owner, member.userId);
    expect(res.statusCode).toBe(204);

    const after = await roles();
    expect(after[member.userId]).toBe("OWNER");
    expect(after[owner.userId]).toBe("ADMIN");
    expect(after[admin.userId]).toBe("ADMIN");
    expect(Object.values(after).filter((role) => role === "OWNER")).toHaveLength(1);

    const view = await app.inject({
      method: "GET",
      url: `/groups/${groupId}`,
      headers: authHeaders(member),
    });
    expect(view.json().role).toBe("OWNER");

    await drainOutbox(app);
    const [audit] = await cleaner.sql<
      { actor_user_id: string; target_id: string; metadata: unknown }[]
    >`
      SELECT actor_user_id, target_id, metadata FROM audit_events WHERE event_type = 'GROUP_OWNERSHIP_TRANSFERRED'
    `;
    expect(audit?.actor_user_id).toBe(owner.userId);
    expect(audit?.target_id).toBe(member.userId);
    expect(audit?.metadata).toEqual({ role: "OWNER", previousRole: "MEMBER" });
  });

  it("o antigo dono, agora ADMIN, pode sair do grupo", async () => {
    await transfer(owner, admin.userId);
    const leave = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/members/me`,
      headers: authHeaders(owner),
    });
    expect(leave.statusCode).toBe(204);
    expect((await roles())[owner.userId]).toBeUndefined();
  });

  it("ADMIN e MEMBER não transferem (403); externo recebe 404", async () => {
    expect((await transfer(admin, member.userId)).statusCode).toBe(403);
    expect((await transfer(admin, member.userId)).json().code).toBe("INSUFFICIENT_GROUP_ROLE");
    expect((await transfer(member, admin.userId)).statusCode).toBe(403);
    const external = await transfer(outsider, member.userId);
    expect(external.statusCode).toBe(404);
    expect(external.json().code).toBe("GROUP_NOT_FOUND");
    expect((await roles())[owner.userId]).toBe("OWNER");
  });

  it("alvo inválido: si mesmo (400), não-membro (404), id malformado (400)", async () => {
    const self = await transfer(owner, owner.userId);
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe("OWNERSHIP_TRANSFER_TARGET_INVALID");

    const notMember = await transfer(owner, outsider.userId);
    expect(notMember.statusCode).toBe(404);
    expect(notMember.json().code).toBe("MEMBER_NOT_FOUND");

    const unknown = await transfer(owner, randomUUID());
    expect(unknown.statusCode).toBe(404);

    const malformed = await transfer(owner, "nao-e-uuid");
    expect(malformed.statusCode).toBe(400);
    expect((await roles())[owner.userId]).toBe("OWNER");
  });

  it("grupo inexistente → 404 GROUP_NOT_FOUND", async () => {
    const res = await transfer(owner, member.userId, randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("GROUP_NOT_FOUND");
  });
});
