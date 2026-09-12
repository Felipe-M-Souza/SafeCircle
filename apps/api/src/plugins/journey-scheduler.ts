import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { createRealtimeEvent } from "../infrastructure/realtime/events.js";
import { notifyJourneyOverdue } from "../modules/journeys/journey-notifications.service.js";
import { JourneyScheduler } from "../modules/journeys/journey-scheduler.js";

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
 * Efeitos de atraso (realtime + push) rodam em segundo plano após o commit da
 * transição, capturados pelo runner — nunca revertem o estado.
 */
export const journeySchedulerPlugin = fp(
  async (app: FastifyInstance, options: JourneySchedulerPluginOptions) => {
    const scheduler = new JourneyScheduler({
      db: app.db,
      log: app.log,
      intervalMs: options.intervalMs,
      onOverdue: (journey) => {
        app.background.run("realtime:JOURNEY_OVERDUE", () =>
          app.realtime.publishToGroup(
            journey.groupId,
            createRealtimeEvent("JOURNEY_OVERDUE", {
              journeyId: journey.id,
              groupId: journey.groupId,
              userId: journey.userId,
            }),
          ),
        );
        app.background.run("journey-overdue-push", () =>
          notifyJourneyOverdue(
            { db: app.db, pushProvider: app.pushProvider, log: app.log },
            journey,
          ),
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
    dependencies: ["safecircle-database", "safecircle-realtime", "safecircle-background-tasks"],
  },
);
