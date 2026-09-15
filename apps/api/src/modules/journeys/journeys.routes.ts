import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { journeyTransitionsTotal, liveLocationUpdatesTotal } from "../../observability/metrics.js";
import { journeyRateLimit } from "../../plugins/rate-limit.js";
import { errors, type AppError } from "../../shared/errors.js";
import { parseIdempotencyKey } from "../../shared/idempotency.js";
import { liveLocationUpdateSchema } from "../alerts/alerts.schemas.js";
import {
  getJourneyLiveLocationHistory,
  getJourneyLiveLocationState,
  sendJourneyLiveLocationUpdate,
  startJourneyLiveLocation,
  stopJourneyLiveLocation,
} from "./journey-live-location.service.js";
import { createJourneySchema, listJourneysQuerySchema } from "./journeys.schemas.js";
import {
  arriveJourney,
  cancelJourney,
  createJourney,
  getJourney,
  listGroupJourneys,
  listMyJourneys,
} from "./journeys.service.js";

export interface JourneysRoutesOptions {
  appConfig: Config;
}

const uuid = z.string().uuid();

function parseUuid(value: unknown, notFound: () => AppError): string {
  const result = uuid.safeParse(value);
  if (!result.success) throw notFound();
  return result.data;
}

/**
 * Rotas do Trajeto Seguro (Phase 8).
 * Fluxo: autenticar → validar → serviço (commit) → resposta → evento realtime
 * em segundo plano (falha nunca desfaz a operação). O vencimento é do
 * scheduler server-side. Eventos de localização NUNCA carregam coordenadas.
 */
export async function journeysRoutes(
  app: FastifyInstance,
  options: JourneysRoutesOptions,
): Promise<void> {
  app.addHook("preHandler", app.authenticate);

  /** Correlaciona os efeitos enfileirados com a requisição que os originou. */
  const actionOptions = (request: FastifyRequest) => ({
    requestId: typeof request.id === "string" ? request.id : null,
  });

  const journeyIdOf = (request: { params: unknown }) =>
    parseUuid((request.params as { journeyId: string }).journeyId, errors.journeyNotFound);

  // --- Trajeto ---

  app.post(
    "/journeys",
    { config: { rateLimit: journeyRateLimit(options.appConfig.rateLimitProfile) } },
    async (request, reply) => {
      const input = createJourneySchema.parse(request.body);
      const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
      const { journey, replayed } = await createJourney(
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
        journeyTransitionsTotal.inc({ transition: "created" });
      }
      return reply.status(201).send(journey);
    },
  );

  app.get("/journeys", async (request) => {
    const query = listJourneysQuerySchema.parse(request.query ?? {});
    return listMyJourneys(app.db, request.auth.userId, query.status);
  });

  app.get("/journeys/:journeyId", async (request) => {
    return getJourney(app.db, request.auth.userId, journeyIdOf(request));
  });

  app.post("/journeys/:journeyId/arrive", async (request) => {
    const { journey, changed } = await arriveJourney(
      app.db,
      request.auth.userId,
      journeyIdOf(request),
      new Date(),
      actionOptions(request),
    );
    if (changed) journeyTransitionsTotal.inc({ transition: "arrived" });
    return journey;
  });

  app.post("/journeys/:journeyId/cancel", async (request) => {
    const { journey, changed } = await cancelJourney(
      app.db,
      request.auth.userId,
      journeyIdOf(request),
      new Date(),
      actionOptions(request),
    );
    if (changed) journeyTransitionsTotal.inc({ transition: "cancelled" });
    return journey;
  });

  app.get("/groups/:groupId/journeys", async (request) => {
    const groupId = parseUuid(
      (request.params as { groupId: string }).groupId,
      errors.groupNotFound,
    );
    return listGroupJourneys(app.db, request.auth.userId, groupId);
  });

  // --- Localização ao vivo do trajeto (opt-in) ---

  app.post("/journeys/:journeyId/live-location/start", async (request, reply) => {
    const journeyId = journeyIdOf(request);
    const { session, created } = await startJourneyLiveLocation(
      app.db,
      request.auth.userId,
      journeyId,
      actionOptions(request),
    );
    return reply.status(created ? 201 : 200).send(session);
  });

  app.post("/journeys/:journeyId/live-location", async (request, reply) => {
    const journeyId = journeyIdOf(request);
    const input = liveLocationUpdateSchema.parse(request.body);
    const result = await sendJourneyLiveLocationUpdate(
      app.db,
      request.auth.userId,
      journeyId,
      input,
      new Date(),
      actionOptions(request),
    );
    if (result.replayed) {
      reply.header("Idempotent-Replayed", "true");
    } else {
      // Contagem apenas: nenhuma coordenada vira métrica.
      liveLocationUpdatesTotal.inc({ resource: "journey" });
    }
    return reply
      .status(result.replayed ? 200 : 201)
      .send({ sessionId: result.sessionId, point: result.point });
  });

  app.post("/journeys/:journeyId/live-location/stop", async (request) => {
    const journeyId = journeyIdOf(request);
    const { state } = await stopJourneyLiveLocation(
      app.db,
      request.auth.userId,
      journeyId,
      actionOptions(request),
    );
    return state;
  });

  app.get("/journeys/:journeyId/live-location", async (request) => {
    return getJourneyLiveLocationState(app.db, request.auth.userId, journeyIdOf(request));
  });

  app.get("/journeys/:journeyId/live-location/history", async (request) => {
    return getJourneyLiveLocationHistory(app.db, request.auth.userId, journeyIdOf(request));
  });
}
