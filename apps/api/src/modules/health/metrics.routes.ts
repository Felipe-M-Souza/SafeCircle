import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { metricsContentType, renderMetrics } from "../../observability/metrics.js";
import { errors } from "../../shared/errors.js";

export interface MetricsRoutesOptions {
  enabled: boolean;
  /** Quando definido, exige `Authorization: Bearer <token>`. */
  token?: string;
}

/** Comparação em tempo constante (evita distinguir tokens por timing). */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Exposição de métricas Prometheus (Phase 9).
 *
 * Política (ADR 0010):
 * - **Desabilitado por padrão** (`METRICS_ENABLED=false`): a rota nem existe,
 *   e uma varredura recebe 404 — não confirmamos que há métricas por trás.
 * - Habilitado **com** `METRICS_TOKEN`: exige Bearer; token ausente/errado → 401.
 * - Habilitado **sem** token: aberto; aceitável só quando a porta está atrás
 *   de rede privada. O README e o runbook deixam isso explícito.
 * - O token nunca é logado (o header Authorization é redigido centralmente).
 */
export async function metricsRoutes(
  app: FastifyInstance,
  options: MetricsRoutesOptions,
): Promise<void> {
  if (!options.enabled) {
    return;
  }

  app.get("/metrics", async (request, reply) => {
    if (options.token) {
      const header = request.headers.authorization;
      const provided =
        typeof header === "string" && header.startsWith("Bearer ")
          ? header.slice("Bearer ".length)
          : null;
      if (!provided || !tokenMatches(provided, options.token)) {
        request.log.warn({ event: "metrics_unauthorized" }, "Acesso não autorizado a /metrics");
        // Pelo handler central: mesma forma dos demais erros, com requestId.
        throw errors.unauthorized();
      }
    }

    const body = await renderMetrics();
    return reply.header("content-type", metricsContentType()).send(body);
  });
}
