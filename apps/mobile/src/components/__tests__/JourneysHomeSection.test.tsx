import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../auth/AuthContext";
import { ApiError, type SafeJourney } from "../../lib/api";
import { RealtimeContext } from "../../realtime/RealtimeProvider";
import {
  createAuthValue,
  createMockApi,
  createMockNav,
  createMockRealtime,
  renderWithAuth,
  testUser,
} from "../../test-utils/renderWithAuth";
import { JourneysHomeSection } from "../JourneysHomeSection";

const NOW = new Date("2026-09-12T21:00:00.000Z");

function journey(overrides: Partial<SafeJourney> = {}): SafeJourney {
  return {
    id: "journey-1",
    groupId: "group-1",
    groupName: "Família",
    user: { id: testUser.id, name: testUser.name },
    status: "ACTIVE",
    destinationLabel: "Casa",
    expectedArrivalAt: new Date(NOW.getTime() + 35 * 60 * 1000).toISOString(),
    liveLocationEnabled: false,
    startedAt: NOW.toISOString(),
    arrivedAt: null,
    cancelledAt: null,
    overdueAt: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function listByStatus(active: SafeJourney[], overdue: SafeJourney[] = []) {
  return jest.fn(async (status?: string) => (status === "OVERDUE" ? overdue : active));
}

describe("JourneysHomeSection", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("sem trajeto ativo: explica e oferece INICIAR TRAJETO", async () => {
    const api = createMockApi({ listMyJourneys: listByStatus([]) });
    const nav = createMockNav();
    await renderWithAuth(<JourneysHomeSection nav={nav} />, { api });

    expect(await screen.findByText("Trajeto seguro")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Compartilhe com seu grupo que você está a caminho e confirme quando chegar.",
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("INICIAR TRAJETO"));
    expect(nav.navigate).toHaveBeenCalledWith({ name: "newJourney" });
  });

  it("com trajeto ativo: destino, chegada prevista, contador; CHEGUEI EM SEGURANÇA confirma via API", async () => {
    const api = createMockApi({
      listMyJourneys: listByStatus([journey()]),
      arriveJourney: jest.fn(async () => journey({ status: "ARRIVED" })),
    });
    await renderWithAuth(<JourneysHomeSection nav={createMockNav()} />, { api });

    expect(await screen.findByText("Trajeto em andamento")).toBeOnTheScreen();
    expect(screen.getByText("Destino: Casa")).toBeOnTheScreen();
    expect(screen.getByText(/^Chegada prevista: \d{2}:\d{2}$/)).toBeOnTheScreen();
    expect(screen.getByText("Faltam 35 min")).toBeOnTheScreen();

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Faltam 34 min")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("CHEGUEI EM SEGURANÇA"));
    await waitFor(() => expect(api.arriveJourney).toHaveBeenCalledWith("journey-1"));
  });

  it("contador zerado consulta o backend e NÃO marca vencido localmente", async () => {
    const soon = journey({ expectedArrivalAt: new Date(NOW.getTime() + 5000).toISOString() });
    const api = createMockApi({ listMyJourneys: listByStatus([soon]) });
    await renderWithAuth(<JourneysHomeSection nav={createMockNav()} />, { api });
    expect(await screen.findByText("Faltam 5 s")).toBeOnTheScreen();
    expect(api.listMyJourneys).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(6000);
    });
    expect(
      screen.getByText("Prazo encerrado. Aguardando confirmação do servidor..."),
    ).toBeOnTheScreen();
    expect(screen.getByText("Trajeto em andamento")).toBeOnTheScreen();
    expect(screen.queryByText("Trajeto não confirmado")).not.toBeOnTheScreen();
    await waitFor(() => expect(api.listMyJourneys).toHaveBeenCalledTimes(4));
  });

  it("cancelar exige confirmação", async () => {
    const api = createMockApi({
      listMyJourneys: listByStatus([journey()]),
      cancelJourney: jest.fn(async () => journey({ status: "CANCELLED" })),
    });
    await renderWithAuth(<JourneysHomeSection nav={createMockNav()} />, { api });
    await fireEvent.press(await screen.findByText("CANCELAR TRAJETO"));
    expect(api.cancelJourney).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText("Manter trajeto"));
    await fireEvent.press(screen.getByText("CANCELAR TRAJETO"));
    await fireEvent.press(screen.getByText("Sim, cancelar"));
    await waitFor(() => expect(api.cancelJourney).toHaveBeenCalledWith("journey-1"));
  });

  it("trajeto vencido do dono: aviso e CHEGUEI EM SEGURANÇA; erro da API em pt-BR", async () => {
    const api = createMockApi({
      listMyJourneys: listByStatus(
        [],
        [journey({ status: "OVERDUE", overdueAt: NOW.toISOString() })],
      ),
      arriveJourney: jest.fn(async () => {
        throw new ApiError("INVALID_JOURNEY_TRANSITION", "x", 409);
      }),
    });
    await renderWithAuth(<JourneysHomeSection nav={createMockNav()} />, { api });
    expect(await screen.findByText("Trajeto não confirmado")).toBeOnTheScreen();
    expect(screen.getByText("O prazo esperado passou sem confirmação.")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("CHEGUEI EM SEGURANÇA"));
    expect(await screen.findByText("Este trajeto já foi encerrado.")).toBeOnTheScreen();
  });

  it("eventos realtime de trajeto recarregam via REST; eventos de alerta não", async () => {
    const api = createMockApi({ listMyJourneys: listByStatus([]) });
    const realtime = createMockRealtime();
    await render(
      <AuthContext.Provider value={createAuthValue(api)}>
        <RealtimeContext.Provider value={realtime}>
          <JourneysHomeSection nav={createMockNav()} />
        </RealtimeContext.Provider>
      </AuthContext.Provider>,
    );
    await screen.findByText("INICIAR TRAJETO");
    expect(api.listMyJourneys).toHaveBeenCalledTimes(2);

    await act(async () =>
      realtime.emit({
        version: 1,
        type: "ALERT_CREATED",
        eventId: "e0",
        occurredAt: NOW.toISOString(),
        data: { alertId: "a", groupId: "g" },
      }),
    );
    expect(api.listMyJourneys).toHaveBeenCalledTimes(2);

    await act(async () =>
      realtime.emit({
        version: 1,
        type: "JOURNEY_OVERDUE",
        eventId: "e1",
        occurredAt: NOW.toISOString(),
        data: { journeyId: "c", groupId: "g", userId: "u" },
      }),
    );
    await waitFor(() => expect(api.listMyJourneys).toHaveBeenCalledTimes(4));
  });
});
