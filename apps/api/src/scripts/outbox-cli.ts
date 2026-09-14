import { z } from "zod";
import "../config/load-dotenv.js";
import { loadEnv } from "../config/env.js";
import { createDatabase } from "../infrastructure/database/client.js";
import {
  deleteExpiredOutboxEvents,
  getOutboxBacklog,
  listDeadEvents,
  retryDeadEvent,
  OUTBOX_DEAD_RETENTION_DAYS,
  OUTBOX_PROCESSED_RETENTION_DAYS,
} from "../outbox/outbox.service.js";

/**
 * CLI operacional da outbox (Phase 10).
 *
 * Deliberadamente **não** existe endpoint HTTP de replay: reprocessar efeitos
 * é uma ação de plantão, com acesso ao servidor, não algo exposto na API.
 *
 *   pnpm outbox:status
 *   pnpm outbox:list-dead
 *   pnpm outbox:retry-dead -- --id <uuid>
 *   pnpm outbox:cleanup
 *
 * O payload NUNCA é editável por aqui: a CLI reprocessa o que foi gravado, não
 * reescreve histórico.
 */

const uuidSchema = z.string().uuid();

function parseIdArgument(argv: string[]): string {
  const index = argv.indexOf("--id");
  const raw = index >= 0 ? argv[index + 1] : undefined;
  const parsed = uuidSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("Informe um UUID válido: pnpm outbox:retry-dead -- --id <uuid>");
    process.exit(1);
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const config = loadEnv();
  if (!config.databaseUrl) {
    console.error("DATABASE_URL não definida. Configure o `.env` e rode `pnpm db:start`.");
    process.exit(1);
  }

  const command = process.argv[2];
  const handle = createDatabase(config.databaseUrl);

  try {
    if (command === "status") {
      const backlog = await getOutboxBacklog(handle.db);
      console.log(
        `Outbox: ${backlog.pending} pendente(s), ${backlog.processing} em processamento, ` +
          `${backlog.dead} em dead-letter. Pendente mais antigo: ` +
          `${backlog.oldestPendingAgeSeconds}s.`,
      );
      return;
    }

    if (command === "list-dead") {
      const dead = await listDeadEvents(handle.db);
      if (dead.length === 0) {
        console.log("Nenhum evento em dead-letter.");
        return;
      }
      console.log(`${dead.length} evento(s) em dead-letter:\n`);
      for (const event of dead) {
        console.log(
          `${event.id}  ${event.eventType}  tentativas=${event.attemptCount}  ` +
            `erro=${event.lastErrorCode ?? "-"}  em=${event.deadLetteredAt?.toISOString() ?? "-"}`,
        );
      }
      return;
    }

    if (command === "retry-dead") {
      const id = parseIdArgument(process.argv);
      const requeued = await retryDeadEvent(handle.db, id);
      if (!requeued) {
        // Só DEAD volta para a fila: reenfileirar PENDING/PROCESSING criaria
        // processamento concorrente do mesmo efeito.
        console.error(`Evento ${id} não está em dead-letter (ou não existe). Nada foi alterado.`);
        process.exit(1);
      }
      console.log(`Evento ${id} reenfileirado como PENDING.`);
      return;
    }

    if (command === "cleanup") {
      const summary = await deleteExpiredOutboxEvents(handle.db);
      console.log(
        `Retenção da outbox: ${summary.processed} processado(s) com mais de ` +
          `${OUTBOX_PROCESSED_RETENTION_DAYS} dias e ${summary.dead} em dead-letter com mais de ` +
          `${OUTBOX_DEAD_RETENTION_DAYS} dias removido(s). PENDING e PROCESSING nunca são apagados.`,
      );
      return;
    }

    console.error("Comando inválido. Use: status | list-dead | retry-dead --id <uuid> | cleanup");
    process.exit(1);
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error("Falha no comando da outbox:", error);
  process.exit(1);
});
