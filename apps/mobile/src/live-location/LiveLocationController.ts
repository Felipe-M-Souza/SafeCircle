import { strings, translateErrorCode } from "../i18n/pt-BR";
import {
  ApiError,
  type ApiClient,
  type LiveLocationState,
  type LiveLocationUpdateInput,
} from "../lib/api";
import {
  requestLiveLocationPermission,
  watchLiveLocation,
  type LiveLocationPermission,
  type LocationSample,
  type WatchHandle,
} from "./live-location.service";
import { LiveLocationUploader, type UploaderStatus } from "./LiveLocationUploader";

/**
 * Transporte REST do compartilhamento: abstrai o recurso (alerta ou trajeto)
 * para que o MESMO controller/GPS/uploader sirva às Phases 6 e 8. Cada recurso
 * fornece suas quatro operações; o controller não conhece endpoints.
 */
export interface LiveLocationTransport {
  start(): Promise<unknown>;
  send(point: LiveLocationUpdateInput): Promise<unknown>;
  stop(): Promise<unknown>;
  getState(): Promise<LiveLocationState>;
}

/** Transporte de um alerta (Phase 6). */
export function alertTransport(api: ApiClient, alertId: string): LiveLocationTransport {
  return {
    start: () => api.startLiveLocation(alertId),
    send: (point) => api.sendLiveLocation(alertId, point),
    stop: () => api.stopLiveLocation(alertId),
    getState: () => api.getLiveLocation(alertId),
  };
}

/** Transporte de um trajeto (Phase 8). */
export function journeyTransport(api: ApiClient, journeyId: string): LiveLocationTransport {
  return {
    start: () => api.startJourneyLiveLocation(journeyId),
    send: (point) => api.sendJourneyLiveLocation(journeyId, point),
    stop: () => api.stopJourneyLiveLocation(journeyId),
    getState: () => api.getJourneyLiveLocation(journeyId),
  };
}

/**
 * Sessão de compartilhamento ao vivo do criador de um recurso (alerta na
 * Phase 6, trajeto na Phase 8) — um único sistema de GPS.
 *
 * Vive fora das telas (registro por recurso) para que navegar dentro do app
 * não interrompa o compartilhamento. É parado: manualmente, ao encerrar o
 * recurso, quando o backend informa que a sessão não está mais ativa, no
 * logout e quando a autorização se perde.
 */

export type SharingState = "INACTIVE" | "STARTING" | "ACTIVE" | "DEGRADED" | "STOPPED";

export interface SharingSnapshot {
  state: SharingState;
  /** Instante (ms) do último envio bem-sucedido. */
  lastSentAt: number | null;
  /** Mensagem pt-BR quando a ativação falhou ou a sessão foi encerrada por erro. */
  error: string | null;
  permission: LiveLocationPermission | null;
}

export interface ControllerDeps {
  requestPermission?: () => Promise<LiveLocationPermission>;
  watch?: (onSample: (sample: LocationSample) => void) => Promise<WatchHandle>;
  now?: () => number;
}

type Listener = (snapshot: SharingSnapshot) => void;

export class LiveLocationController {
  private snapshot: SharingSnapshot = {
    state: "INACTIVE",
    lastSentAt: null,
    error: null,
    permission: null,
  };
  private readonly listeners = new Set<Listener>();
  private watcher: WatchHandle | null = null;
  private uploader: LiveLocationUploader | null = null;
  private readonly requestPermission: () => Promise<LiveLocationPermission>;
  private readonly watch: (onSample: (sample: LocationSample) => void) => Promise<WatchHandle>;
  private readonly now: () => number;

  private readonly transport: LiveLocationTransport;

  constructor(
    readonly alertId: string,
    api: ApiClient,
    deps: ControllerDeps = {},
    transport?: LiveLocationTransport,
  ) {
    // Sem transporte explícito, assume-se um alerta (compatível com a Phase 6).
    this.transport = transport ?? alertTransport(api, alertId);
    this.requestPermission = deps.requestPermission ?? requestLiveLocationPermission;
    this.watch = deps.watch ?? watchLiveLocation;
    this.now = deps.now ?? Date.now;
  }

  getSnapshot(): SharingSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<SharingSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  isActive(): boolean {
    return this.snapshot.state === "ACTIVE" || this.snapshot.state === "DEGRADED";
  }

  /** Ativa o compartilhamento (após o consentimento explícito na UI). */
  async start(): Promise<boolean> {
    if (this.isActive() || this.snapshot.state === "STARTING") return true;
    this.update({ state: "STARTING", error: null });

    const permission = await this.requestPermission();
    if (permission !== "granted") {
      const t = strings.liveLocation;
      this.update({
        state: "INACTIVE",
        permission,
        error: permission === "services-disabled" ? t.servicesDisabled : t.permissionDenied,
      });
      return false;
    }

    try {
      await this.transport.start();
    } catch (error) {
      this.update({
        state: "INACTIVE",
        permission,
        error:
          error instanceof ApiError ? translateErrorCode(error.code) : strings.common.genericError,
      });
      return false;
    }

    this.uploader = new LiveLocationUploader({
      send: (point) => this.transport.send(point),
      now: this.now,
      onSent: (_point, sentAt) => this.update({ lastSentAt: sentAt }),
      onStatus: (status: UploaderStatus) => {
        if (!this.isActive()) return;
        this.update({ state: status === "degraded" ? "DEGRADED" : "ACTIVE" });
      },
      onFatal: (error) => {
        // Backend recusou definitivamente (sessão/alerta encerrado, sem permissão).
        void this.stop({ notifyBackend: false, error: translateErrorCode(error.code) });
      },
    });

    try {
      this.watcher = await this.watch((sample) => this.uploader?.enqueue(sample));
    } catch {
      this.uploader.stop();
      this.uploader = null;
      this.update({ state: "INACTIVE", permission, error: strings.liveLocation.permissionDenied });
      return false;
    }

    this.update({ state: "ACTIVE", permission, error: null });
    return true;
  }

  /**
   * Para o compartilhamento: watcher e uploader são encerrados imediatamente;
   * o backend é avisado em best-effort (quando ele mesmo já encerrou a sessão,
   * `notifyBackend: false`).
   */
  async stop(options: { notifyBackend?: boolean; error?: string | null } = {}): Promise<void> {
    const wasRunning = this.watcher !== null || this.uploader !== null;
    this.watcher?.remove();
    this.watcher = null;
    this.uploader?.stop();
    this.uploader = null;
    if (wasRunning || this.snapshot.state === "STARTING") {
      this.update({ state: "STOPPED", error: options.error ?? null });
    }
    if (options.notifyBackend !== false && wasRunning) {
      try {
        await this.transport.stop();
      } catch {
        // Best-effort: sem alerta ativo o backend já rejeita novos pontos.
      }
    }
  }

  /** Ao voltar ao primeiro plano: confirma no backend se ainda está autorizado a compartilhar. */
  async resync(): Promise<void> {
    if (!this.isActive()) return;
    try {
      const state = await this.transport.getState();
      if (state.status !== "ACTIVE") {
        await this.stop({ notifyBackend: false });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        await this.stop({ notifyBackend: false });
      }
      // Erro de rede: mantém; o uploader já lida com falhas temporárias.
    }
  }
}

// ------------------------------------------------------------------
// Registro por alerta (uma sessão local por alerta)
// ------------------------------------------------------------------

const controllers = new Map<string, LiveLocationController>();

/** Controller de compartilhamento de um alerta (Phase 6). Chave: `alert:<id>`. */
export function getLiveLocationController(
  alertId: string,
  api: ApiClient,
  deps?: ControllerDeps,
): LiveLocationController {
  const key = `alert:${alertId}`;
  let controller = controllers.get(key);
  if (!controller) {
    controller = new LiveLocationController(alertId, api, deps, alertTransport(api, alertId));
    controllers.set(key, controller);
  }
  return controller;
}

/** Controller de compartilhamento de um trajeto (Phase 8). Chave: `journey:<id>`. */
export function getJourneyLiveLocationController(
  journeyId: string,
  api: ApiClient,
  deps?: ControllerDeps,
): LiveLocationController {
  const key = `journey:${journeyId}`;
  let controller = controllers.get(key);
  if (!controller) {
    controller = new LiveLocationController(journeyId, api, deps, journeyTransport(api, journeyId));
    controllers.set(key, controller);
  }
  return controller;
}

/** Para todos os compartilhamentos (logout, sessão inválida). */
export async function stopAllLiveLocation(
  options: { notifyBackend?: boolean } = {},
): Promise<void> {
  const all = [...controllers.values()];
  await Promise.all(all.map((controller) => controller.stop(options)));
}

/** Ao voltar ao primeiro plano: ressincroniza cada compartilhamento ativo. */
export async function resyncAllLiveLocation(): Promise<void> {
  await Promise.all([...controllers.values()].map((controller) => controller.resync()));
}

/** Apenas para testes. */
export function resetLiveLocationRegistry(): void {
  controllers.clear();
}
