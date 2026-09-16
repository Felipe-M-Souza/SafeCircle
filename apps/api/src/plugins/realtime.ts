import fp from "fastify-plugin";
import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RateLimitProfile } from "../config/env.js";
import { RealtimeHub } from "../infrastructure/realtime/realtime-hub.js";
import {
  HubRealtimePublisher,
  type RealtimePublisher,
} from "../infrastructure/realtime/realtime-publisher.js";
import { isOriginAllowed, type OriginPolicy } from "../security/origins.js";
import { errors } from "../shared/errors.js";
import { realtimeHandshakeRateLimit } from "./rate-limit.js";

declare module "fastify" {
  interface FastifyInstance {
    realtimeHub: RealtimeHub;
    realtime: RealtimePublisher;
  }
}

export interface RealtimePluginOptions {
  hub?: RealtimeHub;
  originPolicy: OriginPolicy;
  rateLimitProfile: RateLimitProfile;
}

/** Tamanho máximo de frame aceito do cliente: ele não envia comandos. */
export const REALTIME_MAX_PAYLOAD_BYTES = 1024;

/**
 * WebSocket realtime (Phase 5; endurecido na Phase 11): `GET /realtime` com upgrade.
 *
 * - Autenticação obrigatória no handshake via `Authorization: Bearer <access>`
 *   (mesmo `app.authenticate` do REST: assinatura, expiração, iss/aud, sub/sid
 *   **e sessão viva**). Sem token/inválido/expirado → HTTP 401 e nenhum socket.
 * - `Origin` presente e fora da allow-list → 403 antes de autenticar. Cliente
 *   nativo não envia `Origin` e passa; a autenticação continua decidindo.
 * - Handshake com rate limit por IP: reconexão legítima é rara.
 * - A conexão é encerrada quando o access token expira (4401) ou quando a
 *   sessão é revogada (4403): o cliente renova via REST e reconecta.
 * - Server-push only; `maxPayload` pequeno — frame maior é fechado pelo `ws`.
 * - Shutdown fecha todas as conexões com 1001 (hook preClose, antes do
 *   fechamento sem status do @fastify/websocket).
 */
export const realtimePlugin = fp(
  async (app: FastifyInstance, options: RealtimePluginOptions) => {
    const hub = options.hub ?? new RealtimeHub({ log: app.log });

    // Registrado ANTES do @fastify/websocket: o preClose padrão do plugin fecha
    // os clientes sem status (o peer vê 1005). Este hook corre primeiro e fecha
    // cada conexão com 1001/SERVER_SHUTDOWN, como o contrato do cliente espera.
    app.addHook("preClose", async () => {
      hub.closeAll();
    });

    await app.register(fastifyWebsocket, {
      options: { maxPayload: REALTIME_MAX_PAYLOAD_BYTES },
    });
    app.decorate("realtimeHub", hub);
    app.decorate("realtime", new HubRealtimePublisher(app.db, hub, app.log));

    const enforceOrigin = async (request: FastifyRequest) => {
      if (!isOriginAllowed(options.originPolicy, request.headers.origin)) {
        request.log.warn({ event: "realtime_origin_rejected" }, "Origem web recusada no handshake");
        throw errors.originNotAllowed();
      }
    };

    app.get(
      "/realtime",
      {
        websocket: true,
        config: { rateLimit: realtimeHandshakeRateLimit(options.rateLimitProfile) },
        preHandler: [enforceOrigin, app.authenticate],
      },
      (socket, request) => {
        const exp = (request.user as { exp?: number } | undefined)?.exp;
        hub.register(request.auth.userId, socket, {
          sessionId: request.auth.sessionId,
          expiresAt: typeof exp === "number" ? new Date(exp * 1000) : undefined,
        });
      },
    );

    app.addHook("onClose", async () => {
      hub.closeAll();
    });
  },
  { name: "safecircle-realtime", dependencies: ["safecircle-auth", "safecircle-database"] },
);
