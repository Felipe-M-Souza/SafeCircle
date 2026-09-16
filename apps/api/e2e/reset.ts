import "../src/config/load-dotenv.js";
import { e2eDatabaseUrl, ensureDatabase, resetDatabase } from "./harness.js";

/**
 * Reset do ambiente E2E (Phase 12): `pnpm e2e:reset`.
 * Cria/migra o banco E2E se preciso e apaga todos os dados. Só toca no banco
 * E2E (derivado de `DATABASE_URL`, sufixo `safecircle_e2e`) — nunca no de
 * desenvolvimento nem em produção.
 */
async function main(): Promise<void> {
  const url = e2eDatabaseUrl();
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.includes("e2e")) {
    throw new Error(`Recusando resetar um banco que não parece ser E2E: ${name}`);
  }
  await ensureDatabase(url);
  await resetDatabase(url);
  console.log(`Banco E2E "${name}" migrado e zerado.`);
}

main().catch((error) => {
  console.error("Falha no reset E2E:", error instanceof Error ? error.message : error);
  process.exit(1);
});
