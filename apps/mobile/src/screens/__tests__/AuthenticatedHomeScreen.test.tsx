import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { AuthenticatedHomeScreen } from "../AuthenticatedHomeScreen";
import { DEFAULT_HOLD_DURATION_MS } from "../../components/HoldToActivateButton";
import { ApiError, type EmergencyAlert, type GroupSummary } from "../../lib/api";
import { captureInitialLocation } from "../../lib/location";
import {
  createMockApi,
  createMockNav,
  makeAlert,
  renderWithAuth,
  testUser,
} from "../../test-utils/renderWithAuth";

jest.mock("../../lib/location", () => ({
  captureInitialLocation: jest.fn(async () => null),
}));

const mockedCapture = jest.mocked(captureInitialLocation);

const familia: GroupSummary = {
  id: "group-1",
  name: "Família",
  role: "OWNER",
  memberCount: 3,
  createdAt: "2026-09-01T00:00:00.000Z",
};
const amigos: GroupSummary = {
  id: "group-2",
  name: "Amigos",
  role: "MEMBER",
  memberCount: 5,
  createdAt: "2026-09-02T00:00:00.000Z",
};

// Coordenadas SINTÉTICAS.
const syntheticSnapshot = {
  latitude: -23,
  longitude: -46,
  accuracy: 15,
  capturedAt: "2026-09-11T20:30:00.000Z",
};

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/** Pressiona e segura o botão SOS pelo tempo completo. */
async function holdSos() {
  const button = await screen.findByTestId("sos-button");
  await fireEvent(button, "pressIn");
  await advance(DEFAULT_HOLD_DURATION_MS);
}

describe("AuthenticatedHomeScreen (Phase 3)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedCapture.mockReset();
    mockedCapture.mockResolvedValue(null);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("usuário sem grupos vê orientação e não vê o botão SOS", async () => {
    const api = createMockApi({ listGroups: jest.fn(async () => []) });
    const nav = createMockNav();
    await renderWithAuth(<AuthenticatedHomeScreen nav={nav} />, { api });

    expect(
      await screen.findByText(
        "Você precisa participar de um grupo de confiança antes de criar um alerta.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId("sos-button")).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByText("Ver meus grupos"));
    expect(nav.navigate).toHaveBeenCalledWith({ name: "groups" });
  });

  it("seleciona o primeiro grupo por padrão e permite trocar", async () => {
    const api = createMockApi({ listGroups: jest.fn(async () => [familia, amigos]) });
    await renderWithAuth(<AuthenticatedHomeScreen nav={createMockNav()} />, { api });

    expect(await screen.findByText("Grupo selecionado")).toBeOnTheScreen();
    expect(screen.getByRole("radio", { name: "Família" })).toBeSelected();
    expect(screen.getByRole("radio", { name: "Amigos" })).not.toBeSelected();

    await fireEvent.press(screen.getByRole("radio", { name: "Amigos" }));
    expect(screen.getByRole("radio", { name: "Amigos" })).toBeSelected();
    expect(screen.getByRole("radio", { name: "Família" })).not.toBeSelected();
    expect(screen.getByText("SEGURE PARA PEDIR AJUDA")).toBeOnTheScreen();
  });

  it("press-and-hold não aciona antes do tempo e soltar cancela", async () => {
    const api = createMockApi({ listGroups: jest.fn(async () => [familia]) });
    await renderWithAuth(<AuthenticatedHomeScreen nav={createMockNav()} />, { api });

    const button = await screen.findByTestId("sos-button");
    await fireEvent(button, "pressIn");
    await advance(DEFAULT_HOLD_DURATION_MS - 100);
    await fireEvent(button, "pressOut");
    await advance(3000);

    expect(mockedCapture).not.toHaveBeenCalled();
    expect(api.createAlert).not.toHaveBeenCalled();
  });

  it("conclusão do hold gera uma única intenção com a localização capturada", async () => {
    mockedCapture.mockResolvedValue(syntheticSnapshot);
    const created = makeAlert({ id: "alert-9" });
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia, amigos]),
      createAlert: jest.fn(async () => created),
    });
    const nav = createMockNav();
    await renderWithAuth(<AuthenticatedHomeScreen nav={nav} />, { api });

    await holdSos();

    await waitFor(() => expect(api.createAlert).toHaveBeenCalledTimes(1));
    expect(api.createAlert).toHaveBeenCalledWith(
      { groupId: "group-1", location: syntheticSnapshot },
      expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/),
    );
    await waitFor(() =>
      expect(nav.navigate).toHaveBeenCalledWith({
        name: "alertDetails",
        alertId: "alert-9",
        justActivated: true,
      }),
    );
    // Continuar segurando não gera segundo request.
    await advance(5000);
    expect(api.createAlert).toHaveBeenCalledTimes(1);
  });

  it("GPS falhando ou permissão negada não impede a criação do alerta", async () => {
    mockedCapture.mockResolvedValue(null);
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia]),
      createAlert: jest.fn(async () => makeAlert({ location: null })),
    });
    const nav = createMockNav();
    await renderWithAuth(<AuthenticatedHomeScreen nav={nav} />, { api });

    await holdSos();

    await waitFor(() => expect(api.createAlert).toHaveBeenCalledTimes(1));
    expect(mockedCapture).toHaveBeenCalledTimes(1);
    expect(api.createAlert.mock.calls[0]?.[0]).toEqual({ groupId: "group-1", location: null });
    await waitFor(() => expect(nav.navigate).toHaveBeenCalled());
  });

  it("mostra estado de carregamento durante a ativação", async () => {
    let resolveCreate: (value: EmergencyAlert) => void = () => {};
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia]),
      createAlert: jest.fn(
        () =>
          new Promise<EmergencyAlert>((resolve) => {
            resolveCreate = resolve;
          }),
      ),
    });
    await renderWithAuth(<AuthenticatedHomeScreen nav={createMockNav()} />, { api });

    await holdSos();

    expect(await screen.findByText("Ativando alerta...")).toBeOnTheScreen();
    expect(screen.getByTestId("sos-button")).toBeBusy();

    await act(async () => {
      resolveCreate(makeAlert());
    });
    await waitFor(() => expect(screen.queryByText("Ativando alerta...")).not.toBeOnTheScreen());
  });

  it("erro da API é exibido em pt-BR", async () => {
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia]),
      createAlert: jest.fn(async () => {
        throw new ApiError("ALERT_ALREADY_ACTIVE", "conflict", 409);
      }),
    });
    const nav = createMockNav();
    await renderWithAuth(<AuthenticatedHomeScreen nav={nav} />, { api });

    await holdSos();

    expect(
      await screen.findByText("Você já possui um alerta ativo neste grupo."),
    ).toBeOnTheScreen();
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it("falha de rede é exibida em pt-BR e a nova tentativa reutiliza a mesma chave", async () => {
    const createAlert = jest
      .fn()
      .mockRejectedValueOnce(new ApiError("NETWORK", "offline", 0))
      .mockResolvedValueOnce(makeAlert());
    const api = createMockApi({ listGroups: jest.fn(async () => [familia]), createAlert });
    await renderWithAuth(<AuthenticatedHomeScreen nav={createMockNav()} />, { api });

    await holdSos();
    expect(await screen.findByText("Não foi possível conectar ao servidor.")).toBeOnTheScreen();

    await holdSos();
    await waitFor(() => expect(createAlert).toHaveBeenCalledTimes(2));
    expect(createAlert.mock.calls[0]?.[1]).toBe(createAlert.mock.calls[1]?.[1]);
  });

  it("exibe o próprio alerta ativo no grupo selecionado em vez do botão SOS", async () => {
    const api = createMockApi({
      listGroups: jest.fn(async () => [familia]),
      listAlerts: jest.fn(async () => [makeAlert({ id: "alert-mine", groupId: "group-1" })]),
    });
    const nav = createMockNav();
    await renderWithAuth(<AuthenticatedHomeScreen nav={nav} />, { api, user: testUser });

    expect(await screen.findByText("Você tem um alerta ativo neste grupo.")).toBeOnTheScreen();
    expect(screen.queryByTestId("sos-button")).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByText("Ver alerta"));
    expect(nav.navigate).toHaveBeenCalledWith({ name: "alertDetails", alertId: "alert-mine" });
  });

  it("textos principais em pt-BR", async () => {
    const api = createMockApi({ listGroups: jest.fn(async () => [familia]) });
    await renderWithAuth(<AuthenticatedHomeScreen nav={createMockNav()} />, { api });

    expect(await screen.findByText("Olá, Felipe.")).toBeOnTheScreen();
    expect(screen.getByText("SEGURE PARA PEDIR AJUDA")).toBeOnTheScreen();
    expect(screen.getByText("Mantenha pressionado para ativar.")).toBeOnTheScreen();
    expect(screen.getByText("Alertas ativos")).toBeOnTheScreen();
    expect(screen.getByText("Meus grupos")).toBeOnTheScreen();
  });
});
