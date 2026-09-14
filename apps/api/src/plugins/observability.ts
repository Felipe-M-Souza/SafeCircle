import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  httpRequestDuration,
  httpRequestsInFlight,
  httpRequestsTotal,
  routeLabel,
  safeLabel,
  startDefaultMetrics,
  statusClass,
} from "../observability/metrics.js";
import { REQUEST_ID_HEADER } from "../observability/request-context.js";

/**
 * Observabilidade HTTP (Phase 9).
 *
 * - Devolve `X-Request-Id` em TODA resposta (inclusive erros), permitindo que
 *   o usuário informe o código ao suporte e que o log seja encontrado.
 * - Enriquece `request.log` com `requestId`, `method` e `route` (template) uma
 *   única vez — nenhuma rota precisa repetir isso.
 * - Mede requisições com labels de baixa cardinalidade (método, template da
 *   rota, classe de status). NUNCA a URL concreta, que carrega UUIDs.
 * - Rotas de altíssima frequência (envio de localização) são logadas em
 *   `debug`: um ponto de GPS a cada poucos segundos não é evento de `info`.
 */

const HIGH_FREQUENCY_ROUTES = new Set([
  "/alerts/:alertId/live-location",
  "/journeys/:journeyId/live-location",
]);

declare module "fastify" {
  interface FastifyRequest {
    /** Instante de início (ns) para medir a duração da requisição. */
    startedAt?: bigint;
  }
}

export interface ObservabilityPluginOptions {
  /** Habilita as métricas padrão de processo (CPU, memória, event loop, GC). */
  collectProcessMetrics?: boolean;
}

export const observabilityPlugin = fp(
  async (app: FastifyInstance, options: ObservabilityPluginOptions) => {
    if (options.collectProcessMetrics !== false) {
      startDefaultMetrics();
    }

    app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      request.startedAt = process.hrtime.bigint();
      // O id já foi resolvido por `genReqId` (header validado ou novo UUID).
      reply.header(REQUEST_ID_HEADER, request.id);
      httpRequestsInFlight.inc({ method: safeLabel(request.method, "OTHER") });
      // Correlação automática: tudo logado com `request.log` carrega estes campos.
      request.log = request.log.child({
        requestId: request.id,
        method: request.method,
        route: routeLabel(request.routeOptions?.url),
      });
    });

    app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
      const method = safeLabel(request.method, "OTHER");
      const route = routeLabel(request.routeOptions?.url);
      const status = statusClass(reply.statusCode);
      const seconds = request.startedAt
        ? Number(process.hrtime.bigint() - request.startedAt) / 1e9
        : 0;

      httpRequestsInFlight.dec({ method });
      httpRequestsTotal.inc({ method, route, status_class: status });
      httpRequestDuration.observe({ method, route, status_class: status }, seconds);

      const level =
        reply.statusCode >= 500 ? "error" : HIGH_FREQUENCY_ROUTES.has(route) ? "debug" : "info";
      request.log[level](
        {
          event: "http_request_completed",
          statusCode: reply.statusCode,
          durationMs: Math.round(seconds * 1000),
          userId: request.auth?.userId,
        },
        "Requisição concluída",
      );
    });
  },
  { name: "safecircle-observability" },
);
