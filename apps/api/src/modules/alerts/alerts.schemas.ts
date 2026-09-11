import { z } from "zod";

/**
 * Schemas de validação do Alerta de Emergência (Phase 3).
 * O backend é a validação autoritativa; o cliente nunca é confiado.
 */

export const alertStatusValues = ["ACTIVE", "RESOLVED", "CANCELLED"] as const;

/** Snapshot opcional de localização capturado no início do alerta. */
export const alertLocationInputSchema = z.object({
  latitude: z.number().min(-90, "Latitude inválida.").max(90, "Latitude inválida."),
  longitude: z.number().min(-180, "Longitude inválida.").max(180, "Longitude inválida."),
  accuracy: z.number().nonnegative("Precisão inválida.").optional(),
  capturedAt: z.iso.datetime({ offset: true, message: "Data de captura inválida." }).optional(),
});

export const createAlertSchema = z.object({
  groupId: z.string().uuid("Grupo inválido."),
  // `location` é opcional: a falta de GPS nunca impede o pedido de ajuda.
  location: alertLocationInputSchema.nullish(),
});

export const listAlertsQuerySchema = z.object({
  // Por padrão a listagem retorna apenas alertas ACTIVE.
  status: z.enum(alertStatusValues).optional(),
});

// Phase 5 — acknowledgements
export const acknowledgementTypeValues = [
  "SEEN",
  "ACKNOWLEDGED",
  "GOING_TO_HELP",
  "EMERGENCY_SERVICES_CONTACTED",
] as const;

export const setAcknowledgementSchema = z.object({
  type: z.enum(acknowledgementTypeValues),
});

export type SetAcknowledgementInput = z.infer<typeof setAcknowledgementSchema>;
export type AlertLocationInput = z.infer<typeof alertLocationInputSchema>;
export type CreateAlertInput = z.infer<typeof createAlertSchema>;
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;
