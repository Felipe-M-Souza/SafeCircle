/**
 * Geração da `Idempotency-Key` para a criação do alerta (Phase 3).
 *
 * Uma chave nova representa uma nova intenção de ativação. O retry da mesma
 * intenção (ex.: falha de rede) deve reutilizar a mesma chave para que o
 * backend devolva o alerta já criado em vez de criar outro incidente.
 *
 * A chave é escopada por usuário no backend; não precisa ser criptograficamente
 * forte, apenas única por usuário. Formato aceito: [A-Za-z0-9_-]{8,128}.
 */
export function generateIdempotencyKey(): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  const random = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random()}${random()}${random()}`;
}
