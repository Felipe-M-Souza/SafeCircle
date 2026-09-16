import Constants from "expo-constants";

/**
 * Metadados de build exibidos na tela inicial (Phase 12).
 *
 * Tudo aqui é público por definição: versão do app (do `app.json`), ambiente
 * (`EXPO_PUBLIC_APP_ENV`: development | preview | production) e, quando a
 * build injeta, o commit curto. Nunca um segredo — `EXPO_PUBLIC_*` vai para o
 * bundle e é legível por qualquer pessoa com o APK/IPA.
 */
export type AppEnvironment = "development" | "preview" | "production";

const KNOWN_ENVIRONMENTS: readonly AppEnvironment[] = ["development", "preview", "production"];

export function appEnvironment(): AppEnvironment {
  const raw = process.env.EXPO_PUBLIC_APP_ENV;
  return (KNOWN_ENVIRONMENTS as readonly string[]).includes(raw ?? "")
    ? (raw as AppEnvironment)
    : "development";
}

export function appVersion(): string {
  return Constants.expoConfig?.version ?? "0.0.0";
}

export function gitSha(): string | null {
  const raw = process.env.EXPO_PUBLIC_GIT_SHA;
  return raw && /^[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(0, 7) : null;
}

/** Ex.: "SafeCircle 0.1.0 · preview · a1b2c3d". Em produção o ambiente é omitido. */
export function buildInfoLabel(): string {
  const env = appEnvironment();
  const parts = [`SafeCircle ${appVersion()}`];
  if (env !== "production") parts.push(env);
  const sha = gitSha();
  if (sha) parts.push(sha);
  return parts.join(" · ");
}
