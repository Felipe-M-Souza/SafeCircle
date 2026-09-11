import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./modules/health/health.routes.js";

export interface BuildAppOptions {
  logger?: boolean;
}

/**
 * Monta a instância Fastify com plugins e rotas.
 *
 * Fluxo por requisição (README §9): rota -> validação -> serviço -> resposta.
 * Rotas permanecem enxutas e registradas por módulo.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          // Nunca registrar dados sensíveis (README §15).
          redact: {
            paths: ["req.headers.authorization", "req.headers.cookie"],
            remove: true,
          },
        }
      : false,
  });

  await app.register(healthRoutes);

  return app;
}
