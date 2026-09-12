import type { FastifyBaseLogger } from "fastify";

/**
 * Scheduler genérico de vencimento por polling sobre o PostgreSQL (Phases 7/8).
 *
 * O prazo vive no banco; um restart da API não perde vencimentos. Cada
 * `runOnce()` processa um lote com um update condicional atômico feito por
 * `findOverdue` (compare-and-swap no `WHERE`), então execuções concorrentes
 * (dois ticks, duas instâncias) nunca produzem dois efeitos para o mesmo
 * registro — só quem alterou a linha recebe o item e chama `onOverdue`.
 *
 * Limitação: instância única. Com várias instâncias cada uma faz polling, mas
 * o update condicional garante efeito único; a evolução natural é um
 * worker/job queue ou lock distribuído.
 */
export type Clock = () => Date;

export interface OverdueSchedulerOptions<T> {
  log: FastifyBaseLogger;
  /** Marca um lote como vencido de forma atômica e devolve os itens alterados. */
  findOverdue: (now: Date, batchSize: number) => Promise<T[]>;
  /** Efeitos pós-commit (realtime, push). Erros são capturados por item. */
  onOverdue: (item: T) => Promise<void> | void;
  /** Contexto seguro para logs (somente IDs, nunca dados pessoais). */
  describe: (item: T) => Record<string, unknown>;
  /** Nome do recurso para as mensagens de log (ex.: "check-in", "trajeto"). */
  label: string;
  intervalMs?: number;
  batchSize?: number;
  now?: Clock;
}

export const DEFAULT_SCHEDULER_INTERVAL_MS = 15_000;
export const DEFAULT_SCHEDULER_BATCH_SIZE = 100;

export class OverdueScheduler<T> {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<number> | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly now: Clock;

  constructor(private readonly options: OverdueSchedulerOptions<T>) {
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
        this.options.log.error({ err: error }, `Falha no scheduler de ${this.options.label}`);
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
   * Processa um lote de registros vencidos e devolve quantos mudaram de
   * estado. Chamadas sobrepostas no mesmo processo compartilham a execução.
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
    const overdue = await this.options.findOverdue(now, this.batchSize);
    for (const item of overdue) {
      try {
        await this.options.onOverdue(item);
      } catch (error) {
        this.options.log.error(
          { err: error, ...this.options.describe(item) },
          `Falha nos efeitos de ${this.options.label} vencido`,
        );
      }
    }
    if (overdue.length > 0) {
      this.options.log.info(
        { processed: overdue.length },
        `${this.options.label} marcados como OVERDUE`,
      );
    }
    return overdue.length;
  }
}
