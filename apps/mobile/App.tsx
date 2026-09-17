import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StyleSheet } from "react-native";
import { colors } from "./src/theme/colors";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import { ErrorBoundary } from "./src/components/ErrorBoundary";
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
  // O boundary envolve tudo: uma falha de render em qualquer tela cai na
  // mensagem segura, com código de suporte, em vez de tela branca (Phase 9).
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <AuthProvider beforeSignOut={beforeSignOut}>
          <NotificationsProvider>
            <RealtimeProvider>
              <LiveLocationLifecycle />
              <StatusBar style="light" />
              {/* Android edge-to-edge: status bar e barra de navegação não cobrem o conteúdo. */}
              <SafeAreaView style={styles.safeArea} edges={["top", "bottom", "left", "right"]}>
                <Root />
              </SafeAreaView>
            </RealtimeProvider>
          </NotificationsProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
});
