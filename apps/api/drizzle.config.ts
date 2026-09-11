import { defineConfig } from "drizzle-kit";

/**
 * Configuração do drizzle-kit.
 *
 * Phase 0: nenhuma tabela de domínio foi criada ainda, portanto não há
 * migrations. A configuração existe para deixar a integração pronta para
 * as próximas fases (cada alteração de schema gerará sua migration).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infrastructure/database/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://safecircle:safecircle@localhost:5432/safecircle",
  },
});
