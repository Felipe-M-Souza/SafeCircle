import { z } from "zod";

/**
 * Validação do Trajeto Seguro (Phase 8).
 * `expectedArrivalAt` é absoluto (ISO/UTC); o servidor é a autoridade do
 * relógio e aplica os limites de duração no serviço. O destino é textual e
 * opcional (sem coordenada, sem geocoding).
 */
export const journeyStatusValues = ["ACTIVE", "ARRIVED", "CANCELLED", "OVERDUE"] as const;

/** Tamanho máximo razoável do rótulo de destino (ex.: "Casa", "Rodoviária"). */
export const DESTINATION_LABEL_MAX_LENGTH = 120;

export const createJourneySchema = z.object({
  groupId: z.string().uuid("Grupo inválido."),
  destinationLabel: z
    .string()
    .trim()
    .max(DESTINATION_LABEL_MAX_LENGTH, "Destino muito longo.")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  expectedArrivalAt: z.iso.datetime({ offset: true, message: "Horário de chegada inválido." }),
  liveLocationEnabled: z.boolean().optional().default(false),
});

export const listJourneysQuerySchema = z.object({
  status: z.enum(journeyStatusValues).optional(),
});

/** Duração mínima e máxima do prazo, contadas a partir do relógio do servidor. */
export const JOURNEY_MIN_DURATION_MS = 10 * 60 * 1000;
export const JOURNEY_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export type CreateJourneyInput = z.infer<typeof createJourneySchema>;
export type ListJourneysQuery = z.infer<typeof listJourneysQuerySchema>;
