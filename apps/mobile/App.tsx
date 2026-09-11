import { useState } from "react";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "./src/auth/AuthContext";
import { AuthenticatedHomeScreen } from "./src/screens/AuthenticatedHomeScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { RegisterScreen } from "./src/screens/RegisterScreen";
import { SplashScreen } from "./src/screens/SplashScreen";

function Root(): React.JSX.Element {
  const { status } = useAuth();
  const [authScreen, setAuthScreen] = useState<"login" | "register">("login");

  if (status === "loading") {
    return <SplashScreen />;
  }

  if (status === "authenticated") {
    return <AuthenticatedHomeScreen />;
  }

  return authScreen === "login" ? (
    <LoginScreen onNavigateToRegister={() => setAuthScreen("register")} />
  ) : (
    <RegisterScreen onNavigateToLogin={() => setAuthScreen("login")} />
  );
}

export default function App(): React.JSX.Element {
  return (
    <AuthProvider>
      <StatusBar style="light" />
      <Root />
    </AuthProvider>
  );
}
