import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../../config/env.js";
import type { EmailProvider } from "./email-provider.js";
import { NoopEmailProvider } from "./noop-email-provider.js";
import { ResendApiEmailProvider } from "./resend-api-email-provider.js";
import { SmtpEmailProvider } from "./smtp-email-provider.js";

/**
 * Escolhe a implementação de e-mail a partir da configuração (Phase 13).
 *
 * Regra central: **configuração de e-mail nunca derruba a API**. Se o provedor
 * pedido não tem credencial, o serviço sobe com `noop` e registra um aviso alto.
 * Num app de emergência, ficar sem SOS porque o convite por e-mail está mal
 * configurado seria a troca errada — o convite continua visível dentro do app.
 *
 * O aviso é explícito de propósito: silenciar levaria a descobrir meses depois
 * que nenhum convite chegou.
 */
export function selectEmailProvider(
  config: Pick<Config, "emailProvider" | "resendApiKey" | "smtp" | "emailFrom">,
  log: FastifyBaseLogger,
): EmailProvider {
  if (config.emailProvider === "resend") {
    if (!config.resendApiKey) {
      log.error(
        { event: "email_provider_misconfigured", requested: "resend", missing: "RESEND_API_KEY" },
        "EMAIL_PROVIDER=resend sem RESEND_API_KEY: nenhum e-mail será enviado",
      );
      return new NoopEmailProvider(log);
    }
    log.info({ event: "email_provider_selected", provider: "resend" }, "Provedor de e-mail ativo");
    return new ResendApiEmailProvider({
      apiKey: config.resendApiKey,
      from: config.emailFrom,
      log,
    });
  }

  if (config.emailProvider === "smtp") {
    if (!config.smtp.host) {
      log.error(
        { event: "email_provider_misconfigured", requested: "smtp", missing: "SMTP_HOST" },
        "EMAIL_PROVIDER=smtp sem SMTP_HOST: nenhum e-mail será enviado",
      );
      return new NoopEmailProvider(log);
    }
    log.info({ event: "email_provider_selected", provider: "smtp" }, "Provedor de e-mail ativo");
    return new SmtpEmailProvider({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user,
      password: config.smtp.password,
      from: config.emailFrom,
      log,
    });
  }

  log.info({ event: "email_provider_selected", provider: "noop" }, "Provedor de e-mail ativo");
  return new NoopEmailProvider(log);
}
