import postgres from "postgres";
import { runMigrations } from "../../src/infrastructure/database/migrate.js";

/**
 * Infraestrutura de banco para os testes de integração (README §20).
 * Usa um banco PostgreSQL dedicado (`*_test`), aplica as migrations reais e
 * oferece limpeza determinística entre os testes.
 */
const DEFAULT_URL = "postgres://safecircle:safecircle@localhost:5432/safecircle";

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

export function getTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) {
    return process.env.TEST_DATABASE_URL;
  }
  const base = process.env.DATABASE_URL ?? DEFAULT_URL;
  return withDatabase(base, "safecircle_test");
}

function getMaintenanceUrl(): string {
  const base = process.env.DATABASE_URL ?? DEFAULT_URL;
  return withDatabase(base, "postgres");
}

/**
 * Garante que o banco de testes exista e esteja migrado. Idempotente.
 */
export async function ensureTestDatabase(): Promise<void> {
  const testUrl = getTestDatabaseUrl();
  const testDbName = new URL(testUrl).pathname.replace(/^\//, "");

  const admin = postgres(getMaintenanceUrl(), { max: 1 });
  try {
    const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${testDbName}`;
    if (existing.length === 0) {
      // Identificador não pode ser parametrizado; usamos unsafe com nome validado.
      if (!/^[a-zA-Z0-9_]+$/.test(testDbName)) {
        throw new Error(`Nome de banco de testes inválido: ${testDbName}`);
      }
      await admin.unsafe(`CREATE DATABASE "${testDbName}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  await runMigrations(testUrl);
}

/**
 * Cliente auxiliar para limpar as tabelas entre testes. Expõe também o cliente
 * SQL bruto para asserções diretas no banco (ex.: constraints e persistência).
 */
export function createCleaner(): {
  sql: postgres.Sql;
  truncate: () => Promise<void>;
  close: () => Promise<void>;
} {
  const sql = postgres(getTestDatabaseUrl(), { max: 1 });
  return {
    sql,
    truncate: async () => {
      await sql`TRUNCATE TABLE alert_locations, emergency_alerts, idempotency_keys, group_invitations, group_memberships, trusted_groups, auth_sessions, users RESTART IDENTITY CASCADE`;
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}
