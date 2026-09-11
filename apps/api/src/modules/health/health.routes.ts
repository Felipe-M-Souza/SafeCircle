import type { FastifyInstance } from "fastify";

/**
 * Rota de saúde.
 *
 * Contrato estável (README §12):
 *   GET /health -> 200 { "status": "ok" }
 *
 * Deve permanecer enxuta e sem dependências externas: é usada por
 * verificações de disponibilidade e não pode falhar por conta do banco.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return { status: "ok" } as const;
  });
}
