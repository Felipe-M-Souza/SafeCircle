import { strings, translateErrorCode } from "../i18n/pt-BR";
import { ApiError, type ApiClient } from "../lib/api";
import {
  requestLiveLocationPermission,
  watchLiveLocation,
  type LiveLocationPermission,
  type LocationSample,
  type WatchHandle,
} from "./live-location.service";
import { LiveLocationUploader, type UploaderStatus } from "./LiveLocationUploader";

/**
 * Sessão de compartilhamento ao vivo do criador para um alerta (Phase 6).
 *
 * Vive fora das telas (registro por alertId) para que navegar dentro do app
 * não interrompa o compartilhamento. É parado: manualmente, ao resolver ou
 * cancelar o alerta, quando o backend informa que a sessão não está mais
 * ativa, no logout e quando a autorização se perde.
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

  constructor(
    readonly alertId: string,
    private readonly api: ApiClient,
    deps: ControllerDeps = {},
  ) {
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
      await this.api.startLiveLocation(this.alertId);
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
      send: (point) => this.api.sendLiveLocation(this.alertId, point),
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
        await this.api.stopLiveLocation(this.alertId);
      } catch {
        // Best-effort: sem alerta ativo o backend já rejeita novos pontos.
      }
    }
  }

  /** Ao voltar ao primeiro plano: confirma no backend se ainda está autorizado a compartilhar. */
  async resync(): Promise<void> {
    if (!this.isActive()) return;
    try {
      const state = await this.api.getLiveLocation(this.alertId);
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

export function getLiveLocationController(
  alertId: string,
  api: ApiClient,
  deps?: ControllerDeps,
): LiveLocationController {
  let controller = controllers.get(alertId);
  if (!controller) {
    controller = new LiveLocationController(alertId, api, deps);
    controllers.set(alertId, controller);
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
