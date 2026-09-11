import { Linking } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import {
  NotificationsContext,
  type NotificationsContextValue,
} from "../../notifications/NotificationsProvider";
import { NotificationsCard } from "../NotificationsCard";

async function renderCard(overrides: Partial<NotificationsContextValue>) {
  const value: NotificationsContextValue = {
    supported: true,
    permission: "undetermined",
    refresh: jest.fn(async () => undefined),
    enable: jest.fn(async () => "granted" as const),
    ...overrides,
  };
  const view = await render(
    <NotificationsContext.Provider value={value}>
      <NotificationsCard />
    </NotificationsContext.Provider>,
  );
  return { value, view };
}

describe("NotificationsCard", () => {
  it("permissão indeterminada: explica o motivo antes de pedir e permite adiar", async () => {
    const { value } = await renderCard({ permission: "undetermined" });
    expect(screen.getByText("Ative as notificações")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "O SafeCircle usa notificações para avisar quando alguém do seu grupo de confiança pedir ajuda.",
      ),
    ).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("Ativar notificações"));
    expect(value.enable).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText("Agora não"));
    expect(screen.queryByText("Ative as notificações")).not.toBeOnTheScreen();
  });

  it("permissão negada: estado informativo com nova tentativa", async () => {
    const { value } = await renderCard({ permission: "denied" });
    expect(screen.getByText("Notificações desativadas")).toBeOnTheScreen();
    expect(
      screen.getByText("Sem notificações, você só verá os alertas ao abrir o SafeCircle."),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Tentar novamente"));
    expect(value.enable).toHaveBeenCalledTimes(1);
  });

  it("permissão bloqueada: orienta a abrir as configurações do aparelho", async () => {
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined);
    await renderCard({ permission: "blocked" });
    expect(screen.getByText("Notificações desativadas")).toBeOnTheScreen();
    expect(
      screen.getByText("Ative as notificações nas configurações do aparelho para receber alertas."),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Abrir configurações"));
    expect(openSettings).toHaveBeenCalledTimes(1);
    openSettings.mockRestore();
  });

  it("permissão concedida: mostra status Ativadas", async () => {
    await renderCard({ permission: "granted" });
    expect(screen.getByText("Notificações")).toBeOnTheScreen();
    expect(
      screen.getByText("Receba alertas quando alguém do seu grupo pedir ajuda."),
    ).toBeOnTheScreen();
    expect(screen.getByText("Ativadas")).toBeOnTheScreen();
  });

  it("plataforma sem push ou carregando: não renderiza nada", async () => {
    const unsupported = await renderCard({ supported: false, permission: "unavailable" });
    expect(unsupported.view.toJSON()).toBeNull();
    await unsupported.view.unmount();
    const loading = await renderCard({ permission: "loading" });
    expect(loading.view.toJSON()).toBeNull();
  });

  it("sem provider: não renderiza nada", async () => {
    const view = await render(<NotificationsCard />);
    expect(view.toJSON()).toBeNull();
  });
});
