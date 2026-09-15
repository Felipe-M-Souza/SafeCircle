import fp from "fastify-plugin";
import fastifyRateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

/**
 * Rate limiting compatível com Fastify (README §10, endurecido na Phase 11).
 *
 * Registrado com `global: false`: só se aplica às rotas que optarem via
 * `config.rateLimit`. Assim evitamos um limite global que poderia afetar
 * fluxos de emergência — o SOS nunca é limitado.
 *
 * Todos os limites são **por instância e em memória**: com várias réplicas o
 * limite efetivo é multiplicado pelo número de réplicas. Decisão registrada no
 * ADR 0012; não adicionamos Redis só para distribuir contadores.
 */
export const rateLimitPlugin = fp(
  async (app: FastifyInstance) => {
    await app.register(fastifyRateLimit, { global: false });
  },
  { name: "safecircle-rate-limit" },
);

/**
 * Perfil dos limites. `relaxed` (NODE_ENV=test) usa tetos altíssimos para não
 * gerar flakiness; os testes que exercitam o rate limit pedem `production`
 * explicitamente ao construir a app.
 */
export type RateLimitProfile = "production" | "relaxed";

export interface RateLimitConfig {
  max: number;
  timeWindow: string;
  /** Backoff progressivo: cada excesso dobra a espera (throttling gradual). */
  exponentialBackoff?: boolean;
}

const RELAXED: RateLimitConfig = { max: 1_000_000, timeWindow: "1 minute" };

function pick(profile: RateLimitProfile, production: RateLimitConfig): RateLimitConfig {
  return profile === "relaxed" ? RELAXED : production;
}

/**
 * Login e registro: janela curta e backoff progressivo por IP. Junto com o
 * freio por conta (`LoginThrottle`), cobre os dois eixos do credential
 * stuffing — muitas senhas para uma conta e muitas contas de um IP.
 */
export function authRateLimit(profile: RateLimitProfile): RateLimitConfig {
  return pick(profile, { max: 10, timeWindow: "1 minute", exponentialBackoff: true });
}

/** Refresh é chamado legitimamente com frequência maior que login. */
export function refreshRateLimit(profile: RateLimitProfile): RateLimitConfig {
  return pick(profile, { max: 30, timeWindow: "1 minute" });
}

/** Convites: mesmo teto do login (evita spam de convites). */
export function invitationRateLimit(profile: RateLimitProfile): RateLimitConfig {
  return pick(profile, { max: 10, timeWindow: "1 minute" });
}

/**
 * Limite para criação de check-ins (Phase 7): evita spam sem afetar o SOS
 * nem outros endpoints (um check-in ativo por grupo já contém o volume).
 */
export function checkinRateLimit(profile: RateLimitProfile): RateLimitConfig {
  return pick(profile, { max: 20, timeWindow: "1 minute" });
}

/**
 * Limite para criação de trajetos (Phase 8): evita spam sem afetar o SOS.
 * Um trajeto não-finalizado por usuário já contém o volume.
 */
export function journeyRateLimit(profile: RateLimitProfile): RateLimitConfig {
  return pick(profile, { max: 20, timeWindow: "1 minute" });
}

/** Handshake do WebSocket: reconexão legítima é rara; tempestade não é. */
export function realtimeHandshakeRateLimit(profile: RateLimitProfile): RateLimitConfig {
  return pick(profile, { max: 30, timeWindow: "1 minute" });
}

/**
 * Exportação de dados pessoais: operação cara e sensível; poucas por hora
 * bastam para qualquer uso legítimo.
 */
export function privacyExportRateLimit(profile: RateLimitProfile): RateLimitConfig {
  return pick(profile, { max: 5, timeWindow: "1 hour" });
}
