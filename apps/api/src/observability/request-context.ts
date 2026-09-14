import { randomUUID } from "node:crypto";

/**
 * Identificação e correlação de requisições (Phase 9).
 *
 * Toda requisição tem um `requestId` UUID. O cliente PODE propagar o seu via
 * `X-Request-Id`, mas apenas se for um UUID válido: qualquer outro valor é
 * descartado e substituído por um novo. Isso evita log injection (quebra de
 * linha, terminadores ANSI), poluição de índices e valores gigantes vindos de
 * fora — o header é entrada não confiável como qualquer outra.
 */

export const REQUEST_ID_HEADER = "x-request-id";

const UUID_V4_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** UUID canônico (aceita apenas as versões 1–5 com variante correta). */
export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID_V4_LIKE.test(value);
}

/**
 * Request ID a partir do header do cliente, com fallback seguro.
 * Header ausente, malformado, repetido (array) ou não-UUID → novo UUID.
 */
export function resolveRequestId(headerValue: unknown): string {
  const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return isValidRequestId(candidate) ? candidate.toLowerCase() : randomUUID();
}

/** Identificador de uma falha interna, para correlacionar log e suporte. */
export function newErrorId(): string {
  return randomUUID();
}

/**
 * Caminhos redigidos centralmente pelo Pino. Nada aqui pode chegar a um log,
 * arquivo ou coletor: credenciais, tokens e coordenadas precisas.
 * Ver ADR 0010 e a regra de segurança/privacidade do projeto.
 */
export const REDACTED_LOG_PATHS = [
  // Credenciais e sessões
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['set-cookie']",
  "req.headers['idempotency-key']",
  "res.headers['set-cookie']",
  "password",
  "passwordHash",
  "*.password",
  "*.passwordHash",
  "req.body.password",
  "req.body.newPassword",
  "req.body.refreshToken",
  "req.body.accessToken",
  "req.body.token",
  // Push tokens (Phase 4)
  "token",
  "*.token",
  "req.body.pushToken",
  // Localização precisa (Phases 3/6/8)
  "latitude",
  "longitude",
  "*.latitude",
  "*.longitude",
  "req.body.latitude",
  "req.body.longitude",
  "req.body.accuracy",
  "req.body.altitude",
  "req.body.heading",
  "req.body.speed",
  "req.body.location",
] as const;
