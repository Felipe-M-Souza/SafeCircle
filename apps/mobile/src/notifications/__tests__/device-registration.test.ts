import * as Notifications from "expo-notifications";
import { createMockApi } from "../../test-utils/renderWithAuth";
import {
  registerCurrentDevice,
  resetRegistrationCache,
  unregisterCurrentDevice,
} from "../device-registration";

const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";

jest.mock("../../lib/storage", () => ({
  getOrCreateInstallationId: jest.fn(async () => "11111111-1111-4111-8111-111111111111"),
}));

const getPermissions = jest.mocked(Notifications.getPermissionsAsync);
const getToken = jest.mocked(Notifications.getExpoPushTokenAsync);

type PermissionResponse = Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>;
const granted = { status: "granted", granted: true, canAskAgain: true } as PermissionResponse;
const denied = { status: "denied", granted: false, canAskAgain: true } as PermissionResponse;

// Tokens SINTÉTICOS.
const TOKEN_A = "ExponentPushToken[sintetico-aaaa-0001]";
const TOKEN_B = "ExponentPushToken[sintetico-bbbb-0002]";

describe("device-registration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetRegistrationCache();
    getPermissions.mockResolvedValue(granted);
    getToken.mockResolvedValue({ type: "expo", data: TOKEN_A });
  });

  it("sem permissão concedida não registra (skipped)", async () => {
    getPermissions.mockResolvedValue(denied);
    const api = createMockApi();
    expect(await registerCurrentDevice(api)).toBe("skipped");
    expect(api.registerPushDevice).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it("com permissão e token registra no backend com plataforma e deviceId", async () => {
    const api = createMockApi();
    expect(await registerCurrentDevice(api)).toBe("registered");
    expect(api.registerPushDevice).toHaveBeenCalledWith({
      token: TOKEN_A,
      platform: "IOS",
      deviceId: INSTALLATION_ID,
    });
  });

  it("o mesmo token não é registrado duas vezes no mesmo processo", async () => {
    const api = createMockApi();
    expect(await registerCurrentDevice(api)).toBe("registered");
    expect(await registerCurrentDevice(api)).toBe("skipped");
    expect(api.registerPushDevice).toHaveBeenCalledTimes(1);
  });

  it("token novo (rotação) é registrado de novo com o mesmo deviceId", async () => {
    const api = createMockApi();
    await registerCurrentDevice(api);
    getToken.mockResolvedValue({ type: "expo", data: TOKEN_B });
    expect(await registerCurrentDevice(api)).toBe("registered");
    expect(api.registerPushDevice).toHaveBeenCalledTimes(2);
    expect(api.registerPushDevice).toHaveBeenLastCalledWith({
      token: TOKEN_B,
      platform: "IOS",
      deviceId: INSTALLATION_ID,
    });
  });

  it("token indisponível → skipped; falha da API → failed e tenta de novo depois", async () => {
    getToken.mockResolvedValueOnce({ type: "expo", data: "" });
    const api = createMockApi({
      registerPushDevice: jest.fn().mockRejectedValueOnce(new Error("offline")),
    });
    expect(await registerCurrentDevice(api)).toBe("skipped");
    expect(await registerCurrentDevice(api)).toBe("failed");
    expect(await registerCurrentDevice(api)).toBe("registered");
    expect(api.registerPushDevice).toHaveBeenCalledTimes(2);
  });

  it("logout desregistra o dispositivo e falha não é propagada", async () => {
    const api = createMockApi({
      unregisterPushDevice: jest.fn().mockRejectedValue(new Error("offline")),
    });
    await registerCurrentDevice(api);
    await expect(unregisterCurrentDevice(api)).resolves.toBeUndefined();
    expect(api.unregisterPushDevice).toHaveBeenCalledWith(INSTALLATION_ID);

    // Depois do logout, o mesmo token volta a ser registrado (novo login).
    expect(await registerCurrentDevice(api)).toBe("registered");
  });
});
