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
 * Desde a Phase 13 (ADR 0015) o compartilhamento continua com a tela bloqueada
 * e o app em segundo plano, por serviço em primeiro plano. A ressincronização
 * ao voltar continua valendo: é ela que encerra sessões que o backend já não
 * autoriza mais.
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
