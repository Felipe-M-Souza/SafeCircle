import { defineConfig } from "vitest/config";

/**
 * Suíte E2E da API (Phase 12): black-box, por HTTP e WebSocket reais, contra um
 * processo da API iniciado pelo global setup sobre um PostgreSQL descartável.
 * Diferente dos testes de integração (`vitest.config.ts`), aqui nada usa
 * `app.inject`: o que roda é o `server.ts` de verdade, com worker e schedulers.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.ts"],
    globals: false,
    globalSetup: ["./e2e/setup/global-setup.ts"],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 90_000,
    reporters: ["default"],
  },
});
