import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  backgroundTasksCompletedTotal,
  backgroundTasksDuration,
  backgroundTasksFailedTotal,
  backgroundTasksPending,
  backgroundTasksStartedTotal,
  taskTypeLabel,
} from "../observability/metrics.js";

/**
 * Tarefas em segundo plano após a resposta (Phase 4).
 *
 * Uso: efeitos que NÃO podem influenciar o resultado da requisição — por
 * exemplo, o envio de push depois que o alerta já foi persistido. Não é
 * fire-and-forget irresponsável: todo erro é capturado e logado, as tarefas
 * pendentes são rastreadas e o shutdown do Fastify aguarda sua conclusão
 * (com limite de tempo). Testes usam `flush()` para aguardar determinística-
 * mente.
 *
 * Limitação (documentada no ADR 0005): as tarefas vivem no processo; se a API
 * cair antes de concluí-las, não há retry persistente. Uma fase futura poderá
 * substituir isto por outbox + worker.
 */
export interface BackgroundTasks {
  run(name: string, task: () => Promise<unknown>): void;
  /** Aguarda todas as tarefas pendentes (erros já foram capturados). */
  flush(): Promise<void>;
  pendingCount(): number;
}

declare module "fastify" {
  interface FastifyInstance {
    background: BackgroundTasks;
  }
}

export interface BackgroundTasksOptions {
  /** Tempo máximo de espera no shutdown. */
  shutdownTimeoutMs?: number;
}

export const backgroundTasksPlugin = fp(
  async (app: FastifyInstance, options: BackgroundTasksOptions) => {
    const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    const pending = new Set<Promise<unknown>>();

    const flush = async (): Promise<void> => {
      // Tarefas podem enfileirar outras; repete até esvaziar.
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    };

    const background: BackgroundTasks = {
      run(name, task) {
        // Métricas (Phase 9): tipo controlado, nunca IDs.
        const taskType = taskTypeLabel(name);
        const startedAt = process.hrtime.bigint();
        backgroundTasksStartedTotal.inc({ task_type: taskType });
        backgroundTasksPending.set(pending.size + 1);

        const promise = Promise.resolve()
          .then(task)
          .then(() => {
            backgroundTasksCompletedTotal.inc({ task_type: taskType });
          })
          .catch((error: unknown) => {
            backgroundTasksFailedTotal.inc({ task_type: taskType });
            app.log.error(
              { event: "background_task_failed", err: error, taskType },
              "Falha em tarefa em segundo plano",
            );
          })
          .finally(() => {
            backgroundTasksDuration.observe(
              { task_type: taskType },
              Number(process.hrtime.bigint() - startedAt) / 1e9,
            );
            pending.delete(promise);
            backgroundTasksPending.set(pending.size);
          });
        pending.add(promise);
      },
      flush,
      pendingCount: () => pending.size,
    };

    app.decorate("background", background);

    app.addHook("onClose", async () => {
      if (pending.size === 0) {
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          app.log.warn(
            { pending: pending.size },
            "Encerrando com tarefas em segundo plano ainda pendentes",
          );
          resolve();
        }, shutdownTimeoutMs);
      });
      await Promise.race([flush(), timeout]);
      clearTimeout(timer);
    });
  },
  { name: "safecircle-background-tasks" },
);
