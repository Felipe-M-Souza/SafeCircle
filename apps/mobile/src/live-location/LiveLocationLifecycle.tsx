import { useEffect } from "react";
import { AppState } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { resyncAllLiveLocation, stopAllLiveLocation } from "./LiveLocationController";

/**
 * Integra os compartilhamentos ao vivo com o ciclo de vida do app (Phase 6).
 *
 * - Volta ao primeiro plano: confirma no backend se cada sessão ainda está
 *   autorizada (alerta ativo, sessão ACTIVE) e para as que não estão.
 * - Sessão encerrada (logout/expirada): para tudo localmente, imediatamente.
 *
 * Limitação (ADR 0007): apenas primeiro plano; em background o SO pode
 * suspender o watcher e as atualizações são retomadas ao voltar.
 */
export function LiveLocationLifecycle(): null {
  const { status } = useAuth();

  useEffect(() => {
    if (status === "unauthenticated") {
      void stopAllLiveLocation({ notifyBackend: false });
    }
  }, [status]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        void resyncAllLiveLocation();
      }
    });
    return () => subscription.remove();
  }, []);

  return null;
}
