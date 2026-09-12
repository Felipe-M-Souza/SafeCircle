import { and, eq, inArray, ne } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../infrastructure/database/client.js";
import { groupMemberships, pushDevices } from "../../infrastructure/database/schema.js";
import type { PushMessage, PushProvider } from "../../infrastructure/push/push-provider.js";

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
  if (messages.length === 0) {
    return summary;
  }

  let results;
  try {
    results = await ctx.pushProvider.send(messages);
  } catch (error) {
    summary.failed = messages.length;
    ctx.log.error(
      { err: error, ...logContext, recipients: messages.length, provider: ctx.pushProvider.name },
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

  ctx.log.info({ ...logContext, ...summary }, `Push processado: ${description}`);
  return summary;
}
