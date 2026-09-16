import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import WebSocket from "ws";
import { runMigrations } from "../src/infrastructure/database/migrate.js";

/**
 * Harness E2E (Phase 12).
 *
 * Sobe o **processo real** da API (`src/server.ts`, via tsx) sobre um banco
 * PostgreSQL descartável e conversa com ele por HTTP e WebSocket, como o app
 * faria. Nada aqui usa `app.inject`: se o worker da outbox, os schedulers ou o
 * shutdown quebrarem, é aqui que aparece.
 *
 * Dados sempre sintéticos: e-mails `*.e2e@safecircle.test`, coordenadas
 * fictícias, nenhum push token real (o provedor é `noop`).
 */

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);

export const E2E_PASSWORD = "senha-e2e-segura-123";
const DEFAULT_URL = "postgres://safecircle:safecircle@localhost:5432/safecircle";

/** Coordenadas sintéticas (oceano), nunca um endereço. */
export const SYNTHETIC_POINT = { latitude: -10.5, longitude: -30.25, accuracy: 12 };

export function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** URL do banco E2E, derivada de `DATABASE_URL` (mesmo servidor, banco próprio). */
export function e2eDatabaseUrl(name = "safecircle_e2e"): string {
  if (process.env.E2E_DATABASE_URL && name === "safecircle_e2e") {
    return process.env.E2E_DATABASE_URL;
  }
  return withDatabase(process.env.DATABASE_URL ?? DEFAULT_URL, name);
}

/** Cria (se preciso) e migra o banco. Idempotente. */
export async function ensureDatabase(url: string): Promise<void> {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (!/^[a-zA-Z0-9_]+$/.test(dbName)) {
    throw new Error(`Nome de banco E2E inválido: ${dbName}`);
  }
  const admin = postgres(withDatabase(url, "postgres"), { max: 1 });
  try {
    const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (existing.length === 0) {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  await runMigrations(url);
}

export const ALL_TABLES = [
  "outbox_events",
  "audit_events",
  "journey_location_updates",
  "journey_location_sessions",
  "safe_journeys",
  "safety_checkins",
  "alert_location_updates",
  "alert_location_sessions",
  "alert_acknowledgements",
  "push_devices",
  "alert_locations",
  "emergency_alerts",
  "idempotency_keys",
  "group_invitations",
  "group_memberships",
  "trusted_groups",
  "auth_refresh_token_history",
  "auth_sessions",
  "users",
];

/** Apaga todos os dados (não o schema). Só em bancos E2E. */
export async function resetDatabase(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`TRUNCATE TABLE ${ALL_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function sqlClient(url: string): postgres.Sql {
  return postgres(url, { max: 2 });
}

// ------------------------------------------------------------------
// Processo da API
// ------------------------------------------------------------------

/** Ambiente padrão do E2E: perto de produção, mas rápido e sem provedores reais. */
export const API_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  RATE_LIMIT_PROFILE: "relaxed",
  SCHEDULER_POLL_INTERVAL_MS: "1000",
  OUTBOX_POLL_INTERVAL_MS: "100",
  OUTBOX_ENABLED: "true",
  PUSH_PROVIDER: "noop",
  METRICS_ENABLED: "true",
  APP_VERSION: "0.1.0-rc.1",
  GIT_SHA: "e2e",
};

export interface ApiProcess {
  url: string;
  port: number;
  /** Tudo que o processo escreveu (JSON por linha) — para asserções de log. */
  logs: () => string;
  stop: () => Promise<void>;
}

export interface StartApiOptions {
  port: number;
  databaseUrl: string;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

export async function startApi(options: StartApiOptions): Promise<ApiProcess> {
  const tsxCli = require_.resolve("tsx/cli");
  const output: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...API_ENV_DEFAULTS,
    ...options.env,
    PORT: String(options.port),
    DATABASE_URL: options.databaseUrl,
  };
  // O E2E não deve herdar um `.env` local com credenciais reais.
  delete env.EXPO_ACCESS_TOKEN;

  const child: ChildProcess = spawn(process.execPath, [tsxCli, "src/server.ts"], {
    cwd: API_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const url = `http://127.0.0.1:${options.port}`;
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));

  const deadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
  let ready = false;
  while (!ready && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${url}/ready`);
      ready = res.status === 200;
    } catch {
      // ainda subindo
    }
    if (!ready) await sleep(150);
  }
  if (!ready) {
    child.kill();
    throw new Error(`API não ficou pronta em ${url}.\n${output.join("")}`);
  }

  return {
    url,
    port: options.port,
    logs: () => output.join(""),
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([exited, sleep(15_000)]);
      }
    },
  };
}

// ------------------------------------------------------------------
// Cliente HTTP
// ------------------------------------------------------------------

export interface E2eResponse<T = unknown> {
  status: number;
  headers: Headers;
  json: T;
}

export interface E2eUser {
  id: string;
  name: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

let counter = 0;
export function uniqueEmail(prefix = "pessoa"): string {
  counter += 1;
  return `${prefix}.${Date.now().toString(36)}${counter}.e2e@safecircle.test`;
}

export class E2eClient {
  constructor(readonly baseUrl: string) {}

  async call<T = unknown>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      token?: string;
      headers?: Record<string, string>;
      idempotencyKey?: string;
    } = {},
  ): Promise<E2eResponse<T>> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, headers: res.headers, json: json as T };
  }

  async register(name = "Pessoa E2E", email = uniqueEmail()): Promise<E2eUser> {
    const res = await this.call<{
      user: { id: string; name: string; email: string };
      accessToken: string;
      refreshToken: string;
    }>("POST", "/auth/register", { body: { name, email, password: E2E_PASSWORD } });
    if (res.status !== 201) {
      throw new Error(`Registro falhou: ${res.status} ${JSON.stringify(res.json)}`);
    }
    return {
      id: res.json.user.id,
      name,
      email,
      password: E2E_PASSWORD,
      accessToken: res.json.accessToken,
      refreshToken: res.json.refreshToken,
    };
  }

  async login(
    email: string,
    password: string,
  ): Promise<
    E2eResponse<{
      user: { id: string };
      accessToken: string;
      refreshToken: string;
    }>
  > {
    return this.call("POST", "/auth/login", { body: { email, password } });
  }

  /** Cria um grupo e adiciona os membros via convite + aceite. */
  async createGroupWith(owner: E2eUser, name: string, members: E2eUser[] = []): Promise<string> {
    const group = await this.call<{ id: string }>("POST", "/groups", {
      token: owner.accessToken,
      body: { name },
    });
    if (group.status !== 201) throw new Error(`Grupo falhou: ${group.status}`);
    for (const member of members) {
      const invitation = await this.call<{ id: string }>(
        "POST",
        `/groups/${group.json.id}/invitations`,
        { token: owner.accessToken, body: { email: member.email } },
      );
      if (invitation.status !== 201) throw new Error(`Convite falhou: ${invitation.status}`);
      const accept = await this.call("POST", `/me/group-invitations/${invitation.json.id}/accept`, {
        token: member.accessToken,
      });
      if (accept.status !== 200) throw new Error(`Aceite falhou: ${accept.status}`);
    }
    return group.json.id;
  }
}

// ------------------------------------------------------------------
// WebSocket
// ------------------------------------------------------------------

export interface WsClient {
  events: Array<Record<string, unknown>>;
  waitFor: (
    predicate: (event: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  waitForClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
  close: () => Promise<void>;
  send: (payload: string) => void;
}

export function connectWs(
  baseUrl: string,
  token?: string,
  extraHeaders: Record<string, string> = {},
): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/realtime`, { headers });
    const events: Array<Record<string, unknown>> = [];
    const waiters = new Set<() => void>();
    let closed: { code: number; reason: string } | null = null;
    const closeWaiters = new Set<() => void>();

    socket.on("message", (data) => {
      events.push(JSON.parse(data.toString()) as Record<string, unknown>);
      for (const waiter of waiters) waiter();
    });
    socket.on("close", (code, reason) => {
      closed = { code, reason: reason.toString() };
      for (const waiter of closeWaiters) waiter();
    });
    socket.on("unexpected-response", (_req, res) => {
      reject(new Error(`Handshake rejeitado: ${res.statusCode}`));
      socket.terminate();
    });
    socket.on("error", (error) => reject(error));
    socket.on("open", () => {
      resolve({
        events,
        send: (payload) => socket.send(payload),
        waitFor(predicate, timeoutMs = 10_000) {
          return new Promise((resolveEvent, rejectEvent) => {
            const check = () => {
              const found = events.find(predicate);
              if (found) {
                waiters.delete(check);
                clearTimeout(timer);
                resolveEvent(found);
              }
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              rejectEvent(new Error("Tempo esgotado aguardando evento realtime."));
            }, timeoutMs);
            waiters.add(check);
            check();
          });
        },
        waitForClose(timeoutMs = 10_000) {
          return new Promise((resolveClose, rejectClose) => {
            if (closed) return resolveClose(closed);
            const timer = setTimeout(() => {
              closeWaiters.delete(onClose);
              rejectClose(new Error("Tempo esgotado aguardando fechamento."));
            }, timeoutMs);
            const onClose = () => {
              clearTimeout(timer);
              closeWaiters.delete(onClose);
              resolveClose(closed!);
            };
            closeWaiters.add(onClose);
          });
        },
        close: () =>
          new Promise<void>((resolveClose) => {
            if (socket.readyState === WebSocket.CLOSED) return resolveClose();
            socket.once("close", () => resolveClose());
            socket.close();
          }),
      });
    });
  });
}

// ------------------------------------------------------------------
// Utilitários
// ------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error("Tempo esgotado aguardando condição.");
}

export function decodeJwt(token: string): Record<string, unknown> {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}
