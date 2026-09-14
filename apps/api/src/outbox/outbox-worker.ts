import { hostname } from "node:os";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../infrastructure/database/client.js";
import type { OutboxEvent } from "../infrastructure/database/schema.js";
import type { PushProvider } from "../infrastructure/push/push-provider.js";
import type { RealtimePublisher } from "../infrastructure/realtime/realtime-publisher.js";
import {
  outboxBacklog,
  outboxDeadTotal,
  outboxExpiredTotal,
  outboxOldestPendingAge,
  outboxProcessedTotal,
  outboxProcessingDuration,
  outboxRetriesTotal,
  safeLabel,
} from "../observability/metrics.js";
import { dispatchOutboxEvent } from "./handlers/index.js";
import {
  claimOutboxEvents,
  getOutboxBacklog,
  markDeadLettered,
  markExpired,
  markProcessed,
  scheduleRetryOrDeadLetter,
} from "./outbox.service.js";

/**
 * Worker da outbox (Phase 10).
 *
 * Roda no mesmo processo da API **nesta fase**, mas a durabilidade está toda no
 * PostgreSQL e o código não toca em Fastify: virar um processo separado é
 * trocar quem chama `start()`, nada mais.
 *
 * Ciclo de cada evento:
 *
 * 1. **Claim** em transação curta (`FOR UPDATE SKIP LOCKED` + lease).
 * 2. **Handler** fora da transação — nunca seguramos lock durante I/O externo.
 * 3. **Conclusão** persistida: PROCESSED, retry com backoff, DEAD ou expirado.
 *
 * Entrega **at-least-once**: uma queda entre o efeito externo e o UPDATE final
 * faz o evento ser reprocessado. Os handlers são escritos para tolerar isso.
 */

export const DEFAULT_POLL_INTERVAL_MS = 500;
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_CONCURRENCY = 5;
export const DEFAULT_LEASE_MS = 60_000;
/** Intervalo mínimo entre atualizações das métricas de backlog. */
const BACKLOG_REFRESH_MS = 5_000;
/** Tempo máximo esperando os handlers em andamento no shutdown. */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

export interface OutboxWorkerOptions {
  db: Database;
  pushProvider: PushProvider;
  realtime: RealtimePublisher;
  log: FastifyBaseLogger;
  pollIntervalMs?: number;
  batchSize?: number;
  concurrency?: number;
  leaseMs?: number;
  now?: () => Date;
  random?: () => number;
}

export class OutboxWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<number> | null = null;
  private stopping = false;
  private lastBacklogRefresh = 0;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(private readonly options: OutboxWorkerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.workerId = `${hostname()}:${process.pid}`;
  }

  isStarted(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.options.log.info(
      {
        event: "outbox_worker_started",
        workerId: this.workerId,
        pollIntervalMs: this.pollIntervalMs,
      },
      "Worker da outbox iniciado",
    );
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Aguarda o lote em andamento, sem esperar para sempre: o que não concluir
    // volta a ser elegível pela recuperação de lease.
    if (this.running) {
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
      });
      await Promise.race([this.running.then(() => undefined), timeout]);
      if (drainTimer) clearTimeout(drainTimer);
    }
    this.options.log.info(
      { event: "outbox_worker_stopped", workerId: this.workerId },
      "Worker da outbox encerrado",
    );
  }

  /**
   * Processa um lote e devolve quantos eventos foram concluídos.
   * Chamadas sobrepostas compartilham a mesma execução.
   */
  runOnce(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      void this.runOnce()
        .then((processed) => {
          // Fila vazia não vira busy loop: espera o intervalo de polling.
          this.scheduleNext(processed > 0 ? 0 : this.pollIntervalMs);
        })
        .catch((error: unknown) => {
          this.options.log.error(
            { event: "outbox_worker_cycle_failed", err: error },
            "Falha no ciclo do worker da outbox",
          );
          this.scheduleNext(this.pollIntervalMs);
        });
    }, delayMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  private async execute(): Promise<number> {
    const events = await claimOutboxEvents(this.options.db, {
      batchSize: this.batchSize,
      lockedBy: this.workerId,
      leaseMs: this.leaseMs,
      now: this.now(),
    });

    if (events.length === 0) {
      await this.refreshBacklogMetrics();
      return 0;
    }

    // Concorrência limitada: várias entregas em paralelo, sem estourar o
    // provedor nem o pool de conexões.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, events.length) }, async () => {
      while (cursor < events.length) {
        const event = events[cursor++];
        if (event) await this.processEvent(event);
      }
    });
    await Promise.all(workers);
    await this.refreshBacklogMetrics(true);
    return events.length;
  }

  private async processEvent(event: OutboxEvent): Promise<void> {
    const eventType = safeLabel(event.eventType);
    const startedAt = process.hrtime.bigint();
    const now = this.now();

    this.options.log.debug(
      {
        event: "outbox_event_claimed",
        outboxEventId: event.id,
        eventType: event.eventType,
        attemptCount: event.attemptCount,
      },
      "Evento da outbox reivindicado",
    );

    // Expirou enquanto esperava: encerra sem executar o efeito.
    if (event.expiresAt && event.expiresAt.getTime() <= now.getTime()) {
      await markExpired(this.options.db, event.id, now);
      outboxExpiredTotal.inc({ event_type: eventType });
      this.options.log.info(
        { event: "outbox_event_expired", outboxEventId: event.id, eventType: event.eventType },
        "Evento da outbox expirou antes da entrega",
      );
      return;
    }

    let result;
    try {
      result = await dispatchOutboxEvent(
        {
          db: this.options.db,
          pushProvider: this.options.pushProvider,
          realtime: this.options.realtime,
          log: this.options.log,
        },
        event,
      );
    } catch (error) {
      // Handler quebrou de forma inesperada: trata como transitório, mas
      // registra — é bug até prova em contrário.
      this.options.log.error(
        { event: "outbox_handler_crashed", err: error, outboxEventId: event.id },
        "Handler da outbox lançou erro inesperado",
      );
      result = {
        outcome: "TRANSIENT_FAILURE" as const,
        errorCode: "HANDLER_UNEXPECTED_ERROR" as const,
      };
    }

    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    outboxProcessingDuration.observe({ event_type: eventType }, durationSeconds);

    if (result.outcome === "SUCCESS") {
      await markProcessed(this.options.db, event.id, this.now());
      outboxProcessedTotal.inc({ event_type: eventType, result: "success" });
      this.options.log.debug(
        { event: "outbox_event_processed", outboxEventId: event.id, eventType: event.eventType },
        "Evento da outbox processado",
      );
      return;
    }

    if (result.outcome === "EXPIRED") {
      await markExpired(this.options.db, event.id, this.now());
      outboxExpiredTotal.inc({ event_type: eventType });
      return;
    }

    if (result.outcome === "PERMANENT_FAILURE") {
      await markDeadLettered(
        this.options.db,
        event.id,
        result.errorCode ?? "HANDLER_UNEXPECTED_ERROR",
        this.now(),
      );
      outboxDeadTotal.inc({ event_type: eventType });
      this.options.log.error(
        {
          event: "outbox_event_dead_lettered",
          outboxEventId: event.id,
          eventType: event.eventType,
          attemptCount: event.attemptCount + 1,
          lastErrorCode: result.errorCode,
          reason: "permanent",
        },
        "Evento da outbox descartado por falha permanente",
      );
      return;
    }

    const retry = await scheduleRetryOrDeadLetter(
      this.options.db,
      event,
      result.errorCode ?? "HANDLER_UNEXPECTED_ERROR",
      this.now(),
      this.random,
    );

    if (retry.status === "DEAD") {
      outboxDeadTotal.inc({ event_type: eventType });
      this.options.log.error(
        {
          event: "outbox_event_dead_lettered",
          outboxEventId: event.id,
          eventType: event.eventType,
          attemptCount: retry.attemptCount,
          lastErrorCode: result.errorCode,
          reason: "max_attempts",
        },
        "Evento da outbox atingiu o limite de tentativas",
      );
      return;
    }

    outboxRetriesTotal.inc({ event_type: eventType });
    this.options.log.warn(
      {
        event: "outbox_event_retry_scheduled",
        outboxEventId: event.id,
        eventType: event.eventType,
        attemptCount: retry.attemptCount,
        lastErrorCode: result.errorCode,
        availableAt: retry.availableAt?.toISOString(),
      },
      "Reprocessamento do evento da outbox agendado",
    );
  }

  /** Backlog é agregado, e só de tempos em tempos — nunca por evento. */
  private async refreshBacklogMetrics(force = false): Promise<void> {
    const nowMs = Date.now();
    if (!force && nowMs - this.lastBacklogRefresh < BACKLOG_REFRESH_MS) return;
    this.lastBacklogRefresh = nowMs;
    try {
      const backlog = await getOutboxBacklog(this.options.db, this.now());
      outboxBacklog.set({ status: "pending" }, backlog.pending);
      outboxBacklog.set({ status: "processing" }, backlog.processing);
      outboxBacklog.set({ status: "dead" }, backlog.dead);
      outboxOldestPendingAge.set(backlog.oldestPendingAgeSeconds);
    } catch (error) {
      this.options.log.debug(
        { event: "outbox_backlog_refresh_failed", err: error },
        "Falha ao atualizar métricas de backlog da outbox",
      );
    }
  }
}
