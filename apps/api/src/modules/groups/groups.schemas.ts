import { z } from "zod";

/**
 * Schemas de validação dos Grupos de Confiança (Phase 2).
 * Nome com trim e limite razoável; e-mail normalizado (trim + lowercase).
 */
export const groupNameSchema = z
  .string()
  .trim()
  .min(1, "Informe o nome do grupo.")
  .max(80, "Nome do grupo muito longo.");

export const createGroupSchema = z.object({
  name: groupNameSchema,
});

export const updateGroupSchema = z.object({
  name: groupNameSchema,
});

export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido.").max(254),
});

// Papéis que podem ser atribuídos via PATCH role (OWNER nunca é atribuível aqui).
export const changeRoleSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER"]),
});

// Phase 12: alvo da transferência de propriedade (um membro do grupo).
export const transferOwnershipSchema = z.object({
  userId: z.string().uuid("Membro inválido."),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
