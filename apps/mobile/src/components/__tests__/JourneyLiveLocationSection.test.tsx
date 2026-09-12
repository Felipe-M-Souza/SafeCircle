import * as Location from "expo-location";
import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import type { LiveLocationPoint, LiveLocationState, SafeJourney } from "../../lib/api";
import { resetLiveLocationRegistry } from "../../live-location/LiveLocationController";
import { createMockApi, renderWithAuth, testUser } from "../../test-utils/renderWithAuth";
import { JourneyLiveLocationSection } from "../JourneyLiveLocationSection";

const NOW = new Date("2026-09-12T21:00:00.000Z");
const requestPermissions = jest.mocked(Location.requestForegroundPermissionsAsync);
const servicesEnabled = jest.mocked(Location.hasServicesEnabledAsync);
const watchPosition = jest.mocked(Location.watchPositionAsync);
type PermissionResponse = Awaited<ReturnType<typeof Location.getForegroundPermissionsAsync>>;
const granted = { status: "granted", canAskAgain: true } as PermissionResponse;

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

function liveState(status: LiveLocationState["status"], latest: LiveLocationPoint | null) {
  return {
    status,
    sessionId: status === "INACTIVE" ? null : "session-1",
    startedAt: status === "INACTIVE" ? null : "2026-09-12T20:50:00.000Z",
    stoppedAt: null,
    latest,
  };
}

function journey(overrides: Partial<SafeJourney> = {}): SafeJourney {
  return {
    id: "journey-1",
    groupId: "group-1",
    groupName: "Família",
    user: { id: "user-2", name: "Maria" },
    status: "ACTIVE",
    destinationLabel: "Casa",
    expectedArrivalAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
    liveLocationEnabled: true,
    startedAt: NOW.toISOString(),
    arrivedAt: null,
    cancelledAt: null,
    overdueAt: null,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("JourneyLiveLocationSection", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest.clearAllMocks();
    resetLiveLocationRegistry();
    requestPermissions.mockResolvedValue(granted);
    servicesEnabled.mockResolvedValue(true);
    watchPosition.mockResolvedValue({ remove: jest.fn() } as Location.LocationSubscription);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("opt-in desligado: mostra que a localização não é compartilhada", async () => {
    const api = createMockApi();
    await renderWithAuth(
      <JourneyLiveLocationSection journey={journey({ liveLocationEnabled: false })} isOwner />,
      { api },
    );
    expect(
      await screen.findByText("Localização não compartilhada neste trajeto."),
    ).toBeOnTheScreen();
    expect(api.getJourneyLiveLocation).not.toHaveBeenCalled();
  });

  it("membro vê o mapa com a posição mais recente e a precisão", async () => {
    const api = createMockApi({
      getJourneyLiveLocation: jest.fn(async () => liveState("ACTIVE", point(5))),
      getJourneyLiveLocationHistory: jest.fn(async () => ({
        sessionId: "session-1",
        points: [point(5)],
      })),
    });
    await renderWithAuth(<JourneyLiveLocationSection journey={journey()} isOwner={false} />, {
      api,
    });
    expect(await screen.findByTestId("live-location-map")).toBeOnTheScreen();
    expect(screen.getByText("Ativa")).toBeOnTheScreen();
    expect(screen.getByText("Precisão aproximada: 12 m")).toBeOnTheScreen();
  });

  it("posição antiga é sinalizada como desatualizada", async () => {
    const api = createMockApi({
      getJourneyLiveLocation: jest.fn(async () => liveState("ACTIVE", point(120))),
      getJourneyLiveLocationHistory: jest.fn(async () => ({
        sessionId: "session-1",
        points: [point(120)],
      })),
    });
    await renderWithAuth(<JourneyLiveLocationSection journey={journey()} isOwner={false} />, {
      api,
    });
    expect(await screen.findByText("Sem atualização recente")).toBeOnTheScreen();
  });

  it("dono ativa o compartilhamento (permissão + watcher + backend)", async () => {
    const api = createMockApi({
      getJourneyLiveLocation: jest.fn(async () => liveState("INACTIVE", null)),
      getJourneyLiveLocationHistory: jest.fn(async () => ({ sessionId: null, points: [] })),
    });
    await renderWithAuth(
      <JourneyLiveLocationSection
        journey={journey({ user: { id: testUser.id, name: testUser.name } })}
        isOwner
      />,
      { api },
    );
    await fireEvent.press(await screen.findByText("ATIVAR LOCALIZAÇÃO AO VIVO"));
    await waitFor(() => expect(api.startJourneyLiveLocation).toHaveBeenCalledWith("journey-1"));
    expect(watchPosition).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Ativa")).toBeOnTheScreen();
  });
});
