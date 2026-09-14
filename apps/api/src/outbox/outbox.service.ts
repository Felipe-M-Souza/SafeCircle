import { and, asc, count, eq, inArray, isNotNull, lt, lte, min, or, sql } from "drizzle-orm";
import type { Database } from "../infrastructure/database/client.js";
import { outboxEvents, type OutboxEvent } from "../infrastructure/database/schema.js";
import {
  familyOf,
  OUTBOX_PAYLOAD_VERSION,
  OUTBOX_POLICIES,
  type OutboxErrorCode,
  type OutboxEventType,
} from "./outbox.types.js";

/**
 * Operações da outbox transacional (Phase 10).
 *
 * O ponto central é `enqueueOutboxEvent`, que **exige** o cliente de transação:
 * é impossível chamá-lo com o `db` normal por acidente, o que garante a
 * invariante da fase — mudança de domínio e efeito no mesmo COMMIT.
 */

/** Cliente de transação do Drizzle (o `tx` de `db.transaction`). */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface EnqueueOutboxEventInput {
  eventType: OutboxEventType;
  aggregateType: string;
  aggregateId?: string | null;
  groupId?: string | null;
  /** Conteúdo específico do evento; `version` é preenchida aqui. */
  payload: Record<string, unknown>;
  requestId?: string | null;
  /** Sobrescreve a política da família (usado só em testes). */
  maxAttempts?: number;
  /** Sobrescreve o TTL da família (ms). `null` = não expira. */
  ttlMs?: number | null;
}

/**
 * Insere um evento na outbox **dentro da transação do domínio**.
 *
 * Exigir o `tx` não é preciosismo: é o que impede o padrão errado
 * (`COMMIT` do domínio → `INSERT` na outbox), que recria exatamente a janela de
 * perda que esta fase existe para fechar.
 */
export async function enqueueOutboxEvent(
  tx: Transaction,
  input: EnqueueOutboxEventInput,
  now: Date = new Date(),
): Promise<string> {
  const family = familyOf(input.eventType);
  if (!family) {
    // Tipo fora do conjunto fechado: erro de programação, falha alto e cedo.
    throw new Error(`Tipo de evento de outbox desconhecido: ${input.eventType}`);
  }
  const policy = OUTBOX_POLICIES[family];
  const ttlMs = input.ttlMs !== undefined ? input.ttlMs : policy.ttlMs;

  const [created] = await tx
    .insert(outboxEvents)
    .values({
      eventType: input.eventType,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId ?? null,
      groupId: input.groupId ?? null,
      payload: { version: OUTBOX_PAYLOAD_VERSION, ...input.payload },
      status: "PENDING",
      availableAt: now,
      maxAttempts: input.maxAttempts ?? policy.maxAttempts,
      expiresAt: ttlMs === null ? null : new Date(now.getTime() + ttlMs),
      requestId: input.requestId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: outboxEvents.id });

  if (!created) throw new Error("Falha ao enfileirar evento na outbox.");
  return created.id;
}

// ------------------------------------------------------------------
// Claim (com lease) — seguro para múltiplos workers
// ------------------------------------------------------------------

export interface ClaimOptions {
  batchSize: number;
  /** Identificação do worker (host/pid) — apenas para diagnóstico. */
  lockedBy: string;
  /** Tempo de lease: PROCESSING mais antigo que isso é recuperável. */
  leaseMs: number;
  now?: Date;
}

/**
 * Reivindica um lote de eventos processáveis.
 *
 * `FOR UPDATE SKIP LOCKED` é o que torna seguro rodar vários workers sobre a
 * mesma tabela: quem já está sendo travado por outra transação é simplesmente
 * pulado, sem espera e sem duplicidade.
 *
 * Inclui **recuperação de lease**: eventos `PROCESSING` cujo `locked_at` é mais
 * antigo que o lease voltam a ser candidatos — é assim que o trabalho de um
 * worker que morreu no meio não fica preso para sempre.
 *
 * A transação daqui é curta e NÃO envolve I/O externo: o lock é liberado antes
 * de qualquer chamada à Expo ou ao hub realtime.
 */
export async function claimOutboxEvents(
  db: Database,
  options: ClaimOptions,
): Promise<OutboxEvent[]> {
  const now = options.now ?? new Date();
  const leaseCutoff = new Date(now.getTime() - options.leaseMs);

  return db.transaction(async (tx) => {
    // Datas vão como ISO com cast explícito: o driver não aceita `Date` em SQL
    // bruto (mesma armadilha da retenção da Phase 7).
    const candidates = await tx.execute<{ id: string }>(sql`
      SELECT id FROM ${outboxEvents}
       WHERE (status = 'PENDING' AND available_at <= ${now.toISOString()}::timestamptz)
          OR (
            status = 'PROCESSING'
            AND locked_at IS NOT NULL
            AND locked_at <= ${leaseCutoff.toISOString()}::timestamptz
          )
       ORDER BY available_at ASC
       LIMIT ${options.batchSize}
       FOR UPDATE SKIP LOCKED
    `);

    const ids = [...candidates].map((row) => row.id);
    if (ids.length === 0) return [];

    return tx
      .update(outboxEvents)
      .set({
        status: "PROCESSING",
        lockedAt: now,
        lockedBy: options.lockedBy.slice(0, 80),
        updatedAt: now,
      })
      .where(inArray(outboxEvents.id, ids))
      .returning();
  });
}

// ------------------------------------------------------------------
// Conclusão de um evento
// ------------------------------------------------------------------

export async function markProcessed(
  db: Database,
  eventId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(outboxEvents)
    .set({ status: "PROCESSED", processedAt: now, lockedAt: null, lockedBy: null, updatedAt: now })
    .where(eq(outboxEvents.id, eventId));
}

/**
 * Backoff exponencial com teto e jitter.
 *
 * O jitter existe para evitar thundering herd: sem ele, mil eventos que
 * falharam juntos (provedor fora do ar) voltariam exatamente juntos e
 * derrubariam o provedor de novo assim que ele se recuperasse.
 */
export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_CAP_MS = 15 * 60 * 1000;

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  // Jitter de ±20% sobre o valor exponencial.
  const jitter = exponential * 0.2 * (random() * 2 - 1);
  return Math.max(1_000, Math.round(exponential + jitter));
}

export interface RetryResult {
  status: "PENDING" | "DEAD";
  attemptCount: number;
  availableAt?: Date;
}

/**
 * Falha transitória: volta para PENDING com backoff, ou vira DEAD ao atingir
 * `maxAttempts`. Tudo persistido — o retry sobrevive ao restart do processo.
 */
export async function scheduleRetryOrDeadLetter(
  db: Database,
  event: Pick<OutboxEvent, "id" | "attemptCount" | "maxAttempts">,
  errorCode: OutboxErrorCode,
  now: Date = new Date(),
  random: () => number = Math.random,
): Promise<RetryResult> {
  const attemptCount = event.attemptCount + 1;

  if (attemptCount >= event.maxAttempts) {
    await db
      .update(outboxEvents)
      .set({
        status: "DEAD",
        attemptCount,
        deadLetteredAt: now,
        lastErrorCode: errorCode,
        lockedAt: null,
        lockedBy: null,
        updatedAt: now,
      })
      .where(eq(outboxEvents.id, event.id));
    return { status: "DEAD", attemptCount };
  }

  const availableAt = new Date(now.getTime() + backoffDelayMs(attemptCount, random));
  await db
    .update(outboxEvents)
    .set({
      status: "PENDING",
      attemptCount,
      availableAt,
      lastErrorCode: errorCode,
      lockedAt: null,
      lockedBy: null,
      updatedAt: now,
    })
    .where(eq(outboxEvents.id, event.id));
  return { status: "PENDING", attemptCount, availableAt };
}

/** Falha permanente: sem retry, direto para DEAD. */
export async function markDeadLettered(
  db: Database,
  eventId: string,
  errorCode: OutboxErrorCode,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(outboxEvents)
    .set({
      status: "DEAD",
      deadLetteredAt: now,
      lastErrorCode: errorCode,
      lockedAt: null,
      lockedBy: null,
      updatedAt: now,
      attemptCount: sql`${outboxEvents.attemptCount} + 1`,
    })
    .where(eq(outboxEvents.id, eventId));
}

/**
 * Evento expirado: encerra sem executar o efeito. Não é falha — é a decisão
 * deliberada de não entregar uma notificação velha depois de um outage.
 */
export async function markExpired(
  db: Database,
  eventId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(outboxEvents)
    .set({
      status: "PROCESSED",
      processedAt: now,
      lastErrorCode: null,
      lockedAt: null,
      lockedBy: null,
      updatedAt: now,
    })
    .where(eq(outboxEvents.id, eventId));
}

// ------------------------------------------------------------------
// Observabilidade e operação
// ------------------------------------------------------------------

export interface OutboxBacklog {
  pending: number;
  processing: number;
  dead: number;
  /** Idade (s) do PENDING mais antigo; 0 quando não há backlog. */
  oldestPendingAgeSeconds: number;
}

/**
 * Backlog em UMA consulta agregada — nunca varrendo evento a evento, para que
 * a métrica não vire o próprio problema de performance.
 */
export async function getOutboxBacklog(
  db: Database,
  now: Date = new Date(),
): Promise<OutboxBacklog> {
  const rows = await db
    .select({
      status: outboxEvents.status,
      total: count(),
      oldest: min(outboxEvents.createdAt),
    })
    .from(outboxEvents)
    .where(inArray(outboxEvents.status, ["PENDING", "PROCESSING", "DEAD"]))
    .groupBy(outboxEvents.status);

  const backlog: OutboxBacklog = {
    pending: 0,
    processing: 0,
    dead: 0,
    oldestPendingAgeSeconds: 0,
  };

  for (const row of rows) {
    const total = Number(row.total);
    if (row.status === "PENDING") {
      backlog.pending = total;
      if (row.oldest) {
        backlog.oldestPendingAgeSeconds = Math.max(
          0,
          Math.round((now.getTime() - new Date(row.oldest).getTime()) / 1000),
        );
      }
    } else if (row.status === "PROCESSING") {
      backlog.processing = total;
    } else if (row.status === "DEAD") {
      backlog.dead = total;
    }
  }
  return backlog;
}

export interface DeadEventSummary {
  id: string;
  eventType: string;
  attemptCount: number;
  lastErrorCode: string | null;
  deadLetteredAt: Date | null;
  createdAt: Date;
}

/** Eventos em DEAD, mais recentes primeiro (uso operacional via CLI). */
export async function listDeadEvents(db: Database, limit = 50): Promise<DeadEventSummary[]> {
  return db
    .select({
      id: outboxEvents.id,
      eventType: outboxEvents.eventType,
      attemptCount: outboxEvents.attemptCount,
      lastErrorCode: outboxEvents.lastErrorCode,
      deadLetteredAt: outboxEvents.deadLetteredAt,
      createdAt: outboxEvents.createdAt,
    })
    .from(outboxEvents)
    .where(eq(outboxEvents.status, "DEAD"))
    .orderBy(asc(outboxEvents.deadLetteredAt))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/**
 * Reenfileira um evento DEAD. Somente DEAD: reenfileirar algo PENDING ou
 * PROCESSING criaria processamento concorrente do mesmo efeito.
 * O payload NÃO é alterável — a CLI reprocessa, não edita histórico.
 */
export async function retryDeadEvent(
  db: Database,
  eventId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(outboxEvents)
    .set({
      status: "PENDING",
      availableAt: now,
      attemptCount: 0,
      lockedAt: null,
      lockedBy: null,
      deadLetteredAt: null,
      updatedAt: now,
    })
    .where(and(eq(outboxEvents.id, eventId), eq(outboxEvents.status, "DEAD")))
    .returning({ id: outboxEvents.id });
  return updated.length > 0;
}

export const OUTBOX_PROCESSED_RETENTION_DAYS = 30;
export const OUTBOX_DEAD_RETENTION_DAYS = 90;

export interface OutboxCleanupSummary {
  processed: number;
  dead: number;
}

/**
 * Retenção da outbox. NUNCA apaga PENDING ou PROCESSING — apagar trabalho
 * pendente é perder exatamente o que esta tabela existe para proteger.
 */
export async function deleteExpiredOutboxEvents(
  db: Database,
  now: Date = new Date(),
  processedDays: number = OUTBOX_PROCESSED_RETENTION_DAYS,
  deadDays: number = OUTBOX_DEAD_RETENTION_DAYS,
): Promise<OutboxCleanupSummary> {
  const processedCutoff = new Date(now.getTime() - processedDays * 24 * 60 * 60 * 1000);
  const deadCutoff = new Date(now.getTime() - deadDays * 24 * 60 * 60 * 1000);

  const processed = await db
    .delete(outboxEvents)
    .where(
      and(
        eq(outboxEvents.status, "PROCESSED"),
        isNotNull(outboxEvents.processedAt),
        lt(outboxEvents.processedAt, processedCutoff),
      ),
    )
    .returning({ id: outboxEvents.id });

  const dead = await db
    .delete(outboxEvents)
    .where(
      and(
        eq(outboxEvents.status, "DEAD"),
        isNotNull(outboxEvents.deadLetteredAt),
        lt(outboxEvents.deadLetteredAt, deadCutoff),
      ),
    )
    .returning({ id: outboxEvents.id });

  return { processed: processed.length, dead: dead.length };
}

/** Eventos elegíveis agora (diagnóstico e testes). */
export async function countClaimable(db: Database, now: Date = new Date()): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(outboxEvents)
    .where(or(and(eq(outboxEvents.status, "PENDING"), lte(outboxEvents.availableAt, now))));
  return Number(row?.total ?? 0);
}
