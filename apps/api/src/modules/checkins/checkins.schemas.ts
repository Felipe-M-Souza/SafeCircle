import { z } from "zod";

/**
 * Validação do Check-in de Segurança (Phase 7).
 * `dueAt` é absoluto (ISO/UTC); o servidor é a autoridade do relógio e aplica
 * os limites de duração no serviço.
 */
export const checkinStatusValues = ["ACTIVE", "SAFE", "CANCELLED", "OVERDUE"] as const;

export const createCheckinSchema = z.object({
  groupId: z.string().uuid("Grupo inválido."),
  dueAt: z.iso.datetime({ offset: true, message: "Prazo inválido." }),
});

export const listCheckinsQuerySchema = z.object({
  status: z.enum(checkinStatusValues).optional(),
});

/** Duração mínima e máxima do prazo, contadas a partir do relógio do servidor. */
export const CHECKIN_MIN_DURATION_MS = 5 * 60 * 1000;
export const CHECKIN_MAX_DURATION_MS = 24 * 60 * 60 * 1000;

export type CreateCheckinInput = z.infer<typeof createCheckinSchema>;
export type ListCheckinsQuery = z.infer<typeof listCheckinsQuerySchema>;
