import "./config/load-dotenv.js";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

/**
 * Entrada do processo da API.
 *
 * Startup e shutdown são observáveis (Phase 9): eventos estruturados
 * `application_starting`, `application_ready`, `shutdown_started`,
 * `shutdown_completed` e `shutdown_timeout`, com apenas dados seguros
 * (ambiente, versão, commit) — nunca segredo ou connection string.
 *
 * Ordem do encerramento (garantida pelos hooks `onClose` registrados pelos
 * plugins, na ordem inversa do registro): schedulers param, WebSockets são
 * fechados, tarefas em segundo plano são aguardadas até o limite e o pool do
 * banco é fechado por último.
 */

/** Limite total do encerramento; acima disso o processo sai assim mesmo. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const config = loadEnv();
  const app = await buildApp({ logger: true });

  const buildInfo = {
    environment: config.nodeEnv,
    version: config.appVersion,
    gitSha: config.gitSha,
    buildDate: config.buildDate,
  };

  app.log.info({ event: "application_starting", ...buildInfo }, "Iniciando SafeCircle API");

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error({ event: "application_start_failed", err: error }, "Falha ao iniciar a API");
    process.exit(1);
  }

  app.log.info(
    {
      event: "application_ready",
      ...buildInfo,
      port: config.port,
      metricsEnabled: config.metricsEnabled,
    },
    "SafeCircle API pronta para receber tráfego",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    // Um segundo SIGTERM não deve reentrar no fechamento.
    if (shuttingDown) return;
    shuttingDown = true;

    const startedAt = Date.now();
    app.log.info({ event: "shutdown_started", signal }, "Encerrando SafeCircle API");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS);
    });

    const result = await Promise.race([app.close().then(() => "closed" as const), timeout]);
    if (timer) clearTimeout(timer);

    const durationMs = Date.now() - startedAt;
    if (result === "timeout") {
      app.log.warn(
        { event: "shutdown_timeout", signal, durationMs, timeoutMs: SHUTDOWN_TIMEOUT_MS },
        "Tempo de encerramento esgotado; finalizando assim mesmo",
      );
      process.exit(1);
    }

    app.log.info({ event: "shutdown_completed", signal, durationMs }, "SafeCircle API encerrada");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
