import { createHash } from "node:crypto";
import { z } from "zod";
import { errors } from "./errors.js";

/**
 * Utilitários de idempotência (README §17).
 *
 * A chave vem do header `Idempotency-Key` e é escopada por usuário + operação
 * na tabela `idempotency_keys`. O hash do payload canônico permite detectar o
 * reuso da mesma chave com uma requisição diferente.
 */

/**
 * Formato aceito: 8–128 caracteres de [A-Za-z0-9_-] (UUIDs se encaixam).
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Valida o header `Idempotency-Key`; ausente/repetido/inválido → INVALID_IDEMPOTENCY_KEY. */
export function parseIdempotencyKey(header: unknown): string {
  if (typeof header !== "string") {
    throw errors.invalidIdempotencyKey();
  }
  const result = idempotencyKeySchema.safeParse(header);
  if (!result.success) {
    throw errors.invalidIdempotencyKey();
  }
  return result.data;
}

/** Hash SHA-256 do payload (após validação, portanto canônico). */
export function hashRequestPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
