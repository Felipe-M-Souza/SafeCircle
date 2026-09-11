import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Carrega variáveis de um arquivo `.env` (se existir) antes da validação.
 * Procura na raiz do monorepo e no diretório atual. Silencioso quando ausente,
 * pois em produção as variáveis vêm do ambiente do processo.
 */
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(here, "../../../../.env"), // raiz do monorepo
  resolve(process.cwd(), ".env"),
];

for (const path of candidates) {
  if (existsSync(path)) {
    dotenv.config({ path, override: false });
  }
}
