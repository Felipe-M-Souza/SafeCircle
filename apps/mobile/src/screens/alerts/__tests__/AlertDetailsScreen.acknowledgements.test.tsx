import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../../auth/AuthContext";
import { ApiError, type AlertAcknowledgement } from "../../../lib/api";
import { RealtimeContext } from "../../../realtime/RealtimeProvider";
import {
  createAuthValue,
  createMockApi,
  createMockNav,
  createMockRealtime,
  makeAlert,
  renderWithAuth,
  testUser,
} from "../../../test-utils/renderWithAuth";
import { AlertDetailsScreen } from "../AlertDetailsScreen";

const creator = { id: "user-creator", name: "Felipe" };
const member = testUser; // usuário autenticado nos testes (não criador)

function memberAlert(overrides = {}) {
  return makeAlert({ createdBy: creator, ...overrides });
}

function ack(user: { id: string; name: string }, type: AlertAcknowledgement["type"]) {
  return { user, type, updatedAt: "2026-09-11T20:31:00.000Z" };
}

describe("AlertDetailsScreen — respostas do grupo (acknowledgements)", () => {
  it("membro vê as ações, o aviso de segurança e envia SEEN uma única vez ao abrir", async () => {
    const api = createMockApi({ getAlert: jest.fn(async () => memberAlert()) });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });

    expect(await screen.findByText("VI O ALERTA")).toBeOnTheScreen();
    expect(screen.getByText("ESTOU INDO AJUDAR")).toBeOnTheScreen();
    expect(screen.getByText("ACIONEI EMERGÊNCIA")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Evite confronto direto. Em risco imediato, acione os serviços oficiais de emergência.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("ESTOU EM SEGURANÇA")).not.toBeOnTheScreen();

    await waitFor(() => expect(api.setAcknowledgement).toHaveBeenCalledWith("alert-1", "SEEN"));
    expect(api.setAcknowledgement).toHaveBeenCalledTimes(1);
  });

  it("criador não vê ações de resposta nem envia SEEN, mas vê as respostas do grupo", async () => {
    const api = createMockApi({
      getAlert: jest.fn(async () => makeAlert()),
      listAcknowledgements: jest.fn(async () => [
        ack({ id: "u-maria", name: "Maria" }, "GOING_TO_HELP"),
        ack({ id: "u-joao", name: "João" }, "SEEN"),
        ack({ id: "u-ana", name: "Ana" }, "EMERGENCY_SERVICES_CONTACTED"),
      ]),
    });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });

    expect(await screen.findByText("Respostas do grupo")).toBeOnTheScreen();
    expect(screen.getByText("Maria")).toBeOnTheScreen();
    expect(screen.getByText("Está indo ajudar")).toBeOnTheScreen();
    expect(screen.getByText("João")).toBeOnTheScreen();
    expect(screen.getByText("Viu o alerta")).toBeOnTheScreen();
    expect(screen.getByText("Ana")).toBeOnTheScreen();
    expect(screen.getByText("Acionou serviço de emergência")).toBeOnTheScreen();

    expect(screen.queryByText("ESTOU INDO AJUDAR")).not.toBeOnTheScreen();
    expect(screen.getByText("ESTOU EM SEGURANÇA")).toBeOnTheScreen();
    expect(api.setAcknowledgement).not.toHaveBeenCalled();
  });

  it("responder atualiza a lista e destaca a resposta atual", async () => {
    const api = createMockApi({
      getAlert: jest.fn(async () => memberAlert()),
      listAcknowledgements: jest
        .fn()
        .mockResolvedValue([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([ack(member, "SEEN")])
        .mockResolvedValue([ack(member, "GOING_TO_HELP")]),
    });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });
    await screen.findByText("ESTOU INDO AJUDAR");

    await fireEvent.press(screen.getByText("ESTOU INDO AJUDAR"));

    await waitFor(() =>
      expect(api.setAcknowledgement).toHaveBeenCalledWith("alert-1", "GOING_TO_HELP"),
    );
    expect(await screen.findByText("Está indo ajudar")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "ESTOU INDO AJUDAR" })).toBeSelected();
  });

  it("erro da API ao responder é exibido em pt-BR", async () => {
    const api = createMockApi({
      getAlert: jest.fn(async () => memberAlert()),
      setAcknowledgement: jest
        .fn()
        .mockResolvedValueOnce(ack(member, "SEEN"))
        .mockRejectedValueOnce(new ApiError("ALERT_NOT_ACTIVE", "conflict", 409)),
    });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });
    await screen.findByText("ACIONEI EMERGÊNCIA");
    await waitFor(() => expect(api.setAcknowledgement).toHaveBeenCalledTimes(1));

    await fireEvent.press(screen.getByText("ACIONEI EMERGÊNCIA"));
    expect(await screen.findByText("Este alerta não está mais ativo.")).toBeOnTheScreen();
  });

  it("alerta encerrado desabilita as ações e não envia SEEN", async () => {
    const api = createMockApi({
      getAlert: jest.fn(async () =>
        memberAlert({ status: "RESOLVED", resolvedAt: "2026-09-11T21:00:00.000Z" }),
      ),
    });
    await renderWithAuth(<AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />, { api });

    expect(await screen.findByText("Alerta resolvido")).toBeOnTheScreen();
    expect(screen.getByRole("button", { name: "ESTOU INDO AJUDAR" })).toBeDisabled();
    expect(
      screen.getByText("O alerta foi encerrado. Novas respostas não são aceitas."),
    ).toBeOnTheScreen();
    expect(api.setAcknowledgement).not.toHaveBeenCalled();
  });

  it("eventos realtime deste alerta recarregam detalhe e respostas; de outro alerta são ignorados", async () => {
    const api = createMockApi({
      getAlert: jest
        .fn()
        .mockResolvedValueOnce(makeAlert())
        .mockResolvedValue(
          makeAlert({ status: "RESOLVED", resolvedAt: "2026-09-11T21:00:00.000Z" }),
        ),
      listAcknowledgements: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([ack({ id: "u-maria", name: "Maria" }, "GOING_TO_HELP")]),
    });
    const realtime = createMockRealtime();
    await render(
      <AuthContext.Provider value={createAuthValue(api)}>
        <RealtimeContext.Provider value={realtime}>
          <AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />
        </RealtimeContext.Provider>
      </AuthContext.Provider>,
    );
    expect(await screen.findByText("🚨 Alerta ativo")).toBeOnTheScreen();

    realtime.emit({
      version: 1,
      type: "ALERT_ACKNOWLEDGEMENT_CHANGED",
      eventId: "e-other",
      occurredAt: "2026-09-11T20:40:00.000Z",
      data: { alertId: "outro-alerta", groupId: "group-1", userId: "u-maria" },
    });
    expect(api.getAlert).toHaveBeenCalledTimes(1);

    realtime.emit({
      version: 1,
      type: "ALERT_RESOLVED",
      eventId: "e-resolved",
      occurredAt: "2026-09-11T21:00:00.000Z",
      data: { alertId: "alert-1", groupId: "group-1" },
    });
    expect(await screen.findByText("Alerta resolvido")).toBeOnTheScreen();
    expect(await screen.findByText("Está indo ajudar")).toBeOnTheScreen();
    expect(api.getAlert).toHaveBeenCalledTimes(2);
    expect(api.listAcknowledgements).toHaveBeenCalledTimes(2);
  });

  it("ressincronização (reconexão) recarrega pela API", async () => {
    const api = createMockApi({
      getAlert: jest
        .fn()
        .mockResolvedValueOnce(makeAlert())
        .mockResolvedValue(
          makeAlert({ status: "CANCELLED", cancelledAt: "2026-09-11T21:00:00.000Z" }),
        ),
    });
    const realtime = createMockRealtime({ resyncVersion: 1 });
    const tree = (value: typeof realtime) => (
      <AuthContext.Provider value={createAuthValue(api)}>
        <RealtimeContext.Provider value={value}>
          <AlertDetailsScreen nav={createMockNav()} alertId="alert-1" />
        </RealtimeContext.Provider>
      </AuthContext.Provider>
    );
    const view = await render(tree(realtime));
    expect(await screen.findByText("🚨 Alerta ativo")).toBeOnTheScreen();

    await view.rerender(tree({ ...realtime, resyncVersion: 2 }));
    expect(await screen.findByText("Alerta cancelado")).toBeOnTheScreen();
    expect(api.getAlert).toHaveBeenCalledTimes(2);
  });
});
