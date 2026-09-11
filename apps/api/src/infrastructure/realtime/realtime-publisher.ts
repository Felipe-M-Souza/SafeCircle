import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../database/client.js";
import { groupMemberships } from "../database/schema.js";
import type { RealtimeEvent } from "./events.js";
import type { RealtimeHub } from "./realtime-hub.js";

/**
 * Publicação de eventos realtime (Phase 5).
 *
 * Rotas e serviços nunca tocam em sockets: publicam por grupo ou por usuário.
 * Os destinatários de um grupo são calculados no banco a cada publicação —
 * quem saiu/foi removido deixa de receber automaticamente. Nunca há broadcast
 * global com dados privados.
 */
export interface PublishToGroupOptions {
  /** Usuários a excluir (ex.: quem não deve receber o próprio evento). */
  exclude?: string[];
}

export interface RealtimePublisher {
  publishToGroup(
    groupId: string,
    event: RealtimeEvent,
    options?: PublishToGroupOptions,
  ): Promise<number>;
  publishToUser(userId: string, event: RealtimeEvent): number;
}

export class HubRealtimePublisher implements RealtimePublisher {
  constructor(
    private readonly db: Database,
    private readonly hub: RealtimeHub,
    private readonly log: FastifyBaseLogger,
  ) {}

  async publishToGroup(
    groupId: string,
    event: RealtimeEvent,
    options: PublishToGroupOptions = {},
  ): Promise<number> {
    const rows = await this.db
      .select({ userId: groupMemberships.userId })
      .from(groupMemberships)
      .where(eq(groupMemberships.groupId, groupId));
    const excluded = new Set(options.exclude ?? []);
    const recipients = rows.map((row) => row.userId).filter((userId) => !excluded.has(userId));
    const delivered = this.hub.send(recipients, event);
    this.log.debug(
      { eventType: event.type, eventId: event.eventId, groupId, delivered },
      "Evento realtime publicado",
    );
    return delivered;
  }

  publishToUser(userId: string, event: RealtimeEvent): number {
    return this.hub.send([userId], event);
  }
}
