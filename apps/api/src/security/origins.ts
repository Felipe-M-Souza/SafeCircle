/**
 * Allow-list de origens web (Phase 11).
 *
 * Usada em dois lugares com a mesma semântica: CORS (respostas a navegadores)
 * e o handshake do WebSocket. O `fetch` do app nativo não envia `Origin`, mas
 * o WebSocket do React Native (Android/OkHttp e iOS) envia `Origin` igual à
 * própria origem da API (`https://host` derivado da URL `wss://`); por isso a
 * origem da própria requisição é sempre aceita. A autenticação continua sendo
 * o Bearer, sempre. Origem permitida **não** substitui autenticação; origem
 * proibida só fecha a porta mais cedo.
 */

/** Origem é `scheme://host[:port]`, sem path, sem wildcard. */
export function isValidOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  if (value.includes("*")) return false;
  return url.origin === normalizeOrigin(value);
}

/** Forma canônica (`new URL(...).origin`), em minúsculas, sem barra final. */
export function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/** Entradas brutas (trim, sem vazios) da lista separada por vírgula — para validar. */
export function splitOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/** Divide a lista separada por vírgula, normalizando e removendo vazios. */
export function parseOriginList(raw: string | undefined): string[] {
  return splitOriginList(raw).map(normalizeOrigin);
}

export interface OriginPolicy {
  /** Origens permitidas, já normalizadas. */
  allowed: ReadonlySet<string>;
  /**
   * Estrito: `Origin` presente e fora da lista é recusada. Relaxado (dev/test
   * sem lista): qualquer origem passa, para não atrapalhar o app web local.
   */
  strict: boolean;
}

export function createOriginPolicy(allowedOrigins: string[], strict: boolean): OriginPolicy {
  return { allowed: new Set(allowedOrigins.map(normalizeOrigin)), strict };
}

/**
 * Decide se uma requisição com o header `Origin` informado pode prosseguir.
 * Sem header (fetch nativo, curl, server-to-server): sempre pode — a
 * autenticação é quem decide. `selfOrigin` é a origem da própria API nesta
 * requisição (`scheme://host[:port]`): um `Origin` idêntico a ela é
 * same-origin (caso do WebSocket do React Native) e passa mesmo em modo estrito.
 */
export function isOriginAllowed(
  policy: OriginPolicy,
  originHeader: unknown,
  selfOrigin?: string,
): boolean {
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (typeof origin !== "string" || origin === "") return true;
  if (!policy.strict) return true;
  const normalized = normalizeOrigin(origin);
  if (selfOrigin && normalized === normalizeOrigin(selfOrigin)) return true;
  return policy.allowed.has(normalized);
}
