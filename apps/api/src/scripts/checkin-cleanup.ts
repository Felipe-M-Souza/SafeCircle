import "../config/load-dotenv.js";
import { loadEnv } from "../config/env.js";
import { createDatabase } from "../infrastructure/database/client.js";
import {
  CHECKIN_RETENTION_DAYS,
  deleteExpiredCheckins,
} from "../modules/checkins/checkins.service.js";

/**
 * Retenção de check-ins (Phase 7 — ADR 0008): apaga check-ins finalizados
 * (SAFE/CANCELLED/OVERDUE) encerrados há mais de 90 dias. Nunca apaga ACTIVE.
 * Em produção deve ser executado periodicamente (ex.: cron diário):
 *
 *   pnpm checkin:cleanup
 */
async function main(): Promise<void> {
  const config = loadEnv();
  if (!config.databaseUrl) {
    console.error("DATABASE_URL não definida. Configure o `.env` e rode `pnpm db:start`.");
    process.exit(1);
  }

  const handle = createDatabase(config.databaseUrl);
  try {
    const deleted = await deleteExpiredCheckins(handle.db, new Date(), CHECKIN_RETENTION_DAYS);
    console.log(
      `Retenção de check-ins (${CHECKIN_RETENTION_DAYS} dias): ${deleted} check-in(s) finalizado(s) removido(s).`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error("Falha na retenção de check-ins:", error);
  process.exit(1);
});
