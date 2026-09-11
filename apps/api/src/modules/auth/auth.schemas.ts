import { z } from "zod";

/**
 * Schemas de validação da autenticação (README §7).
 * O e-mail é normalizado (trim + lowercase) e o nome tem trim aplicado.
 * O backend é a validação autoritativa.
 */
export const registerSchema = z.object({
  name: z.string().trim().min(1, "Informe seu nome.").max(120),
  email: z.string().trim().toLowerCase().email("E-mail inválido.").max(254),
  password: z.string().min(8, "A senha deve ter ao menos 8 caracteres.").max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("E-mail inválido.").max(254),
  password: z.string().min(1, "Informe a senha.").max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token ausente."),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1, "Refresh token ausente."),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type LogoutInput = z.infer<typeof logoutSchema>;
