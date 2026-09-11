import { render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../../auth/AuthContext";
import { RealtimeContext } from "../../../realtime/RealtimeProvider";
import {
  createAuthValue,
  createMockApi,
  createMockNav,
  createMockRealtime,
  makeAlert,
} from "../../../test-utils/renderWithAuth";
import { ActiveAlertsScreen } from "../ActiveAlertsScreen";

const created = {
  version: 1 as const,
  type: "ALERT_CREATED" as const,
  eventId: "evt-1",
  occurredAt: "2026-09-11T20:30:00.000Z",
  data: { alertId: "alert-2", groupId: "group-1" },
};

describe("ActiveAlertsScreen — tempo real", () => {
  it("ALERT_CREATED recarrega a lista pela API; evento de grupo não", async () => {
    const api = createMockApi({
      listAlerts: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeAlert({ id: "alert-2", createdBy: { id: "u2", name: "Ana" } }),
        ]),
    });
    const realtime = createMockRealtime();
    await render(
      <AuthContext.Provider value={createAuthValue(api)}>
        <RealtimeContext.Provider value={realtime}>
          <ActiveAlertsScreen nav={createMockNav()} />
        </RealtimeContext.Provider>
      </AuthContext.Provider>,
    );
    expect(await screen.findByText("Nenhum alerta ativo nos seus grupos.")).toBeOnTheScreen();

    realtime.emit({
      ...created,
      type: "GROUP_MEMBERSHIP_CHANGED",
      data: { groupId: "g", userId: "u" },
    });
    expect(api.listAlerts).toHaveBeenCalledTimes(1);

    realtime.emit(created);
    expect(await screen.findByText("🚨 Ana")).toBeOnTheScreen();
    expect(api.listAlerts).toHaveBeenCalledTimes(2);
  });

  it("evento perdido durante desconexão é recuperado na ressincronização via REST", async () => {
    // Enquanto desconectado, um alerta foi criado (nenhum evento chegou).
    const api = createMockApi({
      listAlerts: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          makeAlert({ id: "alert-lost", createdBy: { id: "u2", name: "Bruno" } }),
        ]),
    });
    const disconnected = createMockRealtime({ state: "RECONNECTING", resyncVersion: 1 });
    const tree = (realtime: typeof disconnected) => (
      <AuthContext.Provider value={createAuthValue(api)}>
        <RealtimeContext.Provider value={realtime}>
          <ActiveAlertsScreen nav={createMockNav()} />
        </RealtimeContext.Provider>
      </AuthContext.Provider>
    );
    const view = await render(tree(disconnected));
    expect(await screen.findByText("Nenhum alerta ativo nos seus grupos.")).toBeOnTheScreen();
    expect(screen.getByText("Reconectando às atualizações em tempo real...")).toBeOnTheScreen();

    // Reconectou: resyncVersion incrementa → GET /alerts?status=ACTIVE → estado correto.
    await view.rerender(tree({ ...disconnected, state: "CONNECTED", resyncVersion: 2 }));
    expect(await screen.findByText("🚨 Bruno")).toBeOnTheScreen();
    await waitFor(() => expect(api.listAlerts).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText("Reconectando às atualizações em tempo real..."),
    ).not.toBeOnTheScreen();
  });
});
