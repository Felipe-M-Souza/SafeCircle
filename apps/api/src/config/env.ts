import { z } from "zod";
import { isValidOrigin, parseOriginList, splitOriginList } from "../security/origins.js";

/**
 * Validação centralizada das variáveis de ambiente da API.
 * Tudo que é entrada não confiável (inclusive o ambiente) deve ser validado.
 *
 * Phase 11: em produção a configuração é **fail-fast**. Subir com segredo
 * fraco, sem banco, com CORS inválido ou com métricas abertas é pior do que
 * não subir — o processo recusa iniciar e diz exatamente qual variável.
 * Nenhum valor de segredo aparece nas mensagens.
 */

// Segredo explícito de desenvolvimento/testes. NUNCA usar em produção:
// em produção o segredo é obrigatório e validado abaixo.
const DEV_JWT_ACCESS_SECRET = "dev-only-insecure-jwt-access-secret-change-me";

export const JWT_SECRET_MIN_LENGTH = 32;

/** Trechos que denunciam placeholder copiado do `.env.example` ou de tutorial. */
const PLACEHOLDER_FRAGMENTS = [
  "changeme",
  "change-me",
  "change_me",
  "placeholder",
  "example",
  "insecure",
  "dev-only",
  "secret123",
  "password",
  "your-secret",
  "todo",
];

/**
 * Segredo fraco: curto, igual ao de desenvolvimento, com pouca variedade de
 * caracteres ou contendo um placeholder óbvio. Heurística, não prova de
 * entropia — o suficiente para barrar o erro operacional comum.
 */
export function isWeakSecret(secret: string): boolean {
  if (secret.length < JWT_SECRET_MIN_LENGTH) return true;
  if (secret === DEV_JWT_ACCESS_SECRET) return true;
  if (new Set(secret).size < 8) return true;
  const lower = secret.toLowerCase();
  return PLACEHOLDER_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

// Trata strings vazias (comuns em `.env.example`) como "não definidas".
const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const booleanFlag = (defaultValue: "true" | "false") =>
  z.preprocess(
    emptyToUndefined,
    z
      .enum(["true", "false", "1", "0"])
      .default(defaultValue)
      .transform((value) => value === "true" || value === "1"),
  );

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default("0.0.0.0"),
    // Opcional fora de produção: a API sobe e responde /health mesmo sem banco.
    DATABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

    // Autenticação (Phase 1)
    JWT_ACCESS_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    JWT_ACCESS_TTL: z.preprocess(emptyToUndefined, z.string().min(1).default("15m")),
    REFRESH_TOKEN_TTL_DAYS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().max(365).default(30),
    ),

    // Origens web permitidas (Phase 11): allow-list explícita, sem wildcard.
    // `CORS_ORIGINS` é o nome antigo (Phase 1), aceito por compatibilidade.
    CORS_ALLOWED_ORIGINS: z.preprocess(emptyToUndefined, z.string().optional()),
    CORS_ORIGINS: z.preprocess(emptyToUndefined, z.string().optional()),

    // HSTS só onde o HTTPS externo é garantido pelo ingress/proxy.
    HSTS_ENABLED: booleanFlag("false"),
    // `false` (padrão), `true` (todos os proxies) ou número de saltos confiáveis.
    TRUST_PROXY: z.preprocess(emptyToUndefined, z.string().default("false")),

    // Notificações push (Phase 4): token de acesso opcional da Expo Push API.
    // Segredo do backend — NUNCA versionar nem expor ao app.
    EXPO_ACCESS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    // Phase 12: `noop` para E2E/staging sem credenciais — recusado em produção.
    PUSH_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["expo", "noop"]).default("expo")),

    // Phase 13 — e-mail transacional (convites). `noop` registra e descarta:
    // o convite continua visível no app, só não sai aviso por e-mail.
    // `resend`: API HTTP (porta 443). Necessário onde a hospedagem bloqueia
    // SMTP de saída — é o caso do Railway fora do plano Pro.
    EMAIL_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(["resend", "smtp", "noop"]).default("noop"),
    ),
    RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().min(8).optional()),
    SMTP_HOST: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
    SMTP_SECURE: booleanFlag("false"),
    SMTP_USER: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    SMTP_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
    /** Remetente: `Nome <endereco>` ou só o endereço. */
    EMAIL_FROM: z.preprocess(
      emptyToUndefined,
      z.string().min(3).default("SafeCircle <nao-responda@safecircle.invalid>"),
    ),
    /**
     * Endereço do site, usado como destino clicável dos e-mails.
     *
     * O convite chega para quem normalmente **não** tem o aplicativo, então um
     * link `safecircle://` não leva a lugar nenhum. Pior: esquema fora de
     * http(s) dentro de um `<a>` é sinal de spam para vários filtros, e os
     * primeiros convites foram parar na lixeira.
     */
    APP_SITE_URL: z.preprocess(
      emptyToUndefined,
      z.string().url().default("https://safecircle.softechconsulting.com.br"),
    ),
    /** Para onde vão as respostas; o remetente é uma caixa que não existe. */
    EMAIL_REPLY_TO: z.preprocess(emptyToUndefined, z.string().email().optional()),

    // Observabilidade (Phase 9).
    // /metrics é desligado por padrão: só existe quando explicitamente habilitado.
    METRICS_ENABLED: booleanFlag("false"),
    // Bearer exigido em /metrics quando definido. Segredo — NUNCA versionar.
    METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
    // Identificação da build (valores públicos, não são secrets).
    APP_VERSION: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
    GIT_SHA: z.preprocess(emptyToUndefined, z.string().max(64).optional()),
    BUILD_DATE: z.preprocess(emptyToUndefined, z.string().max(64).optional()),

    // Phase 12 — ambiente E2E. Nunca válidos em produção: `production` ignora
    // o perfil relaxado, e o intervalo tem piso de 1 s.
    RATE_LIMIT_PROFILE: z.preprocess(
      emptyToUndefined,
      z.enum(["production", "relaxed"]).optional(),
    ),
    SCHEDULER_POLL_INTERVAL_MS: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(1_000).max(300_000).default(15_000),
    ),

    // Outbox transacional (Phase 10). Limites impostos aqui para que uma
    // configuração errada não vire busy loop nem lote gigante em produção.
    OUTBOX_ENABLED: booleanFlag("true"),
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
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    // Origens: válidas em qualquer ambiente (erro de digitação não pode virar
    // "nenhuma origem funciona" só em produção). Validamos a entrada BRUTA:
    // a normalização descartaria um path digitado por engano.
    const origins = splitOriginList(value.CORS_ALLOWED_ORIGINS ?? value.CORS_ORIGINS);
    for (const origin of origins) {
      if (!isValidOrigin(origin)) {
        issue(
          value.CORS_ALLOWED_ORIGINS ? "CORS_ALLOWED_ORIGINS" : "CORS_ORIGINS",
          "Cada origem deve ser `https://host[:porta]` (sem path nem wildcard).",
        );
        break;
      }
    }

    const trust = value.TRUST_PROXY.trim().toLowerCase();
    if (trust !== "true" && trust !== "false" && !/^\d{1,2}$/.test(trust)) {
      issue("TRUST_PROXY", "Use `true`, `false` ou o número de proxies confiáveis.");
    }

    // Provedor de e-mail mal configurado NÃO derruba a API: `selectEmailProvider`
    // avisa no log e cai para `noop`. Deixar o SOS fora do ar porque o convite
    // por e-mail está sem credencial seria a troca errada num app de emergência.

    if (value.NODE_ENV !== "production") return;

    // --- Produção: fail-fast ---
    if (!value.JWT_ACCESS_SECRET) {
      issue("JWT_ACCESS_SECRET", "JWT_ACCESS_SECRET é obrigatório em produção.");
    } else if (isWeakSecret(value.JWT_ACCESS_SECRET)) {
      issue(
        "JWT_ACCESS_SECRET",
        `JWT_ACCESS_SECRET fraco: use ao menos ${JWT_SECRET_MIN_LENGTH} caracteres aleatórios (nunca o valor de desenvolvimento nem placeholder).`,
      );
    }
    if (!value.DATABASE_URL) {
      issue("DATABASE_URL", "DATABASE_URL é obrigatória em produção.");
    }
    if (!value.OUTBOX_ENABLED) {
      issue(
        "OUTBOX_ENABLED",
        "Em produção a outbox precisa estar ligada: sem worker, push e auditoria ficam pendentes para sempre.",
      );
    }
    if (value.PUSH_PROVIDER !== "expo") {
      issue("PUSH_PROVIDER", "Em produção o provedor de push precisa ser `expo`.");
    }
    if (value.METRICS_ENABLED && !value.METRICS_TOKEN) {
      issue(
        "METRICS_TOKEN",
        "Em produção /metrics só pode ser habilitado com METRICS_TOKEN definido.",
      );
    }
  });

export type RateLimitProfile = "production" | "relaxed";

export interface Config {
  nodeEnv: "development" | "test" | "production";
  port: number;
  host: string;
  databaseUrl?: string;
  jwtAccessSecret: string;
  jwtAccessTtl: string;
  refreshTokenTtlDays: number;
  /** Origens web permitidas, normalizadas. Vazio = nenhuma origem web. */
  corsAllowedOrigins: string[];
  /**
   * Estrito: só a allow-list passa (CORS e WebSocket). Produção é sempre
   * estrita; dev/test relaxam para o app web local, a menos que a lista exista.
   */
  strictOrigins: boolean;
  hstsEnabled: boolean;
  trustProxy: boolean | number;
  /** Tetos de rate limit: relaxados em NODE_ENV=test, reais nos demais. */
  rateLimitProfile: RateLimitProfile;
  expoAccessToken?: string;
  /** `expo` em produção; `noop` só para E2E/staging sem credenciais. */
  pushProvider: "expo" | "noop";
  emailProvider: "resend" | "smtp" | "noop";
  resendApiKey: string | undefined;
  smtp: {
    host: string | undefined;
    port: number;
    secure: boolean;
    user: string | undefined;
    password: string | undefined;
  };
  emailFrom: string;
  appSiteUrl: string;
  emailReplyTo?: string;
  metricsEnabled: boolean;
  metricsToken?: string;
  appVersion?: string;
  gitSha?: string;
  buildDate?: string;
  /** Intervalo de polling dos schedulers de vencimento (ms). */
  schedulerPollIntervalMs: number;
  outboxEnabled: boolean;
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  outboxConcurrency: number;
  outboxLeaseMs: number;
}

let cachedConfig: Config | null = null;

/**
 * Lê e valida a configuração. `source` permite validar um ambiente arbitrário
 * (testes de fail-fast) sem tocar em `process.env`; nesse caso o resultado não
 * é cacheado.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Config {
  const fromProcess = source === process.env;
  if (fromProcess && cachedConfig) {
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
  const corsAllowedOrigins = parseOriginList(env.CORS_ALLOWED_ORIGINS ?? env.CORS_ORIGINS);
  const trust = env.TRUST_PROXY.trim().toLowerCase();

  const config: Config = {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    databaseUrl: env.DATABASE_URL,
    jwtAccessSecret: env.JWT_ACCESS_SECRET ?? DEV_JWT_ACCESS_SECRET,
    jwtAccessTtl: env.JWT_ACCESS_TTL,
    refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    corsAllowedOrigins,
    strictOrigins: env.NODE_ENV === "production" || corsAllowedOrigins.length > 0,
    hstsEnabled: env.HSTS_ENABLED,
    trustProxy: trust === "true" ? true : trust === "false" ? false : Number(trust),
    // Produção nunca relaxa. Fora dela, o E2E pode pedir `relaxed` explicitamente.
    rateLimitProfile:
      env.NODE_ENV === "production"
        ? "production"
        : (env.RATE_LIMIT_PROFILE ?? (env.NODE_ENV === "test" ? "relaxed" : "production")),
    expoAccessToken: env.EXPO_ACCESS_TOKEN,
    pushProvider: env.PUSH_PROVIDER,
    emailProvider: env.EMAIL_PROVIDER,
    resendApiKey: env.RESEND_API_KEY,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      password: env.SMTP_PASSWORD,
    },
    emailFrom: env.EMAIL_FROM,
    appSiteUrl: env.APP_SITE_URL,
    ...(env.EMAIL_REPLY_TO ? { emailReplyTo: env.EMAIL_REPLY_TO } : {}),
    metricsEnabled: env.METRICS_ENABLED,
    metricsToken: env.METRICS_TOKEN,
    appVersion: env.APP_VERSION,
    gitSha: env.GIT_SHA,
    buildDate: env.BUILD_DATE,
    schedulerPollIntervalMs: env.SCHEDULER_POLL_INTERVAL_MS,
    outboxEnabled: env.OUTBOX_ENABLED,
    outboxPollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
    outboxConcurrency: env.OUTBOX_CONCURRENCY,
    outboxLeaseMs: env.OUTBOX_LEASE_MS,
  };

  if (fromProcess) {
    cachedConfig = config;
  }
  return config;
}

/** Apenas para testes: limpa o cache de configuração. */
export function resetEnvCache(): void {
  cachedConfig = null;
}
