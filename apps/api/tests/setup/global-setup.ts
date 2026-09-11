import { ensureTestDatabase } from "../helpers/test-db.js";

/**
 * Global setup do Vitest: cria (se necessário) e migra o banco de testes uma vez.
 */
export default async function setup(): Promise<void> {
  await ensureTestDatabase();
}
