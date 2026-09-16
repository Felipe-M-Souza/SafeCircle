#!/usr/bin/env node
/**
 * Verificações determinísticas do Release Candidate (Phase 12): `pnpm release:check`.
 *
 * Roda, em sequência e sem esconder falhas, o que um RC precisa provar:
 * lint, formatação, typecheck, testes (API + mobile), build, auditoria de
 * dependências, conectividade e consistência do banco, bloqueadores de release
 * e a suíte E2E da API (que sobe um processo real da API sobre um banco
 * descartável). Não constrói binário mobile: isso depende de credenciais EAS.
 *
 * Opções:
 *   --skip-e2e        pula a suíte E2E (ex.: sem PostgreSQL disponível)
 *   --skip-tests      pula testes unitários/integração (use só para diagnóstico)
 *   --eol-auto        prettier com --end-of-line auto (checkout CRLF no Windows)
 *
 * Exit code ≠ 0 se qualquer etapa falhar; o resumo nomeia todas.
 */
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const skipE2e = args.has("--skip-e2e");
const skipTests = args.has("--skip-tests");
const eolAuto = args.has("--eol-auto");

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

/** @type {Array<{name: string, cmd: string[], skip?: boolean}>} */
const steps = [
  { name: "lint", cmd: [pnpm, "run", "lint"] },
  {
    name: "format:check",
    cmd: eolAuto
      ? [pnpm, "exec", "prettier", "--check", ".", "--end-of-line", "auto"]
      : [pnpm, "run", "format:check"],
  },
  { name: "typecheck", cmd: [pnpm, "run", "typecheck"] },
  { name: "test (API + mobile)", cmd: [pnpm, "run", "test"], skip: skipTests },
  { name: "build", cmd: [pnpm, "run", "build"] },
  { name: "security:audit", cmd: [pnpm, "run", "security:audit"] },
  { name: "db:check", cmd: [pnpm, "run", "db:check"] },
  {
    name: "migrations consistentes (drizzle-kit check)",
    cmd: [pnpm, "--filter", "@safecircle/api", "exec", "drizzle-kit", "check"],
  },
  { name: "release:blockers", cmd: [pnpm, "run", "release:blockers"] },
  { name: "e2e:api", cmd: [pnpm, "run", "e2e:api"], skip: skipE2e },
];

const results = [];
const startedAt = Date.now();
for (const step of steps) {
  if (step.skip) {
    results.push({ name: step.name, status: "SKIP", ms: 0 });
    console.log(`\n▶ ${step.name}: pulado`);
    continue;
  }
  console.log(`\n▶ ${step.name}`);
  const t0 = Date.now();
  const result = spawnSync(step.cmd[0], step.cmd.slice(1), {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });
  const ok = result.status === 0;
  results.push({ name: step.name, status: ok ? "PASS" : "FAIL", ms: Date.now() - t0 });
  if (!ok) {
    console.error(`✖ ${step.name} falhou (exit ${result.status ?? "?"}).`);
    // Continua para o resumo mostrar tudo que está quebrado, não só o primeiro.
  }
}

console.log("\n=== release:check ===");
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  ${r.name}${r.ms ? ` (${Math.round(r.ms / 1000)}s)` : ""}`);
}
const failed = results.filter((r) => r.status === "FAIL");
console.log(
  `\n${failed.length === 0 ? "RC checks OK" : `${failed.length} etapa(s) falharam`} em ${Math.round(
    (Date.now() - startedAt) / 1000,
  )}s`,
);
process.exit(failed.length === 0 ? 0 : 1);
