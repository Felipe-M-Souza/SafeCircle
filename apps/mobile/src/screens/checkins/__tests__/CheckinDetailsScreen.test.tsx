import { AppState, type AppStateStatus } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../../auth/AuthContext";
import { ApiError, type SafetyCheckin } from "../../../lib/api";
import { RealtimeContext } from "../../../realtime/RealtimeProvider";
import {
  createAuthValue,
  createMockApi,
  createMockNav,
  createMockRealtime,
  renderWithAuth,
  testUser,
} from "../../../test-utils/renderWithAuth";
import { CheckinDetailsScreen } from "../CheckinDetailsScreen";

const NOW = new Date("2026-09-12T21:00:00.000Z");

function checkin(overrides: Partial<SafetyCheckin> = {}): SafetyCheckin {
  return {
    id: "checkin-1",
    groupId: "group-1",
    groupName: "Família",
    user: { id: testUser.id, name: testUser.name },
    status: "ACTIVE",
    dueAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
    confirmedAt: null,
    cancelledAt: null,
    overdueAt: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}
const other = { id: "user-2", name: "Maria" };

describe("CheckinDetailsScreen", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("dono com check-in ativo: status, contador visual, ESTOU BEM e cancelar com confirmação", async () => {
    const api = createMockApi({
      getCheckin: jest.fn(async () => checkin()),
      confirmCheckinSafe: jest.fn(async () =>
        checkin({ status: "SAFE", confirmedAt: new Date(NOW.getTime() + 60_000).toISOString() }),
      ),
    });
    await renderWithAuth(<CheckinDetailsScreen nav={createMockNav()} checkinId="checkin-1" />, {
      api,
    });

    expect(await screen.findByText("Aguardando confirmação")).toBeOnTheScreen();
    expect(screen.getByText("Faltam 10 min")).toBeOnTheScreen();
    expect(screen.getByText("Família")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("CANCELAR CHECK-IN"));
    expect(screen.getByText("Sim, cancelar")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Manter check-in"));

    await fireEvent.press(screen.getByText("ESTOU BEM"));
    expect(await screen.findByText("Confirmou que está bem")).toBeOnTheScreen();
    expect(
      screen.getByText("Você confirmou que está bem. Seu grupo foi atualizado."),
    ).toBeOnTheScreen();
    expect(screen.queryByText("ESTOU BEM")).not.toBeOnTheScreen();
    expect(api.confirmCheckinSafe).toHaveBeenCalledWith("checkin-1");
  });

  it("contador zerado consulta o backend e só muda quando o servidor devolve OVERDUE", async () => {
    const soon = checkin({ dueAt: new Date(NOW.getTime() + 3000).toISOString() });
    const api = createMockApi({
      getCheckin: jest
        .fn()
        .mockResolvedValueOnce(soon)
        .mockResolvedValueOnce(soon) // ainda ACTIVE segundo o servidor
        .mockResolvedValue(checkin({ ...soon, status: "OVERDUE", overdueAt: NOW.toISOString() })),
    });
    await renderWithAuth(<CheckinDetailsScreen nav={createMockNav()} checkinId="checkin-1" />, {
      api,
    });
    expect(await screen.findByText("Faltam 3 s")).toBeOnTheScreen();

    await act(async () => {
      jest.advanceTimersByTime(4000);
    });
    await waitFor(() => expect(api.getCheckin).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Aguardando confirmação")).toBeOnTheScreen();
    expect(
      screen.getByText("Prazo encerrado. Aguardando confirmação do servidor..."),
    ).toBeOnTheScreen();

    // O estado autoritativo chega por realtime/ressincronização (aqui: AppState ativo).
    const handlers: Array<(s: AppStateStatus) => void> = [];
    jest.spyOn(AppState, "addEventListener").mockImplementation((_t, h) => {
      handlers.push(h as (s: AppStateStatus) => void);
      return { remove: jest.fn() };
    });
    // Remonta para capturar o listener com o spy.
    const view = await renderWithAuth(
      <CheckinDetailsScreen nav={createMockNav()} checkinId="checkin-1" />,
      { api },
    );
    await act(async () => {
      for (const h of handlers) h("active");
    });
    expect(await screen.findByText("O prazo venceu sem confirmação")).toBeOnTheScreen();
    expect(screen.getByText("Seu check-in venceu sem confirmação.")).toBeOnTheScreen();
    await view.unmount();
  });

  it("dono em OVERDUE confirma ESTOU BEM (OVERDUE -> SAFE); sem cancelar", async () => {
    const api = createMockApi({
      getCheckin: jest.fn(async () => checkin({ status: "OVERDUE", overdueAt: NOW.toISOString() })),
      confirmCheckinSafe: jest.fn(async () =>
        checkin({ status: "SAFE", overdueAt: NOW.toISOString(), confirmedAt: NOW.toISOString() }),
      ),
    });
    await renderWithAuth(<CheckinDetailsScreen nav={createMockNav()} checkinId="checkin-1" />, {
      api,
    });
    expect(await screen.findByText("O prazo venceu sem confirmação")).toBeOnTheScreen();
    expect(screen.queryByText("CANCELAR CHECK-IN")).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByText("ESTOU BEM"));
    expect(await screen.findByText("Confirmou que está bem")).toBeOnTheScreen();
  });

  it("membro vê o vencimento com linguagem honesta e sem botões do dono", async () => {
    const api = createMockApi({
      getCheckin: jest.fn(async () =>
        checkin({ user: other, status: "OVERDUE", overdueAt: NOW.toISOString() }),
      ),
    });
    await renderWithAuth(<CheckinDetailsScreen nav={createMockNav()} checkinId="checkin-1" />, {
      api,
    });
    expect(await screen.findByText("Check-in não confirmado")).toBeOnTheScreen();
    expect(screen.getByText("O prazo de Maria venceu sem confirmação.")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Isso não confirma uma emergência. Tente entrar em contato de forma segura.",
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Se houver indícios de risco imediato, considere acionar os serviços oficiais de emergência.",
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText("ESTOU BEM")).not.toBeOnTheScreen();
    expect(screen.queryByText(/perigo/i)).not.toBeOnTheScreen();
  });

  it("evento realtime do check-in e ressincronização recarregam via REST; erro em pt-BR", async () => {
    const api = createMockApi({
      getCheckin: jest
        .fn()
        .mockResolvedValueOnce(checkin({ user: other }))
        .mockResolvedValue(
          checkin({ user: other, status: "SAFE", confirmedAt: NOW.toISOString() }),
        ),
    });
    const realtime = createMockRealtime({ resyncVersion: 1 });
    const tree = (value: typeof realtime) => (
      <AuthContext.Provider value={createAuthValue(api)}>
        <RealtimeContext.Provider value={value}>
          <CheckinDetailsScreen nav={createMockNav()} checkinId="checkin-1" />
        </RealtimeContext.Provider>
      </AuthContext.Provider>
    );
    const view = await render(tree(realtime));
    expect(await screen.findByText("Aguardando confirmação")).toBeOnTheScreen();

    await act(async () =>
      realtime.emit({
        version: 1,
        type: "CHECKIN_SAFE",
        eventId: "e1",
        occurredAt: NOW.toISOString(),
        data: { checkinId: "outro", groupId: "group-1", userId: "user-2" },
      }),
    );
    expect(api.getCheckin).toHaveBeenCalledTimes(1);

    await act(async () =>
      realtime.emit({
        version: 1,
        type: "CHECKIN_SAFE",
        eventId: "e2",
        occurredAt: NOW.toISOString(),
        data: { checkinId: "checkin-1", groupId: "group-1", userId: "user-2" },
      }),
    );
    expect(await screen.findByText("Confirmou que está bem")).toBeOnTheScreen();

    await view.rerender(tree({ ...realtime, resyncVersion: 2 }));
    await waitFor(() => expect(api.getCheckin).toHaveBeenCalledTimes(3));
  });

  it("check-in inacessível mostra erro em pt-BR", async () => {
    const api = createMockApi({
      getCheckin: jest.fn(async () => {
        throw new ApiError("CHECKIN_NOT_FOUND", "x", 404);
      }),
    });
    await renderWithAuth(<CheckinDetailsScreen nav={createMockNav()} checkinId="x" />, { api });
    expect(await screen.findByText("Check-in não encontrado.")).toBeOnTheScreen();
  });
});
