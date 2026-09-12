import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import type { ApiClient } from "./src/lib/api";
import { LiveLocationLifecycle } from "./src/live-location/LiveLocationLifecycle";
import { stopAllLiveLocation } from "./src/live-location/LiveLocationController";
import { unregisterCurrentDevice } from "./src/notifications/device-registration";
import { NotificationsProvider } from "./src/notifications/NotificationsProvider";
import { RealtimeProvider } from "./src/realtime/RealtimeProvider";
import { AuthenticatedApp } from "./src/screens/AuthenticatedApp";
import { LoginScreen } from "./src/screens/LoginScreen";
import { RegisterScreen } from "./src/screens/RegisterScreen";
import { SplashScreen } from "./src/screens/SplashScreen";

function Root(): React.JSX.Element {
  const { status } = useAuth();
  const [authScreen, setAuthScreen] = useState<"login" | "register">("login");

  // Ao entrar no estado não autenticado (inclusive após logout), volta ao Login.
  useEffect(() => {
    if (status === "unauthenticated") {
      setAuthScreen("login");
    }
  }, [status]);

  if (status === "loading") {
    return <SplashScreen />;
  }

  if (status === "authenticated") {
    return <AuthenticatedApp />;
  }

  return authScreen === "login" ? (
    <LoginScreen onNavigateToRegister={() => setAuthScreen("register")} />
  ) : (
    <RegisterScreen onNavigateToLogin={() => setAuthScreen("login")} />
  );
}

/**
 * Antes de encerrar a sessão (ainda autenticado), em best-effort:
 * para o compartilhamento de localização ao vivo (Phase 6) e desativa o push
 * device (Phase 4). Nenhuma falha impede o logout.
 */
async function beforeSignOut(api: ApiClient): Promise<void> {
  await stopAllLiveLocation({ notifyBackend: true });
  await unregisterCurrentDevice(api);
}

export default function App(): React.JSX.Element {
  return (
    <AuthProvider beforeSignOut={beforeSignOut}>
      <NotificationsProvider>
        <RealtimeProvider>
          <LiveLocationLifecycle />
          <StatusBar style="light" />
          <Root />
        </RealtimeProvider>
      </NotificationsProvider>
    </AuthProvider>
  );
}
