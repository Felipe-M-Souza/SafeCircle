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
    const requestId = typeof request.id === "string" ? request.id : null;
    let result: Awaited<ReturnType<typeof loginUser>>;
    try {
      // Sucesso: a auditoria entra na mesma transação da sessão (ver serviço).
      result = await loginUser(buildContext(), input, { requestId });
    } catch (error) {
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
    return reply.status(200).send(result);
  });

  app.post("/auth/refresh", { config: rateLimit }, async (request, reply) => {
    const input = refreshSchema.parse(request.body);
    const result = await refreshSession(buildContext(), input.refreshToken);
    return reply.status(200).send(result);
  });

  app.post("/auth/logout", { config: rateLimit }, async (request, reply) => {
    const input = logoutSchema.parse(request.body);
    await logout(buildContext(), input.refreshToken, {
      requestId: typeof request.id === "string" ? request.id : null,
    });
    // Idempotente e sem revelar detalhes de sessões.
    return reply.status(204).send();
  });
}
