import type { FastifyInstance } from "fastify";
import postgres from "postgres";

/**
 * Drenagem da outbox nos testes (Phase 10).
 *
 * Com a outbox, o efeito (push, realtime, auditoria) não acontece mais junto da
 * resposta HTTP: ele é gravado no commit e entregue pelo worker. Nos testes o
 * worker não roda em background — chamamos `runOnce()` de forma determinística.
 *
 * Repete até a fila esvaziar porque um handler pode enfileirar trabalho novo, e
 * também esvazia as tarefas em segundo plano que ainda existem.
 */
export async function drainOutbox(app: FastifyInstance, maxCycles = 10): Promise<number> {
  let total = 0;
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const processed = await app.outboxWorker.runOnce();
    await app.background.flush();
    total += processed;
    if (processed === 0) break;
  }
  return total;
}

export interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string | null;
  group_id: string | null;
  payload: Record<string, unknown>;
  status: string;
  available_at: Date;
  attempt_count: number;
  max_attempts: number;
  locked_at: Date | null;
  locked_by: string | null;
  processed_at: Date | null;
  dead_lettered_at: Date | null;
  last_error_code: string | null;
  expires_at: Date | null;
  request_id: string | null;
  created_at: Date;
}

export async function outboxRows(sql: postgres.Sql, eventType?: string): Promise<OutboxRow[]> {
  if (eventType) {
    return sql<OutboxRow[]>`
      SELECT * FROM outbox_events WHERE event_type = ${eventType} ORDER BY created_at
    `;
  }
  return sql<OutboxRow[]>`SELECT * FROM outbox_events ORDER BY created_at`;
}

export async function outboxRow(
  sql: postgres.Sql,
  eventId: string,
): Promise<OutboxRow | undefined> {
  const [row] = await sql<OutboxRow[]>`SELECT * FROM outbox_events WHERE id = ${eventId}`;
  return row;
}

/** Torna um evento elegível agora (evita esperar o backoff nos testes). */
export async function makeClaimable(sql: postgres.Sql, eventId: string): Promise<void> {
  await sql`UPDATE outbox_events SET available_at = now() - interval '1 second' WHERE id = ${eventId}`;
}

/** Simula um worker que morreu no meio: PROCESSING com lease vencido. */
export async function simulateStalledClaim(
  sql: postgres.Sql,
  eventId: string,
  ageMinutes = 10,
): Promise<void> {
  await sql`
    UPDATE outbox_events
       SET status = 'PROCESSING',
           locked_at = now() - (${ageMinutes} * interval '1 minute'),
           locked_by = 'worker-morto'
     WHERE id = ${eventId}
  `;
}
