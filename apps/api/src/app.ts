import Fastify, { LogController, type FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import { loadEnv, type Config, type RateLimitProfile } from "./config/env.js";
import { authPlugin } from "./plugins/auth.js";
import { auditPlugin } from "./plugins/audit.js";
import { backgroundTasksPlugin } from "./plugins/background-tasks.js";
import { databasePlugin } from "./plugins/database.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { httpHardeningPlugin } from "./plugins/http-hardening.js";
import { observabilityPlugin } from "./plugins/observability.js";
import { rateLimitPlugin } from "./plugins/rate-limit.js";
import { realtimePlugin } from "./plugins/realtime.js";
import { healthRoutes } from "./modules/health/health.routes.js";
import { metricsRoutes } from "./modules/health/metrics.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { sessionsRoutes } from "./modules/auth/sessions.routes.js";
import { accountRoutes } from "./modules/account/account.routes.js";
import { LoginThrottle, type LoginThrottleOptions } from "./modules/auth/login-throttle.js";
import { usersRoutes } from "./modules/users/users.routes.js";
import { groupsRoutes } from "./modules/groups/groups.routes.js";
import { meInvitationsRoutes } from "./modules/groups/me-invitations.routes.js";
import { alertsRoutes } from "./modules/alerts/alerts.routes.js";
import { pushDevicesRoutes } from "./modules/notifications/push-devices.routes.js";
import { checkinsRoutes } from "./modules/checkins/checkins.routes.js";
import { checkinSchedulerPlugin } from "./plugins/checkin-scheduler.js";
import { journeysRoutes } from "./modules/journeys/journeys.routes.js";
import { journeySchedulerPlugin } from "./plugins/journey-scheduler.js";
import { privacyRoutes } from "./modules/privacy/privacy.routes.js";
import { outboxPlugin } from "./plugins/outbox.js";
import { REDACTED_LOG_PATHS, resolveRequestId } from "./observability/request-context.js";
import type { EmailProvider } from "./infrastructure/email/email-provider.js";
import { selectEmailProvider } from "./infrastructure/email/select-email-provider.js";
import { ExpoPushProvider } from "./infrastructure/push/expo-push-provider.js";
import { NoopPushProvider } from "./infrastructure/push/noop-push-provider.js";
import type { PushProvider } from "./infrastructure/push/push-provider.js";
import { createOriginPolicy } from "./security/origins.js";

declare module "fastify" {
  interface FastifyInstance {
    pushProvider: PushProvider;
    emailProvider: EmailProvider;
  }
}

/**
 * Limite global do corpo (Phase 11): 256 KiB. O maior payload legítimo da API
 * (um ponto de localização, um convite, um registro) tem poucas centenas de
 * bytes; acima disso é erro ou abuso, e a resposta é 413 sem crash.
 */
export const BODY_LIMIT_BYTES = 256 * 1024;

export interface BuildAppOptions {
  logger?: boolean;
  /** Sobrescreve a DATABASE_URL (usado pelos testes de integração). */
  databaseUrl?: string;
  /** Provedor de push injetável (testes usam FakePushProvider). Padrão: Expo. */
  pushProvider?: PushProvider;
  /** Provedor de e-mail injetável (Phase 13). Padrão: EMAIL_PROVIDER do ambiente. */
  emailProvider?: EmailProvider;
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
  /**
   * Inicia o worker da outbox com o servidor (Phase 10).
   * Padrão: OUTBOX_ENABLED, exceto em NODE_ENV=test (os testes chamam runOnce()).
   */
  outboxWorkerAutoStart?: boolean;
  /** Sobrescreve METRICS_ENABLED (Phase 9; usado pelos testes). */
  metricsEnabled?: boolean;
  /** Sobrescreve METRICS_TOKEN (Phase 9; usado pelos testes). */
  metricsToken?: string;
  /**
   * Registra uma rota que lança erro interno, para exercitar o handler de 500.
   * Só é aceita em NODE_ENV=test — nunca existe em produção.
   */
  exposeTestErrorRoute?: boolean;
  /** Phase 11: usa os tetos reais de rate limit mesmo em NODE_ENV=test. */
  rateLimitProfile?: RateLimitProfile;
  /** Phase 11: sobrescreve a allow-list de origens web (testes). */
  corsAllowedOrigins?: string[];
  /** Phase 11: força a validação estrita de Origin (testes). */
  strictOrigins?: boolean;
  /** Phase 11: sobrescreve HSTS_ENABLED (testes). */
  hstsEnabled?: boolean;
  /** Phase 11: parâmetros do freio por conta no login (testes). */
  loginThrottle?: LoginThrottleOptions;
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

/**
 * CORS (Phase 11): allow-list explícita quando estrito; reflexão da origem só
 * em dev/test sem lista, para o app web local. Nunca `*` — e como a API usa
 * Bearer, não há cookies nem `credentials`. Requisição sem `Origin` (app
 * nativo) não passa por CORS: a autenticação decide.
 */
function corsOptions(config: Config) {
  if (config.strictOrigins) {
    return { origin: config.corsAllowedOrigins.length > 0 ? config.corsAllowedOrigins : false };
  }
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
 *
 * Hardening (Phase 11): cabeçalhos de segurança, limite de corpo, CORS por
 * allow-list, `trustProxy` explícito, validação de sessão por requisição.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const base = loadEnv();
  const corsAllowedOrigins = options.corsAllowedOrigins ?? base.corsAllowedOrigins;
  const config: Config = {
    ...base,
    rateLimitProfile: options.rateLimitProfile ?? base.rateLimitProfile,
    corsAllowedOrigins,
    strictOrigins:
      options.strictOrigins ?? (base.nodeEnv === "production" || corsAllowedOrigins.length > 0),
    hstsEnabled: options.hstsEnabled ?? base.hstsEnabled,
  };

  const app = Fastify({
    // Request ID: header do cliente quando é UUID válido, senão um novo.
    genReqId: (request) => resolveRequestId(request.headers["x-request-id"]),
    logController: createLogController(),
    bodyLimit: BODY_LIMIT_BYTES,
    // `X-Forwarded-*` só é confiável atrás do proxy configurado; padrão: não.
    // Número = quantidade de saltos confiáveis a partir da borda.
    trustProxy:
      typeof config.trustProxy === "number"
        ? (_address: string, hop: number) => hop < (config.trustProxy as number)
        : config.trustProxy,
    logger: options.logger
      ? {
          // Nunca registrar dados sensíveis (README §15): senhas, tokens, headers,
          // localização precisa (Phases 3/6/8), push tokens (Phase 4).
          redact: { paths: [...REDACTED_LOG_PATHS], remove: true },
        }
      : false,
  });

  // Só JSON entra (Phase 11): o parser padrão de `text/plain` do Fastify é
  // removido, então qualquer outro Content-Type recebe 415 antes de qualquer
  // handler. Rotas nunca recebem corpo que não pediram.
  app.removeContentTypeParser("text/plain");

  // `Content-Type: application/json` com corpo vazio vale como "sem corpo":
  // clientes `fetch` nativos mandam o header em todo POST, inclusive em ações
  // sem payload (resolver/cancelar alerta, iniciar localização ao vivo). O
  // parser padrão do Fastify respondia 400 e o app mostrava "dados inválidos".
  // JSON malformado ou com `__proto__`/`constructor` continua sendo recusado
  // pelo parser padrão (secure-json-parse), que segue sendo usado para o resto.
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: BODY_LIMIT_BYTES },
    (request, body, done) => {
      if (typeof body !== "string" || body.trim() === "") {
        done(null, undefined);
        return;
      }
      defaultJsonParser(request, body, done);
    },
  );

  await app.register(errorHandlerPlugin);
  await app.register(observabilityPlugin, {});
  await app.register(httpHardeningPlugin, { hstsEnabled: config.hstsEnabled });
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
    options.pushProvider ??
      (config.pushProvider === "noop"
        ? new NoopPushProvider(app.log)
        : new ExpoPushProvider({ accessToken: config.expoAccessToken })),
  );

  // Provedor de e-mail (Phase 13). Sem SMTP configurado, o convite continua
  // funcionando no app: o provedor noop registra a intenção e segue.
  app.decorate("emailProvider", options.emailProvider ?? selectEmailProvider(config, app.log));

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
    await app.register(realtimePlugin, {
      originPolicy: createOriginPolicy(config.corsAllowedOrigins, config.strictOrigins),
      rateLimitProfile: config.rateLimitProfile,
    });
    // Freio por conta: em NODE_ENV=test é praticamente desligado, a menos que
    // o teste peça parâmetros reais.
    const loginThrottle = new LoginThrottle(
      options.loginThrottle ?? (config.nodeEnv === "test" ? { maxFailures: 1_000_000 } : undefined),
    );
    await app.register(authRoutes, { appConfig: config, loginThrottle });
    await app.register(sessionsRoutes);
    await app.register(accountRoutes, { appConfig: config, loginThrottle });
    await app.register(usersRoutes, { appConfig: config });
    await app.register(privacyRoutes, { appConfig: config });
    await app.register(groupsRoutes, { appConfig: config });
    await app.register(meInvitationsRoutes);
    await app.register(alertsRoutes);
    await app.register(pushDevicesRoutes);
    await app.register(checkinsRoutes, { appConfig: config });
    await app.register(checkinSchedulerPlugin, {
      autoStart: options.checkinSchedulerAutoStart ?? config.nodeEnv !== "test",
      intervalMs: config.schedulerPollIntervalMs,
    });
    await app.register(journeysRoutes, { appConfig: config });
    await app.register(journeySchedulerPlugin, {
      autoStart: options.journeySchedulerAutoStart ?? config.nodeEnv !== "test",
      intervalMs: config.schedulerPollIntervalMs,
    });
    await app.register(outboxPlugin, {
      autoStart:
        options.outboxWorkerAutoStart ?? (config.outboxEnabled && config.nodeEnv !== "test"),
      appDeepLink: config.appDeepLink,
      appSiteUrl: config.appSiteUrl,
      ...(config.emailReplyTo ? { emailReplyTo: config.emailReplyTo } : {}),
      pollIntervalMs: config.outboxPollIntervalMs,
      batchSize: config.outboxBatchSize,
      concurrency: config.outboxConcurrency,
      leaseMs: config.outboxLeaseMs,
    });
  } else {
    app.log.warn(
      { event: "database_not_configured" },
      "DATABASE_URL ausente: rotas de autenticação não registradas.",
    );
  }

  return app;
}
