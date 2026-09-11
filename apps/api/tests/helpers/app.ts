import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { FakePushProvider } from "../../src/infrastructure/push/fake-push-provider.js";
import type { PushProvider } from "../../src/infrastructure/push/push-provider.js";
import { getTestDatabaseUrl } from "./test-db.js";

export interface TestAppOptions {
  /** Padrão: um FakePushProvider novo (nenhum teste chama a API real da Expo). */
  pushProvider?: PushProvider;
}

/**
 * Constrói uma instância da API apontando para o banco de testes.
 * NODE_ENV=test (definido pelo Vitest) desativa o rate limit para evitar flakiness.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<FastifyInstance> {
  const app = await buildApp({
    logger: false,
    databaseUrl: getTestDatabaseUrl(),
    pushProvider: options.pushProvider ?? new FakePushProvider(),
  });
  await app.ready();
  return app;
}
