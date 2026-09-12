import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../infrastructure/database/client.js";
import { markOverdueBatch, type Clock, type OverdueCheckin } from "./checkins.service.js";

/**
 * Scheduler de vencimento (Phase 7): polling periódico sobre o PostgreSQL.
 *
 * - O prazo vive no banco (`due_at`); um restart da API não perde vencimentos.
 * - `runOnce()` processa um lote com update condicional atômico; execuções
 *   concorrentes (dois ticks, duas instâncias) nunca produzem dois efeitos
 *   para o mesmo check-in — só quem alterou a linha chama `onOverdue`.
 * - `start()`/`stop()` seguem o lifecycle do Fastify; nenhum timer órfão.
 *
 * Limitação (ADR 0008): instância única. Com várias instâncias cada uma faz
 * polling, mas o update condicional garante efeito único por check-in; a
 * evolução natural é um worker/job queue ou lock distribuído.
 */
export interface CheckinSchedulerOptions {
  db: Database;
  log: FastifyBaseLogger;
  /** Efeitos pós-commit (realtime, push). Erros são capturados por check-in. */
  onOverdue: (checkin: OverdueCheckin) => Promise<void> | void;
  intervalMs?: number;
  batchSize?: number;
  now?: Clock;
}

export const DEFAULT_SCHEDULER_INTERVAL_MS = 15_000;
export const DEFAULT_SCHEDULER_BATCH_SIZE = 100;

export class CheckinScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly now: Clock;

  constructor(private readonly options: CheckinSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_SCHEDULER_BATCH_SIZE;
    this.now = options.now ?? (() => new Date());
  }

  isStarted(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.options.log.error({ err: error }, "Falha no scheduler de check-ins");
      });
    }, this.intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Processa um lote de check-ins vencidos e devolve quantos mudaram para
   * OVERDUE. Chamadas sobrepostas no mesmo processo compartilham a execução.
   */
  runOnce(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.execute().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async execute(): Promise<number> {
    const now = this.now();
    const overdue = await markOverdueBatch(this.options.db, now, this.batchSize);
    for (const checkin of overdue) {
      try {
        await this.options.onOverdue(checkin);
      } catch (error) {
        this.options.log.error(
          { err: error, checkinId: checkin.id, groupId: checkin.groupId },
          "Falha nos efeitos de check-in vencido",
        );
      }
    }
    if (overdue.length > 0) {
      this.options.log.info({ processed: overdue.length }, "Check-ins marcados como OVERDUE");
    }
    return overdue.length;
  }
}
