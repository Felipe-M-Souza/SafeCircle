import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { newErrorId } from "../observability/request-context.js";
import { AppError, type ErrorCode } from "../shared/errors.js";

interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: unknown;
  /** Correlaciona a resposta com os logs do servidor (Phase 9). */
  requestId?: string;
  /** Somente em falhas internas: código de suporte da ocorrência. */
  errorId?: string;
}

/**
 * Tratamento de erros centralizado (README §16, Phase 9).
 *
 * - Converte erros conhecidos em códigos estáveis; nunca expõe stack trace nem
 *   mensagem crua do PostgreSQL.
 * - Toda resposta de erro carrega `requestId`; falhas internas carregam também
 *   `errorId`, que aparece no log correspondente (e vira "código de suporte"
 *   no app).
 * - Severidade honesta: erro **esperado** (validação, auth, anti-IDOR,
 *   conflito) não é `error` — é `debug`/`warn`. Só o inesperado é `error`, para
 *   que o sinal de 5xx continue significando alguma coisa.
 */
export const errorHandlerPlugin = fp(
  async (app: FastifyInstance) => {
    const requestIdOf = (request: FastifyRequest): string | undefined =>
      typeof request.id === "string" ? request.id : undefined;

    app.setErrorHandler((error, request, reply) => {
      const requestId = requestIdOf(request);

      if (error instanceof AppError) {
        const body: ErrorResponse = { code: error.code, message: error.message, requestId };
        if (error.details !== undefined) {
          body.details = error.details;
        }
        // Esperado por contrato: não polui o canal de erro.
        request.log.debug(
          { event: "request_failed_expected", errorCode: error.code, statusCode: error.statusCode },
          "Erro de domínio",
        );
        return reply.status(error.statusCode).send(body);
      }

      if (error instanceof ZodError) {
        const body: ErrorResponse = {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos.",
          requestId,
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        };
        request.log.debug(
          { event: "request_failed_validation", issueCount: error.issues.length },
          "Erro de validação",
        );
        return reply.status(400).send(body);
      }

      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? (error as { statusCode?: number }).statusCode
          : undefined;

      // @fastify/rate-limit sinaliza 429.
      if (statusCode === 429) {
        request.log.warn({ event: "request_rate_limited" }, "Requisição limitada por rate limit");
        return reply.status(429).send({
          code: "RATE_LIMITED",
          message: "Muitas requisições. Tente novamente em instantes.",
          requestId,
        } satisfies ErrorResponse);
      }

      // Erros de validação de JWT / autorização.
      if (statusCode === 401) {
        request.log.debug({ event: "request_unauthorized" }, "Requisição não autenticada");
        return reply
          .status(401)
          .send({ code: "UNAUTHORIZED", message: "Não autenticado.", requestId });
      }

      // Corpo malformado / content-type ou tamanho inválidos (parser do Fastify):
      // erro do cliente, nunca 500 — e sem ecoar o corpo recebido.
      if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
        request.log.debug({ event: "request_malformed", statusCode }, "Requisição malformada");
        return reply.status(400).send({
          code: "VALIDATION_ERROR",
          message: "Requisição inválida.",
          requestId,
        } satisfies ErrorResponse);
      }

      // Qualquer outro erro é interno: logar completo com errorId, responder genérico.
      const errorId = newErrorId();
      request.log.error(
        { event: "request_failed_unexpected", err: error, errorId },
        "Erro não tratado",
      );
      return reply.status(500).send({
        code: "INTERNAL_ERROR",
        message: "Erro interno.",
        requestId,
        errorId,
      } satisfies ErrorResponse);
    });

    // Rota inexistente: mesmo formato dos demais erros (com requestId) e sem
    // ecoar método/URL da requisição, como faz a resposta padrão do Fastify.
    app.setNotFoundHandler((request, reply) => {
      request.log.debug({ event: "route_not_found" }, "Rota não encontrada");
      return reply.status(404).send({
        code: "NOT_FOUND",
        message: "Recurso não encontrado.",
        requestId: requestIdOf(request),
      } satisfies ErrorResponse);
    });
  },
  { name: "safecircle-error-handler" },
);
