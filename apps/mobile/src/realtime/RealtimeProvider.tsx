import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { API_BASE_URL } from "../config";
import type { RealtimeEvent } from "./events";
import {
  RealtimeClient,
  realtimeUrlFromApiBase,
  type RealtimeConnectionState,
  type SocketFactory,
} from "./RealtimeClient";

/**
 * Integra o RealtimeClient ao ciclo de vida do app (Phase 5).
 *
 * - Conecta após login/restauração de sessão; para no logout.
 * - Quando o access token muda (refresh), reconecta com o token novo.
 * - AppState: em background o socket é fechado (o push cobre o awareness);
 *   ao voltar ao primeiro plano reconecta.
 * - A cada conexão bem-sucedida `resyncVersion` é incrementado: telas que
 *   dependem de eventos devem recarregar o estado pela API (eventos perdidos
 *   durante a desconexão nunca são assumidos).
 * - Uma única instância de cliente/socket por app; listeners com cleanup.
 */
export interface RealtimeContextValue {
  state: RealtimeConnectionState;
  /** Assina eventos validados/deduplicados. Devolve a função de cancelamento. */
  subscribe: (listener: (event: RealtimeEvent) => void) => () => void;
  /** Incrementa em cada (re)conexão — gatilho de ressincronização REST. */
  resyncVersion: number;
}

export const RealtimeContext = createContext<RealtimeContextValue | null>(null);

export interface RealtimeProviderProps {
  children: React.ReactNode;
  /** Transporte injetável (testes). Padrão: WebSocket nativo. */
  createSocket?: SocketFactory;
  url?: string;
}

export function RealtimeProvider({
  children,
  createSocket,
  url = realtimeUrlFromApiBase(API_BASE_URL),
}: RealtimeProviderProps): React.JSX.Element {
  const { status, getAccessToken, refreshAccessToken, accessTokenVersion } = useAuth();
  const [state, setState] = useState<RealtimeConnectionState>("DISCONNECTED");
  const [resyncVersion, setResyncVersion] = useState(0);
  const clientRef = useRef<RealtimeClient | null>(null);
  const lastTokenVersionRef = useRef(accessTokenVersion);

  if (!clientRef.current) {
    clientRef.current = new RealtimeClient({
      url,
      getAccessToken,
      refreshAccessToken,
      createSocket,
    });
  }
  const client = clientRef.current;

  useEffect(() => {
    const offState = client.onStateChange(setState);
    const offConnected = client.onConnected(() => setResyncVersion((v) => v + 1));
    return () => {
      offState();
      offConnected();
      client.stop();
    };
  }, [client]);

  // Login/logout.
  useEffect(() => {
    if (status === "authenticated") {
      client.start();
    } else {
      client.stop();
    }
  }, [client, status]);

  // Token renovado: fecha a conexão antiga e reconecta com o token novo.
  useEffect(() => {
    if (lastTokenVersionRef.current === accessTokenVersion) return;
    lastTokenVersionRef.current = accessTokenVersion;
    if (status === "authenticated" && client.isRunning()) {
      client.restart();
    }
  }, [client, status, accessTokenVersion]);

  // Background/foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        if (status === "authenticated") client.start();
      } else if (next === "background") {
        client.stop();
      }
    });
    return () => subscription.remove();
  }, [client, status]);

  const subscribe = useCallback(
    (listener: (event: RealtimeEvent) => void) => client.onEvent(listener),
    [client],
  );

  return (
    <RealtimeContext.Provider value={{ state, subscribe, resyncVersion }}>
      {children}
    </RealtimeContext.Provider>
  );
}

/** `null` fora do provider (telas seguem funcionando só com REST). */
export function useRealtime(): RealtimeContextValue | null {
  return useContext(RealtimeContext);
}

/**
 * Assina eventos realtime (com filtro opcional) e reage à ressincronização.
 * `onEvent`/`onResync` devem ser estáveis (useCallback) ou recriar a assinatura.
 */
export function useRealtimeEvents(
  onEvent: (event: RealtimeEvent) => void,
  onResync?: () => void,
): void {
  const realtime = useRealtime();
  const resyncVersion = realtime?.resyncVersion ?? 0;

  useEffect(() => {
    if (!realtime) return undefined;
    return realtime.subscribe(onEvent);
  }, [realtime, onEvent]);

  // Reexecuta apenas quando a versão muda (não na montagem): a tela já carregou.
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;
  const lastVersionRef = useRef(resyncVersion);
  useEffect(() => {
    if (lastVersionRef.current === resyncVersion) return;
    lastVersionRef.current = resyncVersion;
    onResyncRef.current?.();
  }, [resyncVersion]);
}
