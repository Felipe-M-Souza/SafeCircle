import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import { addMember, createGroup } from "./helpers/groups.js";
import { SYNTHETIC_LOCATION, newIdempotencyKey, postAlert } from "./helpers/alerts.js";
import { registerActiveDevice } from "./helpers/push.js";
import { FakePushProvider } from "../src/infrastructure/push/fake-push-provider.js";
import {
  ALERT_NOTIFICATION_BODY,
  ALERT_NOTIFICATION_CHANNEL,
  ALERT_NOTIFICATION_TITLE,
} from "../src/modules/notifications/alert-notifications.service.js";

const cleaner = createCleaner();
const push = new FakePushProvider();
let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp({ pushProvider: push });
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
  push.reset();
});

/** Cria o alerta e aguarda o processamento em segundo plano do push. */
async function createAlertAndFlush(user: TestUser, groupId: string, location?: unknown) {
  const res = await postAlert(
    app,
    user,
    location === undefined ? { groupId } : { groupId, location },
  );
  await app.background.flush();
  return res;
}

async function isActive(token: string): Promise<boolean> {
  const [row] = await cleaner.sql<{ is_active: boolean }[]>`
    SELECT is_active FROM push_devices WHERE token = ${token}
  `;
  return row?.is_active ?? false;
}

describe("Push ao criar alerta — destinatários", () => {
  let creator: TestUser;
  let memberA: TestUser;
  let memberB: TestUser;
  let outsider: TestUser;
  let groupId: string;
  let tokens: { creator: string; a1: string; a2: string; b: string; outsider: string };

  beforeEach(async () => {
    creator = await registerUser(app, { name: "Felipe" });
    memberA = await registerUser(app);
    memberB = await registerUser(app);
    outsider = await registerUser(app);
    groupId = await createGroup(app, creator, "Família");
    await addMember(app, creator, groupId, memberA);
    await addMember(app, creator, groupId, memberB);
    await createGroup(app, outsider, "Outro grupo");

    tokens = {
      creator: (await registerActiveDevice(app, creator)).token,
      a1: (await registerActiveDevice(app, memberA, { platform: "ANDROID" })).token,
      a2: (await registerActiveDevice(app, memberA, { platform: "IOS" })).token,
      b: (await registerActiveDevice(app, memberB)).token,
      outsider: (await registerActiveDevice(app, outsider)).token,
    };
  });

  it("notifica membros do grupo (todos os dispositivos), exclui criador e externos", async () => {
    const res = await createAlertAndFlush(creator, groupId, SYNTHETIC_LOCATION);
    expect(res.statusCode).toBe(201);

    expect(push.batches).toHaveLength(1);
    expect(push.recipients.sort()).toEqual([tokens.a1, tokens.a2, tokens.b].sort());
    expect(push.recipients).not.toContain(tokens.creator);
    expect(push.recipients).not.toContain(tokens.outsider);
    expect(new Set(push.recipients).size).toBe(push.recipients.length);
  });

  it("conteúdo mínimo e seguro: sem nome, localização, e-mail ou dados de autenticação", async () => {
    const res = await createAlertAndFlush(creator, groupId, SYNTHETIC_LOCATION);
    const alertId = res.json().id as string;

    for (const message of push.messages) {
      expect(message.title).toBe(ALERT_NOTIFICATION_TITLE);
      expect(message.body).toBe(ALERT_NOTIFICATION_BODY);
      expect(message.channelId).toBe(ALERT_NOTIFICATION_CHANNEL);
      expect(message.data).toEqual({ type: "EMERGENCY_ALERT", alertId, groupId });
    }

    const raw = JSON.stringify(push.messages.map(({ to: _to, ...rest }) => rest));
    for (const forbidden of [
      "latitude",
      "longitude",
      String(SYNTHETIC_LOCATION.latitude),
      String(SYNTHETIC_LOCATION.longitude),
      "Felipe",
      creator.email,
      memberA.email,
      "password",
      "refreshToken",
      "accessToken",
      "Bearer",
      "PushToken",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("dispositivo desativado não recebe", async () => {
    const { deviceId } = await registerActiveDevice(app, memberB, { token: tokens.b });
    await app.inject({
      method: "DELETE",
      url: `/me/push-devices/${deviceId}`,
      headers: authHeaders(memberB),
    });

    await createAlertAndFlush(creator, groupId);
    expect(push.recipients.sort()).toEqual([tokens.a1, tokens.a2].sort());
  });

  it("membro sem token não causa erro e o alerta é criado", async () => {
    const quiet = await registerUser(app);
    await addMember(app, creator, groupId, quiet);

    const res = await createAlertAndFlush(creator, groupId);
    expect(res.statusCode).toBe(201);
    expect(push.recipients).toHaveLength(3);
  });

  it("grupo sem nenhum dispositivo: nenhum envio, alerta criado normalmente", async () => {
    const lonely = await registerUser(app);
    const soloGroup = await createGroup(app, lonely, "Solo");
    const res = await createAlertAndFlush(lonely, soloGroup);
    expect(res.statusCode).toBe(201);
    expect(push.batches).toHaveLength(0);
  });

  it("retry idempotente (mesma chave) não envia push novamente", async () => {
    const key = newIdempotencyKey();
    const first = await postAlert(app, creator, { groupId }, key);
    const retry = await postAlert(app, creator, { groupId }, key);
    await app.background.flush();

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(push.batches).toHaveLength(1);
  });

  it("push só é enviado na criação: resolve e cancel não notificam", async () => {
    const created = await createAlertAndFlush(creator, groupId);
    const alertId = created.json().id as string;
    await app.inject({
      method: "POST",
      url: `/alerts/${alertId}/resolve`,
      headers: authHeaders(creator),
    });
    await app.background.flush();
    expect(push.batches).toHaveLength(1);

    const second = await createAlertAndFlush(creator, groupId);
    const secondId = second.json().id as string;
    await app.inject({
      method: "POST",
      url: `/alerts/${secondId}/cancel`,
      headers: authHeaders(creator),
    });
    await app.background.flush();
    expect(push.batches).toHaveLength(2);
  });
});

describe("Push ao criar alerta — falhas do provedor", () => {
  let creator: TestUser;
  let member: TestUser;
  let groupId: string;
  let memberToken: string;

  beforeEach(async () => {
    creator = await registerUser(app);
    member = await registerUser(app);
    groupId = await createGroup(app, creator);
    await addMember(app, creator, groupId, member);
    memberToken = (await registerActiveDevice(app, member)).token;
  });

  it("provedor lançando erro: alerta criado e persistido, sem rollback", async () => {
    push.failNext(new Error("Expo indisponível"));

    const res = await createAlertAndFlush(creator, groupId, SYNTHETIC_LOCATION);
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("ACTIVE");

    const check = await app.inject({
      method: "GET",
      url: `/alerts/${res.json().id}`,
      headers: authHeaders(member),
    });
    expect(check.statusCode).toBe(200);
    expect(check.json().status).toBe("ACTIVE");
    expect(await isActive(memberToken)).toBe(true);
    expect(app.background.pendingCount()).toBe(0);
  });

  it("token inválido (DeviceNotRegistered) é desativado e não recebe nos próximos alertas", async () => {
    push.setResult(memberToken, "invalidToken", "DeviceNotRegistered");

    const first = await createAlertAndFlush(creator, groupId);
    expect(first.statusCode).toBe(201);
    expect(push.recipients).toEqual([memberToken]);
    expect(await isActive(memberToken)).toBe(false);

    // Encerra e cria outro alerta: o token desativado não é mais usado.
    await app.inject({
      method: "POST",
      url: `/alerts/${first.json().id}/resolve`,
      headers: authHeaders(creator),
    });
    push.reset();
    const second = await createAlertAndFlush(creator, groupId);
    expect(second.statusCode).toBe(201);
    expect(push.batches).toHaveLength(0);
  });

  it("erro transitório mantém o token ativo e o alerta válido", async () => {
    push.setResult(memberToken, "failed", "MessageRateExceeded");

    const res = await createAlertAndFlush(creator, groupId);
    expect(res.statusCode).toBe(201);
    expect(await isActive(memberToken)).toBe(true);

    await app.inject({
      method: "POST",
      url: `/alerts/${res.json().id}/resolve`,
      headers: authHeaders(creator),
    });
    push.reset();
    await createAlertAndFlush(creator, groupId);
    expect(push.recipients).toEqual([memberToken]);
  });

  it("a resposta do POST /alerts não espera a entrega do push", async () => {
    let release: () => void = () => {};
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const slowProvider = new FakePushProvider();
    const originalSend = slowProvider.send.bind(slowProvider);
    slowProvider.send = async (messages) => {
      markStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return originalSend(messages);
    };
    const slowApp = await createTestApp({ pushProvider: slowProvider });
    try {
      const res = await postAlert(slowApp, creator, { groupId });
      // A resposta chegou enquanto o envio ainda está bloqueado no provedor.
      expect(res.statusCode).toBe(201);
      expect(slowApp.background.pendingCount()).toBe(1);
      await started;
      expect(slowApp.background.pendingCount()).toBe(1);
      release();
      await slowApp.background.flush();
      expect(slowProvider.recipients).toEqual([memberToken]);
    } finally {
      await slowApp.close();
    }
  });
});
