import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { createRealtimeEvent } from "../../infrastructure/realtime/events.js";
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
  type CheckinView,
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

/**
 * Rotas do Check-in de Segurança (Phase 7).
 * Fluxo: autenticar → validar → serviço (commit) → resposta → evento realtime
 * em segundo plano (falha nunca desfaz a operação). O vencimento é do
 * scheduler server-side, não destas rotas.
 */
export async function checkinsRoutes(
  app: FastifyInstance,
  options: CheckinsRoutesOptions,
): Promise<void> {
  app.addHook("preHandler", app.authenticate);

  const publish = (
    type: "CHECKIN_CREATED" | "CHECKIN_SAFE" | "CHECKIN_CANCELLED",
    checkin: CheckinView,
  ) => {
    app.background.run(`realtime:${type}`, () =>
      app.realtime.publishToGroup(
        checkin.groupId,
        createRealtimeEvent(type, {
          checkinId: checkin.id,
          groupId: checkin.groupId,
          userId: checkin.user.id,
        }),
      ),
    );
  };

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
      );
      if (replayed) {
        reply.header("Idempotent-Replayed", "true");
      } else {
        publish("CHECKIN_CREATED", checkin);
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
    const { checkin, changed } = await confirmCheckinSafe(app.db, request.auth.userId, checkinId);
    if (changed) publish("CHECKIN_SAFE", checkin);
    return checkin;
  });

  app.post("/checkins/:checkinId/cancel", async (request) => {
    const checkinId = parseUuid(
      (request.params as { checkinId: string }).checkinId,
      errors.checkinNotFound,
    );
    const { checkin, changed } = await cancelCheckin(app.db, request.auth.userId, checkinId);
    if (changed) publish("CHECKIN_CANCELLED", checkin);
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
