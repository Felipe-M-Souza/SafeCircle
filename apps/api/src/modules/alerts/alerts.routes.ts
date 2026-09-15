import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { alertTransitionsTotal, liveLocationUpdatesTotal } from "../../observability/metrics.js";
import { errors } from "../../shared/errors.js";
import { parseIdempotencyKey } from "../../shared/idempotency.js";
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
 * Rotas do Alerta de Emergência (Phases 3–6, com outbox na Phase 10).
 *
 * Fluxo: autenticar → validar → serviço → resposta. O serviço grava o domínio
 * **e os efeitos** (push, realtime, auditoria) na mesma transação; o worker da
 * outbox entrega depois. As rotas não disparam mais nada em segundo plano:
 * uma queda logo após o commit deixou de perder o aviso ao grupo — que, em um
 * app de emergência, era exatamente a falha mais cara possível.
 *
 * Eventos de localização ao vivo continuam sem coordenadas: o app busca o
 * estado via REST.
 */
export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  // Todas as rotas de alertas exigem autenticação.
  app.addHook("preHandler", app.authenticate);

  const params = (request: { params: unknown }) =>
    parseAlertId((request.params as { alertId: string }).alertId);

  /** Correlaciona os efeitos enfileirados com a requisição que os originou. */
  const actionOptions = (request: FastifyRequest) => ({
    requestId: typeof request.id === "string" ? request.id : null,
  });

  app.post("/alerts", async (request, reply) => {
    const input = createAlertSchema.parse(request.body);
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
    const { alert, replayed } = await createAlert(
      app.db,
      request.auth.userId,
      input,
      idempotencyKey,
      actionOptions(request),
    );
    if (replayed) {
      // Replay idempotente NÃO enfileira efeitos de novo (ver serviço).
      reply.header("Idempotent-Replayed", "true");
    } else {
      alertTransitionsTotal.inc({ transition: "created" });
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
    // Só transições reais chegam aqui: inválidas lançam antes de enfileirar.
    const { alert } = await resolveAlert(
      app.db,
      request.auth.userId,
      params(request),
      actionOptions(request),
    );
    alertTransitionsTotal.inc({ transition: "resolved" });
    return alert;
  });

  app.post("/alerts/:alertId/cancel", async (request) => {
    const { alert } = await cancelAlert(
      app.db,
      request.auth.userId,
      params(request),
      actionOptions(request),
    );
    alertTransitionsTotal.inc({ transition: "cancelled" });
    return alert;
  });

  // --- Acknowledgements (Phase 5) ---

  app.get("/alerts/:alertId/acknowledgements", async (request) => {
    return listAcknowledgements(app.db, request.auth.userId, params(request));
  });

  app.put("/alerts/:alertId/acknowledgement", async (request) => {
    const input = setAcknowledgementSchema.parse(request.body);
    const result = await setAcknowledgement(
      app.db,
      request.auth.userId,
      params(request),
      input.type,
      actionOptions(request),
    );
    return result.acknowledgement;
  });

  // --- Localização ao vivo (Phase 6) ---

  app.post("/alerts/:alertId/live-location/start", async (request, reply) => {
    const { session, created } = await startLiveLocation(
      app.db,
      request.auth.userId,
      params(request),
      actionOptions(request),
    );
    return reply.status(created ? 201 : 200).send(session);
  });

  app.post("/alerts/:alertId/live-location", async (request, reply) => {
    const input = liveLocationUpdateSchema.parse(request.body);
    const result = await sendLiveLocationUpdate(
      app.db,
      request.auth.userId,
      params(request),
      input,
      new Date(),
      actionOptions(request),
    );
    if (result.replayed) {
      reply.header("Idempotent-Replayed", "true");
    } else {
      // Contagem apenas: nenhuma coordenada vira métrica.
      liveLocationUpdatesTotal.inc({ resource: "alert" });
    }
    return reply
      .status(result.replayed ? 200 : 201)
      .send({ sessionId: result.sessionId, point: result.point });
  });

  app.post("/alerts/:alertId/live-location/stop", async (request) => {
    const { state } = await stopLiveLocation(
      app.db,
      request.auth.userId,
      params(request),
      actionOptions(request),
    );
    return state;
  });

  app.get("/alerts/:alertId/live-location", async (request) => {
    return getLiveLocationState(app.db, request.auth.userId, params(request));
  });

  app.get("/alerts/:alertId/live-location/history", async (request) => {
    return getLiveLocationHistory(app.db, request.auth.userId, params(request));
  });
}
