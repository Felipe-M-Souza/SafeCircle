import type { FastifyInstance } from "fastify";
import type { Config } from "../../config/env.js";
import { getMe, type AuthContext } from "../auth/auth.service.js";

export interface UsersRoutesOptions {
  appConfig: Config;
}

export async function usersRoutes(
  app: FastifyInstance,
  options: UsersRoutesOptions,
): Promise<void> {
  const { appConfig } = options;

  const buildContext = (): AuthContext => ({
    db: app.db,
    refreshTokenTtlDays: appConfig.refreshTokenTtlDays,
    signAccessToken: (claims) => app.jwt.sign(claims),
  });

  // Rota protegida: exige Authorization: Bearer <accessToken>.
  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    return getMe(buildContext(), request.auth.userId);
  });
}
