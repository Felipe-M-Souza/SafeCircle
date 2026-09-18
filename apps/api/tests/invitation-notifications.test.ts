import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { createGroup } from "./helpers/groups.js";
import { registerActiveDevice } from "./helpers/push.js";
import { drainOutbox, outboxRows } from "./helpers/outbox.js";
import { FakeEmailProvider } from "../src/infrastructure/email/fake-email-provider.js";
import { FakePushProvider } from "../src/infrastructure/push/fake-push-provider.js";
import { INVITATION_NOTIFICATION_TYPE } from "../src/modules/groups/invitation-notifications.service.js";

/**
 * Avisos de convite (Phase 13): quem é convidado passa a ser notificado por
 * push (se já tiver conta e aparelho) e por e-mail, em vez de só descobrir o
 * convite abrindo o app por conta própria.
 *
 * Privacidade: a outbox não guarda endereço nenhum; o handler carrega o e-mail
 * do convite no momento da entrega.
 */
const cleaner = createCleaner();
let app: FastifyInstance;
let push: FakePushProvider;
let email: FakeEmailProvider;
let owner: TestUser;
let groupId: string;

async function invite(actor: TestUser, group: string, address: string) {
  return app.inject({
    method: "POST",
    url: `/groups/${group}/invitations`,
    headers: authHeaders(actor),
    payload: { email: address },
  });
}

beforeAll(async () => {
  push = new FakePushProvider();
  email = new FakeEmailProvider();
  app = await createTestApp({ pushProvider: push, emailProvider: email });
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
  push.reset();
  email.reset();
  owner = await registerUser(app, { name: "Ana Souza" });
  groupId = await createGroup(app, owner, "Família");
});

describe("Convite — aviso por e-mail", () => {
  it("envia e-mail com grupo, primeiro nome de quem convidou e prazo; sem outros dados", async () => {
    const res = await invite(owner, groupId, "convidado@example.com");
    expect(res.statusCode).toBe(201);
    await drainOutbox(app);

    expect(email.messages).toHaveLength(1);
    const message = email.messages[0]!;
    expect(message.to).toBe("convidado@example.com");
    expect(message.subject).toContain("Família");
    expect(message.subject).toContain("Ana");
    expect(message.text).toContain("Convites recebidos");
    expect(message.text).toContain("safecircle://");

    // O único link clicável precisa ser https. Um `<a href="safecircle://">`
    // não leva a lugar nenhum para quem ainda não tem o app — que é justamente
    // quem recebe convite — e faz o e-mail cair em spam.
    expect(message.html ?? "").toContain('<a href="https://');
    expect(message.html ?? "").not.toContain('<a href="safecircle://');

    // Só o primeiro nome de quem convidou; o sobrenome não vai na mensagem.
    expect(message.text).not.toContain("Souza");
    // Nada do destinatário além do endereço, e nenhum segredo.
    expect(message.text).not.toContain(owner.email);
    expect(message.text).not.toContain(owner.accessToken);
    expect(message.html ?? "").not.toContain(owner.email);
  });

  it("a outbox nunca guarda o endereço de e-mail", async () => {
    await invite(owner, groupId, "segredo@example.com");
    const rows = await outboxRows(cleaner.sql);
    const emailEvent = rows.find((row) => row.event_type === "EMAIL_GROUP_INVITATION_CREATED");
    expect(emailEvent).toBeDefined();
    expect(JSON.stringify(rows)).not.toContain("segredo@example.com");
  });

  it("convite revogado antes da entrega não gera e-mail, e o evento não vira DEAD", async () => {
    const created = await invite(owner, groupId, "revogado@example.com");
    const invitationId = created.json().id;
    const revoke = await app.inject({
      method: "DELETE",
      url: `/groups/${groupId}/invitations/${invitationId}`,
      headers: authHeaders(owner),
    });
    expect(revoke.statusCode).toBe(204);

    await drainOutbox(app);
    expect(email.messages).toHaveLength(0);
    const rows = await outboxRows(cleaner.sql);
    expect(rows.filter((row) => row.status === "DEAD")).toHaveLength(0);
    expect(rows.filter((row) => row.status === "PENDING")).toHaveLength(0);
  });

  it("endereço recusado em definitivo marca DEAD; servidor fora do ar mantém para retry", async () => {
    email.queueResult("invalidAddress", "SMTP_PERMANENT");
    await invite(owner, groupId, "inexistente@example.com");
    await drainOutbox(app);
    let rows = await outboxRows(cleaner.sql);
    expect(rows.find((row) => row.event_type === "EMAIL_GROUP_INVITATION_CREATED")?.status).toBe(
      "DEAD",
    );

    await cleaner.truncate();
    owner = await registerUser(app, { name: "Ana Souza" });
    groupId = await createGroup(app, owner, "Família");
    email.reset();
    email.queueResult("failed", "SMTP_TRANSIENT");
    await invite(owner, groupId, "instavel@example.com");
    await drainOutbox(app);
    rows = await outboxRows(cleaner.sql);
    const pending = rows.find((row) => row.event_type === "EMAIL_GROUP_INVITATION_CREATED");
    expect(pending?.status).toBe("PENDING");
    expect(Number(pending?.attempt_count)).toBeGreaterThan(0);
  });
});

describe("Convite — aviso por push", () => {
  it("quem já tem conta e aparelho recebe push com o id do convite", async () => {
    const invited = await registerUser(app, { name: "Bruno" });
    await registerActiveDevice(app, invited);
    push.reset();

    await invite(owner, groupId, invited.email);
    await drainOutbox(app);

    expect(push.messages).toHaveLength(1);
    const message = push.messages[0]!;
    expect(message.data?.type).toBe(INVITATION_NOTIFICATION_TYPE);
    expect(message.data?.groupId).toBe(groupId);
    expect(message.body).toContain("Família");
    // Conteúdo aparece na tela bloqueada: nada de e-mail nem sobrenome.
    expect(message.body).not.toContain(invited.email);
    expect(message.body).not.toContain("Souza");
  });

  it("quem ainda não tem conta não gera push, e isso não é erro", async () => {
    await invite(owner, groupId, "ainda-nao-existe@example.com");
    await drainOutbox(app);

    expect(push.messages).toHaveLength(0);
    const rows = await outboxRows(cleaner.sql);
    expect(rows.filter((row) => row.status === "DEAD")).toHaveLength(0);
    expect(rows.find((row) => row.event_type === "PUSH_GROUP_INVITATION_CREATED")?.status).toBe(
      "PROCESSED",
    );
  });

  it("quem convidou nunca recebe o próprio convite por push", async () => {
    const invited = await registerUser(app, { name: "Bruno" });
    await registerActiveDevice(app, invited);
    await registerActiveDevice(app, owner);
    push.reset();

    await invite(owner, groupId, invited.email);
    await drainOutbox(app);

    expect(push.messages).toHaveLength(1);
    expect(push.messages[0]!.data?.invitationId).toBeDefined();
  });
});

describe("Convite — auditoria", () => {
  it("registra GROUP_INVITATION_CREATED sem o endereço convidado", async () => {
    await invite(owner, groupId, "auditado@example.com");
    await drainOutbox(app);

    const rows = await cleaner.sql<{ event_type: string; actor_user_id: string | null }[]>`
      SELECT event_type, actor_user_id FROM audit_events WHERE event_type = 'GROUP_INVITATION_CREATED'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_user_id).toBe(owner.userId);
    const raw = JSON.stringify(await cleaner.sql`SELECT metadata FROM audit_events`);
    expect(raw).not.toContain("auditado@example.com");
  });
});
