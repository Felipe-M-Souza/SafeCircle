import "../config/load-dotenv.js";
import { loadEnv } from "../config/env.js";
import { createDatabase } from "../infrastructure/database/client.js";
import { deleteExpiredJourneyLocationData } from "../modules/journeys/journey-live-location.service.js";
import {
  JOURNEY_RETENTION_DAYS,
  deleteExpiredJourneys,
} from "../modules/journeys/journeys.service.js";

/**
 * Retenção do Trajeto Seguro (Phase 8 — ADR 0009):
 * - localização do trajeto: apagada 30 dias após o encerramento;
 * - trajeto finalizado: apagado 90 dias após o encerramento.
 * Nunca apaga trajetos ACTIVE nem OVERDUE em aberto. Em produção deve ser
 * executado periodicamente (ex.: cron diário):
 *
 *   pnpm journey:cleanup
 */
async function main(): Promise<void> {
  const config = loadEnv();
  if (!config.databaseUrl) {
    console.error("DATABASE_URL não definida. Configure o `.env` e rode `pnpm db:start`.");
    process.exit(1);
  }

  const handle = createDatabase(config.databaseUrl);
  try {
    const now = new Date();
    const location = await deleteExpiredJourneyLocationData(handle.db, now);
    const journeys = await deleteExpiredJourneys(handle.db, now, JOURNEY_RETENTION_DAYS);
    console.log(
      `Retenção de localização de trajetos (30 dias): ${location.journeys} trajeto(s) ` +
        `encerrado(s) processado(s), ${location.updates} ponto(s) e ${location.sessions} ` +
        `sessão(ões) removida(s).`,
    );
    console.log(
      `Retenção de trajetos (${JOURNEY_RETENTION_DAYS} dias): ` +
        `${journeys} trajeto(s) finalizado(s) removido(s).`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error("Falha na retenção de trajetos:", error);
  process.exit(1);
});
