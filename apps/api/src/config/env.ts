import { z } from "zod";

/**
 * Validação centralizada das variáveis de ambiente da API.
 * Tudo que é entrada não confiável (inclusive o ambiente) deve ser validado.
 */

// Segredo explícito de desenvolvimento/testes. NUNCA usar em produção:
// em produção o segredo é obrigatório e validado abaixo.
const DEV_JWT_ACCESS_SECRET = "dev-only-insecure-jwt-access-secret-change-me";

// Trata strings vazias (comuns em `.env.example`) como "não definidas".
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default("0.0.0.0"),
    // Opcional: a API sobe e responde /health mesmo sem banco configurado.
    DATABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

    // Autenticação (Phase 1)
    JWT_ACCESS_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    JWT_ACCESS_TTL: z.preprocess(emptyToUndefined, z.string().min(1).default("15m")),
    REFRESH_TOKEN_TTL_DAYS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().default(30),
    ),

    // Origens permitidas para CORS em produção (lista separada por vírgula).
    // Em dev/test o CORS reflete a origem da requisição para facilitar o app web.
    CORS_ORIGINS: z.preprocess(emptyToUndefined, z.string().optional()),

    // Notificações push (Phase 4): token de acesso opcional da Expo Push API.
    // Segredo do backend — NUNCA versionar nem expor ao app.
    EXPO_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),

    // Observabilidade (Phase 9).
    // /metrics é desligado por padrão: só existe quando explicitamente habilitado.
    METRICS_ENABLED: z.preprocess(
      emptyToUndefined,
      z
        .enum(["true", "false", "1", "0"])
        .default("false")
        .transform((value) => value === "true" || value === "1"),
    ),
    // Bearer exigido em /metrics quando definido. Segredo — NUNCA versionar.
    METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
    // Identificação da build (valores públicos, não são secrets).
    APP_VERSION: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
    GIT_SHA: z.preprocess(emptyToUndefined, z.string().max(64).optional()),

    // Outbox transacional (Phase 10). Limites impostos aqui para que uma
    // configuração errada não vire busy loop nem lote gigante em produção.
    OUTBOX_ENABLED: z.preprocess(
      emptyToUndefined,
      z
        .enum(["true", "false", "1", "0"])
        .default("true")
        .transform((value) => value === "true" || value === "1"),
    ),
    OUTBOX_POLL_INTERVAL_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(100).max(60_000).default(500),
    ),
    OUTBOX_BATCH_SIZE: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(500).default(50),
    ),
    OUTBOX_CONCURRENCY: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1).max(50).default(5),
    ),
    OUTBOX_LEASE_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(5_000).max(600_000).default(60_000),
    ),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production") {
      if (!value.JWT_ACCESS_SECRET || value.JWT_ACCESS_SECRET.length < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["JWT_ACCESS_SECRET"],
          message: "JWT_ACCESS_SECRET é obrigatório em produção e deve ter ao menos 32 caracteres.",
        });
      }
    }
  });

export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  databaseUrl?: string;
  jwtAccessSecret: string;
  jwtAccessTtl: string;
  refreshTokenTtlDays: number;
  corsOrigins?: string[];
  expoAccessToken?: string;
  metricsEnabled: boolean;
  metricsToken?: string;
  appVersion?: string;
  gitSha?: string;
  outboxEnabled: boolean;
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  outboxConcurrency: number;
  outboxLeaseMs: number;
}

let cachedConfig: Config | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `- ${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Variáveis de ambiente inválidas:\n${issues}`);
  }

  const env = parsed.data;

  cachedConfig = {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    jwtAccessSecret: env.JWT_ACCESS_SECRET ?? DEV_JWT_ACCESS_SECRET,
    jwtAccessTtl: env.JWT_ACCESS_TTL,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    corsOrigins: env.CORS_ORIGINS?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    expoAccessToken: env.EXPO_ACCESS_TOKEN,
    metricsEnabled: env.METRICS_ENABLED,
    metricsToken: env.METRICS_TOKEN,
    appVersion: env.APP_VERSION,
    gitSha: env.GIT_SHA,
    outboxEnabled: env.OUTBOX_ENABLED,
    outboxPollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
    outboxConcurrency: env.OUTBOX_CONCURRENCY,
    outboxLeaseMs: env.OUTBOX_LEASE_MS,
  };

  return cachedConfig;
}

/** Apenas para testes: limpa o cache de configuração. */
export function resetEnvCache(): void {
  cachedConfig = null;
}
