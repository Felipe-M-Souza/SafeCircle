import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createTestApp } from "../helpers/app.js";
import { createCleaner, getTestDatabaseUrl } from "../helpers/test-db.js";
import { errorBodyWithoutRequestId } from "../helpers/errors.js";
import {
  authHeaders,
  decodeAccessToken,
  registerUser,
  sessionIdOf,
  signTestAccessToken,
} from "../helpers/auth.js";
import { drainOutbox } from "../helpers/outbox.js";
import { FakePushProvider } from "../../src/infrastructure/push/fake-push-provider.js";
import {
  ARGON2ID_HASH_PREFIX,
  hashPassword,
  isArgon2idHash,
} from "../../src/modules/auth/password.js";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../../src/modules/auth/auth.schemas.js";
import { REFRESH_REUSE_GRACE_MS } from "../../src/modules/auth/auth.service.js";
import { metricValue } from "../../src/observability/metrics.js";

/**
 * Autenticação endurecida (Phase 11): política de senha, Argon2id,
 * anti-enumeração, freio por conta, rate limit por IP, rotação de refresh sob
 * concorrência, detecção de reuso, validação de sessão e claims do JWT.
 */
const cleaner = createCleaner();
let app: FastifyInstance;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
  await cleaner.close();
});
beforeEach(async () => {
  await cleaner.truncate();
});

const register = (payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/auth/register", payload });
const login = (instance: FastifyInstance, email: string, password: string) =>
  instance.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
const refresh = (instance: FastifyInstance, refreshToken: string) =>
  instance.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
const me = (instance: FastifyInstance, accessToken: string) =>
  instance.inject({
    method: "GET",
    url: "/me",
    headers: { authorization: `Bearer ${accessToken}` },
  });

async function buildIsolatedApp(options: Parameters<typeof buildApp>[0]) {
  const instance = await buildApp({
    logger: false,
    databaseUrl: getTestDatabaseUrl(),
    pushProvider: new FakePushProvider(),
    checkinSchedulerAutoStart: false,
    journeySchedulerAutoStart: false,
    outboxWorkerAutoStart: false,
    ...options,
  });
  await instance.ready();
  return instance;
}

describe("Política de senha", () => {
  const base = { name: "Pessoa", email: "pessoa@example.com" };

  it(`mínimo de ${PASSWORD_MIN_LENGTH} caracteres para senhas novas`, async () => {
    const short = await register({ ...base, password: "a".repeat(PASSWORD_MIN_LENGTH - 1) });
    expect(short.statusCode).toBe(400);
    expect(short.json().code).toBe("VALIDATION_ERROR");

    const ok = await register({ ...base, password: "b".repeat(PASSWORD_MIN_LENGTH) });
    expect(ok.statusCode).toBe(201);
  });

  it(`máximo explícito de ${PASSWORD_MAX_LENGTH}: acima disso é recusado, não truncado`, async () => {
    const tooLong = await register({ ...base, password: "c".repeat(PASSWORD_MAX_LENGTH + 1) });
    expect(tooLong.statusCode).toBe(400);

    const password = "d".repeat(PASSWORD_MAX_LENGTH);
    const ok = await register({ ...base, password });
    expect(ok.statusCode).toBe(201);
    // A senha inteira conta: uma variação só no último caractere não entra.
    const wrong = await login(app, base.email, `${password.slice(0, -1)}X`);
    expect(wrong.statusCode).toBe(401);
    expect((await login(app, base.email, password)).statusCode).toBe(200);
  });

  it("passphrase com espaços e acentos é aceita", async () => {
    const res = await register({ ...base, password: "minha avó fazia bolo às quintas" });
    expect(res.statusCode).toBe(201);
  });

  it("conta criada com a política antiga (8 caracteres) continua entrando", async () => {
    const legacyHash = await hashPassword("senha123");
    await cleaner.sql`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Antiga', 'antiga@example.com', ${legacyHash})
    `;
    const res = await login(app, "antiga@example.com", "senha123");
    expect(res.statusCode).toBe(200);
  });
});

describe("Argon2id", () => {
  it("o hash persistido é Argon2id com os parâmetros centralizados", async () => {
    const user = await registerUser(app);
    const [row] = await cleaner.sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE id = ${user.userId}
    `;
    expect(row?.password_hash.startsWith(ARGON2ID_HASH_PREFIX)).toBe(true);
    expect(isArgon2idHash(row?.password_hash ?? "")).toBe(true);
    expect(row?.password_hash).toContain("m=19456,t=2,p=1");
  });

  it("hash nunca aparece em respostas de auth", async () => {
    const res = await register({
      name: "Pessoa",
      email: "hash@example.com",
      password: "x".repeat(16),
    });
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("argon2");
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("password_hash");
  });
});

describe("Login anti-enumeração", () => {
  it("e-mail inexistente e senha errada produzem a mesma resposta", async () => {
    const user = await registerUser(app);
    const missing = await login(app, `nao-existe-${randomUUID()}@example.com`, user.password);
    const wrong = await login(app, user.email, `${user.password}-errada`);
    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(errorBodyWithoutRequestId(missing)).toEqual(errorBodyWithoutRequestId(wrong));
    expect(missing.json().code).toBe("INVALID_CREDENTIALS");
  });

  it("timing entre conta existente e inexistente fica na mesma ordem de grandeza", async () => {
    const user = await registerUser(app);
    const measure = async (email: string) => {
      const started = process.hrtime.bigint();
      await login(app, email, "senha-definitivamente-errada");
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    // Aquece o hash "dummy" antes de medir.
    await measure("aquecimento@example.com");
    const samples = { existing: [] as number[], missing: [] as number[] };
    for (let i = 0; i < 3; i += 1) {
      samples.existing.push(await measure(user.email));
      samples.missing.push(await measure(`ausente-${i}@example.com`));
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[1] ?? 0;
    const existing = median(samples.existing);
    const missing = median(samples.missing);
    // Ambos pagam um Argon2: a diferença não pode ser de uma ordem de grandeza.
    expect(Math.max(existing, missing) / Math.max(1, Math.min(existing, missing))).toBeLessThan(5);
  });
});

describe("Credential stuffing e força bruta", () => {
  it("freio por conta: após N falhas a conta é recusada mesmo com a senha certa, e volta sozinha", async () => {
    let now = Date.now();
    const throttled = await buildIsolatedApp({
      loginThrottle: { maxFailures: 3, windowMs: 60_000, blockMs: 60_000, now: () => now },
    });
    try {
      const user = await registerUser(throttled);
      const other = await registerUser(throttled);
      const before = await metricValue("safecircle_auth_login_attempts_total", {
        result: "rate_limited",
      });

      for (let i = 0; i < 3; i += 1) {
        expect((await login(throttled, user.email, "errada-errada-errada")).statusCode).toBe(401);
      }
      const blocked = await login(throttled, user.email, user.password);
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe("RATE_LIMITED");
      expect(
        await metricValue("safecircle_auth_login_attempts_total", { result: "rate_limited" }),
      ).toBe(before + 1);

      // Outra conta não é afetada (sem lockout colateral).
      expect((await login(throttled, other.email, other.password)).statusCode).toBe(200);

      // Sem lockout permanente: passado o bloqueio, a conta volta.
      now += 61_000;
      expect((await login(throttled, user.email, user.password)).statusCode).toBe(200);
    } finally {
      await throttled.close();
    }
  });

  it("rate limit por IP no login responde 429 RATE_LIMITED", async () => {
    const strict = await buildIsolatedApp({ rateLimitProfile: "production" });
    try {
      const user = await registerUser(strict);
      let limited: number | null = null;
      for (let i = 0; i < 12; i += 1) {
        const res = await login(strict, user.email, "senha-errada-de-teste");
        if (res.statusCode === 429) {
          limited = i;
          expect(res.json().code).toBe("RATE_LIMITED");
          break;
        }
      }
      expect(limited).not.toBeNull();
      expect(
        await metricValue("safecircle_security_rate_limited_total", { route_group: "auth" }),
      ).toBeGreaterThan(0);
    } finally {
      await strict.close();
    }
  });
});

describe("Refresh token: rotação e reuso", () => {
  it("só o hash é persistido e ele não é o token", async () => {
    const user = await registerUser(app);
    const [row] = await cleaner.sql<{ refresh_token_hash: string }[]>`
      SELECT refresh_token_hash FROM auth_sessions WHERE id = ${sessionIdOf(user)}
    `;
    expect(row?.refresh_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.refresh_token_hash).not.toBe(user.refreshToken);
  });

  it("refresh concorrente com o mesmo token: exatamente um vence e a sessão continua viva", async () => {
    const user = await registerUser(app);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => refresh(app, user.refreshToken)),
    );
    const ok = results.filter((res) => res.statusCode === 200);
    const failed = results.filter((res) => res.statusCode === 401);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(4);
    for (const res of failed) expect(res.json().code).toBe("INVALID_REFRESH_TOKEN");

    // Corrida benigna: nada foi revogado; o vencedor segue funcionando.
    const winner = ok[0]!.json().refreshToken as string;
    expect((await refresh(app, winner)).statusCode).toBe(200);
    const [session] = await cleaner.sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM auth_sessions WHERE id = ${sessionIdOf(user)}
    `;
    expect(session?.revoked_at).toBeNull();
  });

  it("token antigo dentro da janela de graça é só recusado; fora dela revoga a sessão e audita", async () => {
    const user = await registerUser(app);
    const rotated = await refresh(app, user.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const fresh = rotated.json().refreshToken as string;

    // Dentro da janela: recusa genérica, sessão intacta.
    const early = await refresh(app, user.refreshToken);
    expect(early.statusCode).toBe(401);
    expect(early.json().code).toBe("INVALID_REFRESH_TOKEN");
    expect((await me(app, rotated.json().accessToken)).statusCode).toBe(200);

    // Fora da janela: reuso detectado.
    const before = await metricValue("safecircle_refresh_reuse_detected_total");
    await cleaner.sql`
      UPDATE auth_refresh_token_history
         SET rotated_at = now() - (${REFRESH_REUSE_GRACE_MS + 5_000} * interval '1 millisecond')
    `;
    const reuse = await refresh(app, user.refreshToken);
    expect(reuse.statusCode).toBe(401);
    // Resposta genérica: igual à de token inválido, nada confirma o reuso ao chamador.
    expect(reuse.json().code).toBe("INVALID_REFRESH_TOKEN");
    expect(await metricValue("safecircle_refresh_reuse_detected_total")).toBe(before + 1);

    const [session] = await cleaner.sql<{ revoked_at: Date | null; revoked_reason: string }[]>`
      SELECT revoked_at, revoked_reason FROM auth_sessions WHERE id = ${sessionIdOf(user)}
    `;
    expect(session?.revoked_at).not.toBeNull();
    expect(session?.revoked_reason).toBe("REFRESH_REUSE");

    // O token legítimo mais novo também morreu junto com a sessão.
    const afterRevoke = await refresh(app, fresh);
    expect(afterRevoke.statusCode).toBe(401);
    expect(afterRevoke.json().code).toBe("SESSION_REVOKED");
    expect((await me(app, rotated.json().accessToken)).statusCode).toBe(401);

    await drainOutbox(app);
    const [audit] = await cleaner.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_events
       WHERE event_type = 'AUTH_REFRESH_REUSE_DETECTED' AND target_id = ${sessionIdOf(user)}
    `;
    expect(audit?.count).toBe(1);
  });

  it("o histórico guarda só hashes e nunca o token", async () => {
    const user = await registerUser(app);
    await refresh(app, user.refreshToken);
    const rows = await cleaner.sql<
      { token_hash: string }[]
    >`SELECT token_hash FROM auth_refresh_token_history`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toBe(user.refreshToken);
  });
});

describe("Validação de sessão por requisição", () => {
  it("sessão revogada: o access token deixa de valer na hora", async () => {
    const user = await registerUser(app);
    expect((await me(app, user.accessToken)).statusCode).toBe(200);
    await cleaner.sql`UPDATE auth_sessions SET revoked_at = now() WHERE id = ${sessionIdOf(user)}`;
    const res = await me(app, user.accessToken);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("sessão expirada: o access token deixa de valer mesmo antes do exp do JWT", async () => {
    const user = await registerUser(app);
    await cleaner.sql`UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${sessionIdOf(user)}`;
    expect((await me(app, user.accessToken)).statusCode).toBe(401);
  });

  it("sid de sessão inexistente ou de outro usuário é recusado", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    const ghost = signTestAccessToken(app, { sub: a.userId, sid: randomUUID() });
    expect((await me(app, ghost)).statusCode).toBe(401);
    const crossed = signTestAccessToken(app, { sub: a.userId, sid: sessionIdOf(b) });
    expect((await me(app, crossed)).statusCode).toBe(401);
  });
});

describe("JWT: algoritmo e claims", () => {
  it("o access token não carrega dado pessoal", async () => {
    const user = await registerUser(app);
    const claims = decodeAccessToken(user.accessToken);
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "sid", "sub"]);
    expect(JSON.stringify(claims)).not.toContain(user.email);
    expect(JSON.stringify(claims)).not.toContain(user.name);
  });

  it("alg=none é recusado", async () => {
    const user = await registerUser(app);
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const [, payload] = user.accessToken.split(".");
    const forged = `${b64({ alg: "none", typ: "JWT" })}.${payload}.`;
    expect((await me(app, forged)).statusCode).toBe(401);
  });

  it("issuer ou audience diferentes são recusados", async () => {
    const user = await registerUser(app);
    const claims = { sub: user.userId, sid: sessionIdOf(user) };
    const badIss = signTestAccessToken(app, claims, { iss: "outro-emissor" });
    const badAud = signTestAccessToken(app, claims, { aud: "outra-audiencia" });
    expect((await me(app, badIss)).statusCode).toBe(401);
    expect((await me(app, badAud)).statusCode).toBe(401);
  });

  it("claims obrigatórias ausentes ou malformadas são recusadas", async () => {
    const user = await registerUser(app);
    // Sem iss/aud (assinado direto, sem os padrões).
    const bare = app.jwt.sign({ sub: user.userId, sid: sessionIdOf(user) }, { expiresIn: "5m" });
    expect((await me(app, bare)).statusCode).toBe(401);
    // Sem sid.
    const noSid = app.jwt.sign({ sub: user.userId } as unknown as { sub: string; sid: string }, {
      expiresIn: "5m",
      iss: "safecircle",
      aud: "safecircle-app",
    });
    expect((await me(app, noSid)).statusCode).toBe(401);
    // sid que não é UUID.
    const badSid = signTestAccessToken(app, { sub: user.userId, sid: "sessao" });
    expect((await me(app, badSid)).statusCode).toBe(401);
  });

  it("token assinado com outro segredo é recusado", async () => {
    const other = await buildIsolatedApp({});
    try {
      const user = await registerUser(app);
      // A app isolada usa o mesmo segredo de teste; forjamos alterando a assinatura.
      const [header, payload, signature] = user.accessToken.split(".");
      const tampered = `${header}.${payload}.${signature!.slice(0, -2)}AA`;
      expect((await me(app, tampered)).statusCode).toBe(401);
      expect((await me(other, tampered)).statusCode).toBe(401);
    } finally {
      await other.close();
    }
  });
});

describe("Logout", () => {
  it("revoga com motivo LOGOUT e o access token da sessão para de valer", async () => {
    const user = await registerUser(app);
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      payload: { refreshToken: user.refreshToken },
    });
    expect(res.statusCode).toBe(204);
    const [row] = await cleaner.sql<{ revoked_reason: string }[]>`
      SELECT revoked_reason FROM auth_sessions WHERE id = ${sessionIdOf(user)}
    `;
    expect(row?.revoked_reason).toBe("LOGOUT");
    expect((await me(app, user.accessToken)).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/me", headers: authHeaders(user) })).statusCode,
    ).toBe(401);
  });
});
