import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
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
 *
 * Phase 10: os efeitos do vencimento (push, realtime, auditoria) são gravados
 * na **mesma transação** da transição `ACTIVE -> OVERDUE`, dentro de
 * `markOverdueBatch`. O plugin não dispara mais nada em segundo plano — quem
 * entrega é o worker da outbox, e por isso um restart no meio do caminho
 * deixou de significar grupo sem aviso.
 */
export const checkinSchedulerPlugin = fp(
  async (app: FastifyInstance, options: CheckinSchedulerPluginOptions) => {
    const scheduler = new CheckinScheduler({
      db: app.db,
      log: app.log,
      intervalMs: options.intervalMs,
      onOverdue: (checkin) => {
        // Métrica local; o efeito externo já está durável na outbox.
        checkinTransitionsTotal.inc({ transition: "overdue" });
        app.log.debug(
          { event: "checkin_marked_overdue", checkinId: checkin.id, groupId: checkin.groupId },
          "Check-in vencido registrado",
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
    dependencies: ["safecircle-database"],
  },
);
