import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { JourneyScheduler } from "../modules/journeys/journey-scheduler.js";
import { journeyTransitionsTotal } from "../observability/metrics.js";

declare module "fastify" {
  interface FastifyInstance {
    journeyScheduler: JourneyScheduler;
  }
}

export interface JourneySchedulerPluginOptions {
  /** Inicia o polling com o servidor (desligado nos testes, que chamam runOnce()). */
  autoStart: boolean;
  intervalMs?: number;
}

/**
 * Integra o JourneyScheduler ao lifecycle do Fastify (Phase 8).
 *
 * Phase 10: como no check-in, os efeitos do atraso são gravados na mesma
 * transação da transição `ACTIVE -> OVERDUE` (ver `markOverdueBatch`) e
 * entregues pelo worker da outbox.
 */
export const journeySchedulerPlugin = fp(
  async (app: FastifyInstance, options: JourneySchedulerPluginOptions) => {
    const scheduler = new JourneyScheduler({
      db: app.db,
      log: app.log,
      intervalMs: options.intervalMs,
      onOverdue: (journey) => {
        journeyTransitionsTotal.inc({ transition: "overdue" });
        app.log.debug(
          { event: "journey_marked_overdue", journeyId: journey.id, groupId: journey.groupId },
          "Trajeto atrasado registrado",
        );
      },
    });

    app.decorate("journeyScheduler", scheduler);

    app.addHook("onReady", async () => {
      if (options.autoStart) scheduler.start();
    });
    app.addHook("onClose", async () => {
      scheduler.stop();
    });
  },
  {
    name: "safecircle-journey-scheduler",
    dependencies: ["safecircle-database"],
  },
);
