import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { selectEmailProvider } from "../src/infrastructure/email/select-email-provider.js";

/**
 * Configuração de e-mail nunca derruba a API (Phase 13).
 *
 * Um provedor sem credencial cai para `noop` com aviso alto, em vez de impedir
 * o boot. Num app de emergência, ficar sem SOS porque o convite por e-mail está
 * mal configurado seria a troca errada — e o convite segue visível no app.
 */
function fakeLog() {
  const entries: Array<{ level: string; payload: Record<string, unknown> }> = [];
  const record =
    (level: string) =>
    (payload: Record<string, unknown>): void => {
      entries.push({ level, payload });
    };
  const log = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
  } as unknown as FastifyBaseLogger;
  return { log, entries };
}

const base = {
  emailFrom: "SafeCircle <nao-responda@exemplo.invalid>",
  smtp: { host: undefined, port: 587, secure: false, user: undefined, password: undefined },
  resendApiKey: undefined,
} as const;

describe("selectEmailProvider", () => {
  it("resend sem chave: cai para noop e registra erro nomeando a variável", () => {
    const { log, entries } = fakeLog();
    const provider = selectEmailProvider({ ...base, emailProvider: "resend" }, log);

    expect(provider.name).toBe("noop");
    const error = entries.find((e) => e.level === "error");
    expect(error?.payload.event).toBe("email_provider_misconfigured");
    expect(error?.payload.missing).toBe("RESEND_API_KEY");
  });

  it("smtp sem host: cai para noop e registra erro nomeando a variável", () => {
    const { log, entries } = fakeLog();
    const provider = selectEmailProvider({ ...base, emailProvider: "smtp" }, log);

    expect(provider.name).toBe("noop");
    expect(entries.find((e) => e.level === "error")?.payload.missing).toBe("SMTP_HOST");
  });

  it("resend com chave: usa a API HTTP", () => {
    const { log, entries } = fakeLog();
    const provider = selectEmailProvider(
      { ...base, emailProvider: "resend", resendApiKey: "re_chave_sintetica_0001" },
      log,
    );

    expect(provider.name).toBe("resend");
    expect(entries.some((e) => e.level === "error")).toBe(false);
    expect(
      entries.find((e) => e.payload.event === "email_provider_selected")?.payload.provider,
    ).toBe("resend");
  });

  it("smtp com host: usa SMTP", () => {
    const { log } = fakeLog();
    const provider = selectEmailProvider(
      { ...base, emailProvider: "smtp", smtp: { ...base.smtp, host: "smtp.exemplo.invalid" } },
      log,
    );
    expect(provider.name).toBe("smtp");
  });

  it("noop explícito não registra erro: é uma escolha válida", () => {
    const { log, entries } = fakeLog();
    const provider = selectEmailProvider({ ...base, emailProvider: "noop" }, log);

    expect(provider.name).toBe("noop");
    expect(entries.some((e) => e.level === "error")).toBe(false);
  });

  it("nenhuma escolha registra a credencial no log", () => {
    const { log, entries } = fakeLog();
    selectEmailProvider(
      { ...base, emailProvider: "resend", resendApiKey: "re_segredo_que_nao_pode_vazar" },
      log,
    );
    expect(JSON.stringify(entries)).not.toContain("re_segredo_que_nao_pode_vazar");
  });
});
