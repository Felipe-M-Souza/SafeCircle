import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import {
  createDatabase,
  type Database,
  type DatabaseHandle,
} from "../infrastructure/database/client.js";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    dbHandle: DatabaseHandle;
  }
}

export interface DatabasePluginOptions {
  databaseUrl: string;
}

/**
 * Disponibiliza o cliente Drizzle (`app.db`) para os módulos e fecha a conexão
 * no shutdown. Deve ser registrado apenas quando há DATABASE_URL configurada.
 */
export const databasePlugin = fp(
  async (app: FastifyInstance, options: DatabasePluginOptions) => {
    const handle = createDatabase(options.databaseUrl);
    app.decorate("db", handle.db);
    app.decorate("dbHandle", handle);

    app.addHook("onClose", async () => {
      await handle.close();
    });
  },
  { name: "safecircle-database" },
);
