import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { REALTIME_CLOSE_CODES } from "../../infrastructure/realtime/realtime-hub.js";
import { authLoginAttemptsTotal, securityRateLimitedTotal } from "../../observability/metrics.js";
import { authRateLimit } from "../../plugins/rate-limit.js";
import { AppError, errors } from "../../shared/errors.js";
import type { LoginThrottle } from "../auth/login-throttle.js";
import { PASSWORD_MAX_LENGTH } from "../auth/auth.schemas.js";
import { deleteAccount, getAccountDeletionPreview } from "./account-deletion.service.js";

export interface AccountRoutesOptions {
  appConfig: Config;
  /** O mesmo freio do login: a senha da exclusão também é alvo de força bruta. */
  loginThrottle: LoginThrottle;
}

const deleteAccountSchema = z.object({
  password: z.string().min(1, "Informe a senha.").max(PASSWORD_MAX_LENGTH),
});

/**
 * Exclusão de conta (Phase 12).
 *
 *   GET  /me/account-deletion   o que bloqueia e o que seria apagado
 *   POST /me/delete-account     { password } → 204; a conta deixa de existir
 *
 * A senha atual é obrigatória: o access token sozinho não confirma uma ação
 * irreversível. Senha errada conta no freio por conta (chave = id do usuário,
 * nunca e-mail) e responde o mesmo `INVALID_CREDENTIALS` do login. Depois do
 * sucesso, todos os WebSockets do usuário são fechados e qualquer token dele
 * passa a valer 401 — a sessão não existe mais.
 */
export async function accountRoutes(
  app: FastifyInstance,
  options: AccountRoutesOptions,
): Promise<void> {
  const { appConfig, loginThrottle } = options;
  app.addHook("preHandler", app.authenticate);

  const requestIdOf = (request: FastifyRequest): string | null =>
    typeof request.id === "string" ? request.id : null;

  app.get("/me/account-deletion", async (request) => {
    return getAccountDeletionPreview(app.db, request.auth.userId);
  });

  app.post(
    "/me/delete-account",
    { config: { rateLimit: authRateLimit(appConfig.rateLimitProfile) } },
    async (request, reply) => {
      const input = deleteAccountSchema.parse(request.body);
      const userId = request.auth.userId;

      if (loginThrottle.isBlocked(userId)) {
        authLoginAttemptsTotal.inc({ result: "rate_limited" });
        securityRateLimitedTotal.inc({ route_group: "auth" });
        throw errors.rateLimited();
      }

      let result: Awaited<ReturnType<typeof deleteAccount>>;
      try {
        result = await deleteAccount(app.db, userId, input, { requestId: requestIdOf(request) });
      } catch (error) {
        if (error instanceof AppError && error.code === "INVALID_CREDENTIALS") {
          loginThrottle.recordFailure(userId);
          authLoginAttemptsTotal.inc({ result: "invalid_credentials" });
        }
        throw error;
      }

      for (const sessionId of result.sessionIds) {
        app.realtimeHub.closeBySession(
          sessionId,
          REALTIME_CLOSE_CODES.SESSION_REVOKED,
          "ACCOUNT_DELETED",
        );
      }
      // Sobrou conexão autenticada por sessão não listada? Fecha por usuário.
      app.realtimeHub.closeByUser(userId, REALTIME_CLOSE_CODES.SESSION_REVOKED, "ACCOUNT_DELETED");

      request.log.info(
        { event: "account_deleted", groupsDeleted: result.groupsDeleted },
        "Conta excluída",
      );
      return reply.status(204).send();
    },
  );
}
