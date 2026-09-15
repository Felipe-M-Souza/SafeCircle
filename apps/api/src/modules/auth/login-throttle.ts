import { createHash } from "node:crypto";

/**
 * Freio por identificador para o login (Phase 11).
 *
 * O rate limit por IP do `@fastify/rate-limit` não enxerga credential stuffing
 * distribuído: mil IPs, uma senha vazada cada, a mesma conta. Este freio olha
 * o outro lado — quantas falhas **esta conta** acumulou — e passa a recusar
 * antes de consultar o banco quando o limite é atingido.
 *
 * Decisões:
 * - A chave é um **hash** do e-mail normalizado: o e-mail bruto não fica em
 *   memória de diagnóstico, não vai para log nem para métrica.
 * - Janela deslizante curta e bloqueio temporário, **sem lockout permanente**:
 *   um lockout que dura até alguém intervir é uma arma de negação de serviço
 *   contra a vítima. Aqui a conta volta sozinha ao fim da janela.
 * - Sucesso zera o contador: dono errando a senha duas vezes e acertando na
 *   terceira não fica marcado.
 * - Estado **em memória, por instância**. Com várias réplicas cada uma conta
 *   a sua parte; o limite efetivo é `maxFailures × réplicas`. Aceito e
 *   documentado (ADR 0012); não vale um Redis só para isso.
 */

export interface LoginThrottleOptions {
  /** Falhas na janela a partir das quais a conta é recusada. */
  maxFailures?: number;
  /** Janela deslizante das falhas (ms). */
  windowMs?: number;
  /** Duração do bloqueio depois de atingir o limite (ms). */
  blockMs?: number;
  now?: () => number;
}

export const DEFAULT_LOGIN_MAX_FAILURES = 5;
export const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_LOGIN_BLOCK_MS = 15 * 60 * 1000;

interface Entry {
  failures: number[];
  blockedUntil: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;

  constructor(options: LoginThrottleOptions = {}) {
    this.maxFailures = options.maxFailures ?? DEFAULT_LOGIN_MAX_FAILURES;
    this.windowMs = options.windowMs ?? DEFAULT_LOGIN_WINDOW_MS;
    this.blockMs = options.blockMs ?? DEFAULT_LOGIN_BLOCK_MS;
    this.now = options.now ?? Date.now;
  }

  /** Hash curto do identificador normalizado — nunca o e-mail em si. */
  static keyFor(identifier: string): string {
    return createHash("sha256").update(identifier.trim().toLowerCase()).digest("hex").slice(0, 32);
  }

  /** Verdadeiro quando novas tentativas devem ser recusadas sem consultar o banco. */
  isBlocked(identifier: string): boolean {
    const entry = this.entries.get(LoginThrottle.keyFor(identifier));
    if (!entry) return false;
    const now = this.now();
    if (entry.blockedUntil > now) return true;
    this.prune(entry, now);
    return false;
  }

  /** Registra uma falha; devolve se o limite acabou de ser atingido. */
  recordFailure(identifier: string): boolean {
    const key = LoginThrottle.keyFor(identifier);
    const now = this.now();
    const entry = this.entries.get(key) ?? { failures: [], blockedUntil: 0 };
    this.prune(entry, now);
    entry.failures.push(now);
    if (entry.failures.length >= this.maxFailures) {
      entry.blockedUntil = now + this.blockMs;
      entry.failures = [];
    }
    this.entries.set(key, entry);
    this.sweep(now);
    return entry.blockedUntil > now;
  }

  /** Login correto: a conta volta ao estado limpo. */
  reset(identifier: string): void {
    this.entries.delete(LoginThrottle.keyFor(identifier));
  }

  /** Quantidade de identificadores rastreados (diagnóstico e testes). */
  size(): number {
    return this.entries.size;
  }

  private prune(entry: Entry, now: number): void {
    const cutoff = now - this.windowMs;
    entry.failures = entry.failures.filter((at) => at > cutoff);
    if (entry.blockedUntil <= now) entry.blockedUntil = 0;
  }

  /**
   * Remove entradas sem informação útil para que um atacante enumerando
   * e-mails não faça a estrutura crescer sem limite.
   */
  private sweep(now: number): void {
    if (this.entries.size < 10_000) return;
    for (const [key, entry] of this.entries) {
      this.prune(entry, now);
      if (entry.failures.length === 0 && entry.blockedUntil === 0) this.entries.delete(key);
    }
  }
}
