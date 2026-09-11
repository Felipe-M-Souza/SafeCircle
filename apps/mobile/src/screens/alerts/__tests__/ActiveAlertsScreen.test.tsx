import { fireEvent, screen } from "@testing-library/react-native";
import { ActiveAlertsScreen } from "../ActiveAlertsScreen";
import { ApiError } from "../../../lib/api";
import {
  createMockApi,
  createMockNav,
  makeAlert,
  renderWithAuth,
} from "../../../test-utils/renderWithAuth";

describe("ActiveAlertsScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-09-11T20:33:30.000Z") });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("lista alertas ativos de outros membros e navega para os detalhes", async () => {
    const api = createMockApi({
      listAlerts: jest.fn(async () => [
        makeAlert({
          id: "alert-2",
          createdBy: { id: "user-2", name: "Ana" },
          groupName: "Vizinhos",
          activatedAt: "2026-09-11T20:30:00.000Z",
        }),
      ]),
    });
    const nav = createMockNav();
    await renderWithAuth(<ActiveAlertsScreen nav={nav} />, { api });

    expect(await screen.findByText("🚨 Ana")).toBeOnTheScreen();
    expect(screen.getByText("Vizinhos")).toBeOnTheScreen();
    expect(screen.getByText("Ativado há 3 min")).toBeOnTheScreen();
    expect(api.listAlerts).toHaveBeenCalledWith("ACTIVE");

    await fireEvent.press(screen.getByText("Ver alerta"));
    expect(nav.navigate).toHaveBeenCalledWith({ name: "alertDetails", alertId: "alert-2" });
  });

  it("estado vazio em pt-BR", async () => {
    const api = createMockApi({ listAlerts: jest.fn(async () => []) });
    await renderWithAuth(<ActiveAlertsScreen nav={createMockNav()} />, { api });

    expect(await screen.findByText("Nenhum alerta ativo nos seus grupos.")).toBeOnTheScreen();
    expect(screen.getByText("Alertas ativos")).toBeOnTheScreen();
  });

  it("erro de carregamento em pt-BR", async () => {
    const api = createMockApi({
      listAlerts: jest.fn(async () => {
        throw new ApiError("UNAUTHORIZED", "x", 401);
      }),
    });
    await renderWithAuth(<ActiveAlertsScreen nav={createMockNav()} />, { api });

    expect(await screen.findByText("Sua sessão expirou. Entre novamente.")).toBeOnTheScreen();
  });
});
