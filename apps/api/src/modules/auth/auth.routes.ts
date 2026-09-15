import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../../config/env.js";
import { REALTIME_CLOSE_CODES } from "../../infrastructure/realtime/realtime-hub.js";
import { authLoginAttemptsTotal, securityRateLimitedTotal } from "../../observability/metrics.js";
import { authRateLimit, refreshRateLimit } from "../../plugins/rate-limit.js";
import { AppError, errors } from "../../shared/errors.js";
import { loginSchema, logoutSchema, refreshSchema, registerSchema } from "./auth.schemas.js";
import { LoginThrottle } from "./login-throttle.js";
import {
  loginUser,
  logout,
  refreshSession,
  registerUser,
  type AuthContext,
} from "./auth.service.js";

export interface AuthRoutesOptions {
  appConfig: Config;
  /** Freio por conta (Phase 11). Uma instância por app, em memória. */
  loginThrottle: LoginThrottle;
}

const requestIdOf = (request: FastifyRequest): string | null =>
  typeof request.id === "string" ? request.id : null;

export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { appConfig, loginThrottle } = options;
  const authLimit = { rateLimit: authRateLimit(appConfig.rateLimitProfile) };
  const refreshLimit = { rateLimit: refreshRateLimit(appConfig.rateLimitProfile) };

  const buildContext = (request: FastifyRequest): AuthContext => ({
    db: app.db,
    refreshTokenTtlDays: appConfig.refreshTokenTtlDays,
    signAccessToken: (claims) => app.jwt.sign(claims),
    log: request.log,
    // Sessão revogada por segurança derruba o WebSocket dela na hora: um
    // token roubado não continua ouvindo eventos do grupo.
    onSessionRevoked: (sessionId) =>
      app.realtimeHub.closeBySession(
        sessionId,
        REALTIME_CLOSE_CODES.SESSION_REVOKED,
        "SESSION_REVOKED",
      ),
  });

  app.post("/auth/register", { config: authLimit }, async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const result = await registerUser(buildContext(request), input);
    return reply.status(201).send(result);
  });

  app.post("/auth/login", { config: authLimit }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const requestId = requestIdOf(request);

    // Freio por conta: depois de N falhas, recusamos antes de tocar no banco.
    // A resposta é a mesma de rate limit por IP — nada que confirme a conta.
    if (loginThrottle.isBlocked(input.email)) {
      authLoginAttemptsTotal.inc({ result: "rate_limited" });
      securityRateLimitedTotal.inc({ route_group: "auth" });
      request.log.warn({ event: "auth_login_throttled" }, "Login recusado pelo freio por conta");
      throw errors.rateLimited();
    }

    let result: Awaited<ReturnType<typeof loginUser>>;
    try {
      // Sucesso: a auditoria entra na mesma transação da sessão (ver serviço).
      result = await loginUser(buildContext(request), input, { requestId });
    } catch (error) {
      if (error instanceof AppError && error.code === "INVALID_CREDENTIALS") {
        loginThrottle.recordFailure(input.email);
        authLoginAttemptsTotal.inc({ result: "invalid_credentials" });
      }
      // Falha: não há mudança de domínio para ser atômica com. Enfileiramos em
      // transação própria — sem e-mail, sem senha, apenas o fato e o ator
      // desconhecido (a credencial não foi confirmada).
      await app.enqueueAuditEvent({
        eventType: "AUDIT_AUTH_LOGIN_FAILED",
        aggregateType: "USER",
        actorUserId: null,
        targetType: "USER",
        outcome: "FAILED",
        requestId,
      });
      throw error;
    }
    loginThrottle.reset(input.email);
    authLoginAttemptsTotal.inc({ result: "success" });
    return reply.status(200).send(result);
  });

  app.post("/auth/refresh", { config: refreshLimit }, async (request, reply) => {
    const input = refreshSchema.parse(request.body);
    const result = await refreshSession(buildContext(request), input.refreshToken, {
      requestId: requestIdOf(request),
    });
    return reply.status(200).send(result);
  });

  app.post("/auth/logout", { config: authLimit }, async (request, reply) => {
    const input = logoutSchema.parse(request.body);
    await logout(buildContext(request), input.refreshToken, { requestId: requestIdOf(request) });
    // Idempotente e sem revelar detalhes de sessões.
    return reply.status(204).send();
  });
}
