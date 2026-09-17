import * as Location from "expo-location";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AuthContext } from "../../auth/AuthContext";
import type { LiveLocationPoint, LiveLocationState } from "../../lib/api";
import { resetLiveLocationRegistry } from "../../live-location/LiveLocationController";
import { RealtimeContext } from "../../realtime/RealtimeProvider";
import {
  createAuthValue,
  createMockApi,
  createMockRealtime,
  makeAlert,
  renderWithAuth,
  testUser,
} from "../../test-utils/renderWithAuth";
import { LiveLocationSection } from "../LiveLocationSection";

const NOW = new Date("2026-09-11T20:10:00.000Z");
const getPermissions = jest.mocked(Location.getForegroundPermissionsAsync);
const requestPermissions = jest.mocked(Location.requestForegroundPermissionsAsync);
const servicesEnabled = jest.mocked(Location.hasServicesEnabledAsync);
// Phase 13: o compartilhamento usa o stream do SO (serviço em primeiro plano),
// não mais o watcher de primeiro plano.
const startUpdates = jest.mocked(Location.startLocationUpdatesAsync);

type PermissionResponse = Awaited<ReturnType<typeof Location.getForegroundPermissionsAsync>>;
const granted = { status: "granted", canAskAgain: true } as PermissionResponse;
const denied = { status: "denied", canAskAgain: true } as PermissionResponse;

// Coordenadas SINTÉTICAS.
function point(secondsAgo: number): LiveLocationPoint {
  const at = new Date(NOW.getTime() - secondsAgo * 1000).toISOString();
  return {
    latitude: -23,
    longitude: -46,
    accuracy: 12,
    altitude: null,
    heading: null,
    speed: null,
    capturedAt: at,
    receivedAt: at,
  };
}

function liveState(
  status: LiveLocationState["status"],
  latest: LiveLocationPoint | null,
): LiveLocationState {
  return {
    status,
    sessionId: status === "INACTIVE" ? null : "session-1",
    startedAt: status === "INACTIVE" ? null : "2026-09-11T20:00:00.000Z",
    stoppedAt: status === "STOPPED" ? "2026-09-11T20:09:00.000Z" : null,
    latest,
  };
}

const inactive = liveState("INACTIVE", null);
const creatorAlert = () => makeAlert(); // criado pelo testUser
const memberAlert = () => makeAlert({ createdBy: { id: "user-creator", name: "Felipe" } });

describe("LiveLocationSection", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest.clearAllMocks();
    resetLiveLocationRegistry();
    getPermissions.mockResolvedValue(granted);
    requestPermissions.mockResolvedValue(granted);
    servicesEnabled.mockResolvedValue(true);
    startUpdates.mockResolvedValue(undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe("criador — opt-in", () => {
    it("mostra a CTA, exige consentimento explícito e inicia a sessão ao confirmar", async () => {
      const api = createMockApi({
        getLiveLocation: jest.fn(async () => inactive),
        getLiveLocationHistory: jest.fn(async () => ({ sessionId: null, points: [] })),
        startLiveLocation: jest.fn(async () => ({
          sessionId: "session-1",
          status: "ACTIVE" as const,
          startedAt: NOW.toISOString(),
          stoppedAt: null,
        })),
      });
      await renderWithAuth(<LiveLocationSection alert={creatorAlert()} isCreator />, { api });

      expect(await screen.findByText("Localização ao vivo")).toBeOnTheScreen();
      expect(
        screen.getByText("Compartilhe sua posição enquanto este alerta estiver ativo."),
      ).toBeOnTheScreen();
      await fireEvent.press(screen.getByText("ATIVAR LOCALIZAÇÃO AO VIVO"));
      expect(api.startLiveLocation).not.toHaveBeenCalled();
      expect(
        screen.getByText(/Sua localização será compartilhada apenas com os membros/),
      ).toBeOnTheScreen();
      expect(
        screen.getByText(/interromper o compartilhamento a qualquer momento/),
      ).toBeOnTheScreen();

      // "Agora não" volta sem pedir permissão.
      await fireEvent.press(screen.getByText("Agora não"));
      expect(requestPermissions).not.toHaveBeenCalled();
      expect(screen.getByText("ATIVAR LOCALIZAÇÃO AO VIVO")).toBeOnTheScreen();

      await fireEvent.press(screen.getByText("ATIVAR LOCALIZAÇÃO AO VIVO"));
      await fireEvent.press(screen.getByText("Compartilhar"));

      await waitFor(() => expect(api.startLiveLocation).toHaveBeenCalledWith("alert-1"));
      expect(await screen.findByText("Ativa")).toBeOnTheScreen();
      expect(
        screen.getByText(
          "Seu grupo pode ver sua localização enquanto o compartilhamento estiver ativo.",
        ),
      ).toBeOnTheScreen();
      expect(screen.getByText("PARAR LOCALIZAÇÃO AO VIVO")).toBeOnTheScreen();
      expect(startUpdates).toHaveBeenCalledTimes(1);
    });

    it("permissão negada: mensagem clara, nada inicia e a CTA continua disponível", async () => {
      getPermissions.mockResolvedValue(denied);
      requestPermissions.mockResolvedValue(denied);
      const api = createMockApi({
        getLiveLocation: jest.fn(async () => inactive),
        getLiveLocationHistory: jest.fn(async () => ({ sessionId: null, points: [] })),
      });
      await renderWithAuth(<LiveLocationSection alert={creatorAlert()} isCreator />, { api });

      await fireEvent.press(await screen.findByText("ATIVAR LOCALIZAÇÃO AO VIVO"));
      await fireEvent.press(screen.getByText("Compartilhar"));

      expect(
        await screen.findByText(/Não foi possível ativar a localização ao vivo/),
      ).toBeOnTheScreen();
      expect(screen.getByText(/continuar usando o alerta normalmente/)).toBeOnTheScreen();
      expect(api.startLiveLocation).not.toHaveBeenCalled();
      expect(startUpdates).not.toHaveBeenCalled();
      expect(screen.getByText("ATIVAR LOCALIZAÇÃO AO VIVO")).toBeOnTheScreen();
    });

    it("parar exige confirmação e avisa o backend", async () => {
      const api = createMockApi({
        getLiveLocation: jest.fn(async () => inactive),
        getLiveLocationHistory: jest.fn(async () => ({ sessionId: null, points: [] })),
        startLiveLocation: jest.fn(async () => ({
          sessionId: "session-1",
          status: "ACTIVE" as const,
          startedAt: NOW.toISOString(),
          stoppedAt: null,
        })),
        stopLiveLocation: jest.fn(async () => liveState("STOPPED", null)),
      });
      await renderWithAuth(<LiveLocationSection alert={creatorAlert()} isCreator />, { api });
      await fireEvent.press(await screen.findByText("ATIVAR LOCALIZAÇÃO AO VIVO"));
      await fireEvent.press(screen.getByText("Compartilhar"));
      await screen.findByText("PARAR LOCALIZAÇÃO AO VIVO");

      await fireEvent.press(screen.getByText("PARAR LOCALIZAÇÃO AO VIVO"));
      expect(api.stopLiveLocation).not.toHaveBeenCalled();
      await fireEvent.press(screen.getByText("Continuar compartilhando"));
      expect(screen.queryByText("Sim, parar")).not.toBeOnTheScreen();

      await fireEvent.press(screen.getByText("PARAR LOCALIZAÇÃO AO VIVO"));
      await fireEvent.press(screen.getByText("Sim, parar"));
      await waitFor(() => expect(api.stopLiveLocation).toHaveBeenCalledWith("alert-1"));
      expect(await screen.findByText("ATIVAR LOCALIZAÇÃO AO VIVO")).toBeOnTheScreen();
    });

    it("alerta encerrado: sem CTA de ativação", async () => {
      const api = createMockApi({
        getLiveLocation: jest.fn(async () => inactive),
        getLiveLocationHistory: jest.fn(async () => ({ sessionId: null, points: [] })),
      });
      await renderWithAuth(<LiveLocationSection alert={creatorAlert()} isCreator={false} />, {
        api,
      });
      expect(await screen.findByText("Localização ao vivo")).toBeOnTheScreen();
      expect(screen.queryByText("ATIVAR LOCALIZAÇÃO AO VIVO")).not.toBeOnTheScreen();
    });
  });

  describe("membro — visualização", () => {
    it("sem compartilhamento: não há CTA e informa que o usuário não está compartilhando", async () => {
      const api = createMockApi({
        getLiveLocation: jest.fn(async () => inactive),
        getLiveLocationHistory: jest.fn(async () => ({ sessionId: null, points: [] })),
      });
      await renderWithAuth(<LiveLocationSection alert={memberAlert()} isCreator={false} />, {
        api,
      });
      expect(
        await screen.findByText("O usuário não está compartilhando localização ao vivo."),
      ).toBeOnTheScreen();
      expect(screen.queryByText("ATIVAR LOCALIZAÇÃO AO VIVO")).not.toBeOnTheScreen();
      expect(screen.queryByTestId("live-location-map")).not.toBeOnTheScreen();
    });

    it("ativa com posição: mapa, marcador, precisão honesta e última atualização", async () => {
      const latest = point(10);
      const api = createMockApi({
        getLiveLocation: jest.fn(async () => liveState("ACTIVE", latest)),
        getLiveLocationHistory: jest.fn(async () => ({
          sessionId: "session-1",
          points: [point(40), point(25), latest],
        })),
      });
      await renderWithAuth(<LiveLocationSection alert={memberAlert()} isCreator={false} />, {
        api,
      });

      expect(await screen.findByText("Ativa")).toBeOnTheScreen();
      expect(screen.getByTestId("live-location-map")).toBeOnTheScreen();
      expect(screen.getByTestId("live-location-marker")).toBeOnTheScreen();
      expect(screen.getByTestId("live-location-trail")).toBeOnTheScreen();
      expect(screen.getByText("Última atualização há 10 s")).toBeOnTheScreen();
      expect(screen.getByText("Precisão aproximada: 12 m")).toBeOnTheScreen();
      // Coordenadas cruas não aparecem como texto.
      expect(screen.queryByText(/-23/)).not.toBeOnTheScreen();
    });

    it("sem update há mais de 30 s: marca como desatualizada", async () => {
      const api = createMockApi({
        getLiveLocation: jest.fn(async () => liveState("ACTIVE", point(42))),
        getLiveLocationHistory: jest.fn(async () => ({ sessionId: "session-1", points: [] })),
      });
      await renderWithAuth(<LiveLocationSection alert={memberAlert()} isCreator={false} />, {
        api,
      });
      expect(await screen.findByText("Sem atualização recente")).toBeOnTheScreen();
      expect(screen.getByText("Última atualização há 42 s")).toBeOnTheScreen();
    });

    it("interrompida e ainda sem primeiro ponto", async () => {
      const api = createMockApi({
        getLiveLocation: jest.fn(async () => liveState("STOPPED", point(300))),
        getLiveLocationHistory: jest.fn(async () => ({ sessionId: "session-1", points: [] })),
      });
      const view = await renderWithAuth(
        <LiveLocationSection alert={memberAlert()} isCreator={false} />,
        { api },
      );
      expect(await screen.findByText("Interrompida")).toBeOnTheScreen();
      await view.unmount();

      const waiting = createMockApi({
        getLiveLocation: jest.fn(async () => liveState("ACTIVE", null)),
        getLiveLocationHistory: jest.fn(async () => ({ sessionId: "session-1", points: [] })),
      });
      await renderWithAuth(<LiveLocationSection alert={memberAlert()} isCreator={false} />, {
        api: waiting,
      });
      expect(await screen.findByText("Localização ainda não disponível.")).toBeOnTheScreen();
    });

    it("ALERT_LIVE_LOCATION_UPDATED (sem coordenadas) recarrega via REST; ressincronização também", async () => {
      const api = createMockApi({
        getLiveLocation: jest
          .fn()
          .mockResolvedValueOnce(liveState("ACTIVE", null))
          .mockResolvedValue(liveState("ACTIVE", point(3))),
        getLiveLocationHistory: jest.fn(async () => ({ sessionId: "session-1", points: [] })),
      });
      const realtime = createMockRealtime({ resyncVersion: 1 });
      const tree = (value: typeof realtime) => (
        <AuthContext.Provider value={createAuthValue(api, { user: testUser })}>
          <RealtimeContext.Provider value={value}>
            <LiveLocationSection alert={memberAlert()} isCreator={false} />
          </RealtimeContext.Provider>
        </AuthContext.Provider>
      );
      const view = await render(tree(realtime));
      expect(await screen.findByText("Localização ainda não disponível.")).toBeOnTheScreen();

      const event = {
        version: 1 as const,
        type: "ALERT_LIVE_LOCATION_UPDATED" as const,
        eventId: "e1",
        occurredAt: NOW.toISOString(),
        data: { alertId: "alert-1", groupId: "group-1" },
      };
      expect(Object.keys(event.data)).toEqual(["alertId", "groupId"]);
      await act(async () => realtime.emit(event));
      expect(await screen.findByText("Última atualização agora")).toBeOnTheScreen();
      expect(api.getLiveLocation).toHaveBeenCalledTimes(2);

      await view.rerender(tree({ ...realtime, resyncVersion: 2 }));
      await waitFor(() => expect(api.getLiveLocation).toHaveBeenCalledTimes(3));
    });
  });
});
