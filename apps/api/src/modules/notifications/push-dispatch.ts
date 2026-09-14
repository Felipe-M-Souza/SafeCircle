import { and, eq, inArray, ne } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../infrastructure/database/client.js";
import { groupMemberships, pushDevices } from "../../infrastructure/database/schema.js";
import type { PushMessage, PushProvider } from "../../infrastructure/push/push-provider.js";
import {
  pushDispatchTotal,
  pushDuration,
  pushFailuresTotal,
  pushInvalidTokensTotal,
  pushMessagesTotal,
  safeLabel,
} from "../../observability/metrics.js";

/**
 * Entrega de push a membros de um grupo (Phases 4/7).
 *
 * - Destinatários em uma única consulta: tokens ativos dos membros atuais do
 *   grupo, excluindo um usuário (o autor), deduplicados por token.
 * - Tokens definitivamente inválidos (DeviceNotRegistered) são desativados;
 *   erros transitórios mantêm o token. Logs só com contagens — nunca tokens.
 */
export interface PushDispatchContext {
  db: Database;
  pushProvider: PushProvider;
  log: FastifyBaseLogger;
}

export interface PushDispatchSummary {
  recipients: number;
  sent: number;
  failed: number;
  invalidToken: number;
}

export async function loadGroupRecipientTokens(
  db: Database,
  groupId: string,
  excludeUserId: string,
): Promise<string[]> {
  const rows = await db
    .select({ token: pushDevices.token })
    .from(pushDevices)
    .innerJoin(
      groupMemberships,
      and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, pushDevices.userId)),
    )
    .where(and(eq(pushDevices.isActive, true), ne(pushDevices.userId, excludeUserId)));
  return [...new Set(rows.map((row) => row.token))];
}

export async function dispatchPush(
  ctx: PushDispatchContext,
  messages: PushMessage[],
  logContext: Record<string, unknown>,
  description: string,
): Promise<PushDispatchSummary> {
  const summary: PushDispatchSummary = {
    recipients: messages.length,
    sent: 0,
    failed: 0,
    invalidToken: 0,
  };
  // Tipo derivado do payload de navegação (conjunto controlado), nunca do token.
  const messageType = safeLabel(messages[0]?.data?.type, "unknown");
  if (messages.length === 0) {
    return summary;
  }

  const startedAt = process.hrtime.bigint();
  const observeDuration = () =>
    pushDuration.observe(
      { message_type: messageType },
      Number(process.hrtime.bigint() - startedAt) / 1e9,
    );

  let results;
  try {
    results = await ctx.pushProvider.send(messages);
  } catch (error) {
    summary.failed = messages.length;
    observeDuration();
    pushDispatchTotal.inc({ message_type: messageType, result: "failed" });
    pushMessagesTotal.inc({ message_type: messageType, result: "failed" }, messages.length);
    pushFailuresTotal.inc({ message_type: messageType }, messages.length);
    ctx.log.error(
      {
        event: "push_dispatch_failed",
        err: error,
        ...logContext,
        messageType,
        recipients: messages.length,
        provider: ctx.pushProvider.name,
      },
      `Falha ao enviar push: ${description}`,
    );
    return summary;
  }

  const invalidTokens: string[] = [];
  for (const result of results) {
    if (result.status === "sent") {
      summary.sent += 1;
    } else if (result.status === "invalidToken") {
      summary.invalidToken += 1;
      invalidTokens.push(result.to);
    } else {
      summary.failed += 1;
    }
  }

  if (invalidTokens.length > 0) {
    await ctx.db
      .update(pushDevices)
      .set({ isActive: false, updatedAt: new Date() })
      .where(inArray(pushDevices.token, invalidTokens));
  }

  // Métricas (Phase 9): contagens por tipo e resultado — nunca o token.
  observeDuration();
  pushDispatchTotal.inc({
    message_type: messageType,
    result: summary.failed > 0 ? "partial" : "ok",
  });
  if (summary.sent > 0) {
    pushMessagesTotal.inc({ message_type: messageType, result: "sent" }, summary.sent);
  }
  if (summary.failed > 0) {
    pushMessagesTotal.inc({ message_type: messageType, result: "failed" }, summary.failed);
    pushFailuresTotal.inc({ message_type: messageType }, summary.failed);
  }
  if (summary.invalidToken > 0) {
    pushMessagesTotal.inc(
      { message_type: messageType, result: "invalid_token" },
      summary.invalidToken,
    );
    pushInvalidTokensTotal.inc({ message_type: messageType }, summary.invalidToken);
  }

  ctx.log.info(
    { event: "push_dispatch_completed", ...logContext, messageType, ...summary },
    `Push processado: ${description}`,
  );
  return summary;
}
