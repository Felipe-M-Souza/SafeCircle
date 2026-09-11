import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, createApiClient, type ApiClient, type AuthUser } from "../lib/api";
import { secureStorage } from "../lib/storage";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Falso na web (sessão apenas em memória, não persiste após reload). */
  sessionPersistent: boolean;
  /** Cliente HTTP autenticado (com auto-refresh) para chamadas protegidas. */
  api: ApiClient;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  const accessTokenRef = useRef<string | null>(null);
  const refreshingRef = useRef<Promise<string | null> | null>(null);
  const clientRef = useRef<ApiClient | null>(null);

  const clearSession = useCallback(async () => {
    accessTokenRef.current = null;
    await secureStorage.clearRefreshToken();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  // Renovação single-flight do access token usando o refresh token seguro.
  const doRefresh = useCallback(async (): Promise<string | null> => {
    if (refreshingRef.current) {
      return refreshingRef.current;
    }
    const promise = (async () => {
      const client = clientRef.current!;
      const refreshToken = await secureStorage.getRefreshToken();
      if (!refreshToken) {
        await clearSession();
        return null;
      }
      try {
        const tokens = await client.refresh(refreshToken);
        accessTokenRef.current = tokens.accessToken;
        await secureStorage.setRefreshToken(tokens.refreshToken);
        return tokens.accessToken;
      } catch {
        await clearSession();
        return null;
      } finally {
        refreshingRef.current = null;
      }
    })();
    refreshingRef.current = promise;
    return promise;
  }, [clearSession]);

  if (!clientRef.current) {
    clientRef.current = createApiClient({
      getAccessToken: () => accessTokenRef.current,
      refreshAccessToken: () => doRefresh(),
    });
  }
  const api = clientRef.current;

  const applySession = useCallback(
    async (accessToken: string, refreshToken: string, nextUser: AuthUser) => {
      accessTokenRef.current = accessToken;
      await secureStorage.setRefreshToken(refreshToken);
      setUser(nextUser);
      setStatus("authenticated");
    },
    [],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await clientRef.current!.login({ email, password });
      await applySession(result.accessToken, result.refreshToken, result.user);
    },
    [applySession],
  );

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      const result = await clientRef.current!.register({ name, email, password });
      await applySession(result.accessToken, result.refreshToken, result.user);
    },
    [applySession],
  );

  const signOut = useCallback(async () => {
    const refreshToken = await secureStorage.getRefreshToken();
    if (refreshToken) {
      try {
        await clientRef.current!.logout(refreshToken);
      } catch {
        // Logout é best-effort no cliente; a sessão local é sempre limpa.
      }
    }
    await clearSession();
  }, [clearSession]);

  // Restauração de sessão ao abrir o app (README §16).
  useEffect(() => {
    let active = true;
    (async () => {
      const refreshToken = await secureStorage.getRefreshToken();
      if (!refreshToken) {
        if (active) setStatus("unauthenticated");
        return;
      }
      const accessToken = await doRefresh();
      if (!accessToken) {
        return; // doRefresh já limpou a sessão.
      }
      try {
        const me = await clientRef.current!.me();
        if (active) {
          setUser({ id: me.id, name: me.name, email: me.email });
          setStatus("authenticated");
        }
      } catch (error) {
        if (error instanceof ApiError) {
          await clearSession();
        } else {
          await clearSession();
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [doRefresh, clearSession]);

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        sessionPersistent: secureStorage.persistent,
        api,
        signIn,
        signUp,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth deve ser usado dentro de <AuthProvider>.");
  }
  return context;
}
