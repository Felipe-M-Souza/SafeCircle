import "../config/load-dotenv.js";
import { sql } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { createDatabase } from "../infrastructure/database/client.js";

/**
 * Verificação de conectividade com o PostgreSQL via Drizzle.
 * Executa um `SELECT 1` para provar que a integração de banco está configurada.
 */
async function main(): Promise<void> {
  const env = loadEnv();

  if (!env.DATABASE_URL) {
    console.error(
      "DATABASE_URL não definida. Configure o `.env` (veja `.env.example`) e rode `pnpm db:start`.",
    );
    process.exit(1);
  }

  const handle = createDatabase(env.DATABASE_URL);
  try {
    const result = await handle.db.execute(sql`select 1 as ok`);
    const ok = (result as unknown as Array<{ ok: number }>)[0]?.ok;
    if (ok === 1) {
      console.log("Conexão com PostgreSQL OK (SELECT 1 => 1).");
    } else {
      console.error("Resposta inesperada do banco:", result);
      process.exit(1);
    }
  } catch (error) {
    console.error("Falha ao conectar no PostgreSQL:", error);
    process.exit(1);
  } finally {
    await handle.close();
  }
}

void main();
