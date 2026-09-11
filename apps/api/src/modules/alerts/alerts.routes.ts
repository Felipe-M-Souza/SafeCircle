import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createRealtimeEvent } from "../../infrastructure/realtime/events.js";
import { errors } from "../../shared/errors.js";
import { parseIdempotencyKey } from "../../shared/idempotency.js";
import { notifyAlertCreated } from "../notifications/alert-notifications.service.js";
import { listAcknowledgements, setAcknowledgement } from "./acknowledgements.service.js";
import {
  createAlertSchema,
  listAlertsQuerySchema,
  setAcknowledgementSchema,
} from "./alerts.schemas.js";
import { cancelAlert, createAlert, getAlert, listAlerts, resolveAlert } from "./alerts.service.js";

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
 * Rotas do Alerta de Emergência (Phase 3/4/5).
 *
 * Fluxo: autenticar → validar → serviço (persistência, commit) → resposta.
 * Depois do commit, em segundo plano e sem influenciar a resposta:
 * push (Phase 4, exclui o criador) e evento realtime (Phase 5, inclui o
 * criador para sincronizar seus outros aparelhos). Falha em qualquer um
 * deles nunca desfaz a operação REST.
 */
export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  // Todas as rotas de alertas exigem autenticação.
  app.addHook("preHandler", app.authenticate);

  const publishToGroup = (groupId: string, event: ReturnType<typeof createRealtimeEvent>) => {
    app.background.run(`realtime:${event.type}`, () => app.realtime.publishToGroup(groupId, event));
  };

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
    }
    return reply.status(201).send(alert);
  });

  app.get("/alerts", async (request) => {
    const query = listAlertsQuerySchema.parse(request.query ?? {});
    return listAlerts(app.db, request.auth.userId, query.status ?? "ACTIVE");
  });

  app.get("/alerts/:alertId", async (request) => {
    const alertId = parseAlertId((request.params as { alertId: string }).alertId);
    return getAlert(app.db, request.auth.userId, alertId);
  });

  app.post("/alerts/:alertId/resolve", async (request) => {
    const alertId = parseAlertId((request.params as { alertId: string }).alertId);
    // Só transições reais chegam aqui: inválidas lançam antes de publicar.
    const alert = await resolveAlert(app.db, request.auth.userId, alertId);
    publishToGroup(
      alert.groupId,
      createRealtimeEvent("ALERT_RESOLVED", { alertId: alert.id, groupId: alert.groupId }),
    );
    return alert;
  });

  app.post("/alerts/:alertId/cancel", async (request) => {
    const alertId = parseAlertId((request.params as { alertId: string }).alertId);
    const alert = await cancelAlert(app.db, request.auth.userId, alertId);
    publishToGroup(
      alert.groupId,
      createRealtimeEvent("ALERT_CANCELLED", { alertId: alert.id, groupId: alert.groupId }),
    );
    return alert;
  });

  // --- Acknowledgements (Phase 5) ---

  app.get("/alerts/:alertId/acknowledgements", async (request) => {
    const alertId = parseAlertId((request.params as { alertId: string }).alertId);
    return listAcknowledgements(app.db, request.auth.userId, alertId);
  });

  app.put("/alerts/:alertId/acknowledgement", async (request) => {
    const alertId = parseAlertId((request.params as { alertId: string }).alertId);
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
}
