import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createRealtimeEvent } from "../../infrastructure/realtime/events.js";
import { alertTransitionsTotal, liveLocationUpdatesTotal } from "../../observability/metrics.js";
import { errors } from "../../shared/errors.js";
import { parseIdempotencyKey } from "../../shared/idempotency.js";
import { notifyAlertCreated } from "../notifications/alert-notifications.service.js";
import { listAcknowledgements, setAcknowledgement } from "./acknowledgements.service.js";
import {
  createAlertSchema,
  listAlertsQuerySchema,
  liveLocationUpdateSchema,
  setAcknowledgementSchema,
} from "./alerts.schemas.js";
import { cancelAlert, createAlert, getAlert, listAlerts, resolveAlert } from "./alerts.service.js";
import {
  getLiveLocationHistory,
  getLiveLocationState,
  sendLiveLocationUpdate,
  startLiveLocation,
  stopLiveLocation,
} from "./live-location.service.js";

const uuid = z.string().uuid();

/** IDs inválidos resultam em 404 (anti-IDOR), nunca em erro de SQL. */
function parseAlertId(value: unknown): string {
  const result = uuid.safeParse(value);
  if (!result.success) {
    throw errors.alertNotFound();
  }
  return result.data;
}

/**
 * Rotas do Alerta de Emergência (Phase 3/4/5/6).
 *
 * Fluxo: autenticar → validar → serviço (persistência, commit) → resposta.
 * Depois do commit, em segundo plano e sem influenciar a resposta:
 * push (Phase 4, exclui o criador) e evento realtime (Phase 5/6, inclui o
 * criador para sincronizar seus outros aparelhos). Falha em qualquer um
 * deles nunca desfaz a operação REST. Eventos de localização ao vivo
 * NUNCA carregam coordenadas: o app busca o estado via REST.
 */
export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  // Todas as rotas de alertas exigem autenticação.
  app.addHook("preHandler", app.authenticate);

  const publishToGroup = (groupId: string, event: ReturnType<typeof createRealtimeEvent>) => {
    app.background.run(`realtime:${event.type}`, () => app.realtime.publishToGroup(groupId, event));
  };

  const params = (request: { params: unknown }) =>
    parseAlertId((request.params as { alertId: string }).alertId);

  app.post("/alerts", async (request, reply) => {
    const input = createAlertSchema.parse(request.body);
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    const { alert, replayed } = await createAlert(
      app.db,
      request.auth.userId,
      input,
      idempotencyKey,
    );
    if (replayed) {
      reply.header("Idempotent-Replayed", "true");
    } else {
      // O alerta já está persistido (commit concluído). Push e realtime rodam
      // em segundo plano; replays idempotentes não publicam nada de novo.
      const userId = request.auth.userId;
      app.background.run("alert-notifications", () =>
        notifyAlertCreated(
          { db: app.db, pushProvider: app.pushProvider, log: request.log },
          { id: alert.id, groupId: alert.groupId, createdByUserId: userId },
        ),
      );
      publishToGroup(
        alert.groupId,
        createRealtimeEvent("ALERT_CREATED", { alertId: alert.id, groupId: alert.groupId }),
      );
      alertTransitionsTotal.inc({ transition: "created" });
      app.auditRequest(request, {
        eventType: "ALERT_CREATED",
        targetType: "ALERT",
        targetId: alert.id,
        groupId: alert.groupId,
      });
    }
    return reply.status(201).send(alert);
  });

  app.get("/alerts", async (request) => {
    const query = listAlertsQuerySchema.parse(request.query ?? {});
    return listAlerts(app.db, request.auth.userId, query.status ?? "ACTIVE");
  });

  app.get("/alerts/:alertId", async (request) => {
    return getAlert(app.db, request.auth.userId, params(request));
  });

  app.post("/alerts/:alertId/resolve", async (request) => {
    const alertId = params(request);
    // Só transições reais chegam aqui: inválidas lançam antes de publicar.
    const { alert, stoppedLiveSessionId } = await resolveAlert(
      app.db,
      request.auth.userId,
      alertId,
    );
    publishToGroup(
      alert.groupId,
      createRealtimeEvent("ALERT_RESOLVED", { alertId: alert.id, groupId: alert.groupId }),
    );
    alertTransitionsTotal.inc({ transition: "resolved" });
    app.auditRequest(request, {
      eventType: "ALERT_RESOLVED",
      targetType: "ALERT",
      targetId: alert.id,
      groupId: alert.groupId,
    });
    if (stoppedLiveSessionId) {
      publishToGroup(
        alert.groupId,
        createRealtimeEvent("ALERT_LIVE_LOCATION_STOPPED", {
          alertId: alert.id,
          groupId: alert.groupId,
          sessionId: stoppedLiveSessionId,
        }),
      );
    }
    return alert;
  });

  app.post("/alerts/:alertId/cancel", async (request) => {
    const alertId = params(request);
    const { alert, stoppedLiveSessionId } = await cancelAlert(app.db, request.auth.userId, alertId);
    publishToGroup(
      alert.groupId,
      createRealtimeEvent("ALERT_CANCELLED", { alertId: alert.id, groupId: alert.groupId }),
    );
    alertTransitionsTotal.inc({ transition: "cancelled" });
    app.auditRequest(request, {
      eventType: "ALERT_CANCELLED",
      targetType: "ALERT",
      targetId: alert.id,
      groupId: alert.groupId,
    });
    if (stoppedLiveSessionId) {
      publishToGroup(
        alert.groupId,
        createRealtimeEvent("ALERT_LIVE_LOCATION_STOPPED", {
          alertId: alert.id,
          groupId: alert.groupId,
          sessionId: stoppedLiveSessionId,
        }),
      );
    }
    return alert;
  });

  // --- Acknowledgements (Phase 5) ---

  app.get("/alerts/:alertId/acknowledgements", async (request) => {
    return listAcknowledgements(app.db, request.auth.userId, params(request));
  });

  app.put("/alerts/:alertId/acknowledgement", async (request) => {
    const alertId = params(request);
    const input = setAcknowledgementSchema.parse(request.body);
    const userId = request.auth.userId;
    const result = await setAcknowledgement(app.db, userId, alertId, input.type);
    if (result.changed) {
      publishToGroup(
        result.groupId,
        createRealtimeEvent("ALERT_ACKNOWLEDGEMENT_CHANGED", {
          alertId,
          groupId: result.groupId,
          userId,
        }),
      );
    }
    return result.acknowledgement;
  });

  // --- Localização ao vivo (Phase 6) ---

  app.post("/alerts/:alertId/live-location/start", async (request, reply) => {
    const alertId = params(request);
    const { session, created } = await startLiveLocation(app.db, request.auth.userId, alertId);
    if (created) {
      const alert = await getAlert(app.db, request.auth.userId, alertId);
      publishToGroup(
        alert.groupId,
        createRealtimeEvent("ALERT_LIVE_LOCATION_STARTED", {
          alertId,
          groupId: alert.groupId,
          sessionId: session.sessionId,
        }),
      );
      app.auditRequest(request, {
        eventType: "LIVE_LOCATION_STARTED",
        targetType: "LIVE_LOCATION_SESSION",
        targetId: session.sessionId,
        groupId: alert.groupId,
        metadata: { resource: "alert" },
      });
    }
    return reply.status(created ? 201 : 200).send(session);
  });

  app.post("/alerts/:alertId/live-location", async (request, reply) => {
    const alertId = params(request);
    const input = liveLocationUpdateSchema.parse(request.body);
    const result = await sendLiveLocationUpdate(app.db, request.auth.userId, alertId, input);
    if (result.replayed) {
      reply.header("Idempotent-Replayed", "true");
    } else {
      const alert = await getAlert(app.db, request.auth.userId, alertId);
      publishToGroup(
        alert.groupId,
        createRealtimeEvent("ALERT_LIVE_LOCATION_UPDATED", {
          alertId,
          groupId: alert.groupId,
          sessionId: result.sessionId,
        }),
      );
      // Contagem apenas: nenhuma coordenada vira métrica.
      liveLocationUpdatesTotal.inc({ resource: "alert" });
    }
    return reply
      .status(result.replayed ? 200 : 201)
      .send({ sessionId: result.sessionId, point: result.point });
  });

  app.post("/alerts/:alertId/live-location/stop", async (request) => {
    const alertId = params(request);
    const { state, changed } = await stopLiveLocation(app.db, request.auth.userId, alertId);
    if (changed && state.sessionId) {
      const alert = await getAlert(app.db, request.auth.userId, alertId);
      publishToGroup(
        alert.groupId,
        createRealtimeEvent("ALERT_LIVE_LOCATION_STOPPED", {
          alertId,
          groupId: alert.groupId,
          sessionId: state.sessionId,
        }),
      );
      app.auditRequest(request, {
        eventType: "LIVE_LOCATION_STOPPED",
        targetType: "LIVE_LOCATION_SESSION",
        targetId: state.sessionId,
        groupId: alert.groupId,
        metadata: { resource: "alert", source: "manual" },
      });
    }
    return state;
  });

  app.get("/alerts/:alertId/live-location", async (request) => {
    return getLiveLocationState(app.db, request.auth.userId, params(request));
  });

  app.get("/alerts/:alertId/live-location/history", async (request) => {
    return getLiveLocationHistory(app.db, request.auth.userId, params(request));
  });
}
