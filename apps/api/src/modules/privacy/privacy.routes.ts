import type { FastifyInstance } from "fastify";
import type { Config } from "../../config/env.js";
import { privacyExportRateLimit } from "../../plugins/rate-limit.js";
import { buildPrivacyExport } from "./privacy-export.service.js";

export interface PrivacyRoutesOptions {
  appConfig: Config;
}

/**
 * Exportação dos próprios dados (Phase 11): `GET /me/privacy/export`.
 *
 * - Autenticado, do próprio usuário, com rate limit específico.
 * - O conteúdo exportado **não é logado** (nem em debug); só o fato de que a
 *   exportação foi pedida vai para a auditoria, com metadata mínima.
 * - `Cache-Control: no-store`: um dump de dados pessoais não pode ficar em
 *   cache intermediário.
 */
export async function privacyRoutes(
  app: FastifyInstance,
  options: PrivacyRoutesOptions,
): Promise<void> {
  app.get(
    "/me/privacy/export",
    {
      preHandler: app.authenticate,
      config: { rateLimit: privacyExportRateLimit(options.appConfig.rateLimitProfile) },
    },
    async (request, reply) => {
      const data = await buildPrivacyExport(app.db, request.auth.userId, request.auth.sessionId);

      await app.enqueueAuditEvent({
        eventType: "AUDIT_PRIVACY_EXPORT_REQUESTED",
        aggregateType: "USER",
        aggregateId: request.auth.userId,
        actorUserId: request.auth.userId,
        targetType: "USER",
        targetId: request.auth.userId,
        requestId: typeof request.id === "string" ? request.id : null,
      });

      request.log.info({ event: "privacy_export_requested" }, "Exportação de dados solicitada");
      return reply.header("cache-control", "no-store").send(data);
    },
  );
}
