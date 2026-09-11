import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Cliente de banco criado sob demanda a partir de uma DATABASE_URL.
 *
 * A conexão é intencionalmente preguiçosa: a API da Phase 0 sobe e responde
 * `/health` mesmo sem banco configurado (segurança antes de conveniência —
 * um fluxo essencial não deve falhar por causa de dependência opcional).
 */
export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
  const sql = postgres(databaseUrl, { max: 5 });
  const db = drizzle(sql, { schema });

  return {
    db,
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
