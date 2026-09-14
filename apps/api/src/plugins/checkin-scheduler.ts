import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { createRealtimeEvent } from "../infrastructure/realtime/events.js";
import { notifyCheckinOverdue } from "../modules/checkins/checkin-notifications.service.js";
import { CheckinScheduler } from "../modules/checkins/checkin-scheduler.js";
import { checkinTransitionsTotal } from "../observability/metrics.js";

declare module "fastify" {
  interface FastifyInstance {
    checkinScheduler: CheckinScheduler;
  }
}

export interface CheckinSchedulerPluginOptions {
  /** Inicia o polling com o servidor (desligado nos testes, que chamam runOnce()). */
  autoStart: boolean;
  intervalMs?: number;
}

/**
 * Integra o CheckinScheduler ao lifecycle do Fastify (Phase 7).
 * Efeitos de vencimento (realtime + push) rodam em segundo plano após o
 * commit da transição, capturados pelo runner — nunca revertem o estado.
 */
export const checkinSchedulerPlugin = fp(
  async (app: FastifyInstance, options: CheckinSchedulerPluginOptions) => {
    const scheduler = new CheckinScheduler({
      db: app.db,
      log: app.log,
      intervalMs: options.intervalMs,
      onOverdue: (checkin) => {
        checkinTransitionsTotal.inc({ transition: "overdue" });
        // Ator nulo: a transição é do sistema, não de uma pessoa.
        app.audit({
          eventType: "CHECKIN_OVERDUE",
          actorUserId: null,
          targetType: "CHECKIN",
          targetId: checkin.id,
          groupId: checkin.groupId,
          metadata: { source: "scheduler" },
        });
        app.background.run("realtime:CHECKIN_OVERDUE", () =>
          app.realtime.publishToGroup(
            checkin.groupId,
            createRealtimeEvent("CHECKIN_OVERDUE", {
              checkinId: checkin.id,
              groupId: checkin.groupId,
              userId: checkin.userId,
            }),
          ),
        );
        app.background.run("checkin-overdue-push", () =>
          notifyCheckinOverdue(
            { db: app.db, pushProvider: app.pushProvider, log: app.log },
            checkin,
          ),
        );
      },
    });

    app.decorate("checkinScheduler", scheduler);

    app.addHook("onReady", async () => {
      if (options.autoStart) scheduler.start();
    });
    app.addHook("onClose", async () => {
      scheduler.stop();
    });
  },
  {
    name: "safecircle-checkin-scheduler",
    dependencies: [
      "safecircle-database",
      "safecircle-realtime",
      "safecircle-background-tasks",
      "safecircle-audit",
    ],
  },
);
