import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { getTestDatabaseUrl } from "./test-db.js";

/**
 * Constrói uma instância da API apontando para o banco de testes.
 * NODE_ENV=test (definido pelo Vitest) desativa o rate limit para evitar flakiness.
 */
export async function createTestApp(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false, databaseUrl: getTestDatabaseUrl() });
  await app.ready();
  return app;
}
