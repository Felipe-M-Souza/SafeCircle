import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../infrastructure/database/client.js";
import {
  DEFAULT_SCHEDULER_BATCH_SIZE,
  DEFAULT_SCHEDULER_INTERVAL_MS,
  OverdueScheduler,
  type Clock,
} from "../../shared/overdue-scheduler.js";
import { markOverdueBatch, type OverdueCheckin } from "./checkins.service.js";

export { DEFAULT_SCHEDULER_BATCH_SIZE, DEFAULT_SCHEDULER_INTERVAL_MS };

/**
 * Scheduler de vencimento de check-ins (Phase 7): polling sobre o PostgreSQL.
 * Reutiliza o motor genérico {@link OverdueScheduler}; a transição
 * `ACTIVE -> OVERDUE` é feita por `markOverdueBatch` com update condicional.
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

export class CheckinScheduler extends OverdueScheduler<OverdueCheckin> {
  constructor(options: CheckinSchedulerOptions) {
    super({
      log: options.log,
      findOverdue: (now, batchSize) => markOverdueBatch(options.db, now, batchSize),
      onOverdue: options.onOverdue,
      describe: (checkin) => ({ checkinId: checkin.id, groupId: checkin.groupId }),
      label: "check-in",
      metricName: "checkins",
      intervalMs: options.intervalMs,
      batchSize: options.batchSize,
      now: options.now,
    });
  }
}
