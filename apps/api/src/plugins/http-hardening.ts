import fp from "fastify-plugin";
import fastifyHelmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";

export interface HttpHardeningOptions {
  /**
   * HSTS só onde o HTTPS externo é garantido (terminação no ingress/proxy).
   * Ligado por engano em dev HTTP, o navegador passa a recusar `http://`.
   */
  hstsEnabled: boolean;
}

/** 180 dias: tempo suficiente para valer, curto o bastante para reverter. */
export const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * Cabeçalhos de segurança HTTP (Phase 11).
 *
 * Esta é uma API JSON consumida por app nativo e, em desenvolvimento, por um
 * app web. Os cabeçalhos escolhidos são os que fazem sentido para uma API —
 * não a CSP de uma SPA copiada sem necessidade:
 *
 * - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`:
 *   nenhuma resposta desta API deve ser renderizada nem emoldurada.
 * - `X-Content-Type-Options: nosniff`: JSON é JSON.
 * - `Referrer-Policy: no-referrer`: nenhuma URL nossa vaza em navegação.
 * - `X-Frame-Options: DENY` (redundante com a CSP, para navegadores antigos).
 * - `Strict-Transport-Security` apenas com `HSTS_ENABLED=true`.
 *
 * `Cross-Origin-Embedder-Policy` fica desligado: não há recurso embutido.
 */
export const httpHardeningPlugin = fp(
  async (app: FastifyInstance, options: HttpHardeningOptions) => {
    await app.register(fastifyHelmet, {
      global: true,
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: "no-referrer" },
      xFrameOptions: { action: "deny" },
      hsts: options.hstsEnabled
        ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: false, preload: false }
        : false,
    });
  },
  { name: "safecircle-http-hardening" },
);
