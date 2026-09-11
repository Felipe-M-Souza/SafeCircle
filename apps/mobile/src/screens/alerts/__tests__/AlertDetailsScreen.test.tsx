import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { AlertDetailsScreen } from "../AlertDetailsScreen";
import { ApiError } from "../../../lib/api";
import {
  createMockApi,
  createMockNav,
  makeAlert,
  renderWithAuth,
} from "../../../test-utils/renderWithAuth";

const otherUser = { id: "user-2", name: "Ana", email: "ana@example.com" };

describe("AlertDetailsScreen", () => {
  it("exibe o alerta ativo sem expor coordenadas cruas", async () => {
    const api = createMockApi({ getAlert: jest.fn(async () => makeAlert()) });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });

    expect(await screen.findByText("🚨 Alerta ativo")).toBeOnTheScreen();
    expect(screen.getByText("Família")).toBeOnTheScreen();
    expect(screen.getByText("Acionado por")).toBeOnTheScreen();
    expect(screen.getByText("Felipe")).toBeOnTheScreen();
    expect(screen.getByText("Horário")).toBeOnTheScreen();
    expect(screen.getByText("Localização")).toBeOnTheScreen();
    expect(screen.getByText("Disponível")).toBeOnTheScreen();
    expect(screen.getByText("ATIVO")).toBeOnTheScreen();
    expect(screen.queryByText(/-23/)).not.toBeOnTheScreen();
    expect(screen.queryByText(/-46/)).not.toBeOnTheScreen();
  });

  it("mostra confirmação honesta logo após a ativação", async () => {
    const api = createMockApi({ getAlert: jest.fn(async () => makeAlert()) });
    await renderWithAuth(
      <AlertDetailsScreen nav={createMockNav()} alertId="alert-1" justActivated />,
      { api },
    );

    expect(await screen.findByText("Alerta ativado")).toBeOnTheScreen();
    expect(screen.getByText("Seu alerta está ativo no grupo Família.")).toBeOnTheScreen();
    expect(
      screen.getByText("Os membros do grupo poderão visualizar este alerta no SafeCircle."),
    ).toBeOnTheScreen();
    expect(screen.queryByText(/Todos foram avisados/)).not.toBeOnTheScreen();
  });

  it("localização indisponível é informada", async () => {
    const api = createMockApi({ getAlert: jest.fn(async () => makeAlert({ location: null })) });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });

    expect(await screen.findByText("Não disponível")).toBeOnTheScreen();
  });

  it("criador vê as ações; outro membro não vê", async () => {
    const api = createMockApi({ getAlert: jest.fn(async () => makeAlert()) });
    const creatorView = await renderWithAuth(
      <AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />,
      { api },
    );
    expect(await screen.findByText("ESTOU EM SEGURANÇA")).toBeOnTheScreen();
    expect(screen.getByText("CANCELAR ALERTA")).toBeOnTheScreen();
    await creatorView.unmount();

    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, {
      api,
      user: otherUser,
    });
    expect(await screen.findByText("Acionado por")).toBeOnTheScreen();
    expect(screen.queryByText("ESTOU EM SEGURANÇA")).not.toBeOnTheScreen();
    expect(screen.queryByText("CANCELAR ALERTA")).not.toBeOnTheScreen();
  });

  it("resolver atualiza a UI com o estado devolvido pelo backend", async () => {
    const resolved = makeAlert({
      status: "RESOLVED",
      resolvedAt: "2026-09-11T20:45:00.000Z",
    });
    const api = createMockApi({
      getAlert: jest.fn(async () => makeAlert()),
      resolveAlert: jest.fn(async () => resolved),
    });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });

    await fireEvent.press(await screen.findByText("ESTOU EM SEGURANÇA"));

    expect(
      await screen.findByText("Que bom que você está em segurança. O alerta foi encerrado."),
    ).toBeOnTheScreen();
    expect(api.resolveAlert).toHaveBeenCalledWith("alert-1");
    expect(screen.getByText("Alerta resolvido")).toBeOnTheScreen();
    expect(screen.getByText("RESOLVIDO")).toBeOnTheScreen();
    expect(screen.queryByText("ESTOU EM SEGURANÇA")).not.toBeOnTheScreen();
    expect(screen.queryByText("CANCELAR ALERTA")).not.toBeOnTheScreen();
  });

  it("cancelar exige confirmação e atualiza a UI", async () => {
    const cancelled = makeAlert({
      status: "CANCELLED",
      cancelledAt: "2026-09-11T20:31:00.000Z",
    });
    const api = createMockApi({
      getAlert: jest.fn(async () => makeAlert()),
      cancelAlert: jest.fn(async () => cancelled),
    });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });

    await fireEvent.press(await screen.findByText("CANCELAR ALERTA"));
    expect(api.cancelAlert).not.toHaveBeenCalled();
    expect(screen.getByText("Sim, cancelar alerta")).toBeOnTheScreen();

    // Desistir mantém o alerta.
    await fireEvent.press(screen.getByText("Manter alerta"));
    expect(screen.queryByText("Sim, cancelar alerta")).not.toBeOnTheScreen();
    expect(api.cancelAlert).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText("CANCELAR ALERTA"));
    await fireEvent.press(screen.getByText("Sim, cancelar alerta"));

    expect(await screen.findByText("O alerta foi cancelado.")).toBeOnTheScreen();
    expect(api.cancelAlert).toHaveBeenCalledWith("alert-1");
    expect(screen.getByText("Alerta cancelado")).toBeOnTheScreen();
    expect(screen.getByText("CANCELADO")).toBeOnTheScreen();
  });

  it("erro da API ao resolver é exibido em pt-BR e o estado é ressincronizado", async () => {
    const api = createMockApi({
      getAlert: jest
        .fn()
        .mockResolvedValueOnce(makeAlert())
        .mockResolvedValueOnce(
          makeAlert({ status: "RESOLVED", resolvedAt: "2026-09-11T20:40:00.000Z" }),
        ),
      resolveAlert: jest.fn(async () => {
        throw new ApiError("INVALID_ALERT_TRANSITION", "conflict", 409);
      }),
    });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });

    await fireEvent.press(await screen.findByText("ESTOU EM SEGURANÇA"));

    expect(await screen.findByText("Este alerta já foi encerrado.")).toBeOnTheScreen();
    await waitFor(() => expect(api.getAlert).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("RESOLVIDO")).toBeOnTheScreen();
  });

  it("alerta inacessível mostra erro em pt-BR", async () => {
    const api = createMockApi({
      getAlert: jest.fn(async () => {
        throw new ApiError("ALERT_NOT_FOUND", "not found", 404);
      }),
    });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-x" />, { api });

    expect(await screen.findByText("Alerta não encontrado.")).toBeOnTheScreen();
  });
});
