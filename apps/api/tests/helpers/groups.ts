import type { FastifyInstance } from "fastify";
import { authHeaders, type TestUser } from "./auth.js";

export async function createGroup(
  app: FastifyInstance,
  owner: TestUser,
  name = "Família",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/groups",
    headers: authHeaders(owner),
    payload: { name },
  });
  if (res.statusCode !== 201) {
    throw new Error(`Falha ao criar grupo: ${res.statusCode} ${res.payload}`);
  }
  return res.json().id;
}

/** Convida e aceita, tornando `user` MEMBER do grupo. */
export async function addMember(
  app: FastifyInstance,
  inviter: TestUser,
  groupId: string,
  user: TestUser,
): Promise<void> {
  const inv = await app.inject({
    method: "POST",
    url: `/groups/${groupId}/invitations`,
    headers: authHeaders(inviter),
    payload: { email: user.email },
  });
  if (inv.statusCode !== 201) {
    throw new Error(`Falha ao convidar: ${inv.statusCode} ${inv.payload}`);
  }
  const invitationId = inv.json().id;
  const accept = await app.inject({
    method: "POST",
    url: `/me/group-invitations/${invitationId}/accept`,
    headers: authHeaders(user),
  });
  if (accept.statusCode !== 200) {
    throw new Error(`Falha ao aceitar convite: ${accept.statusCode} ${accept.payload}`);
  }
}

/** Owner promove/rebaixa um membro. */
export async function setRole(
  app: FastifyInstance,
  owner: TestUser,
  groupId: string,
  target: TestUser,
  role: "ADMIN" | "MEMBER",
): Promise<void> {
  const res = await app.inject({
    method: "PATCH",
    url: `/groups/${groupId}/members/${target.userId}/role`,
    headers: authHeaders(owner),
    payload: { role },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Falha ao alterar role: ${res.statusCode} ${res.payload}`);
  }
}
