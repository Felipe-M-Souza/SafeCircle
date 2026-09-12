import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../auth/AuthContext";
import { ApiError, type SafetyCheckin } from "../../lib/api";
import { RealtimeContext } from "../../realtime/RealtimeProvider";
import {
  createAuthValue,
  createMockApi,
  createMockNav,
  createMockRealtime,
  renderWithAuth,
  testUser,
} from "../../test-utils/renderWithAuth";
import { CheckinsHomeSection } from "../CheckinsHomeSection";

const NOW = new Date("2026-09-12T21:00:00.000Z");

function checkin(overrides: Partial<SafetyCheckin> = {}): SafetyCheckin {
  return {
    id: "checkin-1",
    groupId: "group-1",
    groupName: "Família",
    user: { id: testUser.id, name: testUser.name },
    status: "ACTIVE",
    dueAt: new Date(NOW.getTime() + 24 * 60 * 1000).toISOString(),
    confirmedAt: null,
    cancelledAt: null,
    overdueAt: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

/** listMyCheckins responde por status: ACTIVE e OVERDUE. */
function listByStatus(active: SafetyCheckin[], overdue: SafetyCheckin[] = []) {
  return jest.fn(async (status?: string) => (status === "OVERDUE" ? overdue : active));
}

describe("CheckinsHomeSection", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("sem check-in ativo: explica e oferece INICIAR CHECK-IN", async () => {
    const api = createMockApi({ listMyCheckins: listByStatus([]) });
    const nav = createMockNav();
    await renderWithAuth(<CheckinsHomeSection nav={nav} />, { api });

    expect(await screen.findByText("Check-in de segurança")).toBeOnTheScreen();
    expect(
      screen.getByText(
        "Avise seu grupo que você pretende confirmar que está bem até um determinado horário.",
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("INICIAR CHECK-IN"));
    expect(nav.navigate).toHaveBeenCalledWith({ name: "newCheckin" });
  });

  it("com check-in ativo: mostra grupo, prazo e contador visual; ESTOU BEM confirma via API", async () => {
    const api = createMockApi({
      listMyCheckins: listByStatus([checkin()]),
      confirmCheckinSafe: jest.fn(async () => checkin({ status: "SAFE" })),
    });
    await renderWithAuth(<CheckinsHomeSection nav={createMockNav()} />, { api });

    expect(await screen.findByText("Check-in ativo")).toBeOnTheScreen();
    expect(screen.getByText("Família")).toBeOnTheScreen();
    expect(screen.getByText(/^Confirme até \d{2}:\d{2}$/)).toBeOnTheScreen();
    expect(screen.getByText("Faltam 24 min")).toBeOnTheScreen();

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Faltam 23 min")).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("ESTOU BEM"));
    await waitFor(() => expect(api.confirmCheckinSafe).toHaveBeenCalledWith("checkin-1"));
    await waitFor(() => expect(api.listMyCheckins).toHaveBeenCalledTimes(4));
  });

  it("contador zerado consulta o backend e NÃO marca vencido localmente", async () => {
    const soon = checkin({ dueAt: new Date(NOW.getTime() + 5000).toISOString() });
    const api = createMockApi({ listMyCheckins: listByStatus([soon]) });
    await renderWithAuth(<CheckinsHomeSection nav={createMockNav()} />, { api });
    expect(await screen.findByText("Faltam 5 s")).toBeOnTheScreen();
    expect(api.listMyCheckins).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(6000);
    });
    expect(
      screen.getByText("Prazo encerrado. Aguardando confirmação do servidor..."),
    ).toBeOnTheScreen();
    // Continua "Check-in ativo" até o servidor dizer o contrário.
    expect(screen.getByText("Check-in ativo")).toBeOnTheScreen();
    expect(screen.queryByText("Check-in não confirmado")).not.toBeOnTheScreen();
    await waitFor(() => expect(api.listMyCheckins).toHaveBeenCalledTimes(4));
  });

  it("cancelar exige confirmação", async () => {
    const api = createMockApi({
      listMyCheckins: listByStatus([checkin()]),
      cancelCheckin: jest.fn(async () => checkin({ status: "CANCELLED" })),
    });
    await renderWithAuth(<CheckinsHomeSection nav={createMockNav()} />, { api });
    await fireEvent.press(await screen.findByText("CANCELAR CHECK-IN"));
    expect(api.cancelCheckin).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText("Manter check-in"));
    await fireEvent.press(screen.getByText("CANCELAR CHECK-IN"));
    await fireEvent.press(screen.getByText("Sim, cancelar"));
    await waitFor(() => expect(api.cancelCheckin).toHaveBeenCalledWith("checkin-1"));
  });

  it("check-in vencido do dono: aviso e ESTOU BEM; erro da API em pt-BR", async () => {
    const api = createMockApi({
      listMyCheckins: listByStatus(
        [],
        [checkin({ status: "OVERDUE", overdueAt: NOW.toISOString() })],
      ),
      confirmCheckinSafe: jest.fn(async () => {
        throw new ApiError("INVALID_CHECKIN_TRANSITION", "x", 409);
      }),
    });
    await renderWithAuth(<CheckinsHomeSection nav={createMockNav()} />, { api });
    expect(await screen.findByText("Check-in não confirmado")).toBeOnTheScreen();
    expect(screen.getByText("Seu check-in venceu sem confirmação.")).toBeOnTheScreen();
    expect(screen.queryByText("CANCELAR CHECK-IN")).not.toBeOnTheScreen();

    await fireEvent.press(screen.getByText("ESTOU BEM"));
    expect(await screen.findByText("Este check-in já foi encerrado.")).toBeOnTheScreen();
  });

  it("eventos realtime de check-in recarregam via REST; eventos de alerta não", async () => {
    const api = createMockApi({ listMyCheckins: listByStatus([]) });
    const realtime = createMockRealtime();
    await render(
      <AuthContext.Provider value={createAuthValue(api)}>
        <RealtimeContext.Provider value={realtime}>
          <CheckinsHomeSection nav={createMockNav()} />
        </RealtimeContext.Provider>
      </AuthContext.Provider>,
    );
    await screen.findByText("INICIAR CHECK-IN");
    expect(api.listMyCheckins).toHaveBeenCalledTimes(2);

    await act(async () =>
      realtime.emit({
        version: 1,
        type: "ALERT_CREATED",
        eventId: "e0",
        occurredAt: NOW.toISOString(),
        data: { alertId: "a", groupId: "g" },
      }),
    );
    expect(api.listMyCheckins).toHaveBeenCalledTimes(2);

    await act(async () =>
      realtime.emit({
        version: 1,
        type: "CHECKIN_OVERDUE",
        eventId: "e1",
        occurredAt: NOW.toISOString(),
        data: { checkinId: "c", groupId: "g", userId: "u" },
      }),
    );
    await waitFor(() => expect(api.listMyCheckins).toHaveBeenCalledTimes(4));
  });
});
