import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../../config/env.js";
import { createRealtimeEvent } from "../../infrastructure/realtime/events.js";
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
  type JourneyView,
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

  const publish = (
    type: "JOURNEY_CREATED" | "JOURNEY_ARRIVED" | "JOURNEY_CANCELLED" | "JOURNEY_LOCATION_UPDATED",
    journey: { id: string; groupId: string; userId: string },
  ) => {
    app.background.run(`realtime:${type}`, () =>
      app.realtime.publishToGroup(
        journey.groupId,
        createRealtimeEvent(type, {
          journeyId: journey.id,
          groupId: journey.groupId,
          userId: journey.userId,
        }),
      ),
    );
  };

  const publishJourney = (
    type: "JOURNEY_CREATED" | "JOURNEY_ARRIVED" | "JOURNEY_CANCELLED",
    journey: JourneyView,
  ) => publish(type, { id: journey.id, groupId: journey.groupId, userId: journey.user.id });

  const journeyIdOf = (request: { params: unknown }) =>
    parseUuid((request.params as { journeyId: string }).journeyId, errors.journeyNotFound);

  // --- Trajeto ---

  app.post(
    "/journeys",
    { config: { rateLimit: journeyRateLimit(options.appConfig.nodeEnv) } },
    async (request, reply) => {
      const input = createJourneySchema.parse(request.body);
      const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
      const { journey, replayed } = await createJourney(
        app.db,
        request.auth.userId,
        input,
        idempotencyKey,
      );
      if (replayed) {
        reply.header("Idempotent-Replayed", "true");
      } else {
        publishJourney("JOURNEY_CREATED", journey);
        journeyTransitionsTotal.inc({ transition: "created" });
        app.auditRequest(request, {
          eventType: "JOURNEY_CREATED",
          targetType: "JOURNEY",
          targetId: journey.id,
          groupId: journey.groupId,
          // Allow-listed: nunca o rótulo do destino em si.
          metadata: {
            hasDestination: journey.destinationLabel !== null,
            liveLocationEnabled: journey.liveLocationEnabled,
          },
        });
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
    );
    if (changed) {
      publishJourney("JOURNEY_ARRIVED", journey);
      journeyTransitionsTotal.inc({ transition: "arrived" });
      app.auditRequest(request, {
        eventType: "JOURNEY_ARRIVED",
        targetType: "JOURNEY",
        targetId: journey.id,
        groupId: journey.groupId,
      });
    }
    return journey;
  });

  app.post("/journeys/:journeyId/cancel", async (request) => {
    const { journey, changed } = await cancelJourney(
      app.db,
      request.auth.userId,
      journeyIdOf(request),
    );
    if (changed) {
      publishJourney("JOURNEY_CANCELLED", journey);
      journeyTransitionsTotal.inc({ transition: "cancelled" });
      app.auditRequest(request, {
        eventType: "JOURNEY_CANCELLED",
        targetType: "JOURNEY",
        targetId: journey.id,
        groupId: journey.groupId,
      });
    }
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
    );
    if (created) {
      const journey = await getJourney(app.db, request.auth.userId, journeyId);
      publish("JOURNEY_LOCATION_UPDATED", {
        id: journeyId,
        groupId: journey.groupId,
        userId: request.auth.userId,
      });
      app.auditRequest(request, {
        eventType: "LIVE_LOCATION_STARTED",
        targetType: "LIVE_LOCATION_SESSION",
        targetId: session.sessionId,
        groupId: journey.groupId,
        metadata: { resource: "journey" },
      });
    }
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
    );
    if (result.replayed) {
      reply.header("Idempotent-Replayed", "true");
    } else {
      const journey = await getJourney(app.db, request.auth.userId, journeyId);
      publish("JOURNEY_LOCATION_UPDATED", {
        id: journeyId,
        groupId: journey.groupId,
        userId: request.auth.userId,
      });
      // Contagem apenas: nenhuma coordenada vira métrica.
      liveLocationUpdatesTotal.inc({ resource: "journey" });
    }
    return reply
      .status(result.replayed ? 200 : 201)
      .send({ sessionId: result.sessionId, point: result.point });
  });

  app.post("/journeys/:journeyId/live-location/stop", async (request) => {
    const journeyId = journeyIdOf(request);
    const { state, changed } = await stopJourneyLiveLocation(
      app.db,
      request.auth.userId,
      journeyId,
    );
    if (changed && state.sessionId) {
      const journey = await getJourney(app.db, request.auth.userId, journeyId);
      publish("JOURNEY_LOCATION_UPDATED", {
        id: journeyId,
        groupId: journey.groupId,
        userId: request.auth.userId,
      });
      app.auditRequest(request, {
        eventType: "LIVE_LOCATION_STOPPED",
        targetType: "LIVE_LOCATION_SESSION",
        targetId: state.sessionId,
        groupId: journey.groupId,
        metadata: { resource: "journey", source: "manual" },
      });
    }
    return state;
  });

  app.get("/journeys/:journeyId/live-location", async (request) => {
    return getJourneyLiveLocationState(app.db, request.auth.userId, journeyIdOf(request));
  });

  app.get("/journeys/:journeyId/live-location/history", async (request) => {
    return getJourneyLiveLocationHistory(app.db, request.auth.userId, journeyIdOf(request));
  });
}
