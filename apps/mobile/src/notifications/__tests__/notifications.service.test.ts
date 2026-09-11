import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
  alertDataFromResponse,
  getExpoProjectId,
  getExpoPushToken,
  getPermissionStatus,
  getPushPlatform,
  isPushSupported,
  parseAlertNotificationData,
  requestPermission,
} from "../notifications.service";

const getPermissions = jest.mocked(Notifications.getPermissionsAsync);
const requestPermissions = jest.mocked(Notifications.requestPermissionsAsync);
const getToken = jest.mocked(Notifications.getExpoPushTokenAsync);

type PermissionResponse = Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>;

function permission(status: string, canAskAgain = true): PermissionResponse {
  return { status, granted: status === "granted", canAskAgain } as PermissionResponse;
}

describe("notifications.service — permissão", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("mapeia indeterminada, concedida, negada e bloqueada", async () => {
    getPermissions.mockResolvedValueOnce(permission("undetermined"));
    expect(await getPermissionStatus()).toBe("undetermined");

    getPermissions.mockResolvedValueOnce(permission("granted"));
    expect(await getPermissionStatus()).toBe("granted");

    getPermissions.mockResolvedValueOnce(permission("denied", true));
    expect(await getPermissionStatus()).toBe("denied");

    getPermissions.mockResolvedValueOnce(permission("denied", false));
    expect(await getPermissionStatus()).toBe("blocked");
  });

  it("erro da biblioteca → unavailable; solicitação com erro → denied", async () => {
    getPermissions.mockRejectedValueOnce(new Error("falha"));
    expect(await getPermissionStatus()).toBe("unavailable");

    requestPermissions.mockRejectedValueOnce(new Error("falha"));
    expect(await requestPermission()).toBe("denied");
  });

  it("solicita permissão ao sistema e devolve o resultado mapeado", async () => {
    requestPermissions.mockResolvedValueOnce(permission("granted"));
    expect(await requestPermission()).toBe("granted");
    expect(requestPermissions).toHaveBeenCalledTimes(1);
  });

  it("plataforma nativa é suportada (iOS nos testes)", () => {
    expect(isPushSupported()).toBe(true);
    expect(getPushPlatform()).toBe("IOS");
  });

  it("na web o push é indisponível: sem permissão, token ou plataforma", async () => {
    const restore = jest.replaceProperty(Platform, "OS", "web");
    try {
      expect(isPushSupported()).toBe(false);
      expect(getPushPlatform()).toBeNull();
      expect(await getPermissionStatus()).toBe("unavailable");
      expect(await requestPermission()).toBe("unavailable");
      expect(await getExpoPushToken()).toBeNull();
      expect(getPermissions).not.toHaveBeenCalled();
      expect(getToken).not.toHaveBeenCalled();
    } finally {
      restore.restore();
    }
  });
});

describe("notifications.service — Expo Push Token", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Constants as unknown as { expoConfig: { extra: Record<string, unknown> } }).expoConfig = {
      extra: {},
    };
  });

  it("obtém o token sem projectId quando não configurado", async () => {
    getToken.mockResolvedValueOnce({ type: "expo", data: "ExponentPushToken[abc-sintetico-1]" });
    expect(await getExpoPushToken()).toBe("ExponentPushToken[abc-sintetico-1]");
    expect(getToken).toHaveBeenCalledWith(undefined);
    expect(getExpoProjectId()).toBeUndefined();
  });

  it("usa o projectId público do app.json (extra.eas.projectId) quando existir", async () => {
    (Constants as unknown as { expoConfig: { extra: Record<string, unknown> } }).expoConfig = {
      extra: { eas: { projectId: "projeto-publico" } },
    };
    getToken.mockResolvedValueOnce({ type: "expo", data: "ExponentPushToken[abc-sintetico-2]" });
    await getExpoPushToken();
    expect(getToken).toHaveBeenCalledWith({ projectId: "projeto-publico" });
  });

  it("erro ou resposta vazia → null (nunca lança)", async () => {
    getToken.mockRejectedValueOnce(new Error("sem projectId"));
    expect(await getExpoPushToken()).toBeNull();
    getToken.mockResolvedValueOnce({ type: "expo", data: "" });
    expect(await getExpoPushToken()).toBeNull();
  });
});

describe("notifications.service — payload", () => {
  it("aceita apenas EMERGENCY_ALERT com alertId", () => {
    expect(
      parseAlertNotificationData({ type: "EMERGENCY_ALERT", alertId: "a1", groupId: "g1" }),
    ).toEqual({
      type: "EMERGENCY_ALERT",
      alertId: "a1",
      groupId: "g1",
    });
    expect(parseAlertNotificationData({ type: "EMERGENCY_ALERT", alertId: "a1" })).toEqual({
      type: "EMERGENCY_ALERT",
      alertId: "a1",
    });
    expect(parseAlertNotificationData({ type: "OTHER", alertId: "a1" })).toBeNull();
    expect(parseAlertNotificationData({ type: "EMERGENCY_ALERT" })).toBeNull();
    expect(parseAlertNotificationData(null)).toBeNull();
    expect(parseAlertNotificationData("texto")).toBeNull();
  });

  it("extrai os dados de uma resposta de notificação", () => {
    const response = {
      notification: { request: { content: { data: { type: "EMERGENCY_ALERT", alertId: "a9" } } } },
    } as unknown as Notifications.NotificationResponse;
    expect(alertDataFromResponse(response)?.alertId).toBe("a9");
    expect(alertDataFromResponse(null)).toBeNull();
  });
});
