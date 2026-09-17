import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { PushPlatform } from "../lib/api";

/**
 * Integração com Expo Notifications (Phase 4).
 *
 * Responsabilidades: permissão, canal Android, Expo Push Token e leitura do
 * payload das notificações. Nada aqui registra o token em logs nem o expõe
 * na interface. Push é nativo (iOS/Android); na web o recurso é "unavailable".
 */

export type NotificationPermission =
  | "granted"
  | "undetermined"
  /** Negada, mas o sistema ainda permite perguntar de novo. */
  | "denied"
  /** Negada permanentemente: só muda nas configurações do aparelho. */
  | "blocked"
  /** Plataforma sem push nativo (web) ou biblioteca indisponível. */
  | "unavailable";

export const EMERGENCY_CHANNEL_ID = "emergency";
export const ALERT_NOTIFICATION_TYPE = "EMERGENCY_ALERT";

export interface AlertNotificationData {
  type: typeof ALERT_NOTIFICATION_TYPE;
  alertId: string;
  groupId?: string;
}

export function isPushSupported(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

export function getPushPlatform(): PushPlatform | null {
  if (Platform.OS === "ios") return "IOS";
  if (Platform.OS === "android") return "ANDROID";
  return null;
}

function mapPermission(response: {
  status: string;
  granted?: boolean;
  canAskAgain?: boolean;
}): NotificationPermission {
  if (response.granted || response.status === "granted") return "granted";
  if (response.status === "undetermined") return "undetermined";
  return response.canAskAgain === false ? "blocked" : "denied";
}

export async function getPermissionStatus(): Promise<NotificationPermission> {
  if (!isPushSupported()) return "unavailable";
  try {
    return mapPermission(await Notifications.getPermissionsAsync());
  } catch {
    return "unavailable";
  }
}

/** Solicita a permissão do SO (chamar só depois de explicar o motivo ao usuário). */
export async function requestPermission(): Promise<NotificationPermission> {
  if (!isPushSupported()) return "unavailable";
  try {
    return mapPermission(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: true, allowSound: true },
      }),
    );
  } catch {
    return "denied";
  }
}

/** Canal Android de alta prioridade usado pelo backend (`channelId: "emergency"`). */
export async function ensureEmergencyChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync(EMERGENCY_CHANNEL_ID, {
      name: "Alertas de emergência",
      description: "Avisos quando alguém do seu grupo de confiança pedir ajuda.",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      vibrationPattern: [0, 250, 250, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
    });
  } catch {
    // Sem canal customizado o Android usa o padrão; não bloqueia o app.
  }
}

/** Exibe a notificação também com o app em primeiro plano. */
export function configureForegroundPresentation(): void {
  if (!isPushSupported()) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/**
 * `projectId` EAS (valor público) lido da configuração do app
 * (`app.json` → `extra.eas.projectId`) ou do build EAS. Nunca hardcodado.
 */
export function getExpoProjectId(): string | undefined {
  const fromExtra = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
    ?.eas?.projectId;
  return fromExtra ?? Constants.easConfig?.projectId ?? undefined;
}

/** Obtém o Expo Push Token; `null` quando indisponível (simulador, web, erro). */
export async function getExpoPushToken(): Promise<string | null> {
  if (!isPushSupported()) return null;
  try {
    const projectId = getExpoProjectId();
    const result = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    return result.data ? result.data : null;
  } catch {
    return null;
  }
}

/** Interpreta o payload de dados de uma notificação; IDs são apenas referência. */
export function parseAlertNotificationData(data: unknown): AlertNotificationData | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== ALERT_NOTIFICATION_TYPE) return null;
  if (typeof record.alertId !== "string" || record.alertId.length === 0) return null;
  const parsed: AlertNotificationData = { type: ALERT_NOTIFICATION_TYPE, alertId: record.alertId };
  if (typeof record.groupId === "string") {
    parsed.groupId = record.groupId;
  }
  return parsed;
}

/** Extrai os dados de alerta de uma resposta (toque) de notificação. */
export function alertDataFromResponse(
  response: Notifications.NotificationResponse | null | undefined,
): AlertNotificationData | null {
  return parseAlertNotificationData(response?.notification?.request?.content?.data);
}

// Phase 7 — check-in vencido
export const CHECKIN_OVERDUE_NOTIFICATION_TYPE = "SAFETY_CHECKIN_OVERDUE";

export interface CheckinNotificationData {
  type: typeof CHECKIN_OVERDUE_NOTIFICATION_TYPE;
  checkinId: string;
  groupId?: string;
}

// Phase 8 — trajeto atrasado
export const JOURNEY_OVERDUE_NOTIFICATION_TYPE = "SAFE_JOURNEY_OVERDUE";

export interface JourneyNotificationData {
  type: typeof JOURNEY_OVERDUE_NOTIFICATION_TYPE;
  journeyId: string;
  groupId?: string;
}

// Phase 13 — convite para grupo de confiança
export const GROUP_INVITATION_NOTIFICATION_TYPE = "GROUP_INVITATION";

export interface InvitationNotificationData {
  type: typeof GROUP_INVITATION_NOTIFICATION_TYPE;
  invitationId: string;
  groupId?: string;
}

export type NotificationData =
  | AlertNotificationData
  | CheckinNotificationData
  | JourneyNotificationData
  | InvitationNotificationData;

/** Interpreta qualquer payload conhecido (alerta, check-in ou trajeto); IDs são referência. */
export function parseNotificationData(data: unknown): NotificationData | null {
  const alert = parseAlertNotificationData(data);
  if (alert) return alert;
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;

  if (record.type === CHECKIN_OVERDUE_NOTIFICATION_TYPE) {
    if (typeof record.checkinId !== "string" || record.checkinId.length === 0) return null;
    const parsed: CheckinNotificationData = {
      type: CHECKIN_OVERDUE_NOTIFICATION_TYPE,
      checkinId: record.checkinId,
    };
    if (typeof record.groupId === "string") parsed.groupId = record.groupId;
    return parsed;
  }

  if (record.type === GROUP_INVITATION_NOTIFICATION_TYPE) {
    if (typeof record.invitationId !== "string" || record.invitationId.length === 0) return null;
    const parsed: InvitationNotificationData = {
      type: GROUP_INVITATION_NOTIFICATION_TYPE,
      invitationId: record.invitationId,
    };
    if (typeof record.groupId === "string") parsed.groupId = record.groupId;
    return parsed;
  }

  if (record.type === JOURNEY_OVERDUE_NOTIFICATION_TYPE) {
    if (typeof record.journeyId !== "string" || record.journeyId.length === 0) return null;
    const parsed: JourneyNotificationData = {
      type: JOURNEY_OVERDUE_NOTIFICATION_TYPE,
      journeyId: record.journeyId,
    };
    if (typeof record.groupId === "string") parsed.groupId = record.groupId;
    return parsed;
  }

  return null;
}

export function notificationDataFromResponse(
  response: Notifications.NotificationResponse | null | undefined,
): NotificationData | null {
  return parseNotificationData(response?.notification?.request?.content?.data);
}

export type NotificationResponseSubscription = { remove: () => void };

/** Listener de toque na notificação (app em foreground, background ou fechado). */
export function addNotificationTapListener(
  handler: (data: NotificationData) => void,
): NotificationResponseSubscription {
  if (!isPushSupported()) return { remove: () => {} };
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = notificationDataFromResponse(response);
    if (data) handler(data);
  });
  return { remove: () => subscription.remove() };
}

/** Notificação que abriu o app (cold start), se houver (alerta ou check-in). */
export async function getInitialAlertNotification(): Promise<NotificationData | null> {
  if (!isPushSupported()) return null;
  try {
    return notificationDataFromResponse(await Notifications.getLastNotificationResponseAsync());
  } catch {
    return null;
  }
}
