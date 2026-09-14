import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { OutboxWorker } from "../outbox/outbox-worker.js";

declare module "fastify" {
  interface FastifyInstance {
    outboxWorker: OutboxWorker;
  }
}

export interface OutboxPluginOptions {
  /** Inicia o worker com o servidor (desligado nos testes, que chamam runOnce()). */
  autoStart: boolean;
  pollIntervalMs?: number;
  batchSize?: number;
  concurrency?: number;
  leaseMs?: number;
}

/**
 * Integra o worker da outbox ao lifecycle do Fastify (Phase 10).
 *
 * O worker roda no mesmo processo da API **nesta fase**, mas não depende de
 * nada do Fastify além das dependências injetadas aqui: mover para um processo
 * separado é trocar quem chama `start()`.
 *
 * No shutdown ele para de reivindicar eventos novos e aguarda os handlers em
 * andamento por um tempo limitado — o que não concluir volta a ser elegível
 * pela recuperação de lease, sem trabalho perdido e sem espera infinita.
 */
export const outboxPlugin = fp(
  async (app: FastifyInstance, options: OutboxPluginOptions) => {
    const worker = new OutboxWorker({
      db: app.db,
      pushProvider: app.pushProvider,
      realtime: app.realtime,
      log: app.log,
      pollIntervalMs: options.pollIntervalMs,
      batchSize: options.batchSize,
      concurrency: options.concurrency,
      leaseMs: options.leaseMs,
    });

    app.decorate("outboxWorker", worker);

    app.addHook("onReady", async () => {
      if (options.autoStart) {
        worker.start();
      } else {
        app.log.warn(
          { event: "outbox_worker_disabled" },
          "Worker da outbox desabilitado: efeitos assíncronos ficam pendentes no banco",
        );
      }
    });
    app.addHook("onClose", async () => {
      await worker.stop();
    });
  },
  {
    name: "safecircle-outbox",
    dependencies: ["safecircle-database", "safecircle-realtime"],
  },
);
