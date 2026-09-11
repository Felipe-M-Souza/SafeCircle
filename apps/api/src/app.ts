import Fastify, { type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import { loadEnv, type Config } from "./config/env.js";
import { authPlugin } from "./plugins/auth.js";
import { backgroundTasksPlugin } from "./plugins/background-tasks.js";
import { databasePlugin } from "./plugins/database.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { groupsRoutes } from "./modules/groups/groups.routes.js";
import { meInvitationsRoutes } from "./modules/groups/me-invitations.routes.js";
import { alertsRoutes } from "./modules/alerts/alerts.routes.js";
import { pushDevicesRoutes } from "./modules/notifications/push-devices.routes.js";
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
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = loadEnv();

  const app = Fastify({
    logger: options.logger
      ? {
          // Nunca registrar dados sensíveis (README §15): senhas, tokens, headers,
          // localização precisa (Phase 3), push tokens (Phase 4).
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers.idempotency-key",
              "req.body.password",
              "req.body.refreshToken",
              "req.body.location",
              "req.body.token",
            ],
            remove: true,
          },
        }
      : false,
  });

  await app.register(errorHandlerPlugin);
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

  await app.register(healthRoutes);

  const databaseUrl = options.databaseUrl ?? config.databaseUrl;
  if (databaseUrl) {
    await app.register(databasePlugin, { databaseUrl });
    await app.register(authRoutes, { appConfig: config });
    await app.register(usersRoutes, { appConfig: config });
    await app.register(groupsRoutes, { appConfig: config });
    await app.register(meInvitationsRoutes);
    await app.register(alertsRoutes);
    await app.register(pushDevicesRoutes);
  } else {
    app.log.warn("DATABASE_URL ausente: rotas de autenticação não registradas.");
  }

  return app;
}
