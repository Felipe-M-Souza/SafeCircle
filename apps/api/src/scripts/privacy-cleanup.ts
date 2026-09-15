import "../config/load-dotenv.js";
import { loadEnv } from "../config/env.js";
import { createDatabase, type Database } from "../infrastructure/database/client.js";
import { AUDIT_RETENTION_DAYS, deleteExpiredAuditEvents } from "../observability/audit.js";
import {
  LOCATION_RETENTION_DAYS,
  deleteExpiredLocationData,
} from "../modules/alerts/live-location.service.js";
import {
  CHECKIN_RETENTION_DAYS,
  deleteExpiredCheckins,
} from "../modules/checkins/checkins.service.js";
import { deleteExpiredJourneyLocationData } from "../modules/journeys/journey-live-location.service.js";
import {
  JOURNEY_RETENTION_DAYS,
  deleteExpiredJourneys,
} from "../modules/journeys/journeys.service.js";
import { deleteExpiredOutboxEvents } from "../outbox/outbox.service.js";
import {
  AUTH_SESSION_RETENTION_DAYS,
  deleteExpiredAuthData,
} from "../modules/auth/sessions.service.js";

/**
 * Retenção consolidada de dados pessoais (Phase 11): `pnpm privacy:cleanup`.
 *
 * Encadeia todas as políticas de retenção existentes em uma execução só, para
 * que o cron de produção tenha um único ponto de entrada e um único lugar onde
 * falhar. Cada etapa é independente: uma falha não impede as demais de rodar,
 * mas o processo termina com código de saída diferente de zero e o nome da
 * etapa que falhou.
 *
 * Invariantes herdadas de cada política (ver `docs/privacy/retention-policy.md`):
 * nada ACTIVE, PENDING ou PROCESSING é removido; só o que já encerrou e passou
 * do prazo. O resumo mostra categoria e quantidade — nunca um dado individual.
 */

export interface CleanupStep {
  name: string;
  run: (db: Database, now: Date) => Promise<Record<string, number>>;
}

export const CLEANUP_STEPS: CleanupStep[] = [
  {
    name: "localizacao_alertas",
    run: async (db, now) => {
      const summary = await deleteExpiredLocationData(db, now, LOCATION_RETENTION_DAYS);
      return { ...summary };
    },
  },
  {
    name: "checkins",
    run: async (db, now) => ({
      checkins: await deleteExpiredCheckins(db, now, CHECKIN_RETENTION_DAYS),
    }),
  },
  {
    name: "trajetos",
    run: async (db, now) => {
      const location = await deleteExpiredJourneyLocationData(db, now);
      const journeys = await deleteExpiredJourneys(db, now, JOURNEY_RETENTION_DAYS);
      return { ...location, journeys };
    },
  },
  {
    name: "auditoria",
    run: async (db, now) => ({
      auditEvents: await deleteExpiredAuditEvents(db, now, AUDIT_RETENTION_DAYS),
    }),
  },
  {
    name: "outbox",
    run: async (db, now) => {
      const summary = await deleteExpiredOutboxEvents(db, now);
      return { ...summary };
    },
  },
  {
    name: "autenticacao",
    run: async (db, now) => {
      const summary = await deleteExpiredAuthData(db, now, AUTH_SESSION_RETENTION_DAYS);
      return { ...summary };
    },
  },
];

export interface CleanupReport {
  results: Array<{ step: string; removed: Record<string, number> }>;
  failures: Array<{ step: string }>;
}

/** Executa todas as etapas; nunca lança — o chamador decide o exit code. */
export async function runPrivacyCleanup(
  db: Database,
  now: Date = new Date(),
  log: (message: string) => void = console.log,
  logError: (message: string) => void = console.error,
): Promise<CleanupReport> {
  const report: CleanupReport = { results: [], failures: [] };
  for (const step of CLEANUP_STEPS) {
    try {
      const removed = await step.run(db, now);
      report.results.push({ step: step.name, removed });
      const parts = Object.entries(removed).map(([category, total]) => `${category}=${total}`);
      log(`[ok]    ${step.name}: ${parts.join(", ")}`);
    } catch (error) {
      report.failures.push({ step: step.name });
      // Mensagem do erro, nunca o dado: um erro de banco pode citar uma linha.
      logError(
        `[falha] ${step.name}: ${error instanceof Error ? error.constructor.name : "erro desconhecido"}`,
      );
    }
  }
  return report;
}

async function main(): Promise<void> {
  const config = loadEnv();
  if (!config.databaseUrl) {
    console.error("DATABASE_URL não definida. Configure o `.env` e rode `pnpm db:start`.");
    process.exit(1);
  }

  const handle = createDatabase(config.databaseUrl);
  try {
    console.log("Retenção consolidada de dados pessoais (privacy:cleanup)");
    const report = await runPrivacyCleanup(handle.db);
    if (report.failures.length > 0) {
      console.error(
        `Concluído com falha em ${report.failures.length} etapa(s): ` +
          report.failures.map((failure) => failure.step).join(", "),
      );
      process.exitCode = 1;
      return;
    }
    console.log("Todas as etapas concluídas.");
  } finally {
    await handle.close();
  }
}

// Só executa quando chamado como script; os testes importam as funções.
const invokedDirectly =
  process.argv[1] !== undefined &&
  /privacy-cleanup\.(ts|js)$/.test(process.argv[1].replace(/\\/g, "/"));
if (invokedDirectly) {
  main().catch((error) => {
    console.error("Falha na retenção consolidada:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
