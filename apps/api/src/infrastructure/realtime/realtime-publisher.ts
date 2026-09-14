import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../database/client.js";
import { groupMemberships } from "../database/schema.js";
import {
  realtimeEventsPublishedTotal,
  realtimePublishFailuresTotal,
  safeLabel,
} from "../../observability/metrics.js";
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
    const eventType = safeLabel(event.type);
    try {
      const rows = await this.db
        .select({ userId: groupMemberships.userId })
        .from(groupMemberships)
        .where(eq(groupMemberships.groupId, groupId));
      const excluded = new Set(options.exclude ?? []);
      const recipients = rows.map((row) => row.userId).filter((userId) => !excluded.has(userId));
      const delivered = this.hub.send(recipients, event);
      realtimeEventsPublishedTotal.inc({ event_type: eventType });
      this.log.debug(
        {
          event: "realtime_event_published",
          eventType: event.type,
          eventId: event.eventId,
          groupId,
          delivered,
        },
        "Evento realtime publicado",
      );
      return delivered;
    } catch (error) {
      // A falha é contabilizada aqui e propagada: quem publica roda em segundo
      // plano e nunca desfaz a operação de negócio por causa disso.
      realtimePublishFailuresTotal.inc({ event_type: eventType });
      this.log.error(
        { event: "realtime_publish_failed", err: error, eventType: event.type, groupId },
        "Falha ao publicar evento realtime",
      );
      throw error;
    }
  }

  publishToUser(userId: string, event: RealtimeEvent): number {
    const eventType = safeLabel(event.type);
    try {
      const delivered = this.hub.send([userId], event);
      realtimeEventsPublishedTotal.inc({ event_type: eventType });
      return delivered;
    } catch (error) {
      realtimePublishFailuresTotal.inc({ event_type: eventType });
      throw error;
    }
  }
}
