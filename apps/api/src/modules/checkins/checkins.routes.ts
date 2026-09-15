import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { checkinTransitionsTotal } from "../../observability/metrics.js";
import { checkinRateLimit } from "../../plugins/rate-limit.js";
import { errors, type AppError } from "../../shared/errors.js";
import { parseIdempotencyKey } from "../../shared/idempotency.js";
import { createCheckinSchema, listCheckinsQuerySchema } from "./checkins.schemas.js";
import {
  cancelCheckin,
  confirmCheckinSafe,
  createCheckin,
  getCheckin,
  listGroupCheckins,
  listMyCheckins,
} from "./checkins.service.js";

export interface CheckinsRoutesOptions {
  appConfig: Config;
}

const uuid = z.string().uuid();

function parseUuid(value: unknown, notFound: () => AppError): string {
  const result = uuid.safeParse(value);
  if (!result.success) throw notFound();
  return result.data;
}

/** Correlaciona os efeitos enfileirados com a requisição que os originou. */
function actionOptions(request: FastifyRequest) {
  return { requestId: typeof request.id === "string" ? request.id : null };
}

/**
 * Rotas do Check-in de Segurança (Phase 7, com outbox na Phase 10).
 *
 * Fluxo: autenticar → validar → serviço (que grava domínio **e** efeitos na
 * mesma transação) → resposta. As rotas não publicam mais nada diretamente: o
 * worker da outbox entrega realtime, push e auditoria depois do commit, e uma
 * queda entre commit e entrega deixa de perder o efeito.
 */
export async function checkinsRoutes(
  app: FastifyInstance,
  options: CheckinsRoutesOptions,
): Promise<void> {
  app.addHook("preHandler", app.authenticate);

  app.post(
    "/checkins",
    { config: { rateLimit: checkinRateLimit(options.appConfig.nodeEnv) } },
    async (request, reply) => {
      const input = createCheckinSchema.parse(request.body);
      const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
      const { checkin, replayed } = await createCheckin(
        app.db,
        request.auth.userId,
        input,
        idempotencyKey,
        new Date(),
        actionOptions(request),
      );
      if (replayed) {
        // Replay idempotente NÃO enfileira nada de novo (ver serviço).
        reply.header("Idempotent-Replayed", "true");
      } else {
        checkinTransitionsTotal.inc({ transition: "created" });
      }
      return reply.status(201).send(checkin);
    },
  );

  app.get("/checkins", async (request) => {
    const query = listCheckinsQuerySchema.parse(request.query ?? {});
    return listMyCheckins(app.db, request.auth.userId, query.status);
  });

  app.get("/checkins/:checkinId", async (request) => {
    const checkinId = parseUuid(
      (request.params as { checkinId: string }).checkinId,
      errors.checkinNotFound,
    );
    return getCheckin(app.db, request.auth.userId, checkinId);
  });

  app.post("/checkins/:checkinId/safe", async (request) => {
    const checkinId = parseUuid(
      (request.params as { checkinId: string }).checkinId,
      errors.checkinNotFound,
    );
    const { checkin, changed } = await confirmCheckinSafe(
      app.db,
      request.auth.userId,
      checkinId,
      new Date(),
      actionOptions(request),
    );
    if (changed) checkinTransitionsTotal.inc({ transition: "safe" });
    return checkin;
  });

  app.post("/checkins/:checkinId/cancel", async (request) => {
    const checkinId = parseUuid(
      (request.params as { checkinId: string }).checkinId,
      errors.checkinNotFound,
    );
    const { checkin, changed } = await cancelCheckin(
      app.db,
      request.auth.userId,
      checkinId,
      new Date(),
      actionOptions(request),
    );
    if (changed) checkinTransitionsTotal.inc({ transition: "cancelled" });
    return checkin;
  });

  app.get("/groups/:groupId/checkins", async (request) => {
    const groupId = parseUuid(
      (request.params as { groupId: string }).groupId,
      errors.groupNotFound,
    );
    return listGroupCheckins(app.db, request.auth.userId, groupId);
  });
}
