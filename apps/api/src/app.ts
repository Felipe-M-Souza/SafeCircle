import Fastify, { LogController, type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import { loadEnv, type Config } from "./config/env.js";
import { authPlugin } from "./plugins/auth.js";
import { auditPlugin } from "./plugins/audit.js";
import { backgroundTasksPlugin } from "./plugins/background-tasks.js";
import { databasePlugin } from "./plugins/database.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { observabilityPlugin } from "./plugins/observability.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { realtimePlugin } from "./plugins/realtime.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { metricsRoutes } from "./modules/health/metrics.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { groupsRoutes } from "./modules/groups/groups.routes.js";
import { meInvitationsRoutes } from "./modules/groups/me-invitations.routes.js";
import { alertsRoutes } from "./modules/alerts/alerts.routes.js";
import { pushDevicesRoutes } from "./modules/notifications/push-devices.routes.js";
import { checkinsRoutes } from "./modules/checkins/checkins.routes.js";
import { checkinSchedulerPlugin } from "./plugins/checkin-scheduler.js";
import { journeysRoutes } from "./modules/journeys/journeys.routes.js";
import { journeySchedulerPlugin } from "./plugins/journey-scheduler.js";
import { REDACTED_LOG_PATHS, resolveRequestId } from "./observability/request-context.js";
import { ExpoPushProvider } from "./infrastructure/push/expo-push-provider.js";
import type { PushProvider } from "./infrastructure/push/push-provider.js";

declare module "fastify" {
  interface FastifyInstance {
    pushProvider: PushProvider;
  }
}

export interface BuildAppOptions {
  logger?: boolean;
  /** Sobrescreve a DATABASE_URL (usado pelos testes de integração). */
  databaseUrl?: string;
  /** Provedor de push injetável (testes usam FakePushProvider). Padrão: Expo. */
  pushProvider?: PushProvider;
  /**
   * Inicia o scheduler de check-ins com o servidor (Phase 7).
   * Padrão: ligado, exceto em NODE_ENV=test (os testes chamam runOnce()).
   */
  checkinSchedulerAutoStart?: boolean;
  /**
   * Inicia o scheduler de trajetos com o servidor (Phase 8).
   * Padrão: ligado, exceto em NODE_ENV=test (os testes chamam runOnce()).
   */
  journeySchedulerAutoStart?: boolean;
  /** Sobrescreve METRICS_ENABLED (Phase 9; usado pelos testes). */
  metricsEnabled?: boolean;
  /** Sobrescreve METRICS_TOKEN (Phase 9; usado pelos testes). */
  metricsToken?: string;
  /**
   * Registra uma rota que lança erro interno, para exercitar o handler de 500.
   * Só é aceita em NODE_ENV=test — nunca existe em produção.
   */
  exposeTestErrorRoute?: boolean;
}

/**
 * Controla o logging automático do Fastify (Phase 9).
 *
 * - `requestIdLogLabel: "requestId"`: o campo de correlação tem o mesmo nome em
 *   log, header e corpo de erro.
 * - `disableRequestLogging`: o par genérico do Fastify é substituído pelo
 *   evento `http_request_completed` do plugin de observabilidade, que carrega
 *   rota-template, usuário, duração e severidade adequada.
 *
 * Uma instância por app (o Fastify 5 espera a instância, não a classe).
 */
function createLogController(): LogController {
  return new LogController({ disableRequestLogging: true, requestIdLogLabel: "requestId" });
}

function corsOptions(config: Config) {
  if (config.nodeEnv === "production") {
    return { origin: config.corsOrigins ?? false };
  }
  // Em dev/test refletimos a origem para facilitar o app web (localhost:8081).
  return { origin: true };
}

/**
 * Monta a instância Fastify com plugins e rotas.
 *
 * Fluxo por requisição (README §9): rota -> validação -> auth -> serviço -> resposta.
 * As rotas de autenticação e /me só são registradas quando há banco configurado.
 *
 * Observabilidade (Phase 9): cada requisição recebe um `requestId` UUID
 * (aceitando `X-Request-Id` do cliente apenas se for UUID válido), que é
 * devolvido no header, aparece em todo log da requisição e em toda resposta de
 * erro. A redaction do logger é centralizada em `observability/request-context`.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = loadEnv();

  const app = Fastify({
    // Request ID: header do cliente quando é UUID válido, senão um novo.
    genReqId: (request) => resolveRequestId(request.headers["x-request-id"]),
    logController: createLogController(),
    logger: options.logger
      ? {
          // Nunca registrar dados sensíveis (README §15): senhas, tokens, headers,
          // localização precisa (Phases 3/6/8), push tokens (Phase 4).
          redact: { paths: [...REDACTED_LOG_PATHS], remove: true },
        }
      : false,
  });

  await app.register(errorHandlerPlugin);
  await app.register(observabilityPlugin, {});
  await app.register(fastifyCors, corsOptions(config));
  await app.register(rateLimitPlugin);
  await app.register(backgroundTasksPlugin);
  await app.register(authPlugin, {
    accessSecret: config.jwtAccessSecret,
    accessTtl: config.jwtAccessTtl,
  });

  // Provedor de push (Phase 4): o domínio depende só da interface PushProvider.
  app.decorate(
    "pushProvider",
    options.pushProvider ?? new ExpoPushProvider({ accessToken: config.expoAccessToken }),
  );

  await app.register(healthRoutes, { appVersion: config.appVersion });
  await app.register(metricsRoutes, {
    enabled: options.metricsEnabled ?? config.metricsEnabled,
    token: options.metricsToken ?? config.metricsToken,
  });

  // Rota de erro interno exclusiva de testes (nunca registrada fora deles).
  if (options.exposeTestErrorRoute && config.nodeEnv === "test") {
    app.get("/__test__/boom", async () => {
      throw new Error("Falha interna sintética para teste.");
    });
  }

  const databaseUrl = options.databaseUrl ?? config.databaseUrl;
  if (databaseUrl) {
    await app.register(databasePlugin, { databaseUrl });
    await app.register(auditPlugin);
    // Realtime (Phase 5) depende de auth + banco; registrado antes das rotas
    // que publicam eventos.
    await app.register(realtimePlugin);
    await app.register(authRoutes, { appConfig: config });
    await app.register(usersRoutes, { appConfig: config });
    await app.register(groupsRoutes, { appConfig: config });
    await app.register(meInvitationsRoutes);
    await app.register(alertsRoutes);
    await app.register(pushDevicesRoutes);
    await app.register(checkinsRoutes, { appConfig: config });
    await app.register(checkinSchedulerPlugin, {
      autoStart: options.checkinSchedulerAutoStart ?? config.nodeEnv !== "test",
    });
    await app.register(journeysRoutes, { appConfig: config });
    await app.register(journeySchedulerPlugin, {
      autoStart: options.journeySchedulerAutoStart ?? config.nodeEnv !== "test",
    });
  } else {
    app.log.warn(
      { event: "database_not_configured" },
      "DATABASE_URL ausente: rotas de autenticação não registradas.",
    );
  }

  return app;
}
