import { Pressable, Text } from "react-native";
import * as Notifications from "expo-notifications";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext, type AuthContextValue } from "../../auth/AuthContext";
import { createMockApi, testUser } from "../../test-utils/renderWithAuth";
import { registerCurrentDevice } from "../device-registration";
import { NotificationsProvider, useNotifications } from "../NotificationsProvider";
import { consumePendingAlertId, resetPendingAlert, subscribeAlertOpen } from "../pending-alert";

jest.mock("../device-registration", () => ({
  registerCurrentDevice: jest.fn(async () => "registered"),
  unregisterCurrentDevice: jest.fn(async () => undefined),
}));

const getPermissions = jest.mocked(Notifications.getPermissionsAsync);
const requestPermissions = jest.mocked(Notifications.requestPermissionsAsync);
const addListener = jest.mocked(Notifications.addNotificationResponseReceivedListener);
const getLastResponse = jest.mocked(Notifications.getLastNotificationResponseAsync);
const mockedRegister = jest.mocked(registerCurrentDevice);

type PermissionResponse = Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>;
const undetermined = {
  status: "undetermined",
  granted: false,
  canAskAgain: true,
} as PermissionResponse;
const granted = { status: "granted", granted: true, canAskAgain: true } as PermissionResponse;

function Probe(): React.JSX.Element {
  const notifications = useNotifications();
  return (
    <>
      <Text testID="permission">{notifications?.permission ?? "sem-provider"}</Text>
      <Pressable testID="enable" onPress={() => void notifications?.enable()}>
        <Text>ativar</Text>
      </Pressable>
    </>
  );
}

function renderProvider(status: AuthContextValue["status"] = "authenticated") {
  const api = createMockApi();
  const value: AuthContextValue = {
    status,
    user: status === "authenticated" ? testUser : null,
    sessionPersistent: true,
    api,
    signIn: jest.fn(),
    signUp: jest.fn(),
    signOut: jest.fn(),
  };
  const ui = (
    <AuthContext.Provider value={value}>
      <NotificationsProvider>
        <Probe />
      </NotificationsProvider>
    </AuthContext.Provider>
  );
  return { api, ui, value };
}

describe("NotificationsProvider", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetPendingAlert();
    getPermissions.mockResolvedValue(undetermined);
    getLastResponse.mockResolvedValue(null);
  });

  it("carrega a permissão e configura handler, canal e listener uma única vez", async () => {
    const { ui } = renderProvider();
    const view = await render(ui);
    expect(await screen.findByText("undetermined")).toBeOnTheScreen();

    await view.rerender(ui);
    expect(Notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("registra o dispositivo após autenticação quando a permissão já foi concedida", async () => {
    getPermissions.mockResolvedValue(granted);
    const { api, ui } = renderProvider();
    await render(ui);

    await waitFor(() => expect(mockedRegister).toHaveBeenCalledWith(api));
  });

  it("não registra quando não autenticado", async () => {
    getPermissions.mockResolvedValue(granted);
    const { ui } = renderProvider("unauthenticated");
    await render(ui);
    expect(await screen.findByText("granted")).toBeOnTheScreen();
    expect(mockedRegister).not.toHaveBeenCalled();
  });

  it("enable() pede a permissão ao sistema e, se concedida, registra o dispositivo", async () => {
    requestPermissions.mockResolvedValue(granted);
    const { api, ui } = renderProvider();
    await render(ui);
    expect(await screen.findByText("undetermined")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("enable"));

    expect(await screen.findByText("granted")).toBeOnTheScreen();
    expect(requestPermissions).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockedRegister).toHaveBeenCalledWith(api));
  });

  it("toque na notificação publica a intenção de abrir o alerta; payload inválido é ignorado", async () => {
    const { ui } = renderProvider();
    await render(ui);
    await waitFor(() => expect(addListener).toHaveBeenCalledTimes(1));
    const handler = addListener.mock.calls[0]?.[0];
    expect(handler).toBeDefined();

    const received: string[] = [];
    const unsubscribe = subscribeAlertOpen((alertId) => received.push(alertId));

    await act(async () => {
      handler!({
        notification: { request: { content: { data: { type: "OUTRO", alertId: "x" } } } },
      } as unknown as Notifications.NotificationResponse);
      handler!({
        notification: {
          request: { content: { data: { type: "EMERGENCY_ALERT", alertId: "alert-77" } } },
        },
      } as unknown as Notifications.NotificationResponse);
    });

    expect(received).toEqual(["alert-77"]);
    expect(consumePendingAlertId()).toBe("alert-77");
    unsubscribe();
  });

  it("notificação que abriu o app (cold start) fica pendente para a área autenticada", async () => {
    getLastResponse.mockResolvedValue({
      notification: {
        request: { content: { data: { type: "EMERGENCY_ALERT", alertId: "alert-cold" } } },
      },
    } as unknown as Notifications.NotificationResponse);
    const { ui } = renderProvider("loading");
    await render(ui);

    await waitFor(() => expect(consumePendingAlertId()).toBe("alert-cold"));
  });

  it("remove o listener ao desmontar", async () => {
    const remove = jest.fn();
    addListener.mockReturnValueOnce({ remove } as unknown as ReturnType<typeof addListener>);
    const { ui } = renderProvider();
    const view = await render(ui);
    await view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("useNotifications devolve null fora do provider", async () => {
    await render(<Probe />);
    expect(screen.getByText("sem-provider")).toBeOnTheScreen();
  });
});
