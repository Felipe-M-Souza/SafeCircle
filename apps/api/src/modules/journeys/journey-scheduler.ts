import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../infrastructure/database/client.js";
import { OverdueScheduler, type Clock } from "../../shared/overdue-scheduler.js";
import { markOverdueBatch, type OverdueJourney } from "./journeys.service.js";

/**
 * Scheduler de vencimento de trajetos (Phase 8): reutiliza o mesmo motor
 * genérico {@link OverdueScheduler} da Phase 7. A transição
 * `ACTIVE -> OVERDUE` é feita por `markOverdueBatch` com update condicional
 * atômico; a localização ao vivo NÃO é encerrada no vencimento (o trajeto
 * segue em andamento).
 */
export interface JourneySchedulerOptions {
  db: Database;
  log: FastifyBaseLogger;
  /** Efeitos pós-commit (realtime, push). Erros são capturados por trajeto. */
  onOverdue: (journey: OverdueJourney) => Promise<void> | void;
  intervalMs?: number;
  batchSize?: number;
  now?: Clock;
}

export class JourneyScheduler extends OverdueScheduler<OverdueJourney> {
  constructor(options: JourneySchedulerOptions) {
    super({
      log: options.log,
      findOverdue: (now, batchSize) => markOverdueBatch(options.db, now, batchSize),
      onOverdue: options.onOverdue,
      describe: (journey) => ({ journeyId: journey.id, groupId: journey.groupId }),
      label: "trajeto",
      metricName: "journeys",
      intervalMs: options.intervalMs,
      batchSize: options.batchSize,
      now: options.now,
    });
  }
}
