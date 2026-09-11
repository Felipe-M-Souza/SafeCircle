import { render, type RenderResult } from "@testing-library/react-native";
import { AuthContext, type AuthContextValue } from "../auth/AuthContext";
import type { ApiClient, AuthUser, EmergencyAlert } from "../lib/api";
import type { Nav } from "../navigation/types";

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
}

/** Renderiza a tela dentro de um AuthContext de teste (RNTL v14: assíncrono). */
export function renderWithAuth(
  ui: React.ReactElement,
  { api, user = testUser }: RenderWithAuthOptions,
): Promise<RenderResult> {
  const value: AuthContextValue = {
    status: "authenticated",
    user,
    sessionPersistent: true,
    api,
    signIn: jest.fn(),
    signUp: jest.fn(),
    signOut: jest.fn(),
  };
  return render(<AuthContext.Provider value={value}>{ui}</AuthContext.Provider>);
}
