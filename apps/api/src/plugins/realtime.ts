import fp from "fastify-plugin";
import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { RealtimeHub } from "../infrastructure/realtime/realtime-hub.js";
import {
  HubRealtimePublisher,
  type RealtimePublisher,
} from "../infrastructure/realtime/realtime-publisher.js";

declare module "fastify" {
  interface FastifyInstance {
    realtimeHub: RealtimeHub;
    realtime: RealtimePublisher;
  }
}

export interface RealtimePluginOptions {
  hub?: RealtimeHub;
}

/**
 * WebSocket realtime (Phase 5): `GET /realtime` com upgrade.
 *
 * - Autenticação obrigatória no handshake via `Authorization: Bearer <access>`
 *   (mesmo `app.authenticate` do REST: assinatura, expiração, iss/aud, sub/sid).
 *   Sem token/inválido/expirado → resposta HTTP 401 e nenhum socket.
 * - A conexão é encerrada quando o access token expira (4401): o cliente
 *   renova via REST e reconecta.
 * - Server-push only; `maxPayload` pequeno pois o cliente não envia comandos.
 * - Shutdown fecha todas as conexões (1001).
 */
export const realtimePlugin = fp(
  async (app: FastifyInstance, options: RealtimePluginOptions) => {
    await app.register(fastifyWebsocket, { options: { maxPayload: 1024 } });

    const hub = options.hub ?? new RealtimeHub({ log: app.log });
    app.decorate("realtimeHub", hub);
    app.decorate("realtime", new HubRealtimePublisher(app.db, hub, app.log));

    app.get("/realtime", { websocket: true, preHandler: app.authenticate }, (socket, request) => {
      const exp = (request.user as { exp?: number } | undefined)?.exp;
      hub.register(request.auth.userId, socket, {
        expiresAt: typeof exp === "number" ? new Date(exp * 1000) : undefined,
      });
    });

    app.addHook("onClose", async () => {
      hub.closeAll();
    });
  },
  { name: "safecircle-realtime", dependencies: ["safecircle-auth", "safecircle-database"] },
);
