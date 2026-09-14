import { sql } from "drizzle-orm";
import type { Database } from "../infrastructure/database/client.js";

/**
 * Liveness x readiness (Phase 9).
 *
 * - **Liveness** (`GET /health`): o processo está vivo. NÃO depende do banco —
 *   derrubar o container porque o PostgreSQL piscou é pior do que esperar.
 * - **Readiness** (`GET /ready`): a instância pode receber tráfego. Depende do
 *   banco (com timeout curto) e do término da inicialização. Dependências
 *   externas não-críticas (provedor de push) NUNCA tornam a API not-ready: o
 *   push é assíncrono e degradado, o resto da API continua útil.
 *
 * A resposta é deliberadamente pobre em detalhes: nunca connection string,
 * host, credencial ou mensagem crua do driver.
 */

export const READINESS_TIMEOUT_MS = 1500;

export type ReadinessStatus = "ok" | "degraded";

export interface ReadinessCheck {
  name: string;
  status: "ok" | "fail";
}

export interface ReadinessResult {
  status: ReadinessStatus;
  checks: ReadinessCheck[];
  /** Código HTTP correspondente: 200 quando pronto, 503 quando não. */
  statusCode: 200 | 503;
}

/** `SELECT 1` com timeout curto; qualquer erro/lentidão conta como falha. */
export async function checkDatabase(
  db: Database,
  timeoutMs: number = READINESS_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("readiness_timeout")), timeoutMs);
    });
    await Promise.race([db.execute(sql`select 1`), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ReadinessOptions {
  /** Ausente quando a API sobe sem DATABASE_URL (modo degradado da Phase 0). */
  db?: Database;
  /** Falso enquanto plugins/rotas ainda não terminaram de subir. */
  started: boolean;
  timeoutMs?: number;
}

export async function evaluateReadiness(options: ReadinessOptions): Promise<ReadinessResult> {
  const checks: ReadinessCheck[] = [{ name: "startup", status: options.started ? "ok" : "fail" }];

  if (options.db) {
    const databaseOk = await checkDatabase(options.db, options.timeoutMs);
    checks.push({ name: "database", status: databaseOk ? "ok" : "fail" });
  } else {
    // Sem banco configurado a instância não serve tráfego de negócio.
    checks.push({ name: "database", status: "fail" });
  }

  const ready = checks.every((check) => check.status === "ok");
  return { status: ready ? "ok" : "degraded", checks, statusCode: ready ? 200 : 503 };
}
