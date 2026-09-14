import { API_BASE_URL } from "../config";

/**
 * Cliente HTTP centralizado (README §17).
 * Responsável por base URL, JSON, Authorization Bearer, tratamento de erros
 * padronizado e renovação automática (single-flight) em 401.
 */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

export interface PublicUser extends AuthUser {
  createdAt: string;
}

export interface AuthResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Correlação com os logs do servidor (Phase 9). */
  readonly requestId?: string;
  /** Só em falhas internas (500): vira o "código de suporte" na interface. */
  readonly errorId?: string;

  constructor(
    code: string,
    message: string,
    status: number,
    correlation: { requestId?: string; errorId?: string } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    if (correlation.requestId) this.requestId = correlation.requestId;
    if (correlation.errorId) this.errorId = correlation.errorId;
  }

  /**
   * Código curto que o usuário pode informar ao suporte. Preferimos o
   * `errorId` (identifica a falha exata); sem ele, o `requestId` já permite
   * achar a requisição no log.
   */
  get supportCode(): string | undefined {
    return this.errorId ?? this.requestId;
  }
}

export interface AuthBridge {
  getAccessToken(): string | null;
  /** Renova o access token (single-flight). Retorna o novo token ou null. */
  refreshAccessToken(): Promise<string | null>;
}

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const code = (data && data.code) || "INTERNAL_ERROR";
    const message = (data && data.message) || "Erro na requisição.";
    // Correlação (Phase 9): aceita só strings curtas — o corpo é entrada externa.
    const short = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 && value.length <= 64 ? value : undefined;
    throw new ApiError(code, message, response.status, {
      requestId: short(data?.requestId) ?? short(response.headers.get("x-request-id")),
      errorId: short(data?.errorId),
    });
  }

  return data as T;
}

async function doFetch<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError("NETWORK", "Não foi possível conectar ao servidor.", 0);
  }
  return parse<T>(response);
}

export type GroupRole = "OWNER" | "ADMIN" | "MEMBER";

export interface GroupSummary {
  id: string;
  name: string;
  role: GroupRole;
  memberCount: number;
  createdAt: string;
}

export interface GroupMember {
  id: string;
  name: string;
  role: GroupRole;
  joinedAt: string;
}

export interface GroupInvitation {
  id: string;
  invitedEmail: string;
  status: string;
  expiresAt: string;
  createdAt: string;
}

export interface MyInvitation {
  id: string;
  group: { id: string; name: string };
  invitedBy: { name: string };
  expiresAt: string;
}

// --- Alerta de Emergência (Phase 3) ---

export type AlertStatus = "ACTIVE" | "RESOLVED" | "CANCELLED";

/** Snapshot de localização devolvido pela API (somente a membros do grupo). */
export interface AlertLocation {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  capturedAt: string;
}

/** Snapshot opcional enviado na criação do alerta. */
export interface AlertLocationInput {
  latitude: number;
  longitude: number;
  accuracy?: number;
  capturedAt?: string;
}

export interface EmergencyAlert {
  id: string;
  groupId: string;
  groupName: string;
  status: AlertStatus;
  createdBy: { id: string; name: string };
  activatedAt: string;
  resolvedAt: string | null;
  cancelledAt: string | null;
  location: AlertLocation | null;
}

export interface CreateAlertInput {
  groupId: string;
  /** Opcional: a falta de GPS nunca impede o pedido de ajuda. */
  location?: AlertLocationInput | null;
}

// --- Acknowledgements (Phase 5) ---

export type AcknowledgementType =
  "SEEN" | "ACKNOWLEDGED" | "GOING_TO_HELP" | "EMERGENCY_SERVICES_CONTACTED";

export interface AlertAcknowledgement {
  user: { id: string; name: string };
  type: AcknowledgementType;
  updatedAt: string;
}

// --- Localização ao vivo (Phase 6) ---

export type LiveLocationStatus = "ACTIVE" | "STOPPED" | "INACTIVE";

export interface LiveLocationPoint {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  capturedAt: string;
  receivedAt: string;
}

export interface LiveLocationSession {
  sessionId: string;
  status: "ACTIVE" | "STOPPED";
  startedAt: string;
  stoppedAt: string | null;
}

export interface LiveLocationState {
  status: LiveLocationStatus;
  sessionId: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  latest: LiveLocationPoint | null;
}

export interface LiveLocationHistory {
  sessionId: string | null;
  points: LiveLocationPoint[];
}

/** Ponto enviado pelo criador; `clientUpdateId` garante idempotência no retry. */
export interface LiveLocationUpdateInput {
  clientUpdateId: string;
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  altitude?: number | null;
  heading?: number | null;
  speed?: number | null;
  capturedAt: string;
}

// --- Check-in de Segurança (Phase 7) ---

export type CheckinStatus = "ACTIVE" | "SAFE" | "CANCELLED" | "OVERDUE";

export interface SafetyCheckin {
  id: string;
  groupId: string;
  groupName: string;
  user: { id: string; name: string };
  status: CheckinStatus;
  /** Prazo absoluto (UTC) — o servidor é o relógio autoritativo. */
  dueAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  overdueAt: string | null;
  createdAt: string;
}

export interface CreateCheckinInput {
  groupId: string;
  dueAt: string;
}

// --- Trajeto Seguro (Phase 8) ---

export type JourneyStatus = "ACTIVE" | "ARRIVED" | "CANCELLED" | "OVERDUE";

export interface SafeJourney {
  id: string;
  groupId: string;
  groupName: string;
  user: { id: string; name: string };
  status: JourneyStatus;
  destinationLabel: string | null;
  /** Chegada prevista absoluta (UTC) — o servidor é o relógio autoritativo. */
  expectedArrivalAt: string;
  liveLocationEnabled: boolean;
  startedAt: string;
  arrivedAt: string | null;
  cancelledAt: string | null;
  overdueAt: string | null;
  createdAt: string;
}

export interface CreateJourneyInput {
  groupId: string;
  destinationLabel?: string;
  expectedArrivalAt: string;
  liveLocationEnabled?: boolean;
}

// --- Notificações Push (Phase 4) ---

export type PushPlatform = "IOS" | "ANDROID";

export interface RegisterPushDeviceInput {
  /** Expo Push Token — nunca logar nem exibir. */
  token: string;
  platform: PushPlatform;
  /** UUID de instalação gerado pelo app. */
  deviceId: string;
}

/** Resposta do backend: o token nunca é devolvido. */
export interface PushDeviceView {
  id: string;
  platform: PushPlatform;
  deviceId: string;
  isActive: boolean;
  updatedAt: string;
}

interface AuthedOptions {
  headers?: Record<string, string>;
}

export function createApiClient(bridge?: AuthBridge) {
  async function authed<T>(
    method: string,
    path: string,
    body?: unknown,
    options: AuthedOptions = {},
    retry = true,
  ): Promise<T> {
    const token = bridge?.getAccessToken() ?? null;
    try {
      return await doFetch<T>(path, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && retry && bridge) {
        const refreshed = await bridge.refreshAccessToken();
        if (refreshed) {
          return authed<T>(method, path, body, options, false);
        }
      }
      throw error;
    }
  }

  return {
    register(input: { name: string; email: string; password: string }): Promise<AuthResponse> {
      return doFetch<AuthResponse>("/auth/register", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    login(input: { email: string; password: string }): Promise<AuthResponse> {
      return doFetch<AuthResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify(input),
      });
    },
    refresh(refreshToken: string): Promise<TokenPair> {
      return doFetch<TokenPair>("/auth/refresh", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
    },
    async logout(refreshToken: string): Promise<void> {
      await doFetch<void>("/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refreshToken }),
      });
    },
    me(): Promise<PublicUser> {
      return authed<PublicUser>("GET", "/me");
    },

    // --- Grupos de Confiança (Phase 2) ---
    listGroups(): Promise<GroupSummary[]> {
      return authed<GroupSummary[]>("GET", "/groups");
    },
    createGroup(name: string): Promise<GroupSummary> {
      return authed<GroupSummary>("POST", "/groups", { name });
    },
    getGroup(groupId: string): Promise<GroupSummary> {
      return authed<GroupSummary>("GET", `/groups/${groupId}`);
    },
    updateGroup(groupId: string, name: string): Promise<GroupSummary> {
      return authed<GroupSummary>("PATCH", `/groups/${groupId}`, { name });
    },
    listMembers(groupId: string): Promise<GroupMember[]> {
      return authed<GroupMember[]>("GET", `/groups/${groupId}/members`);
    },
    leaveGroup(groupId: string): Promise<void> {
      return authed<void>("DELETE", `/groups/${groupId}/members/me`);
    },
    removeMember(groupId: string, userId: string): Promise<void> {
      return authed<void>("DELETE", `/groups/${groupId}/members/${userId}`);
    },
    changeMemberRole(
      groupId: string,
      userId: string,
      role: "ADMIN" | "MEMBER",
    ): Promise<GroupMember> {
      return authed<GroupMember>("PATCH", `/groups/${groupId}/members/${userId}/role`, { role });
    },
    createInvitation(groupId: string, email: string): Promise<GroupInvitation> {
      return authed<GroupInvitation>("POST", `/groups/${groupId}/invitations`, { email });
    },
    listGroupInvitations(groupId: string): Promise<GroupInvitation[]> {
      return authed<GroupInvitation[]>("GET", `/groups/${groupId}/invitations`);
    },
    revokeInvitation(groupId: string, invitationId: string): Promise<void> {
      return authed<void>("DELETE", `/groups/${groupId}/invitations/${invitationId}`);
    },
    listMyInvitations(): Promise<MyInvitation[]> {
      return authed<MyInvitation[]>("GET", "/me/group-invitations");
    },
    acceptInvitation(invitationId: string): Promise<{ groupId: string }> {
      return authed<{ groupId: string }>("POST", `/me/group-invitations/${invitationId}/accept`);
    },
    rejectInvitation(invitationId: string): Promise<void> {
      return authed<void>("POST", `/me/group-invitations/${invitationId}/reject`);
    },

    // --- Alerta de Emergência (Phase 3) ---
    /**
     * Cria um alerta. A `idempotencyKey` identifica a intenção de ativação:
     * o retry da mesma intenção deve reutilizar a mesma chave.
     */
    createAlert(input: CreateAlertInput, idempotencyKey: string): Promise<EmergencyAlert> {
      return authed<EmergencyAlert>("POST", "/alerts", input, {
        headers: { "Idempotency-Key": idempotencyKey },
      });
    },
    listAlerts(status: AlertStatus = "ACTIVE"): Promise<EmergencyAlert[]> {
      return authed<EmergencyAlert[]>("GET", `/alerts?status=${status}`);
    },
    getAlert(alertId: string): Promise<EmergencyAlert> {
      return authed<EmergencyAlert>("GET", `/alerts/${alertId}`);
    },
    resolveAlert(alertId: string): Promise<EmergencyAlert> {
      return authed<EmergencyAlert>("POST", `/alerts/${alertId}/resolve`);
    },
    cancelAlert(alertId: string): Promise<EmergencyAlert> {
      return authed<EmergencyAlert>("POST", `/alerts/${alertId}/cancel`);
    },

    // --- Acknowledgements (Phase 5) ---
    listAcknowledgements(alertId: string): Promise<AlertAcknowledgement[]> {
      return authed<AlertAcknowledgement[]>("GET", `/alerts/${alertId}/acknowledgements`);
    },
    setAcknowledgement(alertId: string, type: AcknowledgementType): Promise<AlertAcknowledgement> {
      return authed<AlertAcknowledgement>("PUT", `/alerts/${alertId}/acknowledgement`, { type });
    },

    // --- Localização ao vivo (Phase 6) ---
    startLiveLocation(alertId: string): Promise<LiveLocationSession> {
      return authed<LiveLocationSession>("POST", `/alerts/${alertId}/live-location/start`);
    },
    sendLiveLocation(
      alertId: string,
      input: LiveLocationUpdateInput,
    ): Promise<{ sessionId: string; point: LiveLocationPoint }> {
      return authed("POST", `/alerts/${alertId}/live-location`, input);
    },
    stopLiveLocation(alertId: string): Promise<LiveLocationState> {
      return authed<LiveLocationState>("POST", `/alerts/${alertId}/live-location/stop`);
    },
    getLiveLocation(alertId: string): Promise<LiveLocationState> {
      return authed<LiveLocationState>("GET", `/alerts/${alertId}/live-location`);
    },
    getLiveLocationHistory(alertId: string): Promise<LiveLocationHistory> {
      return authed<LiveLocationHistory>("GET", `/alerts/${alertId}/live-location/history`);
    },

    // --- Check-in de Segurança (Phase 7) ---
    createCheckin(input: CreateCheckinInput, idempotencyKey: string): Promise<SafetyCheckin> {
      return authed<SafetyCheckin>("POST", "/checkins", input, {
        headers: { "Idempotency-Key": idempotencyKey },
      });
    },
    listMyCheckins(status?: CheckinStatus): Promise<SafetyCheckin[]> {
      return authed<SafetyCheckin[]>("GET", status ? `/checkins?status=${status}` : "/checkins");
    },
    getCheckin(checkinId: string): Promise<SafetyCheckin> {
      return authed<SafetyCheckin>("GET", `/checkins/${checkinId}`);
    },
    listGroupCheckins(groupId: string): Promise<SafetyCheckin[]> {
      return authed<SafetyCheckin[]>("GET", `/groups/${groupId}/checkins`);
    },
    confirmCheckinSafe(checkinId: string): Promise<SafetyCheckin> {
      return authed<SafetyCheckin>("POST", `/checkins/${checkinId}/safe`);
    },
    cancelCheckin(checkinId: string): Promise<SafetyCheckin> {
      return authed<SafetyCheckin>("POST", `/checkins/${checkinId}/cancel`);
    },

    // --- Trajeto Seguro (Phase 8) ---
    createJourney(input: CreateJourneyInput, idempotencyKey: string): Promise<SafeJourney> {
      return authed<SafeJourney>("POST", "/journeys", input, {
        headers: { "Idempotency-Key": idempotencyKey },
      });
    },
    listMyJourneys(status?: JourneyStatus): Promise<SafeJourney[]> {
      return authed<SafeJourney[]>("GET", status ? `/journeys?status=${status}` : "/journeys");
    },
    getJourney(journeyId: string): Promise<SafeJourney> {
      return authed<SafeJourney>("GET", `/journeys/${journeyId}`);
    },
    listGroupJourneys(groupId: string): Promise<SafeJourney[]> {
      return authed<SafeJourney[]>("GET", `/groups/${groupId}/journeys`);
    },
    arriveJourney(journeyId: string): Promise<SafeJourney> {
      return authed<SafeJourney>("POST", `/journeys/${journeyId}/arrive`);
    },
    cancelJourney(journeyId: string): Promise<SafeJourney> {
      return authed<SafeJourney>("POST", `/journeys/${journeyId}/cancel`);
    },
    startJourneyLiveLocation(journeyId: string): Promise<LiveLocationSession> {
      return authed<LiveLocationSession>("POST", `/journeys/${journeyId}/live-location/start`);
    },
    sendJourneyLiveLocation(
      journeyId: string,
      input: LiveLocationUpdateInput,
    ): Promise<{ sessionId: string; point: LiveLocationPoint }> {
      return authed("POST", `/journeys/${journeyId}/live-location`, input);
    },
    stopJourneyLiveLocation(journeyId: string): Promise<LiveLocationState> {
      return authed<LiveLocationState>("POST", `/journeys/${journeyId}/live-location/stop`);
    },
    getJourneyLiveLocation(journeyId: string): Promise<LiveLocationState> {
      return authed<LiveLocationState>("GET", `/journeys/${journeyId}/live-location`);
    },
    getJourneyLiveLocationHistory(journeyId: string): Promise<LiveLocationHistory> {
      return authed<LiveLocationHistory>("GET", `/journeys/${journeyId}/live-location/history`);
    },

    // --- Notificações Push (Phase 4) ---
    registerPushDevice(input: RegisterPushDeviceInput): Promise<PushDeviceView> {
      return authed<PushDeviceView>("POST", "/me/push-devices", input);
    },
    unregisterPushDevice(deviceId: string): Promise<void> {
      return authed<void>("DELETE", `/me/push-devices/${deviceId}`);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
