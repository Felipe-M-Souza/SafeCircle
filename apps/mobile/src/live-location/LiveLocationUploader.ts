import { ApiError, type LiveLocationUpdateInput } from "../lib/api";
import { randomUUID } from "../lib/uuid";
import type { LocationSample } from "./live-location.service";

/**
 * Envio dos pontos ao backend (Phase 6).
 *
 * - Mantém no máximo UM ponto pendente (o mais recente); pontos antigos são
 *   descartados — nunca despeja centenas de pontos ao reconectar.
 * - Respeita um intervalo mínimo entre envios (o servidor também limita).
 * - Em falha temporária (rede, 5xx, 429) mantém o ponto e tenta de novo com o
 *   MESMO `clientUpdateId`; em resposta definitiva (4xx) descarta e avisa.
 * - Pontos pendentes mais velhos que `maxAgeMs` são descartados.
 */

export type UploaderStatus = "idle" | "sending" | "degraded";

export interface LiveLocationUploaderOptions {
  send: (point: LiveLocationUpdateInput) => Promise<unknown>;
  /** Erro definitivo do backend (ex.: sessão encerrada): quem chama deve parar. */
  onFatal?: (error: ApiError) => void;
  onStatus?: (status: UploaderStatus) => void;
  onSent?: (point: LiveLocationUpdateInput, sentAt: number) => void;
  minIntervalMs?: number;
  retryDelayMs?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export const DEFAULT_MIN_INTERVAL_MS = 4000;
export const DEFAULT_RETRY_DELAY_MS = 3000;
export const DEFAULT_MAX_AGE_MS = 60_000;

export class LiveLocationUploader {
  private readonly options: Required<
    Pick<LiveLocationUploaderOptions, "minIntervalMs" | "retryDelayMs" | "maxAgeMs" | "now">
  > &
    LiveLocationUploaderOptions;
  private pending: { point: LiveLocationUpdateInput; enqueuedAt: number } | null = null;
  private inFlight = false;
  private lastSentAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private status: UploaderStatus = "idle";

  constructor(options: LiveLocationUploaderOptions) {
    this.options = {
      minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      maxAgeMs: DEFAULT_MAX_AGE_MS,
      now: Date.now,
      ...options,
    };
  }

  getStatus(): UploaderStatus {
    return this.status;
  }

  /** Apenas para testes/diagnóstico: ponto pendente atual (sem logar coordenadas). */
  getPending(): LiveLocationUpdateInput | null {
    return this.pending?.point ?? null;
  }

  enqueue(sample: LocationSample): void {
    if (this.stopped) return;
    // Substitui qualquer pendente anterior: só o ponto mais recente importa.
    this.pending = {
      point: { ...sample, clientUpdateId: randomUUID() },
      enqueuedAt: this.options.now(),
    };
    void this.flush();
  }

  stop(): void {
    this.stopped = true;
    this.pending = null;
    this.clearTimer();
  }

  private setStatus(status: UploaderStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.inFlight || !this.pending) return;

    const now = this.options.now();
    if (now - this.pending.enqueuedAt > this.options.maxAgeMs) {
      // Ponto velho demais para ser útil (e potencialmente enganoso).
      this.pending = null;
      return;
    }
    const wait = this.options.minIntervalMs - (now - this.lastSentAt);
    if (wait > 0) {
      this.schedule(wait);
      return;
    }

    const current = this.pending;
    this.inFlight = true;
    this.setStatus("sending");
    try {
      await this.options.send(current.point);
      this.lastSentAt = this.options.now();
      if (this.pending === current) {
        this.pending = null;
      }
      this.options.onSent?.(current.point, this.lastSentAt);
      this.setStatus("idle");
    } catch (error) {
      if (this.stopped) return;
      const definitive =
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429;
      if (definitive) {
        if (this.pending === current) this.pending = null;
        this.setStatus("idle");
        this.options.onFatal?.(error as ApiError);
        return;
      }
      // Temporário: mantém o ponto (mesmo clientUpdateId) e tenta de novo.
      this.setStatus("degraded");
      this.schedule(this.options.retryDelayMs);
    } finally {
      this.inFlight = false;
      if (!this.stopped && this.pending && !this.timer) {
        this.schedule(
          Math.max(0, this.options.minIntervalMs - (this.options.now() - this.lastSentAt)),
        );
      }
    }
  }
}
