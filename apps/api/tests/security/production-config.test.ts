import { describe, expect, it } from "vitest";
import { isWeakSecret, loadEnv } from "../../src/config/env.js";

/**
 * Fail-fast de produção (Phase 11). `loadEnv(source)` valida um ambiente
 * arbitrário sem tocar em `process.env` nem no cache.
 */

const STRONG_SECRET = "q7Zp3vX9mL2kR8tW5yB1nH4cJ6gF0dS2aU8eK3iO7pQ1";

function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://app:secret@db.internal:5432/safecircle",
    JWT_ACCESS_SECRET: STRONG_SECRET,
    CORS_ALLOWED_ORIGINS: "https://app.safecircle.example",
    OUTBOX_ENABLED: "true",
    METRICS_ENABLED: "false",
    ...overrides,
  };
}

describe("Configuração de produção — fail-fast", () => {
  it("configuração válida sobe", () => {
    const config = loadEnv(productionEnv());
    expect(config.nodeEnv).toBe("production");
    expect(config.strictOrigins).toBe(true);
    expect(config.corsAllowedOrigins).toEqual(["https://app.safecircle.example"]);
    expect(config.rateLimitProfile).toBe("production");
  });

  it("JWT secret ausente derruba o startup", () => {
    expect(() => loadEnv(productionEnv({ JWT_ACCESS_SECRET: undefined }))).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it("JWT secret fraco ou placeholder derruba o startup, sem imprimir o valor", () => {
    for (const weak of [
      "curto",
      "dev-only-insecure-jwt-access-secret-change-me",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "please-change-me-in-production-please-change-me",
      "this-is-an-example-secret-value-do-not-use-1234",
    ]) {
      let message = "";
      try {
        loadEnv(productionEnv({ JWT_ACCESS_SECRET: weak }));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/JWT_ACCESS_SECRET/);
      expect(message).not.toContain(weak);
    }
  });

  it("DATABASE_URL ausente derruba o startup", () => {
    expect(() => loadEnv(productionEnv({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL/);
  });

  it("outbox desligada em produção derruba o startup", () => {
    expect(() => loadEnv(productionEnv({ OUTBOX_ENABLED: "false" }))).toThrow(/OUTBOX_ENABLED/);
  });

  it("/metrics habilitado sem token em produção derruba o startup", () => {
    expect(() => loadEnv(productionEnv({ METRICS_ENABLED: "true" }))).toThrow(/METRICS_TOKEN/);
    expect(() =>
      loadEnv(productionEnv({ METRICS_ENABLED: "true", METRICS_TOKEN: "t0k3n-com-16-chars!" })),
    ).not.toThrow();
  });

  it("CORS inválido (wildcard, path, esquema estranho) é recusado em qualquer ambiente", () => {
    for (const bad of ["*", "https://app.example/path", "ftp://app.example", "app.example"]) {
      expect(() => loadEnv(productionEnv({ CORS_ALLOWED_ORIGINS: bad }))).toThrow(
        /CORS_ALLOWED_ORIGINS/,
      );
      expect(() =>
        loadEnv({ NODE_ENV: "development", CORS_ALLOWED_ORIGINS: bad } as NodeJS.ProcessEnv),
      ).toThrow(/CORS_ALLOWED_ORIGINS/);
    }
  });

  it("CORS_ORIGINS (nome antigo) continua aceito e vira a mesma allow-list", () => {
    const config = loadEnv(
      productionEnv({ CORS_ALLOWED_ORIGINS: undefined, CORS_ORIGINS: "https://web.example:8443" }),
    );
    expect(config.corsAllowedOrigins).toEqual(["https://web.example:8443"]);
  });

  it("TRUST_PROXY aceita true/false/número e recusa o resto", () => {
    expect(loadEnv(productionEnv({ TRUST_PROXY: "true" })).trustProxy).toBe(true);
    expect(loadEnv(productionEnv({ TRUST_PROXY: "2" })).trustProxy).toBe(2);
    expect(loadEnv(productionEnv()).trustProxy).toBe(false);
    expect(() => loadEnv(productionEnv({ TRUST_PROXY: "sim" }))).toThrow(/TRUST_PROXY/);
  });

  it("em desenvolvimento nada disso é obrigatório e as origens são relaxadas", () => {
    const config = loadEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(config.strictOrigins).toBe(false);
    expect(config.hstsEnabled).toBe(false);
    expect(config.rateLimitProfile).toBe("production");
    expect(loadEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv).rateLimitProfile).toBe("relaxed");
  });
});

describe("isWeakSecret", () => {
  it("aceita segredo longo e variado; recusa curto, repetitivo ou com placeholder", () => {
    expect(isWeakSecret(STRONG_SECRET)).toBe(false);
    expect(isWeakSecret("abc")).toBe(true);
    expect(isWeakSecret("abababababababababababababababababab")).toBe(true);
    expect(isWeakSecret(`${STRONG_SECRET}-CHANGEME`)).toBe(true);
  });
});
