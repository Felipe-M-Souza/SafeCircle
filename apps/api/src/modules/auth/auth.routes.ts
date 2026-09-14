import type { FastifyInstance } from "fastify";
import type { Config } from "../../config/env.js";
import { authRateLimit } from "../../plugins/rate-limit.js";
import { loginSchema, logoutSchema, refreshSchema, registerSchema } from "./auth.schemas.js";
import {
  loginUser,
  logout,
  refreshSession,
  registerUser,
  type AuthContext,
} from "./auth.service.js";

export interface AuthRoutesOptions {
  appConfig: Config;
}

export async function authRoutes(app: FastifyInstance, options: AuthRoutesOptions): Promise<void> {
  const { appConfig } = options;
  const rateLimit = { rateLimit: authRateLimit(appConfig.nodeEnv) };

  const buildContext = (): AuthContext => ({
    db: app.db,
    refreshTokenTtlDays: appConfig.refreshTokenTtlDays,
    signAccessToken: (claims) => app.jwt.sign(claims),
  });

  app.post("/auth/register", { config: rateLimit }, async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const result = await registerUser(buildContext(), input);
    return reply.status(201).send(result);
  });

  app.post("/auth/login", { config: rateLimit }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    let result: Awaited<ReturnType<typeof loginUser>>;
    try {
      result = await loginUser(buildContext(), input);
    } catch (error) {
      // Auditoria de tentativa falha: sem e-mail, sem senha — apenas o fato.
      // O ator é desconhecido por definição (credencial não confirmada).
      app.auditRequest(request, {
        eventType: "AUTH_LOGIN_FAILED",
        actorUserId: null,
        targetType: "USER",
        outcome: "FAILED",
      });
      throw error;
    }
    app.auditRequest(request, {
      eventType: "AUTH_LOGIN_SUCCEEDED",
      actorUserId: result.user.id,
      targetType: "USER",
      targetId: result.user.id,
    });
    return reply.status(200).send(result);
  });

  app.post("/auth/refresh", { config: rateLimit }, async (request, reply) => {
    const input = refreshSchema.parse(request.body);
    const result = await refreshSession(buildContext(), input.refreshToken);
    return reply.status(200).send(result);
  });

  app.post("/auth/logout", { config: rateLimit }, async (request, reply) => {
    const input = logoutSchema.parse(request.body);
    await logout(buildContext(), input.refreshToken);
    // Sem ator conhecido (a rota não exige access token) e sem o refresh token.
    app.auditRequest(request, {
      eventType: "AUTH_LOGOUT",
      actorUserId: null,
      targetType: "SESSION",
    });
    // Idempotente e sem revelar detalhes de sessões.
    return reply.status(204).send();
  });
}
