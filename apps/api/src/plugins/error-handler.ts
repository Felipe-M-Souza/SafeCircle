import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { AppError, type ErrorCode } from "../shared/errors.js";

interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Tratamento de erros centralizado (README §16).
 *
 * Converte erros conhecidos em códigos estáveis. Nunca expõe stack trace nem
 * mensagens cruas do PostgreSQL ao cliente.
 */
export const errorHandlerPlugin = fp(
  async (app: FastifyInstance) => {
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof AppError) {
        const body: ErrorResponse = { code: error.code, message: error.message };
        if (error.details !== undefined) {
          body.details = error.details;
        }
        return reply.status(error.statusCode).send(body);
      }

      if (error instanceof ZodError) {
        const body: ErrorResponse = {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos.",
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        };
        return reply.status(400).send(body);
      }

      const statusCode =
        typeof error === "object" && error !== null && "statusCode" in error
          ? (error as { statusCode?: number }).statusCode
          : undefined;

      // @fastify/rate-limit sinaliza 429.
      if (statusCode === 429) {
        const body: ErrorResponse = {
          code: "RATE_LIMITED",
          message: "Muitas requisições. Tente novamente em instantes.",
        };
        return reply.status(429).send(body);
      }

      // Erros de validação de JWT / autorização.
      if (statusCode === 401) {
        return reply.status(401).send({ code: "UNAUTHORIZED", message: "Não autenticado." });
      }

      // Corpo malformado / content-type ou tamanho inválidos (parser do Fastify):
      // erro do cliente, nunca 500 — e sem ecoar o corpo recebido.
      if (statusCode === 400 || statusCode === 413 || statusCode === 415) {
        const body: ErrorResponse = { code: "VALIDATION_ERROR", message: "Requisição inválida." };
        return reply.status(400).send(body);
      }

      // Qualquer outro erro é interno: logar completo, responder genérico.
      request.log.error({ err: error }, "Erro não tratado");
      const body: ErrorResponse = {
        code: "INTERNAL_ERROR",
        message: "Erro interno.",
      };
      return reply.status(500).send(body);
    });
  },
  { name: "safecircle-error-handler" },
);
