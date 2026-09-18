import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { registerCurrentDevice, type RegistrationResult } from "./device-registration";
import {
  addNotificationTapListener,
  configureForegroundPresentation,
  ensureEmergencyChannel,
  getInitialAlertNotification,
  getPermissionStatus,
  isPushSupported,
  requestPermission,
  type NotificationData,
  type NotificationPermission,
} from "./notifications.service";
import {
  openAlertFromNotification,
  openCheckinFromNotification,
  openInvitationsFromNotification,
  openJourneyFromNotification,
} from "./pending-alert";

/** Encaminha o toque na notificação para a tela certa (só IDs trafegam). */
function routeNotification(data: NotificationData): void {
  if (data.type === "SAFETY_CHECKIN_OVERDUE") {
    openCheckinFromNotification(data.checkinId);
    return;
  }
  if (data.type === "SAFE_JOURNEY_OVERDUE") {
    openJourneyFromNotification(data.journeyId);
    return;
  }
  if (data.type === "GROUP_INVITATION") {
    openInvitationsFromNotification(data.invitationId);
    return;
  }
  openAlertFromNotification(data.alertId);
}

/**
 * Estado das notificações push no app (Phase 4).
 *
 * - Configura uma única vez: apresentação em foreground, canal Android,
 *   listener de toque (com cleanup) e a notificação que abriu o app.
 * - Registra o dispositivo no backend após login/restauração de sessão e
 *   sempre que a permissão passar a "granted" (sem duplicar registros).
 * - A permissão é solicitada apenas via `enable()`, depois de explicar o
 *   motivo ao usuário; permissão negada nunca bloqueia o app.
 */
export interface NotificationsContextValue {
  supported: boolean;
  permission: NotificationPermission | "loading";
  /**
   * Resultado do cadastro no backend. `null` enquanto não houve tentativa.
   *
   * Permissão concedida **não** significa push funcionando: o token ainda pode
   * faltar. A tela precisa dos dois para não afirmar que está tudo certo
   * quando não está.
   */
  registration: RegistrationResult | null;
  refresh: () => Promise<void>;
  enable: () => Promise<NotificationPermission>;
  /** Nova tentativa de cadastro, para o botão da tela. */
  retryRegistration: () => Promise<void>;
}

export const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function NotificationsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { status, api } = useAuth();
  const [permission, setPermission] = useState<NotificationPermission | "loading">("loading");
  const [registration, setRegistration] = useState<RegistrationResult | null>(null);

  const refresh = useCallback(async () => {
    setPermission(await getPermissionStatus());
  }, []);

  // Configuração única (listeners não são duplicados a cada render).
  useEffect(() => {
    let active = true;
    configureForegroundPresentation();
    void ensureEmergencyChannel();
    void refresh();
    void getInitialAlertNotification().then((data) => {
      if (active && data) {
        routeNotification(data);
      }
    });
    const tap = addNotificationTapListener(routeNotification);
    // Ao voltar do sistema (ex.: configurações), reflete a permissão atual.
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refresh();
      }
    });
    return () => {
      active = false;
      tap.remove();
      appState.remove();
    };
  }, [refresh]);

  const register = useCallback(async () => {
    setRegistration(await registerCurrentDevice(api));
  }, [api]);

  // Registro após login/restauração e quando a permissão for concedida.
  useEffect(() => {
    if (status === "authenticated" && permission === "granted") {
      void register();
      return;
    }
    // Sair da conta ou perder a permissão invalida o resultado anterior: manter
    // o "registered" antigo faria a tela afirmar que o push está funcionando.
    setRegistration(null);
  }, [status, permission, register]);

  const enable = useCallback(async () => {
    const result = await requestPermission();
    setPermission(result);
    return result;
  }, []);

  return (
    <NotificationsContext.Provider
      value={{
        supported: isPushSupported(),
        permission,
        registration,
        refresh,
        enable,
        retryRegistration: register,
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}

/** `null` fora do provider (telas continuam funcionando sem o recurso). */
export function useNotifications(): NotificationsContextValue | null {
  return useContext(NotificationsContext);
}
