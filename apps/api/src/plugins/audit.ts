import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { recordAuditEvent, type AuditEventInput } from "../observability/audit.js";

/**
 * Auditoria integrada ao Fastify (Phase 9).
 *
 * `app.audit(...)` grava a trilha em segundo plano: nenhuma rota crítica (SOS
 * inclusive) espera pelo INSERT, e uma falha de auditoria nunca desfaz a
 * operação — ela é logada e contabilizada. As tarefas em segundo plano são
 * aguardadas no shutdown, então a trilha sobrevive a um encerramento limpo.
 *
 * `app.auditRequest(request, ...)` preenche automaticamente `requestId` e o
 * ator autenticado, evitando repetição em cada rota.
 */

export type RequestAuditInput = Omit<AuditEventInput, "requestId" | "actorUserId"> & {
  /** Sobrescreve o ator (padrão: usuário autenticado da requisição). */
  actorUserId?: string | null;
};

declare module "fastify" {
  interface FastifyInstance {
    audit: (input: AuditEventInput) => void;
    auditRequest: (request: FastifyRequest, input: RequestAuditInput) => void;
  }
}

export const auditPlugin = fp(
  async (app: FastifyInstance) => {
    const audit = (input: AuditEventInput): void => {
      app.background.run(`audit:${input.eventType}`, () =>
        recordAuditEvent({ db: app.db, log: app.log }, input),
      );
    };

    app.decorate("audit", audit);

    app.decorate("auditRequest", (request: FastifyRequest, input: RequestAuditInput) => {
      audit({
        ...input,
        actorUserId:
          input.actorUserId !== undefined ? input.actorUserId : (request.auth?.userId ?? null),
        requestId: typeof request.id === "string" ? request.id : null,
      });
    });
  },
  {
    name: "safecircle-audit",
    dependencies: ["safecircle-database", "safecircle-background-tasks"],
  },
);
