import type { FastifyInstance } from "fastify";
import { evaluateReadiness, READINESS_TIMEOUT_MS } from "../../observability/health.js";

export interface HealthRoutesOptions {
  /** Versão/commit da build (valores públicos). */
  appVersion?: string;
  timeoutMs?: number;
}

/**
 * Saúde do processo e prontidão para tráfego (README §12, Phase 9).
 *
 *   GET /health -> 200 { "status": "ok" }        (liveness, sem dependências)
 *   GET /ready  -> 200 | 503 { status, checks }  (readiness, verifica o banco)
 *
 * `/health` permanece enxuta de propósito: é usada por verificações de
 * disponibilidade e não pode falhar por causa do banco. `/ready` responde 503
 * quando a instância não deve receber tráfego, sem revelar detalhes internos
 * (nunca connection string, host ou mensagem do driver).
 */
export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRoutesOptions = {},
): Promise<void> {
  app.get("/health", async () => {
    return { status: "ok" } as const;
  });

  app.get("/ready", async (_request, reply) => {
    const result = await evaluateReadiness({
      // `app.db` só existe quando há DATABASE_URL configurada.
      db: app.hasDecorator("db") ? app.db : undefined,
      started: true,
      timeoutMs: options.timeoutMs ?? READINESS_TIMEOUT_MS,
    });
    const body: Record<string, unknown> = {
      status: result.status,
      checks: result.checks,
    };
    if (options.appVersion) {
      body.version = options.appVersion;
    }
    return reply.status(result.statusCode).send(body);
  });
}
