import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { registerCurrentDevice } from "./device-registration";
import {
  addNotificationTapListener,
  configureForegroundPresentation,
  ensureEmergencyChannel,
  getInitialAlertNotification,
  getPermissionStatus,
  isPushSupported,
  requestPermission,
  type NotificationPermission,
} from "./notifications.service";
import { openAlertFromNotification } from "./pending-alert";

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
  refresh: () => Promise<void>;
  enable: () => Promise<NotificationPermission>;
}

export const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function NotificationsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { status, api } = useAuth();
  const [permission, setPermission] = useState<NotificationPermission | "loading">("loading");

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
        openAlertFromNotification(data.alertId);
      }
    });
    const tap = addNotificationTapListener((data) => openAlertFromNotification(data.alertId));
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

  // Registro após login/restauração e quando a permissão for concedida.
  useEffect(() => {
    if (status === "authenticated" && permission === "granted") {
      void registerCurrentDevice(api);
    }
  }, [status, permission, api]);

  const enable = useCallback(async () => {
    const result = await requestPermission();
    setPermission(result);
    return result;
  }, []);

  return (
    <NotificationsContext.Provider
      value={{ supported: isPushSupported(), permission, refresh, enable }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}

/** `null` fora do provider (telas continuam funcionando sem o recurso). */
export function useNotifications(): NotificationsContextValue | null {
  return useContext(NotificationsContext);
}
