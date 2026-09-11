import "../config/load-dotenv.js";
import { loadEnv } from "../config/env.js";
import { runMigrations } from "../infrastructure/database/migrate.js";

async function main(): Promise<void> {
  const config = loadEnv();
  if (!config.databaseUrl) {
    console.error("DATABASE_URL não definida. Configure o `.env` e rode `pnpm db:start`.");
    process.exit(1);
  }

  console.log("Aplicando migrations...");
  await runMigrations(config.databaseUrl);
  console.log("Migrations aplicadas com sucesso.");
}

main().catch((error) => {
  console.error("Falha ao aplicar migrations:", error);
  process.exit(1);
});
