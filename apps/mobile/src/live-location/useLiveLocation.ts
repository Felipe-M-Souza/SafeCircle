import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import type { LiveLocationHistory, LiveLocationState } from "../lib/api";
import type { RealtimeEvent } from "../realtime/events";
import { useRealtimeEvents } from "../realtime/RealtimeProvider";
import { getLiveLocationController, type SharingSnapshot } from "./LiveLocationController";

/** Sem update há mais de 30 s a posição é considerada desatualizada. */
export const STALE_AFTER_MS = 30_000;

/**
 * Estado da localização ao vivo de um alerta, para quem visualiza (membros e
 * criador): recarrega via REST a cada evento realtime do alerta e a cada
 * (re)conexão. O WebSocket nunca traz coordenadas.
 */
export function useLiveLocationView(alertId: string, enabled: boolean) {
  const { api } = useAuth();
  const [state, setState] = useState<LiveLocationState | null>(null);
  const [history, setHistory] = useState<LiveLocationHistory | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      const [nextState, nextHistory] = await Promise.all([
        api.getLiveLocation(alertId),
        api.getLiveLocationHistory(alertId),
      ]);
      setState(nextState);
      setHistory(nextHistory);
    } catch {
      // Complementar ao alerta: falha aqui não esconde o restante da tela.
    }
  }, [api, alertId, enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onEvent = useCallback(
    (event: RealtimeEvent) => {
      if (event.data.alertId === alertId && event.type.startsWith("ALERT_LIVE_LOCATION_")) {
        void reload();
      }
    },
    [alertId, reload],
  );
  useRealtimeEvents(onEvent, reload);

  return { state, history, reload };
}

/** Compartilhamento do próprio criador (controller fora da tela). */
export function useLiveLocationSharing(alertId: string, enabled: boolean) {
  const { api } = useAuth();
  const controller = useMemo(
    () => (enabled ? getLiveLocationController(alertId, api) : null),
    [alertId, api, enabled],
  );
  const [snapshot, setSnapshot] = useState<SharingSnapshot | null>(
    controller?.getSnapshot() ?? null,
  );

  useEffect(() => {
    if (!controller) return undefined;
    setSnapshot(controller.getSnapshot());
    return controller.subscribe(setSnapshot);
  }, [controller]);

  return {
    snapshot,
    start: useCallback(() => controller?.start() ?? Promise.resolve(false), [controller]),
    stop: useCallback(
      (options?: { notifyBackend?: boolean }) => controller?.stop(options) ?? Promise.resolve(),
      [controller],
    ),
  };
}

/** Relógio de baixa frequência para calcular "há X s" sem depender de eventos. */
export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function secondsSince(iso: string, now: number): number {
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
}

export function isStale(receivedAt: string, now: number): boolean {
  return now - new Date(receivedAt).getTime() > STALE_AFTER_MS;
}
