import { describe, expect, inject, it } from "vitest";
import { E2eClient, connectWs, uniqueEmail } from "./harness.js";

/**
 * E2E — Grupos (Phase 12 §26): A cria, convida B, B aceita, B aparece como
 * MEMBER; promoção a ADMIN; transferência de propriedade; anti-IDOR.
 */
const api = new E2eClient(inject("apiUrl"));

describe("E2E grupos", () => {
  it("criar grupo, convidar, aceitar, promover e transferir a propriedade", async () => {
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const bruno = await api.register("Bruno", uniqueEmail("bruno"));
    const socketBruno = await connectWs(api.baseUrl, bruno.accessToken);

    const group = await api.call<{ id: string; role: string; memberCount: number }>(
      "POST",
      "/groups",
      { token: ana.accessToken, body: { name: "Família E2E" } },
    );
    expect(group.status).toBe(201);
    expect(group.json.role).toBe("OWNER");
    const groupId = group.json.id;

    const invitation = await api.call<{ id: string; status: string }>(
      "POST",
      `/groups/${groupId}/invitations`,
      { token: ana.accessToken, body: { email: bruno.email } },
    );
    expect(invitation.status).toBe(201);

    const mine = await api.call<Array<{ id: string; group: { name: string } }>>(
      "GET",
      "/me/group-invitations",
      { token: bruno.accessToken },
    );
    expect(mine.json.map((i) => i.id)).toContain(invitation.json.id);
    expect(mine.json[0]?.group.name).toBe("Família E2E");

    const accept = await api.call("POST", `/me/group-invitations/${invitation.json.id}/accept`, {
      token: bruno.accessToken,
    });
    expect(accept.status).toBe(200);
    // Bruno recebe o evento de membership pelo realtime.
    await socketBruno.waitFor((event) => event.type === "GROUP_MEMBERSHIP_CHANGED");

    const members = await api.call<Array<{ id: string; role: string }>>(
      "GET",
      `/groups/${groupId}/members`,
      { token: ana.accessToken },
    );
    expect(members.json.find((m) => m.id === bruno.id)?.role).toBe("MEMBER");

    // Promoção a ADMIN (opcional na spec; estável aqui).
    const promote = await api.call<{ role: string }>(
      "PATCH",
      `/groups/${groupId}/members/${bruno.id}/role`,
      { token: ana.accessToken, body: { role: "ADMIN" } },
    );
    expect(promote.status).toBe(200);
    expect(promote.json.role).toBe("ADMIN");

    // Transferência de propriedade (Phase 12): Bruno vira OWNER, Ana vira ADMIN.
    const transfer = await api.call("POST", `/groups/${groupId}/transfer-ownership`, {
      token: ana.accessToken,
      body: { userId: bruno.id },
    });
    expect(transfer.status).toBe(204);
    const asBruno = await api.call<{ role: string }>("GET", `/groups/${groupId}`, {
      token: bruno.accessToken,
    });
    expect(asBruno.json.role).toBe("OWNER");
    const asAna = await api.call<{ role: string }>("GET", `/groups/${groupId}`, {
      token: ana.accessToken,
    });
    expect(asAna.json.role).toBe("ADMIN");
    await socketBruno.close();
  });

  it("quem não é membro recebe 404 e a listagem não vaza o grupo", async () => {
    const ana = await api.register("Ana", uniqueEmail("ana"));
    const externo = await api.register("Externo", uniqueEmail("externo"));
    const groupId = await api.createGroupWith(ana, "Privado");

    const read = await api.call<{ code: string }>("GET", `/groups/${groupId}`, {
      token: externo.accessToken,
    });
    expect(read.status).toBe(404);
    expect(read.json.code).toBe("GROUP_NOT_FOUND");
    const list = await api.call<Array<{ id: string }>>("GET", "/groups", {
      token: externo.accessToken,
    });
    expect(list.json.map((g) => g.id)).not.toContain(groupId);
  });
});
