import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestApp } from "./helpers/app.js";
import { createCleaner } from "./helpers/test-db.js";
import { authHeaders, registerUser, type TestUser } from "./helpers/auth.js";
import {
  fakeExpoToken,
  newDeviceId,
  registerActiveDevice,
  registerDevice,
} from "./helpers/push.js";

const cleaner = createCleaner();
let app: FastifyInstance;

interface DeviceRow {
  id: string;
  user_id: string;
  token: string;
  platform: string;
  device_id: string;
  is_active: boolean;
  last_seen_at: Date;
}

async function allDevices(): Promise<DeviceRow[]> {
  return cleaner.sql<DeviceRow[]>`
    SELECT id, user_id, token, platform, device_id, is_active, last_seen_at
    FROM push_devices ORDER BY created_at
  `;
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

describe("POST /me/push-devices", () => {
  let user: TestUser;
  beforeEach(async () => {
    user = await registerUser(app);
  });

  it("registra dispositivo autenticado (201) sem devolver o token", async () => {
    const token = fakeExpoToken();
    const deviceId = newDeviceId();
    const res = await registerDevice(app, user, { token, platform: "ANDROID", deviceId });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ platform: "ANDROID", deviceId, isActive: true });
    expect(typeof res.json().id).toBe("string");
    expect(typeof res.json().updatedAt).toBe("string");
    expect(res.payload).not.toContain(token);
    expect(res.payload).not.toContain("PushToken");
    expect(res.json().token).toBeUndefined();

    const rows = await allDevices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: user.userId, token, is_active: true });
  });

  it("aceita os dois formatos de token da Expo e ambas as plataformas", async () => {
    const a = await registerDevice(app, user, {
      token: "ExpoPushToken[abcdefgh12345678]",
      platform: "IOS",
      deviceId: newDeviceId(),
    });
    expect(a.statusCode).toBe(201);
    const b = await registerDevice(app, user, {
      token: "ExponentPushToken[zzzzzzzz_-12345678]",
      platform: "ANDROID",
      deviceId: newDeviceId(),
    });
    expect(b.statusCode).toBe(201);
  });

  it("exige autenticação (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      payload: { token: fakeExpoToken(), platform: "ANDROID", deviceId: newDeviceId() },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejeita token inválido (400 INVALID_PUSH_TOKEN) — prefixo não basta", async () => {
    for (const token of [
      "",
      "abc",
      "ExponentPushToken[]",
      "ExponentPushToken[curto]",
      "ExponentPushToken[com espaço 12345678]",
      "ExponentPushToken[" + "x".repeat(300) + "]",
      "FCMToken[abcdefgh12345678]",
      12345,
      undefined,
    ]) {
      const res = await registerDevice(app, user, {
        token,
        platform: "ANDROID",
        deviceId: newDeviceId(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("INVALID_PUSH_TOKEN");
    }
    expect(await allDevices()).toHaveLength(0);
  });

  it("rejeita plataforma inválida (400 INVALID_PUSH_PLATFORM)", async () => {
    for (const platform of ["WEB", "android", "", undefined]) {
      const res = await registerDevice(app, user, {
        token: fakeExpoToken(),
        platform,
        deviceId: newDeviceId(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("INVALID_PUSH_PLATFORM");
    }
  });

  it("rejeita deviceId inválido (400 INVALID_DEVICE_ID)", async () => {
    for (const deviceId of ["nao-e-uuid", "", 42, undefined]) {
      const res = await registerDevice(app, user, {
        token: fakeExpoToken(),
        platform: "IOS",
        deviceId,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("INVALID_DEVICE_ID");
    }
  });

  it("body vazio ou não objeto → 400 sem erro interno", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/me/push-devices",
      headers: authHeaders(user),
      payload: "texto",
    });
    expect(res.statusCode).toBe(400);
  });

  it("mesmo deviceId com token novo atualiza o registro (rotação) sem duplicar", async () => {
    const deviceId = newDeviceId();
    const first = await registerDevice(app, user, {
      token: fakeExpoToken("old"),
      platform: "ANDROID",
      deviceId,
    });
    const newToken = fakeExpoToken("new");
    const second = await registerDevice(app, user, {
      token: newToken,
      platform: "ANDROID",
      deviceId,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const rows = await allDevices();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token).toBe(newToken);
  });

  it("mesmo token registrado de novo não duplica e atualiza lastSeenAt", async () => {
    const token = fakeExpoToken();
    const deviceId = newDeviceId();
    const first = await registerDevice(app, user, { token, platform: "IOS", deviceId });
    const [before] = await allDevices();

    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await registerDevice(app, user, { token, platform: "IOS", deviceId });

    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    const rows = await allDevices();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_seen_at.getTime()).toBeGreaterThan(before!.last_seen_at.getTime());
  });

  it("token de outro usuário é reassociado ao usuário autenticado (troca de conta)", async () => {
    const other = await registerUser(app);
    const deviceId = newDeviceId();
    const token = fakeExpoToken();
    await registerDevice(app, other, { token, platform: "ANDROID", deviceId });

    const res = await registerDevice(app, user, { token, platform: "ANDROID", deviceId });
    expect(res.statusCode).toBe(200);

    const rows = await allDevices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: user.userId, token, is_active: true });
  });

  it("reassociação remove o registro antigo desta instalação (nunca dois registros por instalação)", async () => {
    const other = await registerUser(app);
    const deviceId = newDeviceId();
    const sharedToken = fakeExpoToken("shared");
    await registerDevice(app, other, { token: sharedToken, platform: "ANDROID", deviceId });
    await registerDevice(app, user, {
      token: fakeExpoToken("stale"),
      platform: "ANDROID",
      deviceId,
    });
    expect(await allDevices()).toHaveLength(2);

    const res = await registerDevice(app, user, {
      token: sharedToken,
      platform: "ANDROID",
      deviceId,
    });
    expect(res.statusCode).toBe(200);

    const rows = await allDevices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: user.userId,
      token: sharedToken,
      device_id: deviceId,
    });
  });

  it("registros concorrentes do mesmo token/dispositivo resultam em um único registro", async () => {
    const token = fakeExpoToken();
    const deviceId = newDeviceId();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        registerDevice(app, user, { token, platform: "ANDROID", deviceId }),
      ),
    );
    for (const res of responses) {
      expect([200, 201]).toContain(res.statusCode);
    }
    expect(await allDevices()).toHaveLength(1);
  });

  it("o banco garante unicidade do token e de (usuário, dispositivo)", async () => {
    const { token, deviceId } = await registerActiveDevice(app, user);
    await expect(
      cleaner.sql`
        INSERT INTO push_devices (user_id, token, platform, device_id)
        VALUES (${user.userId}, ${token}, 'IOS', ${newDeviceId()})
      `,
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      cleaner.sql`
        INSERT INTO push_devices (user_id, token, platform, device_id)
        VALUES (${user.userId}, ${fakeExpoToken()}, 'IOS', ${deviceId})
      `,
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("DELETE /me/push-devices/:deviceId", () => {
  let user: TestUser;
  beforeEach(async () => {
    user = await registerUser(app);
  });

  it("desativa o dispositivo do usuário (204) sem apagar o registro", async () => {
    const { deviceId } = await registerActiveDevice(app, user);
    const res = await app.inject({
      method: "DELETE",
      url: `/me/push-devices/${deviceId}`,
      headers: authHeaders(user),
    });
    expect(res.statusCode).toBe(204);

    const rows = await allDevices();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_active).toBe(false);
  });

  it("novo registro reativa um dispositivo desativado", async () => {
    const { token, deviceId } = await registerActiveDevice(app, user);
    await app.inject({
      method: "DELETE",
      url: `/me/push-devices/${deviceId}`,
      headers: authHeaders(user),
    });
    const res = await registerDevice(app, user, { token, platform: "ANDROID", deviceId });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(true);
    expect((await allDevices())[0]?.is_active).toBe(true);
  });

  it("dispositivo inexistente ou de outro usuário → 404 PUSH_DEVICE_NOT_FOUND", async () => {
    const other = await registerUser(app);
    const { deviceId } = await registerActiveDevice(app, other);

    for (const id of [deviceId, newDeviceId()]) {
      const res = await app.inject({
        method: "DELETE",
        url: `/me/push-devices/${id}`,
        headers: authHeaders(user),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("PUSH_DEVICE_NOT_FOUND");
    }
    // O dispositivo do outro usuário permanece ativo.
    expect((await allDevices())[0]?.is_active).toBe(true);
  });

  it("deviceId inválido → 400 INVALID_DEVICE_ID; sem autenticação → 401", async () => {
    const bad = await app.inject({
      method: "DELETE",
      url: "/me/push-devices/nao-uuid",
      headers: authHeaders(user),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("INVALID_DEVICE_ID");

    const unauth = await app.inject({ method: "DELETE", url: `/me/push-devices/${newDeviceId()}` });
    expect(unauth.statusCode).toBe(401);
  });
});
