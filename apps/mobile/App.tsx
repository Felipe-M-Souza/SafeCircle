import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import { unregisterCurrentDevice } from "./src/notifications/device-registration";
import { NotificationsProvider } from "./src/notifications/NotificationsProvider";
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

export default function App(): React.JSX.Element {
  return (
    // Logout desativa o push device no backend (best-effort) antes de encerrar a sessão.
    <AuthProvider beforeSignOut={unregisterCurrentDevice}>
      <NotificationsProvider>
        <StatusBar style="light" />
        <Root />
      </NotificationsProvider>
    </AuthProvider>
  );
}
