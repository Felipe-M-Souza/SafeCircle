import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../../auth/AuthContext";
import { ApiError, type SafeJourney } from "../../../lib/api";
import { resetLiveLocationRegistry } from "../../../live-location/LiveLocationController";
import { RealtimeContext } from "../../../realtime/RealtimeProvider";
import {
  createAuthValue,
  createMockApi,
  createMockNav,
  createMockRealtime,
  renderWithAuth,
  testUser,
} from "../../../test-utils/renderWithAuth";
import { JourneyDetailsScreen } from "../JourneyDetailsScreen";

const NOW = new Date("2026-09-12T21:00:00.000Z");

function journey(overrides: Partial<SafeJourney> = {}): SafeJourney {
  return {
    id: "journey-1",
    groupId: "group-1",
    groupName: "Família",
    user: { id: testUser.id, name: testUser.name },
    status: "ACTIVE",
    destinationLabel: "Casa",
    expectedArrivalAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    liveLocationEnabled: false,
    startedAt: NOW.toISOString(),
    arrivedAt: null,
    cancelledAt: null,
    overdueAt: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}
const other = { id: "user-2", name: "Maria" };

describe("JourneyDetailsScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    resetLiveLocationRegistry();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("dono com trajeto ativo: status, contador, destino, CHEGUEI EM SEGURANÇA e cancelar com confirmação", async () => {
    const api = createMockApi({
      getJourney: jest.fn(async () => journey()),
      arriveJourney: jest.fn(async () =>
        journey({ status: "ARRIVED", arrivedAt: new Date(NOW.getTime() + 60_000).toISOString() }),
      ),
    });
    await renderWithAuth(<JourneyDetailsScreen nav={createMockNav()} journeyId="journey-1" />, {
      api,
    });

    expect(await screen.findByText("A caminho")).toBeOnTheScreen();
    expect(screen.getByText("Faltam 10 min")).toBeOnTheScreen();
    expect(screen.getByText("Casa")).toBeOnTheScreen();
    expect(screen.getByText("Localização não compartilhada neste trajeto.")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("CANCELAR TRAJETO"));
    expect(screen.getByText("Sim, cancelar")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Manter trajeto"));

    await fireEvent.press(screen.getByText("CHEGUEI EM SEGURANÇA"));
    expect(await screen.findByText("Chegada confirmada com segurança.")).toBeOnTheScreen();
    expect(
      screen.getByText("Chegada confirmada com segurança. Seu grupo foi atualizado."),
    ).toBeOnTheScreen();
    expect(api.arriveJourney).toHaveBeenCalledWith("journey-1");
  });

  it("contador zerado consulta o backend e não muda status sem o servidor", async () => {
    const soon = journey({ expectedArrivalAt: new Date(NOW.getTime() + 3000).toISOString() });
    const api = createMockApi({
      getJourney: jest.fn().mockResolvedValueOnce(soon).mockResolvedValue(soon),
    });
    await renderWithAuth(<JourneyDetailsScreen nav={createMockNav()} journeyId="journey-1" />, {
      api,
    });
    expect(await screen.findByText("Faltam 3 s")).toBeOnTheScreen();

    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await waitFor(() => expect(api.getJourney).toHaveBeenCalledTimes(2));
    expect(screen.getByText("A caminho")).toBeOnTheScreen();
    expect(
      screen.getByText("Prazo encerrado. Aguardando confirmação do servidor..."),
    ).toBeOnTheScreen();
  });

  it("dono em OVERDUE confirma chegada (OVERDUE -> ARRIVED)", async () => {
    const api = createMockApi({
      getJourney: jest.fn(async () => journey({ status: "OVERDUE", overdueAt: NOW.toISOString() })),
      arriveJourney: jest.fn(async () =>
        journey({ status: "ARRIVED", overdueAt: NOW.toISOString(), arrivedAt: NOW.toISOString() }),
      ),
    });
    await renderWithAuth(<JourneyDetailsScreen nav={createMockNav()} journeyId="journey-1" />, {
      api,
    });
    expect(await screen.findByText("Chegada não confirmada")).toBeOnTheScreen();
    expect(screen.getByText("O prazo esperado passou sem confirmação.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("CHEGUEI EM SEGURANÇA"));
    expect(await screen.findByText("Chegada confirmada com segurança.")).toBeOnTheScreen();
  });

  it("membro vê o vencimento com linguagem honesta e sem botões do dono", async () => {
    const api = createMockApi({
      getJourney: jest.fn(async () =>
        journey({ user: other, status: "OVERDUE", overdueAt: NOW.toISOString() }),
      ),
    });
    await renderWithAuth(<JourneyDetailsScreen nav={createMockNav()} journeyId="journey-1" />, {
      api,
    });
    expect(await screen.findByText("Chegada não confirmada")).toBeOnTheScreen();
    expect(
      screen.getByText("O prazo de chegada de Maria passou sem confirmação."),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Isso não confirma uma emergência. Tente entrar em contato de forma segura.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("CHEGUEI EM SEGURANÇA")).not.toBeOnTheScreen();
    expect(screen.queryByText(/perigo/i)).not.toBeOnTheScreen();
  });

  it("evento realtime do trajeto e ressincronização recarregam via REST; erro em pt-BR", async () => {
    const api = createMockApi({
      getJourney: jest
        .fn()
        .mockResolvedValueOnce(journey({ user: other }))
        .mockResolvedValue(
          journey({ user: other, status: "ARRIVED", arrivedAt: NOW.toISOString() }),
        ),
    });
    const realtime = createMockRealtime({ resyncVersion: 1 });
    const tree = (value: typeof realtime) => (
      <AuthContext.Provider value={createAuthValue(api)}>
        <RealtimeContext.Provider value={value}>
          <JourneyDetailsScreen nav={createMockNav()} journeyId="journey-1" />
        </RealtimeContext.Provider>
      </AuthContext.Provider>
    );
    const view = await render(tree(realtime));
    expect(await screen.findByText("A caminho")).toBeOnTheScreen();

    // Evento de localização NÃO recarrega o trajeto (tratado pela seção).
    await act(async () =>
      realtime.emit({
        version: 1,
        type: "JOURNEY_LOCATION_UPDATED",
        eventId: "e0",
        occurredAt: NOW.toISOString(),
        data: { journeyId: "journey-1", groupId: "group-1", userId: "user-2" },
      }),
    );
    expect(api.getJourney).toHaveBeenCalledTimes(1);

    await act(async () =>
      realtime.emit({
        version: 1,
        type: "JOURNEY_ARRIVED",
        eventId: "e1",
        occurredAt: NOW.toISOString(),
        data: { journeyId: "journey-1", groupId: "group-1", userId: "user-2" },
      }),
    );
    expect(await screen.findByText("Chegada confirmada com segurança.")).toBeOnTheScreen();

    await view.rerender(tree({ ...realtime, resyncVersion: 2 }));
    await waitFor(() => expect(api.getJourney).toHaveBeenCalledTimes(3));
  });

  it("trajeto inacessível mostra erro em pt-BR", async () => {
    const api = createMockApi({
      getJourney: jest.fn(async () => {
        throw new ApiError("JOURNEY_NOT_FOUND", "x", 404);
      }),
    });
    await renderWithAuth(<JourneyDetailsScreen nav={createMockNav()} journeyId="x" />, { api });
    expect(await screen.findByText("Trajeto não encontrado.")).toBeOnTheScreen();
  });
});
