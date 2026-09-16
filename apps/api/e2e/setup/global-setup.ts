import type { TestProject } from "vitest/node";
import { e2eDatabaseUrl, ensureDatabase, resetDatabase, startApi } from "../harness.js";

declare module "vitest" {
  export interface ProvidedContext {
    apiUrl: string;
    databaseUrl: string;
  }
}

/**
 * Global setup do E2E (Phase 12): um banco descartável migrado do zero, dados
 * zerados e um processo real da API para toda a suíte. A porta pode ser
 * trocada com `E2E_API_PORT`; o banco, com `E2E_DATABASE_URL`.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const databaseUrl = e2eDatabaseUrl();
  await ensureDatabase(databaseUrl);
  await resetDatabase(databaseUrl);

  const port = Number(process.env.E2E_API_PORT ?? 3457);
  const api = await startApi({ port, databaseUrl });

  project.provide("apiUrl", api.url);
  project.provide("databaseUrl", databaseUrl);

  return async () => {
    await api.stop();
  };
}
