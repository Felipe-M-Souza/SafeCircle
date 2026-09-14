import type { LightMyRequestResponse } from "fastify";

/**
 * Corpo de erro sem o `requestId` (Phase 9).
 *
 * O `requestId` é único por requisição — comparar corpos inteiros entre duas
 * respostas passaria a falhar sempre. A garantia anti-IDOR que os testes
 * verificam é que `code` e `message` são **idênticos** para "não é seu" e
 * "não existe"; a correlação é justamente o campo que pode (e deve) variar.
 */
export function errorBodyWithoutRequestId(
  response: LightMyRequestResponse,
): Record<string, unknown> {
  const body = response.json() as Record<string, unknown>;
  const { requestId: _requestId, ...rest } = body;
  return rest;
}
