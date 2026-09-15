import type { FastifyInstance, FastifyRequest } from "fastify";
import { REALTIME_CLOSE_CODES } from "../../infrastructure/realtime/realtime-hub.js";
import { isValidRequestId } from "../../observability/request-context.js";
import { errors } from "../../shared/errors.js";
import { listSessions, revokeOtherSessions, revokeSession } from "./sessions.service.js";

/**
 * Sessões do usuário autenticado (Phase 11).
 *
 *   GET    /me/sessions                 lista as sessões ativas (sanitizadas)
 *   DELETE /me/sessions/:sessionId      revoga uma sessão própria (inclusive a atual)
 *   POST   /me/sessions/revoke-others   revoga todas menos a atual
 *
 * Revogação tem efeito imediato: a validação de sessão em `authenticate`
 * recusa o access token na próxima requisição e o WebSocket da sessão é
 * fechado. Sessão de outro usuário responde 404, igual a inexistente.
 */
export async function sessionsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", app.authenticate);

  const requestIdOf = (request: FastifyRequest): string | null =>
    typeof request.id === "string" ? request.id : null;

  const closeRealtime = (sessionId: string) =>
    app.realtimeHub.closeBySession(
      sessionId,
      REALTIME_CLOSE_CODES.SESSION_REVOKED,
      "SESSION_REVOKED",
    );

  app.get("/me/sessions", async (request) => {
    return listSessions(app.db, request.auth.userId, request.auth.sessionId);
  });

  app.delete("/me/sessions/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    // Id malformado recebe o mesmo 404 de id desconhecido: nada a distinguir.
    if (!isValidRequestId(sessionId)) {
      throw errors.sessionNotFound();
    }
    const result = await revokeSession(app.db, request.auth.userId, sessionId, {
      requestId: requestIdOf(request),
    });
    if (result.revoked) {
      closeRealtime(sessionId);
    }
    return reply.status(204).send();
  });

  app.post("/me/sessions/revoke-others", async (request) => {
    const result = await revokeOtherSessions(app.db, request.auth.userId, request.auth.sessionId, {
      requestId: requestIdOf(request),
    });
    for (const sessionId of result.revokedSessionIds) {
      closeRealtime(sessionId);
    }
    return { revokedCount: result.revokedCount };
  });
}
