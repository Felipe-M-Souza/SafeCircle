import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errors } from "../shared/errors.js";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; sid: string };
    user: { sub: string; sid: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    auth: { userId: string; sessionId: string };
  }
}

export interface AuthPluginOptions {
  accessSecret: string;
  accessTtl: string;
}

/**
 * Autenticação reutilizável via JWT (README §8).
 *
 * Registra o @fastify/jwt e expõe `app.authenticate` como preHandler para
 * proteger rotas. Em caso de token ausente/inválido/expirado, responde
 * UNAUTHORIZED sem vazar detalhes.
 */
export const authPlugin = fp(
  async (app: FastifyInstance, options: AuthPluginOptions) => {
    await app.register(fastifyJwt, {
      secret: options.accessSecret,
      sign: {
        expiresIn: options.accessTtl,
        iss: "safecircle",
        aud: "safecircle-app",
      },
      verify: {
        allowedIss: "safecircle",
        allowedAud: "safecircle-app",
      },
    });

    app.decorate("authenticate", async (request: FastifyRequest) => {
      try {
        await request.jwtVerify();
        request.auth = { userId: request.user.sub, sessionId: request.user.sid };
      } catch {
        throw errors.unauthorized();
      }
    });
  },
  { name: "safecircle-auth" },
);
