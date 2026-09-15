import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { enqueueAudit } from "../outbox/effects.js";
import type { AuditOutboxEventType } from "../outbox/outbox.types.js";
import type { AuditMetadata } from "../observability/audit.js";

/**
 * Auditoria avulsa (Phase 10).
 *
 * A regra geral é enfileirar o evento de auditoria **dentro da transação do
 * domínio** (ver `outbox/effects.ts`). Este helper existe só para o caso em que
 * não há mudança de domínio com a qual ser atômico — hoje, a tentativa de login
 * malsucedida: nada foi alterado no banco, mas o fato precisa ficar registrado.
 *
 * Mesmo aqui a durabilidade é real: o evento é gravado em uma transação própria
 * e entregue pelo worker, em vez de depender de uma tarefa em memória.
 */
export interface StandaloneAuditInput {
  eventType: AuditOutboxEventType;
  aggregateType: string;
  aggregateId?: string | null;
  actorUserId: string | null;
  targetType?: string;
  targetId?: string | null;
  groupId?: string | null;
  outcome?: "SUCCEEDED" | "FAILED";
  metadata?: AuditMetadata;
  requestId?: string | null;
}

declare module "fastify" {
  interface FastifyInstance {
    enqueueAuditEvent: (input: StandaloneAuditInput) => Promise<void>;
  }
}

export const auditPlugin = fp(
  async (app: FastifyInstance) => {
    app.decorate("enqueueAuditEvent", async (input: StandaloneAuditInput) => {
      const { eventType, ...rest } = input;
      await app.db.transaction(async (tx) => {
        await enqueueAudit(tx, eventType, rest);
      });
    });
  },
  { name: "safecircle-audit", dependencies: ["safecircle-database"] },
);
