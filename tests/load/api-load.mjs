#!/usr/bin/env node
/**
 * Sanidade de carga da API (Phase 12 §69–70), sem dependências externas.
 *
 * Não é benchmark. Objetivo: detectar crash, vazamento óbvio, exaustão do pool
 * e cardinalidade explosiva sob carga **moderada** (20–50 usuários virtuais),
 * e registrar números realmente medidos (p50/p95 por rota).
 *
 *   node tests/load/api-load.mjs --url http://127.0.0.1:3460 --vus 30 --seconds 20
 *
 * Cada usuário virtual: registro (uma vez), login, e um laço de
 * GET /groups → GET /alerts → POST /alerts (idempotente, 1 a cada 10 iterações,
 * resolvido em seguida) → GET /me/sessions. Contas sintéticas
 * (`load.*@safecircle.test`) apagadas ao final via exclusão de conta.
 *
 * Use contra API E2E/local com RATE_LIMIT_PROFILE=relaxed. Nunca contra produção.
 */
import { randomUUID } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1] ?? "true"]);
    return acc;
  }, []),
);
const BASE = (args.url ?? "http://127.0.0.1:3460").replace(/\/$/, "");
const VUS = Number(args.vus ?? 30);
const SECONDS = Number(args.seconds ?? 20);
const PASSWORD = `load-${randomUUID()}`;

const samples = new Map(); // rota -> ms[]
let errors = 0;
let statuses = {};

function record(route, ms, status) {
  if (!samples.has(route)) samples.set(route, []);
  samples.get(route).push(ms);
  statuses[status] = (statuses[status] ?? 0) + 1;
}

async function call(route, method, path, { body, token, idempotencyKey } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    record(route, performance.now() - t0, res.status);
    if (res.status >= 500) errors += 1;
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } catch (error) {
    record(route, performance.now() - t0, "ERR");
    errors += 1;
    return { status: 0, json: null, error };
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function virtualUser(index, deadline) {
  const email = `load.${Date.now().toString(36)}.${index}@safecircle.test`;
  const reg = await call("POST /auth/register", "POST", "/auth/register", {
    body: { name: `Carga ${index}`, email, password: PASSWORD },
  });
  if (reg.status !== 201) return;
  const login = await call("POST /auth/login", "POST", "/auth/login", {
    body: { email, password: PASSWORD },
  });
  const token = login.json?.accessToken;
  if (!token) return;
  const group = await call("POST /groups", "POST", "/groups", {
    token,
    body: { name: `Grupo ${index}` },
  });
  const groupId = group.json?.id;

  let iteration = 0;
  while (Date.now() < deadline) {
    iteration += 1;
    await call("GET /groups", "GET", "/groups", { token });
    await call("GET /alerts", "GET", "/alerts", { token });
    await call("GET /me/sessions", "GET", "/me/sessions", { token });
    if (groupId && iteration % 10 === 1) {
      const alert = await call("POST /alerts", "POST", "/alerts", {
        token,
        body: { groupId },
        idempotencyKey: randomUUID(),
      });
      if (alert.json?.id) {
        await call("POST /alerts/:id/resolve", "POST", `/alerts/${alert.json.id}/resolve`, {
          token,
        });
      }
    }
  }

  // Limpeza: a conta sintética sai com tudo (grupo em que era a única pessoa).
  await call("POST /me/delete-account", "POST", "/me/delete-account", {
    token,
    body: { password: PASSWORD },
  });
}

async function metricsSnapshot() {
  try {
    const text = await fetch(`${BASE}/metrics`).then((r) => r.text());
    const lines = text.split("\n").filter((l) => l.startsWith("safecircle_") && !l.startsWith("#"));
    const series = lines.length;
    const heap = /process_resident_memory_bytes (\d+)/.exec(text)?.[1];
    const rss = /safecircle_process_resident_memory_bytes (\d+)/.exec(text)?.[1] ?? heap;
    return { series, rssMb: rss ? Math.round(Number(rss) / 1024 / 1024) : null };
  } catch {
    return { series: null, rssMb: null };
  }
}

async function main() {
  console.log(`Carga moderada → ${BASE} · ${VUS} VUs · ${SECONDS}s`);
  const before = await metricsSnapshot();
  const deadline = Date.now() + SECONDS * 1000;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: VUS }, (_, i) => virtualUser(i, deadline)));
  const elapsed = (Date.now() - t0) / 1000;
  const after = await metricsSnapshot();

  const total = [...samples.values()].reduce((n, arr) => n + arr.length, 0);
  console.log(
    `\n${total} requisições em ${elapsed.toFixed(1)}s (${(total / elapsed).toFixed(0)} req/s), erros 5xx/rede: ${errors}`,
  );
  console.log(`status: ${JSON.stringify(statuses)}`);
  console.log("\nrota                          n      p50 ms   p95 ms   max ms");
  for (const [route, values] of [...samples.entries()].sort()) {
    console.log(
      `${route.padEnd(28)} ${String(values.length).padStart(5)}  ${percentile(values, 50).toFixed(1).padStart(8)} ${percentile(values, 95).toFixed(1).padStart(8)} ${Math.max(
        ...values,
      )
        .toFixed(1)
        .padStart(8)}`,
    );
  }
  console.log(
    `\nséries de métricas: ${before.series} → ${after.series} (cardinalidade não deve crescer com o número de usuários)`,
  );
  console.log(`RSS do processo: ${before.rssMb} MB → ${after.rssMb} MB`);
  const health = await fetch(`${BASE}/ready`)
    .then((r) => r.status)
    .catch(() => 0);
  console.log(`/ready após a carga: ${health}`);
  process.exit(errors === 0 && health === 200 ? 0 : 1);
}

main();
