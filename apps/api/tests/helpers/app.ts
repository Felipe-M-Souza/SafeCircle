import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { FakePushProvider } from "../../src/infrastructure/push/fake-push-provider.js";
import type { PushProvider } from "../../src/infrastructure/push/push-provider.js";
import { getTestDatabaseUrl } from "./test-db.js";

export interface TestAppOptions {
  /** Padrão: um FakePushProvider novo (nenhum teste chama a API real da Expo). */
  pushProvider?: PushProvider;
  /** Phase 9: habilita /metrics nesta instância. */
  metricsEnabled?: boolean;
  /** Phase 9: exige Bearer em /metrics. */
  metricsToken?: string;
  /** Phase 9: registra a rota sintética de erro interno (só em NODE_ENV=test). */
  exposeTestErrorRoute?: boolean;
  /** Habilita o logger real (testes de redaction capturam a saída). */
  logger?: boolean;
  /** Phase 10: inicia o worker da outbox (padrão: desligado; use runOnce()). */
  outboxWorkerAutoStart?: boolean;
}

/**
 * Constrói uma instância da API apontando para o banco de testes.
 * NODE_ENV=test (definido pelo Vitest) desativa o rate limit para evitar flakiness.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<FastifyInstance> {
  const app = await buildApp({
    logger: options.logger ?? false,
    databaseUrl: getTestDatabaseUrl(),
    pushProvider: options.pushProvider ?? new FakePushProvider(),
    metricsEnabled: options.metricsEnabled,
    metricsToken: options.metricsToken,
    exposeTestErrorRoute: options.exposeTestErrorRoute,
    // Os testes controlam a entrega via app.outboxWorker.runOnce().
    outboxWorkerAutoStart: options.outboxWorkerAutoStart ?? false,
    // Os testes controlam o vencimento via app.checkinScheduler.runOnce().
    checkinSchedulerAutoStart: false,
    // Os testes controlam o vencimento via app.journeyScheduler.runOnce().
    journeySchedulerAutoStart: false,
  });
  await app.ready();
  return app;
}
