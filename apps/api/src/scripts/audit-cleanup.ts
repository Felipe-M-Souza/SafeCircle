import "../config/load-dotenv.js";
import { loadEnv } from "../config/env.js";
import { createDatabase } from "../infrastructure/database/client.js";
import { AUDIT_RETENTION_DAYS, deleteExpiredAuditEvents } from "../observability/audit.js";

/**
 * Retenção da trilha de auditoria (Phase 9 — ADR 0010): apaga eventos com mais
 * de 180 dias. Toca SOMENTE `audit_events` — nunca entidades de domínio.
 * Em produção deve ser executado periodicamente (ex.: cron diário):
 *
 *   pnpm audit:cleanup
 */
async function main(): Promise<void> {
  const config = loadEnv();
  if (!config.databaseUrl) {
    console.error("DATABASE_URL não definida. Configure o `.env` e rode `pnpm db:start`.");
    process.exit(1);
  }

  const handle = createDatabase(config.databaseUrl);
  try {
    const deleted = await deleteExpiredAuditEvents(handle.db, new Date(), AUDIT_RETENTION_DAYS);
    console.log(
      `Retenção de auditoria (${AUDIT_RETENTION_DAYS} dias): ${deleted} evento(s) removido(s).`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error("Falha na retenção de auditoria:", error);
  process.exit(1);
});
