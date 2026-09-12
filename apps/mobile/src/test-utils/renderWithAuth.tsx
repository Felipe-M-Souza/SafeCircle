import { render, type RenderResult } from "@testing-library/react-native";
import { AuthContext, type AuthContextValue } from "../auth/AuthContext";
import type { ApiClient, AuthUser, EmergencyAlert } from "../lib/api";
import type { Nav } from "../navigation/types";
import type { RealtimeEvent } from "../realtime/events";
import { RealtimeContext, type RealtimeContextValue } from "../realtime/RealtimeProvider";

/** Usuário sintético para testes. */
export const testUser: AuthUser = { id: "user-1", name: "Felipe", email: "felipe@example.com" };

/**
 * Cliente de API falso: todos os métodos são `jest.fn()` que, por padrão,
 * resolvem valores neutros. Sobrescreva o necessário em cada teste.
 */
export function createMockApi(overrides: Partial<ApiClient> = {}): jest.Mocked<ApiClient> {
  const api = {
    register: jest.fn(),
    login: jest.fn(),
    refresh: jest.fn(),
    logout: jest.fn(),
    me: jest.fn(),
    listGroups: jest.fn(async () => []),
    createGroup: jest.fn(),
    getGroup: jest.fn(),
    updateGroup: jest.fn(),
    listMembers: jest.fn(),
    leaveGroup: jest.fn(),
    removeMember: jest.fn(),
    changeMemberRole: jest.fn(),
    createInvitation: jest.fn(),
    listGroupInvitations: jest.fn(),
    revokeInvitation: jest.fn(),
    listMyInvitations: jest.fn(async () => []),
    acceptInvitation: jest.fn(),
    rejectInvitation: jest.fn(),
    createAlert: jest.fn(),
    listAlerts: jest.fn(async () => []),
    getAlert: jest.fn(),
    resolveAlert: jest.fn(),
    cancelAlert: jest.fn(),
    listAcknowledgements: jest.fn(async () => []),
    setAcknowledgement: jest.fn(async () => ({
      user: { id: "user-1", name: "Felipe" },
      type: "SEEN" as const,
      updatedAt: "2026-09-11T20:31:00.000Z",
    })),
    startLiveLocation: jest.fn(async () => ({
      sessionId: "session-1",
      status: "ACTIVE" as const,
      startedAt: "2026-09-11T20:30:00.000Z",
      stoppedAt: null,
    })),
    sendLiveLocation: jest.fn(async () => ({
      sessionId: "session-1",
      point: {
        latitude: -23,
        longitude: -46,
        accuracy: 12,
        altitude: null,
        heading: null,
        speed: null,
        capturedAt: "2026-09-11T20:30:00.000Z",
        receivedAt: "2026-09-11T20:30:00.000Z",
      },
    })),
    stopLiveLocation: jest.fn(async () => ({
      status: "STOPPED" as const,
      sessionId: "session-1",
      startedAt: "2026-09-11T20:30:00.000Z",
      stoppedAt: "2026-09-11T20:35:00.000Z",
      latest: null,
    })),
    getLiveLocation: jest.fn(async () => ({
      status: "INACTIVE" as const,
      sessionId: null,
      startedAt: null,
      stoppedAt: null,
      latest: null,
    })),
    getLiveLocationHistory: jest.fn(async () => ({ sessionId: null, points: [] })),
    createCheckin: jest.fn(),
    listMyCheckins: jest.fn(async () => []),
    getCheckin: jest.fn(),
    listGroupCheckins: jest.fn(async () => []),
    confirmCheckinSafe: jest.fn(),
    cancelCheckin: jest.fn(),
    createJourney: jest.fn(),
    listMyJourneys: jest.fn(async () => []),
    getJourney: jest.fn(),
    listGroupJourneys: jest.fn(async () => []),
    arriveJourney: jest.fn(),
    cancelJourney: jest.fn(),
    startJourneyLiveLocation: jest.fn(async () => ({
      sessionId: "journey-session-1",
      status: "ACTIVE" as const,
      startedAt: "2026-09-11T20:30:00.000Z",
      stoppedAt: null,
    })),
    sendJourneyLiveLocation: jest.fn(async () => ({
      sessionId: "journey-session-1",
      point: {
        latitude: -23,
        longitude: -46,
        accuracy: 12,
        altitude: null,
        heading: null,
        speed: null,
        capturedAt: "2026-09-11T20:30:00.000Z",
        receivedAt: "2026-09-11T20:30:00.000Z",
      },
    })),
    stopJourneyLiveLocation: jest.fn(async () => ({
      status: "STOPPED" as const,
      sessionId: "journey-session-1",
      startedAt: "2026-09-11T20:30:00.000Z",
      stoppedAt: "2026-09-11T20:35:00.000Z",
      latest: null,
    })),
    getJourneyLiveLocation: jest.fn(async () => ({
      status: "INACTIVE" as const,
      sessionId: null,
      startedAt: null,
      stoppedAt: null,
      latest: null,
    })),
    getJourneyLiveLocationHistory: jest.fn(async () => ({ sessionId: null, points: [] })),
    registerPushDevice: jest.fn(async () => ({
      id: "device-1",
      platform: "IOS" as const,
      deviceId: "11111111-1111-4111-8111-111111111111",
      isActive: true,
      updatedAt: "2026-09-11T20:00:00.000Z",
    })),
    unregisterPushDevice: jest.fn(async () => undefined),
    ...overrides,
  };
  return api as unknown as jest.Mocked<ApiClient>;
}

export function createMockNav(): jest.Mocked<Nav> {
  return {
    navigate: jest.fn(),
    replace: jest.fn(),
    goBack: jest.fn(),
    reset: jest.fn(),
  };
}

/** Alerta sintético (coordenadas fictícias, nunca localização real). */
export function makeAlert(overrides: Partial<EmergencyAlert> = {}): EmergencyAlert {
  return {
    id: "alert-1",
    groupId: "group-1",
    groupName: "Família",
    status: "ACTIVE",
    createdBy: { id: testUser.id, name: testUser.name },
    activatedAt: "2026-09-11T20:30:00.000Z",
    resolvedAt: null,
    cancelledAt: null,
    location: {
      latitude: -23,
      longitude: -46,
      accuracy: 15,
      capturedAt: "2026-09-11T20:30:00.000Z",
    },
    ...overrides,
  };
}

interface RenderWithAuthOptions {
  api: ApiClient;
  user?: AuthUser | null;
  realtime?: RealtimeContextValue | null;
}

/** Valor de AuthContext para testes (autenticado por padrão). */
export function createAuthValue(
  api: ApiClient,
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  return {
    status: "authenticated",
    user: testUser,
    sessionPersistent: true,
    api,
    getAccessToken: () => "access-token-de-teste",
    refreshAccessToken: jest.fn(async () => "access-token-renovado"),
    accessTokenVersion: 1,
    signIn: jest.fn(),
    signUp: jest.fn(),
    signOut: jest.fn(),
    ...overrides,
  };
}

/** RealtimeContext controlável nos testes: `emit` dispara eventos aos assinantes. */
export function createMockRealtime(
  overrides: Partial<RealtimeContextValue> = {},
): RealtimeContextValue & { emit: (event: RealtimeEvent) => void } {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  return {
    state: "CONNECTED",
    resyncVersion: 0,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    ...overrides,
  };
}

/** Renderiza a tela dentro de um AuthContext de teste (RNTL v14: assíncrono). */
export function renderWithAuth(
  ui: React.ReactElement,
  { api, user = testUser, realtime = null }: RenderWithAuthOptions,
): Promise<RenderResult> {
  const value = createAuthValue(api, { user });
  return render(
    <AuthContext.Provider value={value}>
      <RealtimeContext.Provider value={realtime}>{ui}</RealtimeContext.Provider>
    </AuthContext.Provider>,
  );
}
