import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { createTestApp } from "./helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup, setRole } from "./helpers/groups.js";

const cleaner = createCleaner();
const sql = postgres(getTestDatabaseUrl(), { max: 1 });
let app: FastifyInstance;

function invite(inviter: TestUser, groupId: string, email: string) {
  return app.inject({
    method: "POST",
    url: `/groups/${groupId}/invitations`,
    headers: authHeaders(inviter),
    payload: { email },
  });
}

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

describe("POST /groups/:groupId/invitations", () => {
  it("OWNER e ADMIN criam convite; MEMBER não", async () => {
    const owner = await registerUser(app);
    const admin = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, admin);
    await addMember(app, owner, groupId, member);
    await setRole(app, owner, groupId, admin, "ADMIN");

    expect((await invite(owner, groupId, "a@example.com")).statusCode).toBe(201);
    expect((await invite(admin, groupId, "b@example.com")).statusCode).toBe(201);
    const byMember = await invite(member, groupId, "c@example.com");
    expect(byMember.statusCode).toBe(403);
    expect(byMember.json().code).toBe("INSUFFICIENT_GROUP_ROLE");
  });

  it("normaliza o e-mail do convite", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const res = await invite(owner, groupId, "  Pessoa@Example.COM ");
    expect(res.statusCode).toBe(201);
    expect(res.json().invitedEmail).toBe("pessoa@example.com");
  });

  it("bloqueia convidar a si mesmo", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const res = await invite(owner, groupId, owner.email);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("CANNOT_INVITE_SELF");
  });

  it("bloqueia convidar membro existente", async () => {
    const owner = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);
    const res = await invite(owner, groupId, member.email);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("ALREADY_GROUP_MEMBER");
  });

  it("bloqueia convite PENDING duplicado", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);
    expect((await invite(owner, groupId, "dup@example.com")).statusCode).toBe(201);
    const second = await invite(owner, groupId, "dup@example.com");
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("INVITATION_ALREADY_PENDING");
  });

  it("permite convidar e-mail sem conta e não revela existência de conta", async () => {
    const owner = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const res = await invite(owner, groupId, "semconta@example.com");
    expect(res.statusCode).toBe(201);
    // resposta não informa se há conta associada
    expect(res.payload).not.toContain("userId");
    expect(res.payload).not.toContain("accountExists");
  });
});

describe("GET /me/group-invitations", () => {
  it("apenas o convidado correto vê o convite", async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const other = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await invite(owner, groupId, invitee.email);

    const mine = await app.inject({
      method: "GET",
      url: "/me/group-invitations",
      headers: authHeaders(invitee),
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toHaveLength(1);
    expect(mine.json()[0].group.name).toBe("Família");

    const others = await app.inject({
      method: "GET",
      url: "/me/group-invitations",
      headers: authHeaders(other),
    });
    expect(others.json()).toHaveLength(0);
  });
});

describe("aceitar / recusar / revogar convite", () => {
  async function pendingInvite(owner: TestUser, groupId: string, invitee: TestUser) {
    const res = await invite(owner, groupId, invitee.email);
    return res.json().id as string;
  }

  it("aceitar cria membership MEMBER e marca ACCEPTED", async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const invitationId = await pendingInvite(owner, groupId, invitee);

    const accept = await app.inject({
      method: "POST",
      url: `/me/group-invitations/${invitationId}/accept`,
      headers: authHeaders(invitee),
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().groupId).toBe(groupId);

    const groups = await app.inject({
      method: "GET",
      url: "/groups",
      headers: authHeaders(invitee),
    });
    expect(groups.json()).toHaveLength(1);
    expect(groups.json()[0].role).toBe("MEMBER");

    const [row] = await sql`SELECT status FROM group_invitations WHERE id = ${invitationId}`;
    expect(row?.status).toBe("ACCEPTED");
  });

  it("aceitar duas vezes não duplica membership", async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const invitationId = await pendingInvite(owner, groupId, invitee);

    await app.inject({
      method: "POST",
      url: `/me/group-invitations/${invitationId}/accept`,
      headers: authHeaders(invitee),
    });
    const second = await app.inject({
      method: "POST",
      url: `/me/group-invitations/${invitationId}/accept`,
      headers: authHeaders(invitee),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("INVITATION_ALREADY_PROCESSED");

    const rows =
      await sql`SELECT count(*)::int AS c FROM group_memberships WHERE group_id = ${groupId} AND user_id = ${invitee.userId}`;
    expect(rows[0]?.c).toBe(1);
  });

  it("convite não é aceito por outro usuário", async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const other = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const invitationId = await pendingInvite(owner, groupId, invitee);

    const res = await app.inject({
      method: "POST",
      url: `/me/group-invitations/${invitationId}/accept`,
      headers: authHeaders(other),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("INVITATION_NOT_FOR_USER");
  });

  it("convite expirado não é aceito", async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const invitationId = await pendingInvite(owner, groupId, invitee);
    await sql`UPDATE group_invitations SET expires_at = now() - interval '1 hour' WHERE id = ${invitationId}`;

    const res = await app.inject({
      method: "POST",
      url: `/me/group-invitations/${invitationId}/accept`,
      headers: authHeaders(invitee),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().code).toBe("INVITATION_EXPIRED");
  });

  it("convite recusado não pode ser aceito depois", async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const groupId = await createGroup(app, owner);
    const invitationId = await pendingInvite(owner, groupId, invitee);

    const reject = await app.inject({
      method: "POST",
      url: `/me/group-invitations/${invitationId}/reject`,
      headers: authHeaders(invitee),
    });
    expect(reject.statusCode).toBe(204);

    const accept = await app.inject({
      method: "POST",
      url: `/me/group-invitations/${invitationId}/accept`,
      headers: authHeaders(invitee),
    });
    expect(accept.statusCode).toBe(409);
    expect(accept.json().code).toBe("INVITATION_ALREADY_PROCESSED");
  });

  it("convite revogado não pode ser aceito; OWNER/ADMIN revogam, MEMBER não", async () => {
    const owner = await registerUser(app);
    const invitee = await registerUser(app);
    const member = await registerUser(app);
    const groupId = await createGroup(app, owner);
    await addMember(app, owner, groupId, member);
    const invitationId = await pendingInvite(owner, groupId, invitee);

    // MEMBER não revoga
    const byMember = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/invitations/${invitationId}`,
      headers: authHeaders(member),
    });
    expect(byMember.statusCode).toBe(403);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/invitations/${invitationId}`,
      headers: authHeaders(owner),
    });
    expect(revoke.statusCode).toBe(204);

    const accept = await app.inject({
      method: "POST",
      url: `/me/group-invitations/${invitationId}/accept`,
      headers: authHeaders(invitee),
    });
    expect(accept.statusCode).toBe(409);
  });
});
