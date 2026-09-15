import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isValidRequestId } from "../observability/request-context.js";
import { errors } from "../shared/errors.js";
import {
  findSessionForAuth,
  isSessionUsable,
  touchSession,
} from "../modules/auth/sessions.service.js";

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

export const JWT_ISSUER = "safecircle";
export const JWT_AUDIENCE = "safecircle-app";
/** Único algoritmo aceito. O `alg` do token nunca decide nada. */
export const JWT_ALGORITHM = "HS256";
/** Tolerância de relógio na verificação (ms): pequena, para relógios de aparelho. */
export const JWT_CLOCK_TOLERANCE_MS = 5_000;

/**
 * Autenticação reutilizável via JWT (README §8; endurecida na Phase 11).
 *
 * Verificação do access token:
 * - algoritmo em allow-list (`HS256`) — `alg: none` ou assimétrico é recusado;
 * - `iss`, `aud`, `exp`, `iat`, `sub` e `sid` obrigatórios;
 * - `sub`/`sid` precisam ser UUIDs.
 *
 * Validação de **sessão** a cada requisição: o `sid` precisa apontar para uma
 * sessão existente, não revogada e não expirada, do mesmo usuário. É o que faz
 * "sair de todos os aparelhos" valer na próxima requisição, e não só quando o
 * access token expirar. Custa uma consulta por chave primária.
 *
 * Em caso de token ausente/inválido/expirado ou sessão inutilizável, responde
 * UNAUTHORIZED sem distinguir o motivo.
 */
export const authPlugin = fp(
  async (app: FastifyInstance, options: AuthPluginOptions) => {
    await app.register(fastifyJwt, {
      secret: options.accessSecret,
      sign: {
        algorithm: JWT_ALGORITHM,
        expiresIn: options.accessTtl,
        iss: JWT_ISSUER,
        aud: JWT_AUDIENCE,
      },
      verify: {
        algorithms: [JWT_ALGORITHM],
        allowedIss: JWT_ISSUER,
        allowedAud: JWT_AUDIENCE,
        clockTolerance: JWT_CLOCK_TOLERANCE_MS,
        requiredClaims: ["sub", "sid", "exp", "iat", "iss", "aud"],
      },
    });

    app.decorate("authenticate", async (request: FastifyRequest) => {
      try {
        await request.jwtVerify();
      } catch {
        throw errors.unauthorized();
      }

      const { sub, sid } = request.user;
      if (!isValidRequestId(sub) || !isValidRequestId(sid)) {
        throw errors.unauthorized();
      }

      // Sem banco (modo degradado da Phase 0) não há sessão para validar — e
      // também não há rota de negócio registrada.
      if (app.hasDecorator("db")) {
        const now = new Date();
        const session = await findSessionForAuth(app.db, sid);
        if (!isSessionUsable(session, now) || session?.userId !== sub) {
          request.log.debug(
            { event: "auth_session_unusable", sessionId: sid },
            "Access token de sessão revogada, expirada ou desconhecida",
          );
          throw errors.unauthorized();
        }
        await touchSession(app.db, session, now);
      }

      request.auth = { userId: sub, sessionId: sid };
      // Correlação (Phase 9): a partir daqui todo log da requisição carrega o
      // usuário — em um único lugar, sem repetir em cada rota.
      request.log = request.log.child({ userId: sub });
    });
  },
  { name: "safecircle-auth" },
);
