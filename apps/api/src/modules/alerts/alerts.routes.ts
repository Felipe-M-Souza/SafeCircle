import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { errors } from "../../shared/errors.js";
import { parseIdempotencyKey } from "../../shared/idempotency.js";
import { notifyAlertCreated } from "../notifications/alert-notifications.service.js";
import { createAlertSchema, listAlertsQuerySchema } from "./alerts.schemas.js";
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
 * Rotas do Alerta de Emergência (Phase 3).
 *
 * Fluxo: autenticar → validar payload → validar Idempotency-Key → serviço
 * (membership, idempotência, criação atômica) → estado persistido → push em
 * segundo plano (Phase 4), desacoplado do sucesso da criação.
 */
export async function alertsRoutes(app: FastifyInstance): Promise<void> {
  // Todas as rotas de alertas exigem autenticação.
  app.addHook("preHandler", app.authenticate);

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
      // Phase 4: o alerta já está persistido (commit concluído). O push roda em
      // segundo plano e nunca influencia esta resposta nem desfaz o alerta.
      const userId = request.auth.userId;
      app.background.run("alert-notifications", () =>
        notifyAlertCreated(
          { db: app.db, pushProvider: app.pushProvider, log: request.log },
          { id: alert.id, groupId: alert.groupId, createdByUserId: userId },
        ),
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
    return resolveAlert(app.db, request.auth.userId, alertId);
  });

  app.post("/alerts/:alertId/cancel", async (request) => {
    const alertId = parseAlertId((request.params as { alertId: string }).alertId);
    return cancelAlert(app.db, request.auth.userId, alertId);
  });
}
