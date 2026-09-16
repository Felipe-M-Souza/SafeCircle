import { randomUUID } from "node:crypto";

/**
 * Smoke test da API (Phase 12): `pnpm smoke:api`.
 *
 * Suíte curta, para rodar depois de cada deploy/RC contra uma API já em
 * execução (`SMOKE_API_URL`, padrão http://localhost:3000). Percorre o caminho
 * crítico com uma conta **sintética criada e apagada na própria execução**:
 *
 *   health → ready → register → login → grupo → alerta → resolve → logout →
 *   login de novo → exclusão da conta
 *
 * Sem push token, sem coordenada, sem dado real. Exit code ≠ 0 em qualquer
 * falha, nomeando a etapa. Alvo: menos de 10 segundos.
 */

const BASE_URL = (process.env.SMOKE_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const PASSWORD = `smoke-${randomUUID()}`;

interface Step {
  name: string;
  run: () => Promise<void>;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; idempotencyKey?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const email = `smoke.${Date.now().toString(36)}@safecircle.test`;
  let accessToken = "";
  let refreshToken = "";
  let groupId = "";
  let alertId = "";

  const steps: Step[] = [
    {
      name: "health",
      run: async () => {
        const res = await call("GET", "/health");
        expect(
          res.status === 200 && res.json?.status === "ok",
          `esperado 200 ok, veio ${res.status}`,
        );
      },
    },
    {
      name: "ready",
      run: async () => {
        const res = await call("GET", "/ready");
        expect(
          res.status === 200,
          `esperado 200, veio ${res.status} (${JSON.stringify(res.json)})`,
        );
      },
    },
    {
      name: "register",
      run: async () => {
        const res = await call("POST", "/auth/register", {
          body: { name: "Smoke Test", email, password: PASSWORD },
        });
        expect(res.status === 201, `esperado 201, veio ${res.status}`);
        accessToken = res.json?.accessToken as string;
      },
    },
    {
      name: "login",
      run: async () => {
        const res = await call("POST", "/auth/login", { body: { email, password: PASSWORD } });
        expect(res.status === 200, `esperado 200, veio ${res.status}`);
        accessToken = res.json?.accessToken as string;
        refreshToken = res.json?.refreshToken as string;
      },
    },
    {
      name: "create group",
      run: async () => {
        const res = await call("POST", "/groups", { token: accessToken, body: { name: "Smoke" } });
        expect(res.status === 201, `esperado 201, veio ${res.status}`);
        groupId = res.json?.id as string;
      },
    },
    {
      name: "create alert",
      run: async () => {
        const res = await call("POST", "/alerts", {
          token: accessToken,
          body: { groupId },
          idempotencyKey: randomUUID(),
        });
        expect(
          res.status === 201 && res.json?.status === "ACTIVE",
          `esperado 201 ACTIVE, veio ${res.status}`,
        );
        alertId = res.json?.id as string;
      },
    },
    {
      name: "resolve alert",
      run: async () => {
        const res = await call("POST", `/alerts/${alertId}/resolve`, { token: accessToken });
        expect(
          res.status === 200 && res.json?.status === "RESOLVED",
          `esperado RESOLVED, veio ${res.status}`,
        );
      },
    },
    {
      name: "logout",
      run: async () => {
        const res = await call("POST", "/auth/logout", { body: { refreshToken } });
        expect(res.status === 204, `esperado 204, veio ${res.status}`);
        const me = await call("GET", "/me", { token: accessToken });
        expect(me.status === 401, `token deveria estar morto após logout, veio ${me.status}`);
      },
    },
    {
      name: "login again + delete account (limpeza)",
      run: async () => {
        const login = await call("POST", "/auth/login", { body: { email, password: PASSWORD } });
        expect(login.status === 200, `esperado 200, veio ${login.status}`);
        const del = await call("POST", "/me/delete-account", {
          token: login.json?.accessToken as string,
          body: { password: PASSWORD },
        });
        expect(
          del.status === 204,
          `esperado 204 na exclusão, veio ${del.status} (${JSON.stringify(del.json)})`,
        );
        const again = await call("POST", "/auth/login", { body: { email, password: PASSWORD } });
        expect(again.status === 401, `conta apagada não pode logar, veio ${again.status}`);
      },
    },
  ];

  console.log(`Smoke API → ${BASE_URL}`);
  const startedAt = Date.now();
  let failed = false;
  for (const step of steps) {
    const t0 = Date.now();
    try {
      await step.run();
      console.log(`  PASS  ${step.name} (${Date.now() - t0} ms)`);
    } catch (error) {
      failed = true;
      console.error(
        `  FAIL  ${step.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      break;
    }
  }
  console.log(`${failed ? "FALHOU" : "OK"} em ${Date.now() - startedAt} ms`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("Smoke falhou:", error instanceof Error ? error.message : error);
  process.exit(1);
});
