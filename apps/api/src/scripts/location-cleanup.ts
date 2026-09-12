import "../config/load-dotenv.js";
import { loadEnv } from "../config/env.js";
import { createDatabase } from "../infrastructure/database/client.js";
import {
  LOCATION_RETENTION_DAYS,
  deleteExpiredLocationData,
} from "../modules/alerts/live-location.service.js";

/**
 * Retenção de dados de localização (Phase 6 — ADR 0007).
 *
 * Apaga pontos ao vivo, sessões e a localização inicial de alertas encerrados
 * há mais de 30 dias. Nunca apaga alertas, grupos, usuários ou respostas.
 * Em produção deve ser executado periodicamente (ex.: cron diário):
 *
 *   pnpm location:cleanup
 */
async function main(): Promise<void> {
  const config = loadEnv();
  if (!config.databaseUrl) {
    console.error("DATABASE_URL não definida. Configure o `.env` e rode `pnpm db:start`.");
    process.exit(1);
  }

  const handle = createDatabase(config.databaseUrl);
  try {
    const summary = await deleteExpiredLocationData(handle.db, new Date(), LOCATION_RETENTION_DAYS);
    console.log(
      `Retenção de localização (${LOCATION_RETENTION_DAYS} dias): ` +
        `${summary.alerts} alerta(s) encerrado(s) processado(s), ` +
        `${summary.updates} ponto(s), ${summary.sessions} sessão(ões) e ` +
        `${summary.initialLocations} localização(ões) inicial(is) removida(s).`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error("Falha na retenção de localização:", error);
  process.exit(1);
});
