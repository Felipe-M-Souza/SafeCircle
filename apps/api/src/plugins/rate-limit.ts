import fp from "fastify-plugin";
import fastifyRateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

/**
 * Rate limiting compatível com Fastify (README §10).
 *
 * Registrado com `global: false`: só se aplica às rotas que optarem via
 * `config.rateLimit`. Assim evitamos um limite global que poderia afetar,
 * futuramente, fluxos de emergência.
 */
export const rateLimitPlugin = fp(
  async (app: FastifyInstance) => {
    await app.register(fastifyRateLimit, { global: false });
  },
  { name: "safecircle-rate-limit" },
);

/**
 * Configuração de rate limit para endpoints sensíveis de autenticação.
 * Em ambiente de teste os limites são altíssimos para não gerar flakiness.
 */
export function authRateLimit(nodeEnv: string): { max: number; timeWindow: string } {
  if (nodeEnv === "test") {
    return { max: 1_000_000, timeWindow: "1 minute" };
  }
  return { max: 10, timeWindow: "1 minute" };
}

/**
 * Limite para criação de check-ins (Phase 7): evita spam sem afetar o SOS
 * nem outros endpoints (um check-in ativo por grupo já contém o volume).
 */
export function checkinRateLimit(nodeEnv: string): { max: number; timeWindow: string } {
  if (nodeEnv === "test") {
    return { max: 1_000_000, timeWindow: "1 minute" };
  }
  return { max: 20, timeWindow: "1 minute" };
}
