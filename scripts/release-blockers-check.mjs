#!/usr/bin/env node
/**
 * Bug bar do Release Candidate (Phase 12): `pnpm release:blockers`.
 *
 * Lê `docs/release/release-blockers.md` e falha se houver:
 *   - qualquer item BLOCKER que não esteja RESOLVED;
 *   - qualquer item HIGH que não esteja RESOLVED nem ACCEPTED.
 *
 * Formato esperado das linhas da tabela (uma por item):
 *   | RB-001 | BLOCKER | RESOLVED | descrição | referência |
 *
 * A verificação é deliberadamente simples e determinística: o documento é a
 * fonte de verdade, e este script só impede que um RC seja declarado com um
 * bloqueador esquecido em aberto.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const file = path.resolve("docs/release/release-blockers.md");
let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  console.error(`release:blockers — arquivo não encontrado: ${file}`);
  process.exit(1);
}

const rows = text
  .split(/\r?\n/)
  .filter((line) => /^\|\s*RB-\d+\s*\|/.test(line))
  .map((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    return {
      id: cells[0],
      severity: cells[1]?.toUpperCase(),
      status: cells[2]?.toUpperCase(),
      title: cells[3],
    };
  });

if (rows.length === 0) {
  console.error(
    "release:blockers — nenhuma linha `| RB-xxx |` encontrada; o documento está no formato esperado?",
  );
  process.exit(1);
}

const openBlockers = rows.filter((r) => r.severity === "BLOCKER" && r.status !== "RESOLVED");
const openHigh = rows.filter(
  (r) => r.severity === "HIGH" && r.status !== "RESOLVED" && r.status !== "ACCEPTED",
);

const summary = rows.reduce((acc, r) => {
  const key = `${r.severity}/${r.status}`;
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});
console.log("release:blockers —", rows.length, "item(ns):", JSON.stringify(summary));

for (const r of openBlockers) console.error(`  BLOCKER em aberto: ${r.id} — ${r.title}`);
for (const r of openHigh) console.error(`  HIGH não aceito:   ${r.id} — ${r.title}`);

if (openBlockers.length > 0 || openHigh.length > 0) {
  console.error("Critical blockers precisam ser 0 e HIGH precisam estar resolvidos ou aceitos.");
  process.exit(1);
}
console.log("Critical blockers = 0; nenhum HIGH sem decisão.");
